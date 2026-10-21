import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { taskMapFixture, type TaskMapFixtureName } from './fixtures/taskMapFixtures';
import { buildTaskMap } from './taskMap';
import { taskFlowIndex, taskFlowInView } from './taskFlow';
import { TASK_GRAPH_METRICS, layoutTaskGraph, taskGraphAncestors, taskGraphAutoOpen, taskGraphLaneLabels, taskGraphMarked, taskGraphNeighbor, taskGraphOpen, taskGraphRelated, taskGraphStickyBand, taskGraphWindow } from './taskGraph';
import type { ChatViewState, TaskGraphBox, TaskGraphExpansion, TaskGraphLayout, TaskMapGraph, TaskMapInput, TaskMapNode } from './taskMapTypes';

const input = (name: TaskMapFixtureName = 'nested', extra: Partial<TaskMapInput> = {}): TaskMapInput => ({ ...taskMapFixture(name), copy: en => en, zh: false, ...extra });
const expansion = (extra: Partial<TaskGraphExpansion> = {}): TaskGraphExpansion => ({ mode: 'default', open: new Set(), closed: new Set(), ...extra });
const turn = (graph: TaskMapGraph, phase: number): string => `turn:${graph.phases[phase]!.id}`;
const partNode = (graph: TaskMapGraph, itemId: string): TaskMapNode => {
  const node = graph.nodes.find(node => node.parts.some(ref => ref.itemId === itemId));
  assert.ok(node, itemId); return node;
};
const boxFor = (layout: TaskGraphLayout, node: TaskMapNode): TaskGraphBox => {
  const box = layout.boxes.find(box => box.id === layout.boxOf.get(node.id));
  assert.ok(box, node.id); return box;
};
const state = (sessionId: string, extra: Partial<ChatViewState> = {}): ChatViewState => ({ sessionId, items: [], tools: [], turns: [], following: false, ...extra });
const all = (graph: TaskMapGraph, extra: Partial<TaskGraphExpansion> = {}): TaskGraphLayout => layoutTaskGraph(graph, expansion({ mode: 'all', ...extra }), { width: 1440 });
const node = (id: string, laneId = 'agent:root', phase = 0, sequence = 0): TaskMapNode => ({ id, laneId, phase, sequence, kind: 'tools', step: 'explore', label: id, status: 'done', parts: [], at: sequence * 1000 });
const smallGraph = (): TaskMapGraph => ({ rootSessionId: 'root', lanes: [{ id: 'agent:root', kind: 'agent', sessionId: 'root', title: 'Root', depth: 0 }],
  phases: [{ id: 'one', index: 0, label: 'Turn 1', status: 'done' }], nodes: [], edges: [], hiddenPhases: 0 });

test('turn precedence and delegate lane state use the vertical keys', () => {
  const graph = buildTaskMap(input('parallel')), key = turn(graph, 0), lane = 'lane:agent:claude';
  assert.equal(taskGraphOpen(key, graph, expansion()), false);
  assert.equal(taskGraphOpen(turn(graph, 2), graph, expansion()), true);
  assert.equal(taskGraphOpen(key, graph, expansion({ mode: 'none', auto: new Set([key]) })), true);
  assert.equal(taskGraphOpen(key, graph, expansion({ mode: 'none', open: new Set([key]) })), true);
  assert.equal(taskGraphOpen(key, graph, expansion({ mode: 'all', open: new Set([key]), auto: new Set([key]), closed: new Set([key]) })), false);
  assert.equal(taskGraphOpen(lane, graph, expansion({ mode: 'none' })), true);
  assert.equal(taskGraphOpen(lane, graph, expansion({ open: new Set([lane]), auto: new Set([lane]), closed: new Set([lane]) })), false);
  for (const status of ['running', 'waiting'] as const) {
    graph.phases[0]!.status = status;
    assert.equal(taskGraphOpen(key, graph, expansion()), true);
  }
});

test('folded bands keep one box per lane, both files outputs and the document', () => {
  const graph = buildTaskMap(input('parallel')), layout = layoutTaskGraph(graph, expansion({ mode: 'none' }), { width: 1440 });
  const first = layout.boxes.filter(box => box.phase === 0), work = first.filter(box => box.column !== layout.outputsColumn);
  assert.deepEqual(work.map(box => box.laneId), ['agent:root', 'agent:claude', 'agent:kimi']);
  assert.ok(work.every(box => box.kind === 'summary' && box.id === `fold:${box.laneId}:${graph.phases[0]!.id}`));
  assert.equal(new Set(work.map(box => box.row)).size, 1);
  assert.equal(first.filter(box => box.column === layout.outputsColumn).length, 3);
  assert.ok(first.filter(box => box.column === layout.outputsColumn).every(box => box.kind === 'node'));
  for (const laneId of ['agent:claude', 'agent:kimi']) {
    const root = work.find(box => box.laneId === 'agent:root')!, child = work.find(box => box.laneId === laneId)!;
    assert.ok(layout.edges.some(edge => edge.kind === 'delegate' && edge.from === root.id && edge.to === child.id));
    assert.ok(layout.edges.some(edge => edge.kind === 'return' && edge.from === child.id && edge.to === root.id));
  }
  const members = work.flatMap(box => box.members).map(id => graph.nodes.find(node => node.id === id)!);
  assert.equal(layout.bands[0]!.folded!.steps, members.filter(node => node.kind !== 'prompt').length);
  assert.equal(layout.bands[0]!.folded!.delegates, 2);
  assert.equal(boxFor(layout, partNode(graph, 'root-answer-3')).kind, 'summary');
  const single = buildTaskMap(input('single')), singleLayout = layoutTaskGraph(single, expansion({ mode: 'none' }), { width: 700 });
  assert.equal(singleLayout.boxes[0]!.id, partNode(single, 'single-answer').id);
  assert.equal(singleLayout.boxes[0]!.kind, 'node');
});

test('delegate folds merge descendants in each actual phase, preserve outputs and cover every node', () => {
  const graph = buildTaskMap(input()), ancestors = taskGraphAncestors(graph), child = partNode(graph, 'grok-command');
  assert.deepEqual(ancestors.get(child.id), [turn(graph, 0), 'lane:agent:claude', 'lane:agent:grok']);
  assert.deepEqual(ancestors.get(partNode(graph, 'claude-later-edit').id), [turn(graph, 1), 'lane:agent:claude']);
  for (const node of graph.nodes.filter(node => node.kind === 'files' || node.kind === 'document')) assert.deepEqual(ancestors.get(node.id), [turn(graph, node.phase)]);
  const native = graph.nodes.find(node => node.kind === 'subagent')!;
  assert.deepEqual(ancestors.get(native.id), [turn(graph, native.phase)]);
  const layout = all(graph, { closed: new Set(['lane:agent:claude']) });
  const folded = boxFor(layout, child);
  assert.equal(folded.id, `fold:agent:claude:${graph.phases[0]!.id}`);
  assert.equal(folded.laneId, 'agent:claude'); assert.equal(folded.head, true);
  assert.ok(folded.members.includes(partNode(graph, 'claude-read').id));
  assert.ok(!layout.boxes.some(box => box.laneId === 'agent:grok'));
  assert.equal(boxFor(layout, partNode(graph, 'claude-later-edit')).phase, 1);
  assert.equal(layout.boxOf.get(partNode(graph, 'root-prompt-1').id), turn(graph, 0));
  assert.equal(layout.boxOf.size, graph.nodes.length); assert.equal(layout.ancestors.size, graph.nodes.length);
  assert.strictEqual(layoutTaskGraph(graph, expansion(), { width: 700, ancestors }).ancestors, ancestors);
  for (const node of graph.nodes) assert.ok(layout.boxOf.has(node.id) && ancestors.has(node.id), node.id);
});

test('summary precedence, counts, heads and durations are deterministic', () => {
  const graph = buildTaskMap(input('parallel')), cl = graph.nodes.filter(node => node.laneId === 'agent:claude');
  const statuses = ['done', 'cancelled', 'failed', 'waiting', 'running'] as const;
  for (const status of statuses) {
    for (const node of cl) node.status = 'done';
    cl[1]!.status = status;
    const layout = all(graph, { closed: new Set(['lane:agent:claude']) }), box = boxFor(layout, cl[1]!);
    assert.equal(box.status, status); assert.equal(box.durationMs, 30_000);
    assert.equal(box.folded!.steps, 4); assert.equal(box.folded!.delegates, 0);
  }
  const layout = all(graph);
  assert.equal(boxFor(layout, partNode(graph, 'root-delegate-claude')).durationMs, 30_000);
  assert.equal(boxFor(layout, graph.nodes.find(node => node.kind === 'subagent')!).durationMs, 14_000);
  for (const lane of graph.lanes.filter(lane => lane.kind === 'delegate' || lane.kind === 'subagent')) {
    const boxes = layout.boxes.filter(box => box.laneId === lane.id);
    assert.equal(boxes.filter(box => box.head).length, boxes.length ? 1 : 0);
    assert.equal(boxes[0]?.head, true);
  }
  const running = graph.nodes.find(node => node.kind === 'subagent')!;
  running.subagent = { ...running.subagent!, status: 'running', endedAt: undefined }; running.status = 'running';
  assert.equal(boxFor(all(graph), running).durationMs, undefined);
  assert.deepEqual(all(graph), all(graph));
});

test('root prompt edges bridge across bands, preserve fork edges and deduplicate after folding', () => {
  const graph = smallGraph();
  graph.phases.push({ id: 'two', index: 1, label: 'Turn 2', status: 'done', promptItemId: 'prompt' });
  const before = node('before'), prompt = { ...node('prompt', 'agent:root', 1), kind: 'prompt' as const, parts: [{ itemId: 'prompt', partIndex: 0 }] };
  const after = node('after', 'agent:root', 1, 2), child = node('child', 'native', 1);
  graph.lanes.push({ id: 'native', kind: 'subagent', title: 'Native', parentLaneId: 'agent:root', depth: 1 });
  graph.nodes.push(before, prompt, after, child);
  graph.edges.push({ id: 'a', kind: 'flow', from: before.id, to: prompt.id }, { id: 'b', kind: 'flow', from: prompt.id, to: after.id },
    { id: 'duplicate', kind: 'flow', from: before.id, to: after.id }, { id: 'fork', kind: 'delegate', from: prompt.id, to: child.id },
    { id: 'unknown', kind: 'return', from: 'missing', to: after.id });
  const layout = all(graph);
  assert.equal(layout.boxOf.get(prompt.id), 'turn:two');
  assert.equal(layout.edges.filter(edge => edge.kind === 'flow' && edge.from === before.id && edge.to === after.id).length, 1);
  assert.ok(layout.edges.some(edge => edge.kind === 'delegate' && edge.from === before.id && edge.to === child.id));
  assert.ok(layout.edges.every(edge => !edge.from.startsWith('turn:') && !edge.to.startsWith('turn:') && edge.from !== edge.to));
  graph.nodes = graph.nodes.filter(node => node !== before);
  const first = all(graph);
  assert.ok(first.edges.some(edge => edge.kind === 'delegate' && edge.from === after.id && edge.to === child.id), 'a leading skipped prompt retains its fork via the next root box');
});

test('parallel scheduling, return constraints, output free slots, column reuse and parent-right rule', () => {
  const graph = buildTaskMap(input('parallel')), layout = all(graph);
  assert.equal(boxFor(layout, partNode(graph, 'claude-prompt')).column, 1);
  assert.equal(boxFor(layout, partNode(graph, 'kimi-prompt')).column, 2);
  assert.equal(boxFor(layout, partNode(graph, 'grok-prompt')).column, 1);
  assert.equal(layout.outputsColumn, layout.columnX.length - 1);
  const rows = new Map<number, Set<string>>();
  for (const box of layout.boxes.filter(box => box.phase === 0 && box.column !== layout.outputsColumn)) {
    const lanes = rows.get(box.row) ?? new Set<string>(); lanes.add(box.laneId); rows.set(box.row, lanes);
  }
  assert.ok([...rows.values()].some(lanes => lanes.has('agent:claude') && lanes.has('agent:kimi')));
  const byId = new Map(layout.boxes.map(box => [box.id, box]));
  for (const edge of layout.edges.filter(edge => edge.kind === 'delegate' || edge.kind === 'return')) {
    assert.ok(byId.get(edge.to)!.row >= byId.get(edge.from)!.row + 1, edge.id);
  }
  const outputRows = layout.boxes.filter(box => box.phase === 0 && box.column === layout.outputsColumn).map(box => box.row);
  assert.equal(new Set(outputRows).size, outputRows.length);
  for (const edge of layout.edges.filter(edge => edge.kind === 'produce')) assert.ok(byId.get(edge.to)!.row >= byId.get(edge.from)!.row);
  const nested = buildTaskMap(input('delegation')), nestedLayout = all(nested);
  const columns = new Map(nestedLayout.lanes.map(span => [span.laneId, span.column]));
  for (const lane of nested.lanes) if (lane.parentLaneId && columns.has(lane.id) && columns.has(lane.parentLaneId)) assert.ok(columns.get(lane.id)! > columns.get(lane.parentLaneId)!);
});

test('odd graphs tolerate absent lanes, missing starts, cycles, prompt-only phases and invalid widths', () => {
  const graph = smallGraph();
  graph.lanes.push({ id: 'empty', kind: 'delegate', title: 'Empty', depth: 1 },
    { id: 'orphan', kind: 'delegate', title: 'Orphan', depth: 1, parentLaneId: 'missing' });
  graph.nodes.push(node('a'), node('b', 'agent:root', 0, 1), node('orphan-node', 'orphan'), node('unknown-lane', 'unknown'));
  graph.edges.push({ id: 'ab', from: 'a', to: 'b', kind: 'delegate' }, { id: 'ba', from: 'b', to: 'a', kind: 'return' },
    { id: 'missing', from: 'a', to: 'absent', kind: 'flow' });
  graph.hiddenPhases = 4;
  graph.lanes.push({ id: 'cycle-a', kind: 'delegate', title: '', depth: 1, parentLaneId: 'cycle-b' },
    { id: 'cycle-b', kind: 'delegate', title: '', depth: 1, parentLaneId: 'cycle-a' });
  graph.nodes.push(node('cycle', 'cycle-a'));
  for (const width of [0, Number.NaN, 480]) {
    const layout = layoutTaskGraph(graph, expansion({ mode: 'all' }), { width });
    assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
    assert.equal(layout.boxOf.size, graph.nodes.length); assert.equal(layout.ancestors.size, graph.nodes.length);
    assert.ok(boxFor(layout, graph.nodes[2]!).column >= 1);
    if (!width || Number.isNaN(width)) assert.equal(layout.boxWidth, TASK_GRAPH_METRICS.minBoxWidth);
    assert.equal(layout.earlier!.bottom - layout.earlier!.top, TASK_GRAPH_METRICS.earlierHeight);
    assertGeometry(layout);
  }
  graph.phases = [];
  const unphased = all(graph);
  assert.equal(unphased.boxOf.size, graph.nodes.length); assertGeometry(unphased);
  const prompt = smallGraph(); prompt.phases[0]!.promptItemId = 'p';
  prompt.nodes.push({ ...node('p'), kind: 'prompt', parts: [{ itemId: 'p', partIndex: 0 }] });
  const header = all(prompt);
  assert.equal(header.boxes.length, 0); assert.equal(header.bands[0]!.bottom - header.bands[0]!.top, TASK_GRAPH_METRICS.turnHeight);
  assert.equal(taskGraphStickyBand(header, header.bands[0]!.top + 1), undefined);
  const empty = all(buildTaskMap(input('empty')));
  assert.equal(empty.boxes.length, 0); assert.equal(empty.bands.length, 0); assert.equal(empty.height, 24);
});

test('windowing uses half-open intersections, headers push sticky copies, and column labels follow reuse', () => {
  const graph = buildTaskMap(input('parallel')), layout = all(graph), first = layout.boxes[0]!;
  assert.deepEqual(taskGraphWindow(layout, 0, layout.height), { boxes: layout.boxes, edges: layout.edges, bands: layout.bands });
  assert.deepEqual(taskGraphWindow(layout, 100, 100), { boxes: [], edges: [], bands: [] });
  assert.ok(!taskGraphWindow(layout, first.y + first.height, first.y + first.height + 1).boxes.includes(first));
  assert.ok(!taskGraphWindow(layout, first.y - 1, first.y).boxes.includes(first));
  assert.deepEqual(taskGraphWindow(layout, layout.height + 1, layout.height + 100).boxes, []);
  for (let top = 0; top < layout.height; top += 37) {
    const bottom = top + 150, window = taskGraphWindow(layout, top, bottom);
    assert.deepEqual(window.boxes, layout.boxes.filter(box => box.y < bottom && box.y + box.height > top));
    assert.deepEqual(window.bands, layout.bands.filter(band => band.top < bottom && band.bottom > top));
    assert.deepEqual(window.edges, layout.edges.filter(edge => edge.top < bottom && edge.bottom >= top));
  }
  const band = layout.bands[0]!, next = layout.bands[1]!;
  assert.equal(taskGraphStickyBand(layout, band.top), undefined);
  assert.deepEqual(taskGraphStickyBand(layout, band.top + 1), { band, shift: 0 });
  assert.deepEqual(taskGraphStickyBand(layout, band.bottom - 1), { band, shift: Math.min(0, next.top - (band.bottom - 1) - 32) });
  assert.equal(taskGraphStickyBand(layout, band.bottom), undefined);
  assert.equal(taskGraphStickyBand(layoutTaskGraph(graph, expansion({ mode: 'none' }), { width: 700 }), band.top + 1), undefined);
  const one = taskGraphLaneLabels(layout, band.top, band.bottom), two = taskGraphLaneLabels(layout, next.top, next.bottom);
  assert.equal(one.find(label => label.column === 1)!.laneId, 'agent:claude');
  assert.equal(two.find(label => label.column === 1)!.laneId, 'agent:grok');
  assert.ok(one.every(label => label.column !== layout.outputsColumn));
  assert.deepEqual(taskGraphLaneLabels(layout, layout.height, layout.height + 1), []);
  const custom = { ...TASK_GRAPH_METRICS, turnHeight: 40, rowGap: 20 };
  const changed = layoutTaskGraph(graph, expansion({ mode: 'all' }), { width: 700, metrics: custom });
  const end = changed.bands[0]!.bottom - 1;
  assert.equal(taskGraphStickyBand(changed, end)!.shift, Math.min(0, changed.bands[1]!.top - end - 40));
});

test('keyboard neighbors traverse columns and turn headers, including earlier and empty bands', () => {
  const graph = buildTaskMap(input('parallel')), layout = all(graph), first = layout.boxes[0]!, band = layout.bands[0]!;
  assert.equal(taskGraphNeighbor(layout, band.key, 'left'), undefined);
  assert.equal(taskGraphNeighbor(layout, band.key, 'right'), undefined);
  assert.equal(taskGraphNeighbor(layout, band.key, 'down'), first.id);
  assert.equal(taskGraphNeighbor(layout, first.id, 'up'), band.key);
  const root = layout.boxes.filter(box => box.phase === 0 && box.column === 0);
  assert.equal(taskGraphNeighbor(layout, root[0]!.id, 'down'), root[1]!.id);
  assert.equal(taskGraphNeighbor(layout, root.at(-1)!.id, 'down'), layout.bands[1]!.key);
  assert.equal(taskGraphNeighbor(layout, layout.bands[1]!.key, 'up'), root.at(-1)!.id);
  const child = boxFor(layout, partNode(graph, 'claude-prompt'));
  assert.equal(layout.boxes.find(box => box.id === taskGraphNeighbor(layout, child.id, 'left'))!.column, 0);
  assert.equal(layout.boxes.find(box => box.id === taskGraphNeighbor(layout, child.id, 'right'))!.column, 2);
  assert.equal(taskGraphNeighbor(layout, 'missing', 'up'), undefined);
  graph.hiddenPhases = 2;
  const earlier = all(graph);
  assert.equal(taskGraphNeighbor(earlier, 'earlier', 'down'), band.key);
  assert.equal(taskGraphNeighbor(earlier, band.key, 'up'), 'earlier');
  assert.equal(taskGraphNeighbor(earlier, 'earlier', 'up'), undefined);
  const empty = smallGraph(); empty.phases.push({ id: 'two', index: 1, label: '', status: 'done' });
  const emptyLayout = all(empty);
  assert.equal(taskGraphNeighbor(emptyLayout, 'turn:one', 'down'), 'turn:two');
  assert.equal(taskGraphNeighbor(emptyLayout, 'turn:two', 'up'), 'turn:one');
});

test('Chat marks node boxes, folded lane boxes and otherwise phase-only bands', () => {
  const data = input(), graph = buildTaskMap(data), index = taskFlowIndex(graph, data.items);
  const start = partNode(graph, 'root-delegate-claude'), node = partNode(graph, 'grok-command');
  const visible = taskFlowInView(index, [state('grok', { items: ['grok-command'] }), state('root', { turns: ['root-prompt-2'] })]);
  assert.ok(visible.nodes.has(node.id)); assert.ok(visible.phases.has(1));
  const toolVisible = taskFlowInView(index, [state('root', { tools: ['start-claude'] })]);
  assert.ok(toolVisible.nodes.has(start.id));
  const open = all(graph);
  assert.deepEqual(taskGraphMarked(open, visible), new Set([node.id, turn(graph, 1)]));
  const folded = all(graph, { closed: new Set(['lane:agent:claude']) });
  assert.deepEqual(taskGraphMarked(folded, visible), new Set([`fold:agent:claude:${graph.phases[0]!.id}`, turn(graph, 1)]));
  const closed = layoutTaskGraph(graph, expansion({ mode: 'none' }), { width: 1440 });
  assert.deepEqual(taskGraphMarked(closed, visible), new Set([closed.boxOf.get(node.id)!, turn(graph, 1)]));
  const prompt = partNode(graph, 'root-prompt-1');
  assert.deepEqual(taskGraphMarked(open, { nodes: new Set([prompt.id]), phases: new Set([0]) }), new Set([turn(graph, 0)]));
  assert.deepEqual(taskGraphMarked(open, { nodes: new Set([node.id]), phases: new Set([0]) }), new Set([node.id]));
  assert.deepEqual(taskGraphAutoOpen(open.ancestors, graph, visible), new Set([turn(graph, 0), turn(graph, 1), 'lane:agent:claude', 'lane:agent:grok']));
});

test('Chat auto-open limits turns in phase order while retaining all their lane ancestors', () => {
  const graph = buildTaskMap(input('long', { maxPhases: 200 })), ancestors = taskGraphAncestors(graph), phases = new Set([8, 5, 2, 1, 7]);
  assert.deepEqual(taskGraphAutoOpen(ancestors, graph, { nodes: new Set(), phases }), new Set([turn(graph, 1), turn(graph, 2), turn(graph, 5)]));
  assert.equal(taskGraphAutoOpen(ancestors, graph, { nodes: new Set(), phases }, 0).size, 0);
  const later = graph.nodes.find(node => node.phase === 8)!;
  assert.deepEqual(taskGraphAutoOpen(ancestors, graph, { nodes: new Set([later.id]), phases }, 2), new Set([turn(graph, 1), turn(graph, 2)]));
});

test('return edges never point back to an earlier turn, also when a delegate follows up later', () => {
  for (const name of ['delegation', 'nested', 'parallel', 'running'] as TaskMapFixtureName[]) {
    const graph = buildTaskMap(input(name));
    for (const mode of ['default', 'all', 'none'] as const) {
      const layout = layoutTaskGraph(graph, expansion({ mode }), { width: 1440 });
      const boxes = new Map(layout.boxes.map(box => [box.id, box]));
      for (const edge of layout.edges.filter(edge => edge.kind === 'return'))
        assert.ok(boxes.get(edge.from)!.phase <= boxes.get(edge.to)!.phase, `${name}/${mode}: ${edge.id} points back to an earlier turn`);
    }
  }
  // The nested fixture's Claude delegate works again in turn 2 after the root took its result in turn 1.
  const graph = buildTaskMap(input('nested')), layout = all(graph);
  assert.ok(layout.edges.some(edge => edge.kind === 'return' && layout.boxes.find(box => box.id === edge.to)!.phase === 0), 'the turn-1 return edge is kept, from the delegate\'s turn-1 work');
});

test('related highlights exactly the selected box and its immediate incident edges', () => {
  const graph = buildTaskMap(input('parallel')), layout = all(graph), selected = boxFor(layout, partNode(graph, 'root-delegate-claude'));
  const related = taskGraphRelated(layout, selected.id), incident = layout.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
  assert.deepEqual(related.edges, new Set(incident.map(edge => edge.id)));
  assert.deepEqual(related.boxes, new Set([selected.id, ...incident.flatMap(edge => [edge.from, edge.to])]));
  assert.deepEqual(taskGraphRelated(layout, 'missing'), { boxes: new Set(), edges: new Set() });
});

interface Point { x: number; y: number }
interface Segment { from: Point; to: Point; control?: Point }
function parsePath(d: string): { points: Point[]; segments: Segment[] } {
  assert.ok(!/[a-z]/.test(d), 'only absolute path commands');
  const tokens = d.match(/[MLQ]|-?\d+(?:\.\d+)?/g) ?? [], points: Point[] = [], segments: Segment[] = [];
  let index = 0, current: Point | undefined;
  const point = (): Point => {
    const x = Number(tokens[index++]), y = Number(tokens[index++]);
    assert.ok(Number.isFinite(x) && Number.isFinite(y)); assert.equal(x * 2, Math.round(x * 2)); assert.equal(y * 2, Math.round(y * 2));
    const result = { x, y }; points.push(result); return result;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    assert.ok(command === 'M' || command === 'L' || command === 'Q');
    const a = point();
    if (command === 'M') { assert.equal(current, undefined); current = a; }
    else {
      assert.ok(current);
      if (command === 'L') {
        assert.ok(current.x === a.x || current.y === a.y, 'L segments are orthogonal');
        segments.push({ from: current, to: a }); current = a;
      } else {
        const b = point(); segments.push({ from: current, control: a, to: b }); current = b;
      }
    }
  }
  return { points, segments };
}
function onBorder(point: Point, box: TaskGraphBox): boolean {
  return ((point.x === box.x || point.x === box.x + box.width) && point.y >= box.y && point.y <= box.y + box.height)
    || ((point.y === box.y || point.y === box.y + box.height) && point.x >= box.x && point.x <= box.x + box.width);
}
function lowerBox(boxes: readonly TaskGraphBox[], y: number): number {
  let lo = 0, hi = boxes.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (boxes[mid]!.y + boxes[mid]!.height < y) lo = mid + 1; else hi = mid; }
  return lo;
}
function assertGeometry(layout: TaskGraphLayout): void {
  const byId = new Map(layout.boxes.map(box => [box.id, box])), columns = new Map<number, TaskGraphBox[]>();
  for (const box of layout.boxes) {
    const band = layout.bands.find(band => band.phase === box.phase)!;
    assert.ok(box.y >= band.top + TASK_GRAPH_METRICS.turnHeight && box.y + box.height <= band.bottom, box.id);
    assert.ok(box.x >= 0 && box.x + box.width <= layout.width);
    assert.equal(box.x, layout.columnX[box.column]); assert.equal(box.width, layout.boxWidth);
    const list = columns.get(box.column) ?? [];
    assert.ok(!list.length || list.at(-1)!.y + list.at(-1)!.height <= box.y, `overlapping boxes: ${box.id}`);
    list.push(box); columns.set(box.column, list);
  }
  assert.equal(new Set(layout.edges.map(edge => edge.id)).size, layout.edges.length);
  for (const edge of layout.edges) {
    const path = parsePath(edge.d), source = byId.get(edge.from)!, target = byId.get(edge.to)!;
    assert.ok(onBorder(path.points[0]!, source), `source border: ${edge.id}`);
    assert.ok(onBorder(path.points.at(-1)!, target), `target border: ${edge.id}`);
    assert.equal(edge.top, Math.min(...path.points.map(point => point.y)), edge.id);
    assert.equal(edge.bottom, Math.max(...path.points.map(point => point.y)), edge.id);
    for (const segment of path.segments) {
      const points = [segment.from, segment.to, ...(segment.control ? [segment.control] : [])];
      const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x));
      const top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y));
      for (const [column, boxes] of columns) {
        if (right <= layout.columnX[column]! || left >= layout.columnX[column]! + layout.boxWidth) continue;
        for (let index = lowerBox(boxes, top); index < boxes.length && boxes[index]!.y <= bottom; index++) {
          const box = boxes[index]!;
          if (box.id === source.id || box.id === target.id) continue;
          assert.ok(right <= box.x || left >= box.x + box.width || bottom <= box.y || top >= box.y + box.height,
            `${edge.id} crosses ${box.id}: ${JSON.stringify(segment)}`);
        }
      }
    }
  }
}

test('routing stays clear at every width, fixture and expansion, including a folded delegate lane', () => {
  const names: TaskMapFixtureName[] = ['delegation', 'single', 'empty', 'long', 'running', 'nested', 'parallel'];
  for (const name of names) {
    const graph = buildTaskMap(input(name, { maxPhases: 200 }));
    const delegate = graph.lanes.find(lane => lane.kind === 'delegate');
    const states = [expansion(), expansion({ mode: 'all' }), expansion({ mode: 'none' }),
      expansion({ mode: 'all', closed: new Set(delegate ? [`lane:${delegate.id}`] : []) })];
    for (const width of [1440, 700, 480]) for (const state of states) {
      const layout = layoutTaskGraph(graph, state, { width });
      assert.equal(layout.boxOf.size, graph.nodes.length, `${name}/${width}/${state.mode}`);
      assert.equal(layout.ancestors.size, graph.nodes.length);
      assertGeometry(layout);
      assert.deepEqual(layout, layoutTaskGraph(graph, state, { width }), 'stable boxes, ids and path strings');
    }
  }
});

test('backward, non-adjacent same-row and same-column skip edges detour around intervening boxes', () => {
  const graph = smallGraph();
  graph.lanes.push({ id: 'child', kind: 'delegate', title: '', depth: 1, parentLaneId: 'agent:root' });
  graph.nodes.push(node('a'), node('middle', 'agent:root', 0, 1), node('b', 'agent:root', 0, 2), node('child', 'child'));
  graph.edges.push({ id: 'skip', kind: 'flow', from: 'a', to: 'b' }, { id: 'back', kind: 'return', from: 'b', to: 'a' },
    { id: 'out', kind: 'delegate', from: 'a', to: 'child' }, { id: 'cycle', kind: 'return', from: 'child', to: 'a' });
  assertGeometry(all(graph));
  assertGeometry(layoutTaskGraph(buildTaskMap(input('parallel')), expansion({ mode: 'none' }), { width: 480 }));
});

test('200-turn layout stays within expanded and default timing budgets, excluding graph construction', () => {
  const graph = buildTaskMap(input('long', { maxPhases: 200 }));
  const samples = (mode: TaskGraphExpansion['mode']): number => {
    const times: number[] = [], state = expansion({ mode });
    for (let run = 0; run < 5; run++) {
      const start = performance.now(), layout = layoutTaskGraph(graph, state, { width: 1440 });
      times.push(performance.now() - start);
      assert.equal(layout.boxOf.size, graph.nodes.length);
    }
    times.sort((a, b) => a - b); return times[2]!;
  };
  const expanded = samples('all'), normal = samples('default');
  console.log(`taskGraph 200 turns: expanded ${expanded.toFixed(2)} ms, default ${normal.toFixed(2)} ms (median)`);
  assert.ok(expanded < 150, `expanded ${expanded.toFixed(1)} ms`);
  assert.ok(normal < 60, `default ${normal.toFixed(1)} ms`);
});
