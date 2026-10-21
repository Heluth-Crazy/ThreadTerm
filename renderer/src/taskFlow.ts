import type { ChatItem } from '@threadterm/protocol';
import { groupCodexTranscript } from './codexTranscript';
import type { ChatViewState, TaskFlowIndex, TaskFlowInView, TaskFlowSummary, TaskMapGraph } from './taskMapTypes';

const append = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const values = map.get(key);
  if (values) values.push(value); else map.set(key, [value]);
};
const dated = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

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

export function taskFlowSummary(graph: TaskMapGraph): TaskFlowSummary {
  const counts = new Map<string, number>();
  for (const lane of graph.lanes) if (lane.kind !== 'outputs') { const provider = lane.provider ?? ''; counts.set(provider, (counts.get(provider) ?? 0) + 1); }
  let durationMs: number | undefined;
  for (const phase of graph.phases) if (dated(phase.elapsedMs)) durationMs = (durationMs ?? 0) + phase.elapsedMs;
  return { agents: [...counts].map(([provider, count]) => ({ provider, count })), turns: graph.phases.length,
    steps: graph.nodes.filter(node => node.kind !== 'prompt' && node.kind !== 'files' && node.kind !== 'document').length,
    fileChanges: graph.nodes.reduce((sum, node) => sum + (node.kind === 'files' ? node.count ?? 0 : 0), 0), durationMs };
}
