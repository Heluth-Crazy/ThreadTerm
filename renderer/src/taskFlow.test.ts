import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { taskMapFixture } from './fixtures/taskMapFixtures';
import { buildTaskMap } from './taskMap';
import { TASK_FLOW_METRICS, flattenTaskFlow, taskFlowAutoOpen, taskFlowIndex, taskFlowInView, taskFlowMarkedRows, taskFlowOffsets, taskFlowStickyTurn, taskFlowSummary, taskFlowWindow } from './taskFlow';
import type { ChatViewState, TaskFlowExpansion, TaskMapGraph, TaskMapInput, TaskMapNode } from './taskMapTypes';

const input = (name: Parameters<typeof taskMapFixture>[0] = 'nested', extra: Partial<TaskMapInput> = {}): TaskMapInput => ({ ...taskMapFixture(name), copy: en => en, zh: false, ...extra });
const expansion = (extra: Partial<TaskFlowExpansion> = {}): TaskFlowExpansion => ({ mode: 'default', open: new Set(), closed: new Set(), ...extra });
const partNode = (graph: TaskMapGraph, itemId: string): TaskMapNode => {
  const node = graph.nodes.find(node => node.parts.some(ref => ref.itemId === itemId));
  assert.ok(node, itemId); return node;
};
const turn = (graph: TaskMapGraph, phase: number): string => `turn:${graph.phases[phase]!.id}`;
const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 21, 12) + seconds * 1_000).toISOString();
const item = (id: string, seconds: number, role: ChatItem['role'], parts: ChatPart[], turnId = 't'): ChatItem => ({ id, createdAt: at(seconds), role, parts, turnId });
const text = (value: string): ChatPart => ({ type: 'text', text: value });
const tool = (toolId?: string): ChatPart => ({ type: 'tool', toolName: 'Read', ...(toolId ? { toolId } : {}), status: 'completed', data: { input: { file_path: 'a.ts' } } });
const state = (sessionId: string, extra: Partial<ChatViewState> = {}): ChatViewState => ({ sessionId, items: [], tools: [], turns: [], following: false, ...extra });

test('default opens the last and live turns, counts folded steps, and honors explicit precedence', () => {
  const graph = buildTaskMap(input());
  const all = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  const normal = flattenTaskFlow(graph, expansion());
  assert.equal(normal.rows.find(row => row.key === turn(graph, 0))!.expanded, false);
  assert.equal(normal.rows.find(row => row.key === turn(graph, 2))!.expanded, true);
  const hidden = normal.rows[0]!.hidden!;
  const firstSteps = all.rows.filter(row => row.kind === 'step' && row.phase === 0);
  assert.equal(hidden.steps, firstSteps.length);
  assert.equal(hidden.delegates, firstSteps.filter(row => ['delegate', 'subagent'].includes(graph.nodes.find(node => node.id === row.nodeId)!.kind)).length);
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'none' })).rows.length, graph.phases.length);
  for (const status of ['running', 'waiting'] as const) {
    graph.phases[0]!.status = status;
    assert.equal(flattenTaskFlow(graph, expansion()).rows[0]!.expanded, true);
  }
  const key = turn(graph, 0);
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'none', auto: new Set([key]) })).rows[0]!.expanded, true);
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'none', open: new Set([key]) })).rows[0]!.expanded, true);
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'all', open: new Set([key]), auto: new Set([key]), closed: new Set([key]) })).rows[0]!.expanded, false);
});

test('prompt rows are represented by their enclosing turn and delegate rows', () => {
  const graph = buildTaskMap(input()), flow = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  const rootPrompt = partNode(graph, 'root-prompt-1'), childPrompt = partNode(graph, 'claude-prompt'), start = partNode(graph, 'root-delegate-claude');
  assert.ok(!flow.rows.some(row => row.nodeId === rootPrompt.id));
  assert.ok(!flow.rows.some(row => row.nodeId === childPrompt.id));
  assert.deepEqual(flow.ancestors.get(rootPrompt.id), [turn(graph, 0)]);
  assert.deepEqual(flow.ancestors.get(childPrompt.id), [turn(graph, 0), start.id]);
  assert.equal(flow.ancestors.size, graph.nodes.length, 'every node, including outputs and skipped prompts, has ancestors');
});

test('nested delegates stay under their start turn, and only delegates with visible children expand', () => {
  const graph = buildTaskMap(input()), start = partNode(graph, 'root-delegate-claude');
  const nested = partNode(graph, 'claude-delegate-grok'), grandchild = partNode(graph, 'grok-command'), later = partNode(graph, 'claude-later-edit');
  assert.equal(later.phase, 1);
  const all = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  assert.equal(all.rows.find(row => row.nodeId === grandchild.id)!.depth, 2);
  assert.equal(all.rows.find(row => row.nodeId === later.id)!.phase, 0);
  assert.deepEqual(all.ancestors.get(grandchild.id), [turn(graph, 0), start.id, nested.id]);
  const folded = flattenTaskFlow(graph, expansion({ mode: 'all', closed: new Set([start.id]) }));
  const row = folded.rows.find(row => row.key === start.id)!;
  assert.ok(row.expandable); assert.equal(row.expanded, false);
  assert.equal(row.hidden!.steps, all.rows.filter(row => row.kind === 'step' && all.ancestors.get(row.key)?.includes(start.id)).length);
  assert.ok(!folded.rows.some(row => row.key === later.id));
  const childLane = graph.lanes.find(lane => lane.sessionId === 'claude')!;
  for (const status of ['running', 'waiting', 'failed'] as const) {
    childLane.status = status;
    assert.equal(flattenTaskFlow(graph, expansion({ open: new Set([turn(graph, 0)]) })).rows.find(row => row.key === start.id)!.expanded, true);
  }
  const emptyGraph = buildTaskMap(input('delegation'));
  const emptyStart = partNode(emptyGraph, 'root-delegate-kimi');
  emptyGraph.nodes = emptyGraph.nodes.filter(node => node.sessionId !== 'kimi' || node.kind === 'prompt');
  assert.equal(flattenTaskFlow(emptyGraph, expansion({ mode: 'all' })).rows.find(row => row.key === emptyStart.id)!.expandable, undefined);
});

test('native subagents follow same-phase anchors and otherwise append to the parent phase block', () => {
  const graph = buildTaskMap(input('delegation'));
  const native = graph.nodes.find(node => node.kind === 'subagent')!;
  const edge = graph.edges.find(edge => edge.kind === 'delegate' && edge.to === native.id)!;
  const anchor = graph.nodes.find(node => node.id === edge.from)!;
  let flow = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  const anchorIndex = flow.rows.findIndex(row => row.key === anchor.id);
  assert.equal(flow.rows[anchorIndex + 1]!.key, native.id);
  assert.equal(flow.rows[anchorIndex + 1]!.depth, 1);
  assert.equal(flow.rows[anchorIndex + 1]!.expandable, undefined);
  edge.from = partNode(graph, 'root-prompt-2').id;
  flow = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  const nativeIndex = flow.rows.findIndex(row => row.key === native.id);
  assert.ok(nativeIndex > flow.rows.findIndex(row => row.key === partNode(graph, 'root-answer-1').id));
  assert.equal(flow.rows[nativeIndex]!.phase, 0);
  const data = input('single');
  data.items = new Map([['root', [item('native-only', 1, 'assistant', [{ type: 'subagent', data: {
    key: 'first', provider: 'claude', status: 'completed', transcript: 'none', startedAt: at(1), endedAt: at(2),
  } }])]]]);
  const first = buildTaskMap(data), firstFlow = flattenTaskFlow(first, expansion());
  assert.equal(firstFlow.rows[1]!.nodeId, first.nodes.find(node => node.kind === 'subagent')!.id);
});

test('files follow their lane block, documents follow producers, and unattached outputs end the root block', () => {
  const graph = buildTaskMap(input()), flow = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  const edit = partNode(graph, 'root-edits');
  const document = graph.nodes.find(node => node.kind === 'document' && node.path === 'docs/plan.md')!;
  assert.equal(flow.rows[flow.rows.findIndex(row => row.key === edit.id) + 1]!.key, document.id);
  const childFile = graph.nodes.find(node => node.kind === 'files' && node.sessionId === 'claude' && node.phase === 1)!;
  const childReply = partNode(graph, 'claude-later-answer');
  assert.equal(flow.rows[flow.rows.findIndex(row => row.key === childReply.id) + 1]!.key, childFile.id);
  assert.equal(flow.rows.find(row => row.key === childFile.id)!.depth, 1);
  assert.equal(flow.rows.find(row => row.key === childFile.id)!.phase, 0);
  const rootFile = graph.nodes.find(node => node.kind === 'files' && node.sessionId === 'root' && node.phase === 0)!;
  assert.equal(flow.rows[flow.rows.findIndex(row => row.key === partNode(graph, 'root-answer-1').id) + 1]!.key, rootFile.id);
  const loose = graph.nodes.find(node => node.kind === 'document' && node.path === 'docs/notes.md')!;
  assert.equal(flow.rows[flow.rows.findIndex(row => row.key === turn(graph, 2)) - 1]!.key, loose.id);
  const orphan = partNode(graph, 'unanchored-read');
  assert.equal(flow.rows.find(row => row.key === orphan.id)!.depth, 1);
  assert.deepEqual(flow.ancestors.get(orphan.id), [turn(graph, 1)]);
  assert.ok(flow.rows.findIndex(row => row.key === orphan.id) > flow.rows.findIndex(row => row.key === partNode(graph, 'root-answer-2').id));
  const noProducer: TaskMapNode = { id: 'loose-files', kind: 'files', laneId: 'outputs', label: 'files', status: 'done', phase: 0, sequence: 100, parts: [], count: 3 };
  graph.nodes.push(noProducer);
  const again = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  assert.equal(again.rows[again.rows.findIndex(row => row.key === turn(graph, 1)) - 1]!.key, noProducer.id);
});

test('details are directly after an emitted step and disappear when its ancestors fold', () => {
  const graph = buildTaskMap(input()), node = partNode(graph, 'claude-read');
  const all = flattenTaskFlow(graph, expansion({ mode: 'all', details: node.id }));
  const index = all.rows.findIndex(row => row.key === node.id), details = all.rows[index + 1]!;
  assert.deepEqual(details, { key: `details:${node.id}`, kind: 'details', phase: 0, depth: 1, nodeId: node.id });
  assert.ok(!flattenTaskFlow(graph, expansion({ mode: 'none', details: node.id })).rows.some(row => row.kind === 'details'));
  const producer = partNode(graph, 'root-edits');
  const withDocument = flattenTaskFlow(graph, expansion({ mode: 'all', details: producer.id }));
  assert.equal(withDocument.rows[withDocument.rows.findIndex(row => row.key === producer.id) + 1]!.kind, 'details');
});

test('bars overlap, clamp to the enclosing turn, and require a usable span and branch times', () => {
  const graph = buildTaskMap(input()), start = partNode(graph, 'root-delegate-claude'), other = partNode(graph, 'root-delegate-kimi');
  const flow = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  const a = flow.rows.find(row => row.key === start.id)!, b = flow.rows.find(row => row.key === other.id)!;
  assert.ok(a.bar && b.bar);
  assert.ok(a.bar.start < b.bar.start && b.bar.start < a.bar.end);
  assert.equal(a.bar.end, 1, 'cross-turn work is clamped');
  assert.equal(a.durationMs, 80_000);
  assert.equal(flow.rows[0]!.durationMs, graph.phases[0]!.elapsedMs);
  const native = graph.nodes.find(node => node.kind === 'subagent')!;
  assert.equal(flow.rows.find(row => row.key === native.id)!.durationMs, 16_000);
  start.at = graph.phases[0]!.startedAt! - 10;
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'all' })).rows.find(row => row.key === start.id)!.bar!.start, 0);
  start.at = undefined;
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'all' })).rows.find(row => row.key === start.id)!.bar, undefined);
  for (const node of graph.nodes) if (node.laneId === 'agent:kimi') node.at = undefined;
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'all' })).rows.find(row => row.key === other.id)!.bar, undefined);
  graph.phases[0]!.startedAt = undefined;
  assert.equal(flattenTaskFlow(graph, expansion({ mode: 'all' })).rows.find(row => row.key === native.id)!.bar, undefined);
});

test('running subagents use the deterministic span end, completed agents without duration get no bar', () => {
  const graph = buildTaskMap(input('delegation')), native = graph.nodes.find(node => node.kind === 'subagent')!;
  native.status = 'running'; native.subagent = { ...native.subagent!, status: 'running', endedAt: undefined };
  let row = flattenTaskFlow(graph, expansion({ mode: 'all' })).rows.find(row => row.key === native.id)!;
  assert.equal(row.bar!.end, 1); assert.equal(row.durationMs, undefined);
  native.status = 'done'; native.subagent = { ...native.subagent, status: 'completed', startedAt: undefined };
  row = flattenTaskFlow(graph, expansion({ mode: 'all' })).rows.find(row => row.key === native.id)!;
  assert.equal(row.bar, undefined);
});

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

test('empty parent lanes do not hide descendants or leave any graph nodes without ancestors', () => {
  const graph = buildTaskMap(input());
  graph.nodes = graph.nodes.filter(node => node.laneId !== 'agent:claude');
  const removed = new Set(graph.edges.filter(edge => !graph.nodes.some(node => node.id === edge.from)).map(edge => edge.id));
  graph.edges = graph.edges.filter(edge => !removed.has(edge.id));
  graph.lanes = graph.lanes.filter(lane => lane.id !== 'agent:claude');
  const flow = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  assert.equal(flow.ancestors.size, graph.nodes.length);
  assert.ok(flow.rows.some(row => row.nodeId === partNode(graph, 'grok-command').id));
});

test('Chat marks present rows, innermost emitted ancestors and otherwise phase-only turn rows', () => {
  const data = input(), graph = buildTaskMap(data), index = taskFlowIndex(graph, data.items);
  const nestedStart = partNode(graph, 'claude-delegate-grok'), start = partNode(graph, 'root-delegate-claude'), node = partNode(graph, 'grok-command');
  const visible = taskFlowInView(index, [state('grok', { items: ['grok-command'] }), state('root', { turns: ['root-prompt-2'] })]);
  assert.ok(visible.nodes.has(node.id)); assert.ok(visible.phases.has(1));
  const toolVisible = taskFlowInView(index, [state('root', { tools: ['start-claude'] })]);
  assert.ok(toolVisible.nodes.has(start.id));
  const open = flattenTaskFlow(graph, expansion({ mode: 'all' }));
  assert.deepEqual(taskFlowMarkedRows(open, visible), new Set([node.id, turn(graph, 1)]));
  const folded = flattenTaskFlow(graph, expansion({ mode: 'all', closed: new Set([nestedStart.id]) }));
  assert.deepEqual(taskFlowMarkedRows(folded, visible), new Set([nestedStart.id, turn(graph, 1)]));
  const closed = flattenTaskFlow(graph, expansion({ mode: 'none' }));
  assert.deepEqual(taskFlowMarkedRows(closed, visible), new Set([turn(graph, 0), turn(graph, 1)]));
  const prompt = partNode(graph, 'root-prompt-1');
  assert.deepEqual(taskFlowMarkedRows(open, { nodes: new Set([prompt.id]), phases: new Set([0]) }), new Set([turn(graph, 0)]));
  assert.deepEqual(taskFlowAutoOpen(closed, visible), new Set([turn(graph, 0), turn(graph, 1), start.id, nestedStart.id]));
});

test('Chat auto-open limits turns in phase order, while retaining all ancestors in those turns', () => {
  const graph = buildTaskMap(input('long', { maxPhases: 200 })), flow = flattenTaskFlow(graph, expansion({ mode: 'none' }));
  const phases = new Set([8, 5, 2, 1, 7]);
  assert.deepEqual(taskFlowAutoOpen(flow, { nodes: new Set(), phases }), new Set([turn(graph, 1), turn(graph, 2), turn(graph, 5)]));
  assert.equal(taskFlowAutoOpen(flow, { nodes: new Set(), phases }, 0).size, 0);
});

test('offsets, windows and sticky turns handle measurements, empty content and scroll boundaries', () => {
  const graph = buildTaskMap(input('single')), reply = partNode(graph, 'single-answer');
  const flow = flattenTaskFlow(graph, expansion({ details: reply.id }));
  const offsets = taskFlowOffsets(flow.rows, new Map([[`details:${reply.id}`, 123]]));
  assert.deepEqual(offsets, { tops: [0, 36, 68], total: 191 });
  assert.equal(taskFlowOffsets(flow.rows, new Map()).total, 68 + TASK_FLOW_METRICS.detailsEstimate);
  assert.deepEqual(taskFlowOffsets([], new Map()), { tops: [], total: 0 });
  assert.deepEqual(taskFlowWindow([], 0, 100, 300), { start: 0, end: 0 });
  assert.deepEqual(taskFlowWindow(offsets.tops, offsets.total, 0, 1000, 0), { start: 0, end: 3 });
  assert.deepEqual(taskFlowWindow(offsets.tops, offsets.total, 36, 32, 0), { start: 1, end: 2 });
  assert.deepEqual(taskFlowWindow(offsets.tops, offsets.total, 2000, 20), { start: 3, end: 3 });
  assert.equal(taskFlowStickyTurn(flow.rows, offsets.tops, 0), undefined);
  assert.equal(taskFlowStickyTurn(flow.rows, offsets.tops, 1), 0);
  assert.equal(taskFlowStickyTurn(flow.rows, offsets.tops, 68), 0);
  assert.equal(taskFlowStickyTurn([], [], 100), undefined);
  const earlier = buildTaskMap(input('long', { maxPhases: 2 })), folded = flattenTaskFlow(earlier, expansion({ mode: 'none' }));
  const tops = taskFlowOffsets(folded.rows, new Map()).tops;
  assert.equal(folded.rows[0]!.kind, 'earlier');
  assert.equal(taskFlowStickyTurn(folded.rows, tops, 10), undefined);
  assert.equal(taskFlowStickyTurn(folded.rows, tops, 36), undefined);
  assert.equal(taskFlowStickyTurn(folded.rows, tops, 37), 1);
  assert.equal(taskFlowStickyTurn(folded.rows, tops, 72), undefined);
  assert.equal(taskFlowStickyTurn(folded.rows, tops, 73), 2);
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

test('200-turn flatten plus Chat index stays under 60 ms median, excluding graph construction', () => {
  const data = input('long', { maxPhases: 200 }), graph = buildTaskMap(data), all = expansion({ mode: 'all' });
  const samples: number[] = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const flow = flattenTaskFlow(graph, all), index = taskFlowIndex(graph, data.items);
    samples.push(performance.now() - start);
    assert.equal(flow.ancestors.size, graph.nodes.length);
    assert.ok(index.tools.size >= 3000);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[2]! < 60, `median ${samples[2]!.toFixed(1)} ms`);
});
