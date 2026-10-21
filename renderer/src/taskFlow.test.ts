import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { taskMapFixture } from './fixtures/taskMapFixtures';
import { buildTaskMap } from './taskMap';
import { taskFlowIndex, taskFlowInView, taskFlowSummary } from './taskFlow';
import type { ChatViewState, TaskMapGraph, TaskMapInput, TaskMapNode } from './taskMapTypes';

const input = (name: Parameters<typeof taskMapFixture>[0] = 'nested', extra: Partial<TaskMapInput> = {}): TaskMapInput => ({ ...taskMapFixture(name), copy: en => en, zh: false, ...extra });
const partNode = (graph: TaskMapGraph, itemId: string): TaskMapNode => {
  const node = graph.nodes.find(node => node.parts.some(ref => ref.itemId === itemId));
  assert.ok(node, itemId); return node;
};
const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 21, 12) + seconds * 1_000).toISOString();
const item = (id: string, seconds: number, role: ChatItem['role'], parts: ChatPart[], turnId = 't'): ChatItem => ({ id, createdAt: at(seconds), role, parts, turnId });
const text = (value: string): ChatPart => ({ type: 'text', text: value });
const tool = (toolId?: string): ChatPart => ({ type: 'tool', toolName: 'Read', ...(toolId ? { toolId } : {}), status: 'completed', data: { input: { file_path: 'a.ts' } } });
const state = (sessionId: string, extra: Partial<ChatViewState> = {}): ChatViewState => ({ sessionId, items: [], tools: [], turns: [], following: false, ...extra });

test('Chat index covers explicit and fallback tool ids, first-part targets, session turns and hidden phases', () => {
  const data = input('single');
  const list = [item('old', 0, 'user', [text('old')], 'old-turn'), item('old-answer', 1, 'assistant', [text('done')], 'old-turn'),
    item('prompt', 2, 'user', [text('new')], 'new-turn'), item('tools', 3, 'assistant', [tool('explicit'), tool()], 'new-turn'),
    item('commentary', 4, 'assistant', [text('working')], 'new-turn'), item('answer', 5, 'assistant', [text('done')], 'new-turn')];
  data.items = new Map([['root', list]]); data.maxPhases = 1;
  const graph = buildTaskMap(data), index = taskFlowIndex(graph, data.items), tools = partNode(graph, 'tools');
  assert.equal(graph.hiddenPhases, 1);
  assert.deepEqual(index.items.get('root\ntools'), [tools.id]);
  assert.deepEqual(index.tools.get('root\nexplicit'), [tools.id]);
  assert.deepEqual(index.tools.get('root\ntools:part:1'), [tools.id]);
  // The user item is its own Chat section; the assistant items after it form the next one (`data-chat-turn`).
  assert.deepEqual(index.targets.get(tools.id), { sessionId: 'root', itemId: 'tools', toolId: 'explicit', turnItemId: 'tools' });
  assert.deepEqual([...index.phases.keys()], ['prompt', 'tools', 'commentary', 'answer']);
  assert.ok([...index.phases.values()].every(phase => phase === 0));
  const nestedData = input(), nestedGraph = buildTaskMap(nestedData), nestedIndex = taskFlowIndex(nestedGraph, nestedData.items);
  const later = partNode(nestedGraph, 'claude-later-edit');
  assert.equal(nestedIndex.targets.get(later.id)!.turnItemId, 'claude-later-edit');
  assert.ok(!nestedIndex.targets.has(nestedGraph.nodes.find(node => node.kind === 'files')!.id));
  const noPrompt = input('single', { items: new Map([['root', [item('first', 0, 'assistant', [tool()]), item('second', 1, 'assistant', [text('done')])]]]) });
  const noPromptGraph = buildTaskMap(noPrompt), noPromptIndex = taskFlowIndex(noPromptGraph, noPrompt.items);
  assert.equal(noPromptIndex.targets.get(partNode(noPromptGraph, 'first').id)!.turnItemId, 'first');
  assert.equal(noPromptIndex.targets.get(partNode(noPromptGraph, 'first').id)!.toolId, 'first:part:0');
  // Root phases split only at user items (buildTaskMap); a turnId change alone must not shift later phases.
  const drift = input('single', { items: new Map([['root', [item('p1', 0, 'user', [text('one')], 'token-1'), item('a1', 1, 'assistant', [text('done')], 'provider-1'),
    item('p2', 2, 'user', [text('two')], 'token-2'), item('a2', 3, 'assistant', [text('done')], 'provider-2')]]]) });
  const driftGraph = buildTaskMap(drift), driftIndex = taskFlowIndex(driftGraph, drift.items);
  assert.equal(driftGraph.phases.length, 2);
  assert.deepEqual(['p1', 'a1', 'p2', 'a2'].map(id => driftIndex.phases.get(id)), [0, 0, 1, 1]);
  assert.equal(driftIndex.targets.get(partNode(driftGraph, 'a2').id)!.turnItemId, 'a2');
});

test('Chat in-view resolves items, tool ids and root turns across sessions', () => {
  const data = input(), graph = buildTaskMap(data), index = taskFlowIndex(graph, data.items);
  const start = partNode(graph, 'root-delegate-claude'), node = partNode(graph, 'grok-command');
  const visible = taskFlowInView(index, [state('grok', { items: ['grok-command'] }), state('root', { turns: ['root-prompt-2'] })]);
  assert.ok(visible.nodes.has(node.id)); assert.ok(visible.phases.has(1));
  const toolVisible = taskFlowInView(index, [state('root', { tools: ['start-claude'] })]);
  assert.ok(toolVisible.nodes.has(start.id));
  assert.deepEqual(taskFlowInView(index, []), { nodes: new Set(), phases: new Set() });
});

test('summary merges providers in lane order and sums only shown turns, work and files', () => {
  const graph = buildTaskMap(input('delegation')), summary = taskFlowSummary(graph);
  assert.deepEqual(summary.agents, [{ provider: 'codex', count: 2 }, { provider: 'claude', count: 1 }, { provider: 'grok', count: 1 }, { provider: 'kimi', count: 1 }]);
  assert.equal(summary.turns, 3);
  assert.equal(summary.steps, graph.nodes.filter(node => !['prompt', 'files', 'document'].includes(node.kind)).length);
  assert.equal(summary.fileChanges, 4);
  assert.equal(summary.durationMs, 80_000);
  const empty = taskFlowSummary(buildTaskMap(input('empty')));
  assert.equal(empty.durationMs, undefined); assert.equal(empty.steps, 0);
});
