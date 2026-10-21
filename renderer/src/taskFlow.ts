import type { ChatItem } from '@threadterm/protocol';
import { groupCodexTranscript } from './codexTranscript';
import { elapsedMs } from './subagentActivity';
import type { ChatViewState, TaskFlow, TaskFlowExpansion, TaskFlowIndex, TaskFlowInView, TaskFlowMetrics, TaskFlowRow, TaskFlowSummary, TaskMapGraph, TaskMapLane, TaskMapNode } from './taskMapTypes';

export const TASK_FLOW_METRICS: TaskFlowMetrics = { turnHeight: 36, stepHeight: 32, earlierHeight: 36, detailsEstimate: 200, indent: 16 };

interface Position { node: TaskMapNode; row: TaskFlowRow; ancestors: string[]; skipped: boolean }
const turnKey = (id: string): string => `turn:${id}`;
const append = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const values = map.get(key);
  if (values) values.push(value); else map.set(key, [value]);
};
const dated = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

/** Assign every node a position before folding, so Chat sync can still find hidden work. */
export function flattenTaskFlow(graph: TaskMapGraph, expansion: TaskFlowExpansion): TaskFlow {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const laneNodes = new Map<string, TaskMapNode[]>();
  for (const node of graph.nodes) append(laneNodes, node.laneId, node);
  for (const list of laneNodes.values()) list.sort((a, b) => a.sequence - b.sequence);
  const root = graph.lanes.find(lane => lane.kind === 'agent' && lane.sessionId === graph.rootSessionId);
  const rootPhases = new Map<string, TaskMapNode[]>();
  for (const node of laneNodes.get(root?.id ?? '') ?? []) append(rootPhases, String(node.phase), node);
  const sessionLanes = new Map(graph.lanes.filter(lane => lane.kind === 'delegate' || lane.kind === 'agent').map(lane => [lane.sessionId, lane]));
  const starts = new Map<string, TaskMapLane[]>(), attached = new Set<string>();
  const producers = new Map<string, TaskMapNode>();
  for (const node of graph.nodes) if (node.kind === 'delegate' && node.childSessionId) {
    const lane = sessionLanes.get(node.childSessionId);
    if (lane && lane.id !== root?.id && lane.parentLaneId === node.laneId && !attached.has(lane.id)) {
      append(starts, node.id, lane); attached.add(lane.id);
    }
  }
  for (const edge of graph.edges) {
    const source = nodes.get(edge.from), target = nodes.get(edge.to);
    if (edge.kind === 'produce' && source && target) producers.set(target.id, source);
  }
  const lanes = new Map(graph.lanes.map(lane => [lane.id, lane]));
  for (const edge of graph.edges) if (edge.kind === 'delegate') {
    const anchor = nodes.get(edge.from), node = nodes.get(edge.to);
    const lane = node && lanes.get(node.laneId);
    if (anchor && node?.kind === 'subagent' && lane?.parentLaneId === anchor.laneId && node.phase === anchor.phase && !attached.has(lane.id)) {
      append(starts, anchor.id, lane); attached.add(lane.id);
    }
  }
  const unanchored = new Map<string, TaskMapLane[]>(), unanchoredByParent = new Map<string, TaskMapLane[]>();
  for (const lane of graph.lanes) if (lane.parentLaneId && !attached.has(lane.id) && lane.kind !== 'outputs') {
    const first = laneNodes.get(lane.id)?.[0];
    if (first) { append(unanchored, `${lane.parentLaneId}\n${first.phase}`, lane); append(unanchoredByParent, lane.parentLaneId, lane); }
  }
  const documents = new Map<string, TaskMapNode[]>(), files = new Map<string, TaskMapNode[]>(), loose = new Map<string, TaskMapNode[]>();
  for (const node of graph.nodes) if (node.kind === 'files' || node.kind === 'document') {
    const producer = producers.get(node.id);
    if (!producer) append(loose, String(node.phase), node);
    else if (node.kind === 'document') append(documents, producer.id, node);
    else append(files, `${producer.laneId}\n${node.phase}`, node);
  }
  const positions: Position[][] = graph.phases.map(() => []);
  const ancestors = new Map<string, string[]>(), seen = new Set<string>(), seenLanes = new Set<string>();
  const placeOutput = (node: TaskMapNode, phase: number, depth: number, enclosing: string[]) => {
    if (seen.has(node.id)) return;
    seen.add(node.id); ancestors.set(node.id, enclosing);
    positions[phase]!.push({ node, ancestors: enclosing, skipped: false, row: { key: node.id, kind: 'step', nodeId: node.id, phase, depth } });
  };
  const visitLane = (lane: TaskMapLane, phase: number, depth: number, enclosing: string[], onlyPhase?: number): number => {
    if (seenLanes.has(lane.id) && onlyPhase === undefined) return 0;
    if (onlyPhase === undefined) seenLanes.add(lane.id);
    const all = laneNodes.get(lane.id) ?? [];
    const list = onlyPhase === undefined ? all : rootPhases.get(String(onlyPhase)) ?? [];
    const last = new Map<number, TaskMapNode>();
    for (const node of list) last.set(node.phase, node);
    const before = positions[phase]!.length;
    for (const node of list) {
      if (seen.has(node.id)) continue;
      seen.add(node.id); ancestors.set(node.id, enclosing);
      const skipped = node.kind === 'prompt' && (lane.id === root?.id
        ? node.parts[0]?.itemId === graph.phases[phase]!.promptItemId
        : node === all[0]);
      const row: TaskFlowRow = { key: node.id, kind: 'step', phase, depth, nodeId: node.id };
      positions[phase]!.push({ node, row, ancestors: enclosing, skipped });
      for (const output of documents.get(node.id) ?? []) placeOutput(output, phase, depth, enclosing);
      for (const child of starts.get(node.id) ?? []) {
        const delegate = child.kind !== 'subagent';
        const count = visitLane(child, phase, depth + 1, delegate ? [...enclosing, node.id] : enclosing);
        if (delegate && count > 0) { row.expandable = true; row.expanded = isOpen(node.id, false, child.status); }
      }
      if (last.get(node.phase) === node) {
        for (const child of unanchored.get(`${lane.id}\n${node.phase}`) ?? []) visitLane(child, phase, depth + 1, enclosing);
        if (lane.id !== root?.id) for (const output of files.get(`${lane.id}\n${node.phase}`) ?? []) placeOutput(output, phase, depth, enclosing);
      }
    }
    // A parent can have no own steps in the phase where an unanchored child appeared.
    for (const child of unanchoredByParent.get(lane.id) ?? []) {
      const childPhase = laneNodes.get(child.id)![0]!.phase;
      if (!last.has(childPhase) && (onlyPhase === undefined || childPhase === onlyPhase)) visitLane(child, phase, depth + 1, enclosing);
    }
    let count = 0;
    for (let index = before; index < positions[phase]!.length; index++) if (!positions[phase]![index]!.skipped) count++;
    return count;
  };
  function isOpen(key: string, turn: boolean, status?: string, phase?: number): boolean {
    if (expansion.closed.has(key)) return false;
    if (expansion.open.has(key) || expansion.auto?.has(key)) return true;
    if (expansion.mode !== 'default') return expansion.mode === 'all';
    return status === 'running' || status === 'waiting' || (turn ? phase === graph.phases.length - 1 : status === 'failed');
  }
  for (let phase = 0; phase < graph.phases.length; phase++) {
    const enclosing = [turnKey(graph.phases[phase]!.id)];
    if (root) visitLane(root, phase, 0, enclosing, phase);
  }
  // The graph can omit an empty parent lane when only its descendants have visible history.
  for (const lane of graph.lanes) if (lane.kind !== 'outputs' && lane.id !== root?.id) {
    const first = laneNodes.get(lane.id)?.find(node => !seen.has(node.id));
    if (first && graph.phases[first.phase]) visitLane(lane, first.phase, lane.depth, [turnKey(graph.phases[first.phase]!.id)]);
  }
  for (let phase = 0; phase < graph.phases.length; phase++) {
    const enclosing = [turnKey(graph.phases[phase]!.id)];
    for (const output of files.get(`${root?.id}\n${phase}`) ?? []) placeOutput(output, phase, 0, enclosing);
    for (const output of loose.get(String(phase)) ?? []) placeOutput(output, phase, 0, enclosing);
  }
  const rows: TaskFlowRow[] = [];
  if (graph.hiddenPhases > 0) rows.push({ key: 'earlier', kind: 'earlier', phase: -1, depth: 0 });
  for (let phase = 0; phase < graph.phases.length; phase++) {
    const info = graph.phases[phase]!, block = positions[phase]!;
    const key = turnKey(info.id), expanded = isOpen(key, true, info.status, phase);
    const turn: TaskFlowRow = { key, kind: 'turn', phase, phaseId: info.id, depth: 0, expandable: true, expanded, durationMs: info.elapsedMs };
    const counts = new Map<string, { steps: number; delegates: number }>();
    let maximum: number | undefined;
    for (const position of block) {
      if (dated(position.node.at)) maximum = Math.max(maximum ?? -Infinity, position.node.at);
      if (position.skipped) continue;
      for (const ancestor of position.ancestors) {
        const count = counts.get(ancestor) ?? { steps: 0, delegates: 0 };
        count.steps++; if (position.node.kind === 'delegate' || position.node.kind === 'subagent') count.delegates++;
        counts.set(ancestor, count);
      }
    }
    const end = graph.phases[phase + 1]?.startedAt ?? maximum;
    const start = info.startedAt;
    const bar = (from: number | undefined, to: number | undefined): TaskFlowRow['bar'] => {
      if (!dated(start) || !dated(end) || end <= start || !dated(from) || !dated(to)) return undefined;
      const fraction = (value: number) => Math.max(0, Math.min(1, (value - start) / (end - start)));
      return { start: fraction(from), end: fraction(Math.max(from, to)) };
    };
    if (!expanded) turn.hidden = counts.get(key) ?? { steps: 0, delegates: 0 };
    rows.push(turn);
    const open = new Map<string, boolean>([[key, expanded]]);
    for (const { node, row, ancestors: enclosing, skipped } of block) {
      if (row.expandable) {
        open.set(row.key, !!row.expanded);
        if (!row.expanded) row.hidden = counts.get(row.key) ?? { steps: 0, delegates: 0 };
      }
      if (node.kind === 'delegate') {
        let last: number | undefined;
        for (const child of laneNodes.get(sessionLanes.get(node.childSessionId)?.id ?? '') ?? []) if (dated(child.at)) last = Math.max(last ?? -Infinity, child.at);
        if (dated(last) && dated(node.at)) last = Math.max(node.at, last);
        row.bar = bar(node.at, last);
        if (dated(node.at) && dated(last) && last > node.at) row.durationMs = last - node.at;
      } else if (node.kind === 'subagent') {
        const duration = node.subagent ? elapsedMs(node.subagent, Number.NaN) : undefined;
        row.durationMs = duration;
        row.bar = bar(node.at, dated(duration) && dated(node.at) ? node.at + duration : node.status === 'running' ? end : undefined);
      }
      if (skipped || enclosing.some(ancestor => open.get(ancestor) === false)) continue;
      rows.push(row);
      if (expansion.details === node.id) rows.push({ key: `details:${node.id}`, kind: 'details', phase, depth: row.depth, nodeId: node.id });
    }
  }
  return { rows, ancestors };
}

export function taskFlowOffsets(rows: readonly TaskFlowRow[], measured: ReadonlyMap<string, number>, metrics = TASK_FLOW_METRICS): { tops: number[]; total: number } {
  const tops: number[] = [];
  let total = 0;
  for (const row of rows) {
    tops.push(total);
    total += row.kind === 'turn' ? metrics.turnHeight : row.kind === 'earlier' ? metrics.earlierHeight : row.kind === 'step' ? metrics.stepHeight : measured.get(row.key) ?? metrics.detailsEstimate;
  }
  return { tops, total };
}

function upperBound(values: readonly number[], value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid]! <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

export function taskFlowWindow(tops: readonly number[], total: number, scrollTop: number, viewportHeight: number, overscan = 240): { start: number; end: number } {
  if (!tops.length) return { start: 0, end: 0 };
  const low = Math.max(0, scrollTop - Math.max(0, overscan));
  const high = Math.max(low, scrollTop + Math.max(0, viewportHeight) + Math.max(0, overscan));
  if (low >= total) return { start: tops.length, end: tops.length };
  const start = Math.max(0, upperBound(tops, low) - 1);
  let end = upperBound(tops, high);
  if (end > 0 && tops[end - 1] === high) end--;
  return { start, end: Math.max(start, end) };
}

export function taskFlowStickyTurn(rows: readonly TaskFlowRow[], tops: readonly number[], scrollTop: number): number | undefined {
  let index = Math.min(rows.length, upperBound(tops, scrollTop)) - 1;
  while (index >= 0 && rows[index]?.kind !== 'turn') index--;
  return index >= 0 && tops[index]! < scrollTop ? index : undefined;
}

export function taskFlowIndex(graph: TaskMapGraph, items: ReadonlyMap<string, readonly ChatItem[]>): TaskFlowIndex {
  const result: TaskFlowIndex = { items: new Map(), tools: new Map(), phases: new Map(), targets: new Map() };
  const sessions = new Map<string, Map<string, ChatItem>>(), turns = new Map<string, Map<string, string>>();
  for (const [sessionId, list] of items) {
    const byId = new Map<string, ChatItem>(), firstItems = new Map<string, string>();
    // `turnItemId` is the Chat's own section id (`data-chat-turn`), from the grouping ChatView renders.
    for (const group of groupCodexTranscript([...list])) for (const item of group.items) firstItems.set(item.id, group.id);
    let phase = -1, started = false;
    for (const item of list) {
      // Phases follow buildTaskMap's root rule: a new phase at each user item (the first may start without one).
      if (!started || item.role === 'user') phase++;
      started = true;
      byId.set(item.id, item);
      const shown = phase - graph.hiddenPhases;
      if (sessionId === graph.rootSessionId && shown >= 0 && shown < graph.phases.length) result.phases.set(item.id, shown);
    }
    sessions.set(sessionId, byId); turns.set(sessionId, firstItems);
  }
  for (const node of graph.nodes) {
    if (!node.sessionId || !node.parts.length) continue;
    const sessionId = node.sessionId, byId = sessions.get(sessionId), seenItems = new Set<string>(), seenTools = new Set<string>();
    for (const ref of node.parts) {
      if (!seenItems.has(ref.itemId)) { append(result.items, `${sessionId}\n${ref.itemId}`, node.id); seenItems.add(ref.itemId); }
      const part = byId?.get(ref.itemId)?.parts[ref.partIndex];
      if (part?.type === 'tool') {
        const id = part.toolId || `${ref.itemId}:part:${ref.partIndex}`;
        if (!seenTools.has(id)) { append(result.tools, `${sessionId}\n${id}`, node.id); seenTools.add(id); }
      }
    }
    const first = node.parts[0]!, part = byId?.get(first.itemId)?.parts[first.partIndex];
    result.targets.set(node.id, { sessionId, itemId: first.itemId, turnItemId: turns.get(sessionId)?.get(first.itemId),
      ...(part?.type === 'tool' ? { toolId: part.toolId || `${first.itemId}:part:${first.partIndex}` } : {}) });
  }
  return result;
}

export function taskFlowInView(index: TaskFlowIndex, states: readonly ChatViewState[]): TaskFlowInView {
  const result: TaskFlowInView = { nodes: new Set(), phases: new Set() };
  for (const state of states) {
    for (const id of state.items) for (const node of index.items.get(`${state.sessionId}\n${id}`) ?? []) result.nodes.add(node);
    for (const id of state.tools) for (const node of index.tools.get(`${state.sessionId}\n${id}`) ?? []) result.nodes.add(node);
    for (const id of [...state.items, ...state.turns]) { const phase = index.phases.get(id); if (phase !== undefined) result.phases.add(phase); }
  }
  return result;
}

export function taskFlowMarkedRows(flow: TaskFlow, inView: TaskFlowInView): Set<string> {
  const rows = new Map(flow.rows.map(row => [row.key, row])), marked = new Set<string>(), phases = new Set<number>();
  for (const id of inView.nodes) {
    const key = rows.has(id) ? id : [...(flow.ancestors.get(id) ?? [])].reverse().find(ancestor => rows.has(ancestor));
    if (key) { marked.add(key); phases.add(rows.get(key)!.phase); }
  }
  for (const row of flow.rows) if (row.kind === 'turn' && inView.phases.has(row.phase) && !phases.has(row.phase)) marked.add(row.key);
  return marked;
}

export function taskFlowAutoOpen(flow: TaskFlow, inView: TaskFlowInView, limit = 3): Set<string> {
  const wanted = new Set<string>();
  for (const id of inView.nodes) for (const key of flow.ancestors.get(id) ?? []) wanted.add(key);
  for (const row of flow.rows) if (row.kind === 'turn' && inView.phases.has(row.phase)) wanted.add(row.key);
  const turns = new Set(flow.rows.filter(row => row.kind === 'turn' && wanted.has(row.key)).slice(0, Math.max(0, limit)).map(row => row.key));
  const result = new Set(turns);
  for (const id of inView.nodes) {
    const ancestors = flow.ancestors.get(id) ?? [];
    if (ancestors[0] && turns.has(ancestors[0])) for (const key of ancestors) result.add(key);
  }
  return result;
}

export function taskFlowSummary(graph: TaskMapGraph): TaskFlowSummary {
  const counts = new Map<string, number>();
  for (const lane of graph.lanes) if (lane.kind !== 'outputs') { const provider = lane.provider ?? ''; counts.set(provider, (counts.get(provider) ?? 0) + 1); }
  let durationMs: number | undefined;
  for (const phase of graph.phases) if (dated(phase.elapsedMs)) durationMs = (durationMs ?? 0) + phase.elapsedMs;
  return { agents: [...counts].map(([provider, count]) => ({ provider, count })), turns: graph.phases.length,
    steps: graph.nodes.filter(node => node.kind !== 'prompt' && node.kind !== 'files' && node.kind !== 'document').length,
    fileChanges: graph.nodes.reduce((sum, node) => sum + (node.kind === 'files' ? node.count ?? 0 : 0), 0), durationMs };
}
