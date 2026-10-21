import type { ChatItem, ChatPart, Session } from '@threadterm/protocol';
import { agentName } from './agents';
import { approvalData } from './chatApproval';
import { planDataOf, planProgress } from './chatPlan';
import { activeTurnId } from './chatPresentation';
import { isStreamingChatItem } from './codexStream';
import { groupCodexTranscript } from './codexTranscript';
import { delegationActive, delegationTool, delegationToolLabel, type DelegationTool } from './delegation';
import { isSubagentPart, subagentInfo, subagentTitle, subagentToolCount } from './subagentActivity';
import { describeTool, hiddenQuestionTool, toolSummary, toolSummarySegments } from './toolActivity';
import type { ToolSummary } from './toolActivity';
import { toolStatus, toolView } from './toolView';
import type { ToolView } from './toolView';
import { turnReview } from './turnFooter';
import type { TaskMapGraph, TaskMapInput, TaskMapLane, TaskMapNode, TaskMapPhase, TaskMapSessions, TaskMapStatus, TaskMapStepKind } from './taskMapTypes';
export { taskMapRoot } from './taskMapRoot';

const time = (value: string | undefined): number | undefined => {
  const result = Date.parse(value ?? '');
  return Number.isFinite(result) ? result : undefined;
};
const firstLine = (value: string, limit: number): string => value.trim().split(/\r?\n/, 1)[0]!.slice(0, limit);
const textOf = (item: ChatItem): string => item.parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
// A delegate's first message can quote the user's words above the delegating agent's prompt (runtime
// `delegation::first_message`); the task it was given is that prompt.
const delegateTask = (text: string): string => {
  if (!text.startsWith("## User's words")) return text;
  const at = text.indexOf('\n## From the delegating agent');
  if (at < 0) return text;
  const prompt = text.slice(text.indexOf('\n', at + 1) + 1), end = prompt.indexOf('\n---\n');
  return end < 0 ? prompt : prompt.slice(0, end);
};
const windowsPath = (path: string): boolean => path.includes('\\') || /^(?:[a-z]:\/|\/\/)/i.test(path);
const pathKey = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return windowsPath(path) ? normalized.toLowerCase() : normalized;
};
const stringify = (data: unknown): string => { try { return JSON.stringify(data) ?? ''; } catch { return ''; } };
const delegateResult = (part: ChatPart): string => {
  const data = part.data && typeof part.data === 'object' && !Array.isArray(part.data) ? part.data as Record<string, unknown> : {};
  return stringify([data.result, data.content, data.rawOutput, part.text]);
};
const byCreated = (a: Session, b: Session): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function childrenOf(sessions: readonly Session[]): Map<string, Session[]> {
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    const parent = session.delegation?.parentSessionId;
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(session);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(byCreated);
  return children;
}

function sessionState(session: Session): TaskMapStatus {
  const state = session.delegation?.state;
  if (state) {
    if (state === 'awaiting_parent' || state === 'awaiting_user') return 'waiting';
    if (delegationActive(state)) return 'running';
    return state === 'failed' || state === 'cancelled' ? state : 'done';
  }
  // A Chat whose turn ended rests in `waiting`/`awaiting_input` until the next prompt: that is done, not "needs you".
  const activity = session.activity?.state;
  if (activity === 'awaiting_approval' || activity === 'awaiting_parent') return 'waiting';
  if (activity === 'running' || (!session.activity && session.status === 'running') || session.status === 'starting') return 'running';
  if (session.status === 'error') return 'failed';
  return session.status === 'interrupted' ? 'cancelled' : 'done';
}

function partState(part: ChatPart, live: boolean): TaskMapStatus {
  if ((part.type === 'approval' || hiddenQuestionTool(part)) && part.status === 'pending') return 'waiting';
  const status = toolStatus(part);
  if (status === 'failed' || status === 'cancelled') return status;
  return status === 'running' && live ? 'running' : 'done';
}

function combineStatus(a: TaskMapStatus, b: TaskMapStatus): TaskMapStatus {
  const priority: TaskMapStatus[] = ['done', 'cancelled', 'running', 'waiting', 'failed'];
  return priority.indexOf(a) >= priority.indexOf(b) ? a : b;
}

function toolStep(view: ToolView, described: ReturnType<typeof describeTool>, delegation: ReturnType<typeof delegationTool>): TaskMapStepKind {
  if (delegation) return 'delegation';
  if (described.kind === 'browser') return 'browser';
  if (view.kind === 'read' || view.kind === 'search' || view.kind === 'web') return 'explore';
  if (view.kind === 'command') return view.actions?.length ? 'explore' : 'command';
  if (view.kind === 'edit') return 'edit';
  if (view.kind === 'mcp') return 'mcp';
  return 'tool';
}

// Keep the shared summary vocabulary while consuming views already parsed for the map.
function addToolView(summary: ToolSummary, view: ToolView, delegation: ReturnType<typeof delegationTool>): void {
  if (view.status === 'failed') summary.failed += 1;
  if (view.status === 'cancelled') summary.interrupted += 1;
  // Delegation follow-ups are labelled from delegation.ts (delegationGroupLabel), not from the shared summary.
  if (delegation) return;
  if (view.kind === 'read') summary.explored += 1;
  else if (view.kind === 'search' || view.kind === 'web') summary.searched += 1;
  else if (view.kind === 'command') {
    summary.ran += 1;
    if (view.actions?.some(action => action === 'read' || action === 'list')) summary.explored += 1;
    if (view.actions?.includes('search')) summary.searched += 1;
  } else if (view.kind !== 'edit' && view.kind !== 'subagent') summary.other += 1;
}

/** One call: its own label ("Waited for delegates"); several: one follow-up label with the count. */
export function delegationGroupLabel(tools: readonly DelegationTool[], copy: TaskMapInput['copy']): string {
  return tools.length === 1 ? delegationToolLabel(tools[0]!, copy) : copy(`Followed delegates (${tools.length})`, `跟进委派（${tools.length}）`);
}

interface Turn { key: string; items: ChatItem[]; turnId?: string }
function turnsOf(items: readonly ChatItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    let turn = turns.at(-1);
    if (!turn || item.role === 'user' || item.turnId && turn.turnId && item.turnId !== turn.turnId) {
      turn = { key: item.id, items: [], turnId: item.turnId };
      turns.push(turn);
    }
    if (item.turnId) turn.turnId = item.turnId;
    turn.items.push(item);
  }
  return turns;
}

function turnState(items: ChatItem[], session: Session | undefined, current: boolean): TaskMapStatus {
  const outcome = [...items].reverse().find(item => item.turnStatus)?.turnStatus;
  if (outcome === 'failed') return 'failed';
  if (outcome === 'interrupted') return 'cancelled';
  if (outcome === 'completed' || outcome !== 'inProgress' && items.some(item => item.elapsedMs !== undefined)) return 'done';
  if (items.some(item => item.parts.some(part => (part.type === 'approval' || hiddenQuestionTool(part)) && part.status === 'pending'))) return 'waiting';
  if (current && (session && activeTurnId(items, session.status) || items.some(item => item.turnOrigin !== 'history' && isStreamingChatItem(item)) && (!session || sessionState(session) === 'running'))) return 'running';
  return 'done';
}

// Keep part indexes intact, including when an imported record contains malformed entries.
function safeItems(items: readonly ChatItem[]): ChatItem[] {
  return items.map(item => ({ ...item, parts: (Array.isArray(item.parts) ? item.parts : []).map(part => {
    if (!part || typeof part !== 'object') return { type: 'status' } as ChatPart;
    return { ...part, text: typeof part.text === 'string' ? part.text : undefined,
      toolName: typeof part.toolName === 'string' ? part.toolName : undefined,
      status: typeof part.status === 'string' ? part.status : undefined };
  }) }));
}

/** The root and its delegate sessions, breadth-first (depth ≤ 4, at most 24 delegates). */
export function taskMapSessions(rootSessionId: string, sessions: readonly Session[]): TaskMapSessions {
  const root = sessions.find(session => session.id === rootSessionId);
  if (!root) return { sessions: [], hiddenDelegates: 0 };
  const children = childrenOf(sessions), seen = new Set([root.id]);
  const queue = [{ session: root, depth: 0 }], selected: Session[] = [];
  let hiddenDelegates = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const { session, depth } = queue[index]!;
    if (depth <= 4 && selected.length < 25) selected.push(session);
    else hiddenDelegates += 1;
    for (const child of children.get(session.id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push({ session: child, depth: depth + 1 });
    }
  }
  return { sessions: selected, hiddenDelegates };
}

export function buildTaskMap(input: TaskMapInput): TaskMapGraph {
  const { rootSessionId, copy } = input;
  const graph: TaskMapGraph = { rootSessionId, lanes: [], nodes: [], edges: [], phases: [], hiddenPhases: 0 };
  const sessions = taskMapSessions(rootSessionId, input.sessions).sessions;
  const root = sessions[0];
  if (!root) return graph;
  const children = childrenOf(sessions), byId = new Map(sessions.map(session => [session.id, session]));
  const rootItems = safeItems(input.items.get(rootSessionId) ?? []);
  const rootTurns: Turn[] = [];
  for (const item of rootItems) {
    if (!rootTurns.length || item.role === 'user') rootTurns.push({ key: item.id, items: [] });
    rootTurns.at(-1)!.items.push(item);
  }
  const allPhases: TaskMapPhase[] = rootTurns.map((turn, index) => {
    const prompt = turn.items.find(item => item.role === 'user');
    return { id: `phase:${turn.key}`, index, turnId: turn.items.find(item => item.turnId)?.turnId,
      label: input.zh ? `第 ${index + 1} 轮` : `Turn ${index + 1}`, prompt: prompt ? firstLine(textOf(prompt), 80) : undefined,
      promptItemId: prompt?.id, status: turnState(turn.items, root, index === rootTurns.length - 1),
      elapsedMs: [...turn.items].reverse().find(item => item.elapsedMs !== undefined)?.elapsedMs,
      startedAt: time(turn.items[0]?.createdAt) };
  });
  const max = Number.isFinite(input.maxPhases) ? Math.max(0, Math.floor(input.maxPhases!)) : 40;
  graph.hiddenPhases = Math.max(0, allPhases.length - max);
  graph.phases = allPhases.slice(graph.hiddenPhases).map((phase, index) => ({ ...phase, index }));
  const rootPhase = new Map<string, number>();
  rootTurns.forEach((turn, index) => turn.items.forEach(item => rootPhase.set(item.id, index)));
  const timed = allPhases.flatMap((phase, index) => phase.startedAt === undefined ? [] : [{ at: phase.startedAt, index }]);
  const phaseAt = (at: number | undefined, fallback: number): number => {
    if (at === undefined || !timed.length) return fallback;
    let lo = 0, hi = timed.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (timed[mid]!.at <= at) lo = mid + 1; else hi = mid; }
    return timed[Math.max(0, lo - 1)]!.index;
  };
  const laneNodes = new Map<string, TaskMapNode[]>(), groups = new Map<TaskMapNode, { summary: ToolSummary; fallback: boolean; delegations: DelegationTool[] }>();
  const turnNodes = new Map<string, TaskMapNode[]>(), turnItems = new Map<string, ChatItem[]>();
  const partData = new Map<string, ChatPart>();
  const starts = new Map<string, { node?: TaskMapNode; phase: number; order: number }>();
  const nativeLinks: { node: TaskMapNode; before?: TaskMapNode; after?: TaskMapNode }[] = [];
  const addEdge = (from: TaskMapNode | undefined, to: TaskMapNode | undefined, kind: TaskMapGraph['edges'][number]['kind']) => {
    if (from && to && from.id !== to.id) graph.edges.push({ id: `${kind}:${from.id}→${to.id}`, from: from.id, to: to.id, kind });
  };
  const visited = new Set<string>();
  const visit = (session: Session, depth: number, fallback: number) => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    const laneId = `agent:${session.id}`;
    const lane: TaskMapLane = { id: laneId, kind: depth ? 'delegate' : 'agent', sessionId: session.id,
      provider: session.provider, title: session.title || session.provider, depth, status: sessionState(session),
      parentLaneId: depth ? `agent:${session.delegation!.parentSessionId}` : undefined,
      subtitle: depth && session.delegation?.workspace === 'worktree' ? session.delegation.branch || copy('Worktree', '工作树') : undefined };
    const nodes: TaskMapNode[] = [];
    laneNodes.set(laneId, nodes);
    const native = new Map<string, { lane: TaskMapLane; node: TaskMapNode; order: number; link: typeof nativeLinks[number] }>();
    const items = session.id === rootSessionId ? rootItems : safeItems(input.items.get(session.id) ?? []);
    const liveTurn = activeTurnId(items, session.status);
    const matched = new Set<string>();
    let order = 0, firstPrompt = true, lastPhase = fallback;
    const turns = turnsOf(items);
    for (const turn of turns) {
      const turnKey = `${laneId}:${turn.key}`;
      turnItems.set(turnKey, turn.items);
      const inTurn: TaskMapNode[] = [];
      turnNodes.set(turnKey, inTurn);
      // Reuse Codex's response policy, then also exclude explicit commentary in live turns.
      const responses = session.provider === 'codex' ? groupCodexTranscript(turn.items).flatMap(group => group.response) : turn.items;
      const hasPhase = session.provider === 'codex' && turn.items.some(item => item.parts.some(part => part.type === 'text' && part.phase));
      const responseIds = new Set(responses.filter(item => item.role === 'assistant' && item.parts.some(part => part.type === 'text' && part.text && (!hasPhase || part.phase !== 'commentary'))).map(item => item.id));
      const final = [...turn.items].reverse().find(item => responseIds.has(item.id));
      let previous: TaskMapNode | undefined;
      const messages = new Map<string, TaskMapNode>();
      const add = (item: ChatItem, partIndex: number, kind: TaskMapNode['kind'], phase: number, label: string, status: TaskMapStatus): TaskMapNode => {
        const node: TaskMapNode = { id: `${laneId}:${item.id}:${partIndex}`, laneId, kind, label, status,
          phase: phase - graph.hiddenPhases, at: time(item.createdAt), sequence: nodes.length, sessionId: session.id, parts: [{ itemId: item.id, partIndex }] };
        nodes.push(node); inTurn.push(node); graph.nodes.push(node);
        for (const entry of native.values()) if (!entry.link.after && entry.link.before !== node) entry.link.after = node;
        previous = node;
        return node;
      };
      for (const item of turn.items) {
        const absolutePhase = session.id === rootSessionId ? rootPhase.get(item.id)! : Math.max(fallback, lastPhase, phaseAt(time(item.createdAt), fallback));
        lastPhase = absolutePhase;
        const visible = absolutePhase >= graph.hiddenPhases && absolutePhase < allPhases.length;
        const live = item.turnOrigin !== 'history' && (item.turnId ? item.turnId === liveTurn : sessionState(session) === 'running' && turn === turns.at(-1)
          && !turn.items.some(entry => entry.turnStatus === 'completed' || entry.turnStatus === 'failed' || entry.turnStatus === 'interrupted' || entry.elapsedMs !== undefined));
        for (let partIndex = 0; partIndex < item.parts.length; partIndex += 1) {
          const part = item.parts[partIndex]!;
          partData.set(`${session.id}:${item.id}:${partIndex}`, part);
          const ref = { itemId: item.id, partIndex };
          const ordinal = order++;
          const delegation = part.type === 'tool' ? delegationTool(part) : undefined;
          if (delegation === 'delegate_start') {
            const available = children.get(session.id) ?? [];
            // Results may embed JSON in a text content block (with escaped quotes).
            const payload = delegateResult(part).replace(/\\+"/g, '"');
            const ids = [...payload.matchAll(/"sessionId"\s*:\s*"([^"\\]+)"/g)].map(match => match[1]);
            const child = available.find(candidate => ids.includes(candidate.id) && !matched.has(candidate.id)) ?? available.find(candidate => !matched.has(candidate.id));
            if (child) matched.add(child.id);
            const node = visible ? add(item, partIndex, 'delegate', absolutePhase,
              copy(`Delegated to ${child ? agentName(child.provider) : 'agent'}`, `委派给 ${child ? agentName(child.provider) : '代理'}`), child ? sessionState(child) : partState(part, live)) : undefined;
            if (node) { node.childSessionId = child?.id; node.detail = child?.title; }
            if (child) starts.set(child.id, { node, phase: absolutePhase, order: ordinal });
            previous = undefined;
            continue;
          }
          if (isSubagentPart(part)) {
            const info = subagentInfo(part);
            previous = undefined;
            if (!info || !visible) continue;
            const id = `subagent:${session.id}:${info.key}`;
            let entry = native.get(id);
            if (!entry) {
              const node: TaskMapNode = { id: `${id}:${item.id}:${partIndex}`, laneId: id, kind: 'subagent', label: '', status: 'done',
                phase: absolutePhase - graph.hiddenPhases, at: time(item.createdAt), sequence: 0, sessionId: session.id, parts: [] };
              const link = { node, before: nodes.at(-1) };
              entry = { lane: { id, kind: 'subagent', sessionId: session.id, provider: info.provider, title: '', depth: depth + 1, parentLaneId: laneId }, node, order: ordinal, link };
              native.set(id, entry); nativeLinks.push(link); graph.nodes.push(node); laneNodes.set(id, [node]);
            }
            entry.node.parts.push(ref); entry.node.subagent = info;
            entry.node.label = subagentTitle(info, copy);
            entry.node.detail = [info.agentType, typeof info.toolCount === 'number' ? subagentToolCount(info.toolCount, copy) : undefined].filter(Boolean).join(' · ');
            entry.node.status = info.status === 'running' ? 'running' : info.status === 'failed' || info.status === 'cancelled' ? info.status : 'done';
            entry.lane.title = entry.node.label; entry.lane.status = entry.node.status; entry.lane.subtitle = info.agentType;
            continue;
          }
          if (!visible) { if (item.role === 'user' && part.type === 'text' && part.text?.trim()) firstPrompt = false; previous = undefined; continue; }
          if (part.type === 'usage' || part.type === 'status' || part.type === 'thinking') continue;
          if (part.type === 'text') {
            if (!part.text?.trim()) continue;
            const prior = previous;
            previous = undefined;
            if (item.role === 'user') {
              const existing = messages.get(item.id);
              if (existing) { existing.parts.push(ref); if (prior === existing) previous = existing; continue; }
              const parentProvider = depth && session.delegation ? byId.get(session.delegation.parentSessionId)?.provider : undefined;
              const label = depth && firstPrompt ? copy(`Task from ${parentProvider ? agentName(parentProvider) : 'agent'}`, `来自 ${parentProvider ? agentName(parentProvider) : '代理'} 的任务`) : firstLine(textOf(item), 60);
              const node = add(item, partIndex, 'prompt', absolutePhase, label, 'done'); node.detail = depth && firstPrompt ? firstLine(delegateTask(textOf(item)), 80) : undefined;
              messages.set(item.id, node);
              firstPrompt = false;
            } else if (item === final && (!hasPhase || part.phase !== 'commentary')) {
              if (messages.has(item.id)) continue;
              const node = add(item, partIndex, 'reply', absolutePhase, copy('Reply', '回复'), partState(part, live));
              const answer = item.parts.flatMap((entry, index) => entry.type === 'text' && entry.text?.trim() && (!hasPhase || entry.phase !== 'commentary') ? [{ entry, index }] : []);
              node.parts = answer.map(({ index }) => ({ itemId: item.id, partIndex: index }));
              node.detail = firstLine(answer.map(({ entry }) => entry.text).join('\n'), 100);
              for (const { entry } of answer) node.status = combineStatus(node.status, partState(entry, live));
              messages.set(item.id, node);
            }
            continue;
          }
          if (part.type === 'plan') {
            const plan = planDataOf(part);
            if (!plan) { previous = undefined; continue; }
            const progress = planProgress(plan.entries);
            const node = previous?.kind === 'plan' && previous.phase === absolutePhase - graph.hiddenPhases ? previous : add(item, partIndex, 'plan', absolutePhase, '', 'done');
            if (!(node.parts.length === 1 && node.parts[0]!.itemId === item.id && node.parts[0]!.partIndex === partIndex)) node.parts.push(ref);
            node.label = copy(`Plan ${progress.done}/${progress.total}`, `计划 ${progress.done}/${progress.total}`);
            node.detail = plan.explanation;
            node.status = progress.done === progress.total ? 'done' : live ? 'running' : 'done';
            continue;
          }
          if (part.type === 'approval') {
            const data = approvalData(part);
            add(item, partIndex, 'approval', absolutePhase, data?.title || copy('Approval required', '需要批准'), partState(part, live));
          } else if (part.type === 'error') {
            const node = add(item, partIndex, 'error', absolutePhase, copy('Error', '错误'), 'failed'); node.detail = part.text;
          } else if (part.type === 'tool' && hiddenQuestionTool(part)) {
            const node = add(item, partIndex, 'question', absolutePhase, copy('Question', '问题'), partState(part, live)); node.detail = part.text;
          } else if (part.type === 'tool') {
            let step: TaskMapStepKind = 'tool', detail: string | undefined, files: string[] = [], view: ToolView | undefined;
            try {
              view = toolView(part);
              const described = describeTool(part, copy);
              step = toolStep(view, described, delegation); detail = described.detail;
              if (view.kind === 'edit') files = view.files.map(file => file.path).filter(Boolean);
            } catch { /* Unknown provider payloads remain inspectable generic tools. */ }
            const node = previous?.kind === 'tools' && previous.step === step && previous.phase === absolutePhase - graph.hiddenPhases ? previous : add(item, partIndex, 'tools', absolutePhase, '', 'done');
            if (!(node.parts.length === 1 && node.parts[0]!.itemId === item.id && node.parts[0]!.partIndex === partIndex)) node.parts.push(ref);
            node.step = step; node.detail = detail; node.status = combineStatus(node.status, partState(part, live));
            if (files.length) node.files = [...new Set([...(node.files ?? []), ...files])];
            const group = groups.get(node) ?? { summary: toolSummary([]), fallback: false, delegations: [] };
            if (delegation) group.delegations.push(delegation);
            if (view) addToolView(group.summary, view, delegation); else group.fallback = true;
            groups.set(node, group); node.count = (node.count ?? 0) + 1;
          } else previous = undefined;
        }
      }
    }
    if (!depth || nodes.length) graph.lanes.push(lane);
    for (let index = 1; index < nodes.length; index += 1) addEdge(nodes[index - 1], nodes[index], 'flow');
    const branches = [
      ...(children.get(session.id) ?? []).map(child => ({ order: starts.get(child.id)?.order ?? Infinity, child })),
      ...[...native.values()].map(entry => ({ order: entry.order, native: entry })),
    ].sort((a, b) => a.order - b.order);
    for (const branch of branches) {
      if ('native' in branch) graph.lanes.push(branch.native.lane);
      else visit(branch.child, depth + 1, starts.get(branch.child.id)?.phase ?? Math.max(fallback, phaseAt(time(branch.child.createdAt), fallback)));
    }
  };
  visit(root, 0, 0);
  for (const [node, group] of groups) {
    group.summary.edited = node.files?.length ?? 0;
    node.label = node.step === 'delegation' && group.delegations.length ? delegationGroupLabel(group.delegations, copy)
      : group.fallback ? copy(`Used ${node.count} tools`, `使用 ${node.count} 项工具`)
      : toolSummarySegments(group.summary, copy).join(' · ') || copy('Tools', '工具');
  }
  for (const session of sessions.slice(1)) {
    const start = starts.get(session.id)?.node;
    const nodes = laneNodes.get(`agent:${session.id}`) ?? [];
    addEdge(start, nodes[0], 'delegate');
    if (!start || !nodes.length || !session.delegation || delegationActive(session.delegation.state)) continue;
    const last = nodes.at(-1)!;
    const parent = (laneNodes.get(start.laneId) ?? []).filter(node => node.sequence > start.sequence && node.step === 'delegation');
    const matched = parent.find(node => node.parts.some(ref => {
      const part = partData.get(`${node.sessionId}:${ref.itemId}:${ref.partIndex}`);
      if (!part || !['delegate_wait', 'delegate_result'].includes(delegationTool(part) ?? '')) return false;
      const payload = stringify(part.data);
      return payload.includes(session.id) || payload.includes(session.delegation!.id);
    }));
    addEdge(last, matched ?? parent.find(node => node.at !== undefined && last.at !== undefined && node.at >= last.at), 'return');
  }
  for (const link of nativeLinks) {
    addEdge(link.before, link.node, 'delegate');
    if (['completed', 'failed', 'cancelled'].includes(link.node.subagent?.status ?? '')) addEdge(link.node, link.after, 'return');
  }
  const outputs: TaskMapNode[] = [];
  const output = (node: TaskMapNode, producer?: TaskMapNode) => {
    node.sequence = outputs.length; outputs.push(node); graph.nodes.push(node); addEdge(producer, node, 'produce');
  };
  for (const [key, nodes] of turnNodes) {
    if (!nodes.length) continue;
    const review = turnReview(turnItems.get(key) ?? []);
    const edits = nodes.filter(node => node.step === 'edit');
    const files = [...new Set(edits.flatMap(node => node.files ?? []))];
    if (!review?.fileCount && (!files.length || review)) continue;
    const producer = edits.at(-1) ?? [...nodes].reverse().find(node => node.kind === 'reply') ?? nodes.at(-1)!;
    const count = review?.fileCount ?? files.length;
    output({ id: `outputs:files:${key}`, laneId: 'outputs', kind: 'files', label: copy(`${count} ${count === 1 ? 'file' : 'files'} changed`, `${count} 个文件已更改`),
      detail: producer.sessionId === rootSessionId ? undefined : byId.get(producer.sessionId!)?.title,
      status: 'done', phase: producer.phase, at: producer.at, sequence: 0, sessionId: producer.sessionId, parts: [], count,
      ...(review ? { review } : { files }) }, producer);
  }
  const editedPaths = new Map<string, TaskMapNode>(), foldedEdits = new Map<string, TaskMapNode>(), windowsEdits = new Map<string, TaskMapNode>();
  const latestEdit = (map: Map<string, TaskMapNode>, key: string, node: TaskMapNode) => {
    const prior = map.get(key);
    if (!prior || (node.at ?? -Infinity) >= (prior.at ?? -Infinity)) map.set(key, node);
  };
  for (const node of graph.nodes) if (node.step === 'edit') for (const path of node.files ?? []) {
    const key = pathKey(path);
    latestEdit(editedPaths, key, node); latestEdit(foldedEdits, key.toLowerCase(), node);
    if (windowsPath(path)) latestEdit(windowsEdits, key.toLowerCase(), node);
  }
  const documentPaths = new Set<string>();
  for (const document of input.documents ?? []) {
    const key = pathKey(document.path);
    if (documentPaths.has(key)) continue;
    documentPaths.add(key);
    const exact = editedPaths.get(key), folded = (windowsPath(document.path) ? foldedEdits : windowsEdits).get(key.toLowerCase());
    const producer = folded && (!exact || (folded.at ?? -Infinity) >= (exact.at ?? -Infinity)) ? folded : exact;
    const phase = producer?.phase ?? phaseAt(time(document.pinnedAt), allPhases.length - 1) - graph.hiddenPhases;
    if (phase < 0 || phase >= graph.phases.length) continue;
    output({ id: `outputs:document:${key}`, laneId: 'outputs', kind: 'document', label: document.title || document.path.replace(/\\/g, '/').split('/').at(-1)!,
      path: document.path.replace(/\\/g, '/'), status: 'done', phase, at: time(document.pinnedAt), sequence: 0, sessionId: rootSessionId, parts: [] }, producer);
  }
  graph.lanes.push({ id: 'outputs', kind: 'outputs', title: copy('Outputs', '产出'),
    subtitle: copy(`${outputs.length} ${outputs.length === 1 ? 'output' : 'outputs'}`, `${outputs.length} 项产出`), depth: 0 });
  // An old delegation without any visible activity must not leave an empty lane.
  const needed = new Set(graph.nodes.map(node => node.laneId));
  needed.add(`agent:${rootSessionId}`); needed.add('outputs');
  graph.lanes = graph.lanes.filter(lane => needed.has(lane.id));
  return graph;
}
