import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, ChatPart, Session } from '@threadterm/protocol';
import { taskMapFixture, taskMapFixtureLastTime } from './fixtures/taskMapFixtures';
import { buildTaskMap, delegationGroupLabel, taskMapRoot, taskMapSessions } from './taskMap';
import { taskMapRoot as standaloneTaskMapRoot } from './taskMapRoot';
import { toolSummary, toolSummarySegments } from './toolActivity';
import type { TaskMapGraph, TaskMapInput } from './taskMapTypes';

const en = (english: string): string => english;
const zh = (_english: string, chinese: string): string => chinese;
const fixtureInput = (name: Parameters<typeof taskMapFixture>[0] = 'delegation', extra: Partial<TaskMapInput> = {}): TaskMapInput => ({ ...taskMapFixture(name), copy: en, zh: false, ...extra });
const at = (second: number): string => new Date(Date.UTC(2026, 9, 21, 12) + second * 1_000).toISOString();
const item = (id: string, turnId: string, parts: ChatPart[], extra: Partial<ChatItem> = {}): ChatItem => ({ id, turnId, parts, role: 'assistant', createdAt: at(1), ...extra });
const read = (path = 'src/a.ts'): ChatPart => ({ type: 'tool', toolName: 'Read', status: 'completed', data: { input: { file_path: path } } });
const command = (status = 'completed'): ChatPart => ({ type: 'tool', toolName: 'Bash', status, data: { input: { command: 'node --check app.mjs' } } });
function custom(items: ChatItem[], extra: Partial<TaskMapInput> = {}): TaskMapInput {
  const input = fixtureInput('single');
  input.sessions = [{ ...input.sessions[0]!, provider: 'codex', status: 'running' }];
  input.items = new Map([['root', items]]);
  return { ...input, ...extra };
}
const byPart = (graph: TaskMapGraph, itemId: string) => graph.nodes.find(node => node.parts.some(ref => ref.itemId === itemId));

test('taskMapRoot climbs nested parents, stops at missing parents and terminates cycles', () => {
  assert.equal(taskMapRoot, standaloneTaskMapRoot, 'the model retains its existing root lookup export');
  const { sessions } = taskMapFixture('delegation');
  assert.equal(taskMapRoot('grok', sessions), 'root');
  assert.equal(taskMapRoot('missing', sessions), 'missing');
  assert.equal(taskMapRoot('grok', sessions.filter(session => session.id !== 'claude')), 'grok');
  const a = { ...sessions[0]!, id: 'a', delegation: { id: 'da', parentSessionId: 'b', workspace: 'shared' as const, state: 'completed' as const } };
  const b = { ...a, id: 'b', delegation: { ...a.delegation, parentSessionId: 'a' } };
  assert.equal(taskMapRoot('a', [a, b]), 'b');
  assert.equal(taskMapRoot('a', [a, b]), taskMapRoot('a', [a, b]));
});

test('taskMapSessions uses creation-ordered BFS, caps depth and 24 delegates, and counts omissions', () => {
  const { sessions } = taskMapFixture('delegation');
  assert.deepEqual(taskMapSessions('root', sessions).sessions.map(session => session.id), ['root', 'claude', 'kimi', 'grok']);
  const root = sessions[0]!;
  const chain: Session[] = [root];
  for (let index = 1; index <= 6; index += 1) chain.push({ ...root, id: `depth-${index}`, createdAt: at(index), delegation: {
    id: `d-${index}`, parentSessionId: index === 1 ? root.id : `depth-${index - 1}`, workspace: 'shared', state: 'completed',
  } });
  const depth = taskMapSessions(root.id, chain);
  assert.equal(depth.sessions.length, 5); assert.equal(depth.hiddenDelegates, 2);
  const wide = [root, ...Array.from({ length: 30 }, (_, index): Session => ({ ...root, id: `child-${index}`, createdAt: at(index + 1), delegation: {
    id: `d-${index}`, parentSessionId: root.id, workspace: 'shared', state: 'completed',
  } }))];
  assert.equal(taskMapSessions(root.id, wide).sessions.length, 25);
  assert.equal(taskMapSessions(root.id, wide).hiddenDelegates, 6);
  assert.deepEqual(taskMapSessions('missing', wide), { sessions: [], hiddenDelegates: 0 });
  const cycle = [{ ...root, delegation: { id: 'cycle', parentSessionId: 'depth-1', workspace: 'shared' as const, state: 'completed' as const } }, ...chain.slice(1)];
  assert.equal(taskMapSessions('root', cycle).sessions.length, 5);
});

test('phases have localized labels, first-line previews, durations and waiting status', () => {
  const graph = buildTaskMap(fixtureInput());
  assert.deepEqual(graph.phases.map(phase => phase.label), ['Turn 1', 'Turn 2', 'Turn 3']);
  assert.equal(graph.phases[0]!.prompt, 'Map the validation flow');
  assert.equal(graph.phases[0]!.elapsedMs, 50_000);
  assert.equal(graph.phases[0]!.status, 'done');
  assert.equal(graph.phases[2]!.status, 'waiting');
  const chinese = buildTaskMap(fixtureInput('delegation', { zh: true, copy: zh }));
  assert.equal(chinese.phases[1]!.label, '第 2 轮');
  assert.equal(chinese.lanes.at(-1)!.title, '产出');
  assert.ok(chinese.nodes.some(node => node.label === '需要批准' || node.label === '计划 2/2'));
  const preview = buildTaskMap(custom([item('u', 't', [{ type: 'text', text: `${'x'.repeat(100)}\nsecond line` }], { role: 'user' })]));
  assert.equal(preview.phases[0]!.prompt?.length, 80);
  assert.equal(preview.nodes[0]!.label.length, 60);
  assert.equal(buildTaskMap(fixtureInput('running')).phases.at(-1)!.status, 'running');
  assert.equal(buildTaskMap(custom([item('failed', 't', [], { turnStatus: 'failed' })])).phases[0]!.status, 'failed');
  assert.equal(buildTaskMap(custom([item('cancelled', 't', [], { turnStatus: 'interrupted' })])).phases[0]!.status, 'cancelled');
});

test('maxPhases retains only latest turns, reindexes nodes and omits invisible delegate lanes', () => {
  const graph = buildTaskMap(fixtureInput('delegation', { maxPhases: 1 }));
  assert.equal(graph.hiddenPhases, 2); assert.equal(graph.phases[0]!.label, 'Turn 3');
  assert.ok(graph.nodes.every(node => node.phase === 0));
  assert.deepEqual(graph.lanes.map(lane => lane.id), ['agent:root', 'outputs']);
  const long = buildTaskMap(fixtureInput('long'));
  assert.equal(long.hiddenPhases, 160); assert.equal(long.phases.length, 40);
  assert.equal(long.phases[0]!.label, 'Turn 161');
  const zero = buildTaskMap(fixtureInput('delegation', { maxPhases: 0 }));
  assert.equal(zero.hiddenPhases, 3); assert.equal(zero.nodes.length, 0);
  assert.equal(buildTaskMap(fixtureInput('empty')).phases.length, 0);
  const partial = buildTaskMap(custom([item('initial', 't', [read()])]));
  assert.equal(partial.phases.length, 1); assert.equal(partial.phases[0]!.promptItemId, undefined);
});

test('tool groups merge only consecutive same-step calls in the same turn and retain failures and edit paths', () => {
  const input = custom([
    item('u', 't', [{ type: 'text', text: 'Check' }], { role: 'user', createdAt: at(0) }),
    item('reads-1', 't', [read()]), item('reads-2', 't', [read('src/b.ts')]),
    item('commands', 't', [command('failed'), command('running')]),
    item('read-again', 't', [read()]),
    item('edits', 't', [{ type: 'tool', toolName: 'Edit', status: 'completed', data: { input: { file_path: 'src/fix.ts', old_string: 'a', new_string: 'b' } } }]),
    item('turn-next', 'next', [read()], { createdAt: at(10) }),
  ]);
  const graph = buildTaskMap(input), tools = graph.nodes.filter(node => node.kind === 'tools');
  assert.deepEqual(tools.map(node => [node.step, node.count]), [['explore', 2], ['command', 2], ['explore', 1], ['edit', 1], ['explore', 1]]);
  assert.equal(tools[1]!.status, 'failed'); assert.equal(tools[1]!.parts.length, 2);
  assert.deepEqual(tools[3]!.files, ['src/fix.ts']);
  assert.match(tools[0]!.label, /Explored 2 files/);
  assert.equal(new Set(graph.nodes.map(node => node.id)).size, graph.nodes.length);
  const boundary = buildTaskMap(custom([item('first', 'a', [read()]), item('commentary', 'a', [{ type: 'text', text: 'Continuing', phase: 'commentary' }]),
    item('second', 'a', [read()]), item('missing-id', '', [read()], { turnId: undefined }), item('third', 'b', [read()])]));
  assert.deepEqual(boundary.nodes.filter(node => node.kind === 'tools').map(node => node.count), [1, 2, 1]);
});

test('command read/search/list actions and web are explore, browser MCP remains browser', () => {
  const graph = buildTaskMap(custom([item('tools', 't', [
    { type: 'tool', toolName: 'commandExecution', status: 'completed', data: { type: 'commandExecution', command: 'ls', commandActions: [{ type: 'listFiles', command: 'ls' }] } },
    { type: 'tool', toolName: 'WebSearch', status: 'completed', data: { input: { query: 'documentation' } } },
    { type: 'tool', toolName: 'mcp__playwright__browser_snapshot', status: 'completed', data: {} },
    { type: 'tool', toolName: 'mcpToolCall', status: 'completed', data: { type: 'mcpToolCall', server: 'other', tool: 'lookup' } },
    { type: 'tool', toolName: 'unrecognized', data: 'not JSON' },
  ])]));
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'tools').map(node => node.step), ['explore', 'browser', 'mcp', 'tool']);
  assert.equal(graph.nodes[0]!.count, 2);
});

test('delegates nest by first appearance with delegate and id-matched return edges', () => {
  const graph = buildTaskMap(fixtureInput());
  assert.deepEqual(graph.lanes.map(lane => [lane.id, lane.depth]), [
    ['agent:root', 0], ['agent:claude', 1], ['agent:grok', 2], ['agent:kimi', 1], ['subagent:root:native-review', 1], ['outputs', 0],
  ]);
  for (const id of ['claude', 'kimi', 'grok']) {
    const start = graph.nodes.find(node => node.childSessionId === id)!;
    assert.ok(start, id);
    const childNodes = graph.nodes.filter(node => node.laneId === `agent:${id}`);
    assert.ok(childNodes[0]!.label.startsWith('Task from '));
    assert.ok(graph.edges.some(edge => edge.kind === 'delegate' && edge.from === start.id && edge.to === childNodes[0]!.id));
    assert.ok(graph.edges.some(edge => edge.kind === 'return' && edge.from === childNodes.at(-1)!.id));
  }
  assert.equal(byPart(graph, 'root-delegate-claude')!.childSessionId, 'claude', 'embedded escaped Codex result is parsed');
  assert.equal(byPart(graph, 'claude-delegate-grok')!.childSessionId, 'grok', 'Claude MCP result is parsed');
});

test('delegate child matching rejects unrelated ids, falls back by creation order, and supports Grok native names', () => {
  const input = fixtureInput();
  const rootItems = input.items.get('root')!.map(entry => ({ ...entry, parts: [...entry.parts] }));
  rootItems.find(entry => entry.id === 'root-delegate-claude')!.parts = [{ type: 'tool', toolName: 'threadterm__delegate_start', status: 'completed', data: { result: '{"sessionId":"grok"}' } }];
  rootItems.find(entry => entry.id === 'root-delegate-kimi')!.parts = [{ type: 'tool', toolName: 'threadterm__delegate_start', status: 'completed', data: { result: 'not JSON' } }];
  input.items = new Map(input.items).set('root', rootItems);
  const graph = buildTaskMap(input);
  assert.equal(byPart(graph, 'root-delegate-claude')!.childSessionId, 'claude');
  assert.equal(byPart(graph, 'root-delegate-kimi')!.childSessionId, 'kimi');
});

test('delegate child ids come from results, never session ids quoted in request arguments or prompts', () => {
  const resultText = JSON.stringify({ sessionId: 'kimi' });
  const resultShapes = [
    { data: { result: { sessionId: 'kimi' } } },
    { data: { result: { content: [{ type: 'text', text: resultText }] } } },
    { data: { content: [{ type: 'text', text: resultText }] } },
    { data: { rawOutput: resultText } },
    { data: {}, text: resultText },
  ];
  for (const toolName of ['mcpToolCall', 'mcp__threadterm__delegate_start', 'threadterm__delegate_start']) for (const result of resultShapes) {
    const input = fixtureInput(), items = [...input.items.get('root')!];
    const prompt = 'Inspect this example, not its session: {"sessionId":"claude"}';
    const data = { type: 'mcpToolCall', server: 'threadterm', tool: 'delegate_start',
      arguments: { agent: 'kimi', prompt }, input: { prompt }, rawInput: JSON.stringify({ prompt }), ...result.data };
    const index = items.findIndex(item => item.id === 'root-delegate-claude');
    items[index] = { ...items[index]!, parts: [{ type: 'tool', toolName, status: 'completed', data, text: result.text }] };
    input.items = new Map(input.items).set('root', items);
    const graph = buildTaskMap(input), start = byPart(graph, 'root-delegate-claude')!;
    assert.equal(start.childSessionId, 'kimi', `${toolName}: ${JSON.stringify(result)}`);
    assert.ok(graph.edges.some(edge => edge.kind === 'delegate' && edge.from === start.id && graph.nodes.find(node => node.id === edge.to)!.laneId === 'agent:kimi'));
  }
  const input = fixtureInput(), items = [...input.items.get('root')!];
  const index = items.findIndex(item => item.id === 'root-delegate-claude');
  items[index] = { ...items[index]!, parts: [{ type: 'tool', toolName: 'threadterm__delegate_start', status: 'completed',
    data: { input: { prompt: '{"sessionId":"kimi"}' } } }] };
  input.items = new Map(input.items).set('root', items);
  assert.equal(byPart(buildTaskMap(input), 'root-delegate-claude')!.childSessionId, 'claude', 'missing result uses creation-order fallback, not the quoted prompt');
});

test('cached tool views preserve shared summary labels for each grouped step in both languages', () => {
  for (const name of ['delegation', 'running', 'long'] as const) for (const copy of [en, zh]) {
    const input = fixtureInput(name, { copy, zh: copy === zh }), graph = buildTaskMap(input);
    const items = new Map([...input.items].map(([sessionId, rows]) => [sessionId, new Map(rows.map(item => [item.id, item]))]));
    for (const node of graph.nodes.filter(node => node.kind === 'tools' && node.step !== 'delegation')) {
      const entries = node.parts.map(ref => ({ id: `${ref.itemId}:${ref.partIndex}`, itemId: ref.itemId,
        part: items.get(node.sessionId!)!.get(ref.itemId)!.parts[ref.partIndex]! }));
      assert.equal(node.label, toolSummarySegments(toolSummary(entries), copy).join(' · ') || copy('Tools', '工具'), node.id);
      assert.equal(node.count, entries.length);
    }
  }
});

test('delegate return uses a matching id before the time fallback and does not return live delegates', () => {
  const input = fixtureInput();
  const rootItems = input.items.get('root')!.map(entry => ({ ...entry, parts: entry.parts.map(part => ({ ...part })) }));
  input.items = new Map(input.items).set('root', rootItems);
  rootItems.find(entry => entry.id === 'root-results')!.createdAt = at(10);
  const byId = buildTaskMap(input), matchedNode = byPart(byId, 'root-results')!;
  assert.equal(byId.edges.filter(edge => edge.kind === 'return' && edge.to === matchedNode.id).length, 2, 'id match wins even before the child end time');
  rootItems.find(entry => entry.id === 'root-results')!.createdAt = at(40);
  rootItems.find(entry => entry.id === 'root-results')!.parts = [{ type: 'tool', toolName: 'threadterm__delegate_status', status: 'completed', data: { result: 'finished' } }];
  const fallback = buildTaskMap(input), result = byPart(fallback, 'root-results')!;
  assert.equal(fallback.edges.filter(edge => edge.kind === 'return' && edge.to === result.id).length, 2);
  rootItems.find(entry => entry.id === 'root-results')!.createdAt = at(10);
  assert.equal(buildTaskMap(input).edges.filter(edge => edge.kind === 'return' && edge.to === result.id).length, 0);
  const live = buildTaskMap(fixtureInput('running'));
  const childIds = new Set(live.nodes.filter(node => node.laneId === 'agent:live-child').map(node => node.id));
  assert.equal(live.edges.some(edge => edge.kind === 'return' && childIds.has(edge.from)), false);
});

test('native subagent updates share one node and have parent delegate/return edges', () => {
  const graph = buildTaskMap(fixtureInput()), nodes = graph.nodes.filter(node => node.kind === 'subagent');
  assert.equal(nodes.length, 1); assert.equal(nodes[0]!.parts.length, 2);
  assert.equal(nodes[0]!.subagent?.toolCount, 4); assert.equal(nodes[0]!.status, 'done');
  assert.ok(graph.edges.some(edge => edge.kind === 'delegate' && edge.to === nodes[0]!.id));
  assert.ok(graph.edges.some(edge => edge.kind === 'return' && edge.from === nodes[0]!.id && edge.to === byPart(graph, 'root-browser')!.id));
});

test('plan updates merge latest data; pending approvals/questions wait; errors fail', () => {
  const plan = (status: 'pending' | 'completed'): ChatPart => ({ type: 'plan', data: { entries: [{ content: 'Check contracts', status }] } });
  const graph = buildTaskMap(custom([
    item('plans', 't', [plan('pending'), plan('completed')]),
    item('approval', 't', [{ type: 'approval', status: 'pending', approvalId: 'a', data: { approvalId: 'a', title: 'Allow?' } }]),
    item('question', 't', [{ type: 'tool', toolName: 'threadterm__ask_user', status: 'pending', data: {} }]),
    item('error', 't', [{ type: 'error', text: 'Oops' }]),
  ]));
  const plans = graph.nodes.filter(node => node.kind === 'plan');
  assert.equal(plans.length, 1); assert.equal(plans[0]!.label, 'Plan 1/1'); assert.equal(plans[0]!.parts.length, 2);
  assert.equal(plans[0]!.status, 'done');
  assert.equal(byPart(graph, 'approval')!.status, 'waiting'); assert.equal(byPart(graph, 'question')!.status, 'waiting');
  assert.equal(byPart(graph, 'error')!.status, 'failed');
});

test('reply keeps only final answer text, excludes Codex commentary, and handles old unphased turns', () => {
  const graph = buildTaskMap(custom([
    item('comment', 't', [{ type: 'text', text: 'Thinking aloud', phase: 'commentary' }]),
    item('answer', 't', [{ type: 'text', text: 'Answer', phase: 'final_answer' }, { type: 'text', text: 'Comment', phase: 'commentary' }], { turnStatus: 'completed' }),
  ]));
  const reply = graph.nodes.filter(node => node.kind === 'reply');
  assert.equal(reply.length, 1); assert.deepEqual(reply[0]!.parts, [{ itemId: 'answer', partIndex: 0 }]);
  const old = buildTaskMap(custom([item('old-comment', 't', [{ type: 'text', text: 'Working' }]), item('old-answer', 't', [{ type: 'text', text: 'Done' }], { elapsedMs: 10 })]));
  assert.deepEqual(old.nodes.filter(node => node.kind === 'reply').map(node => node.parts[0]!.itemId), ['old-answer']);
  const onlyCommentary = buildTaskMap(custom([item('comment', 't', [{ type: 'text', text: 'Still thinking', phase: 'commentary', status: 'streaming' }])]));
  assert.equal(onlyCommentary.nodes.some(node => node.kind === 'reply'), false);
  const multi = buildTaskMap(custom([item('answer', 't', [
    { type: 'text', text: 'First', phase: 'final_answer' }, command(), { type: 'text', text: 'Last', phase: 'final_answer' },
  ], { turnStatus: 'completed' })]));
  assert.equal(multi.nodes.filter(node => node.kind === 'reply').length, 1);
  assert.deepEqual(multi.nodes.find(node => node.kind === 'reply')!.parts, [{ itemId: 'answer', partIndex: 0 }, { itemId: 'answer', partIndex: 2 }]);
});

test('files use turnReview or distinct edit paths, and documents link to the last matching edit', () => {
  const graph = buildTaskMap(fixtureInput());
  const reviewed = graph.nodes.filter(node => node.kind === 'files' && node.review);
  assert.equal(reviewed.length, 2); assert.equal(reviewed[0]!.review?.fileCount, 2);
  const fallback = graph.nodes.find(node => node.kind === 'files' && node.sessionId === 'claude')!;
  assert.deepEqual(fallback.files, ['docs/provider-notes.md']);
  for (const node of graph.nodes.filter(node => node.kind === 'files')) assert.ok(graph.edges.some(edge => edge.kind === 'produce' && edge.to === node.id));
  const plan = graph.nodes.find(node => node.kind === 'document' && node.path === 'docs/plan.md')!;
  assert.ok(graph.edges.some(edge => edge.kind === 'produce' && edge.to === plan.id && edge.from === byPart(graph, 'root-edits')!.id));
  const notes = graph.nodes.find(node => node.kind === 'document' && node.path === 'docs/notes.md')!;
  assert.equal(notes.phase, 1); assert.equal(graph.edges.some(edge => edge.to === notes.id), false);
  const windows = buildTaskMap(custom([item('edit', 't', [{ type: 'tool', toolName: 'Edit', status: 'completed', data: { input: { file_path: 'D:\\Repo\\Plan.md', old_string: 'a', new_string: 'b' } } }])],
    { documents: [{ path: 'd:/repo/PLAN.md', pinnedAt: at(2) }] }));
  const document = windows.nodes.find(node => node.kind === 'document')!;
  assert.ok(windows.edges.some(edge => edge.kind === 'produce' && edge.to === document.id));
  const windowsRelative = buildTaskMap(custom([item('edit-relative', 't', [{ type: 'tool', toolName: 'Edit', status: 'completed', data: { input: { file_path: 'docs\\PLAN.md', old_string: 'a', new_string: 'b' } } }])],
    { documents: [{ path: 'docs/Plan.md', pinnedAt: at(2) }] }));
  assert.ok(windowsRelative.edges.some(edge => edge.kind === 'produce' && edge.to === windowsRelative.nodes.find(node => node.kind === 'document')!.id));
  const editPart: ChatPart = { type: 'tool', toolName: 'Edit', status: 'completed', data: { input: { file_path: 'plan.md', old_string: 'a', new_string: 'b' } } };
  const latest = buildTaskMap(custom([item('edit-first', 'a', [editPart], { createdAt: at(1) }),
    item('edit-last', 'b', [editPart], { createdAt: at(2) })], { documents: [{ path: 'plan.md', pinnedAt: 'unknown' }, { path: 'notes.md', pinnedAt: 'unknown' }] }));
  const latestDoc = latest.nodes.find(node => node.kind === 'document' && node.path === 'plan.md')!;
  assert.ok(latest.edges.some(edge => edge.kind === 'produce' && edge.to === latestDoc.id && edge.from === byPart(latest, 'edit-last')!.id));
});

test('delegate phases advance with time and never regress for missing or out-of-order timestamps', () => {
  const input = fixtureInput();
  input.items = new Map(input.items).set('kimi', [
    item('kimi-late', 'kt', [read()], { createdAt: at(75) }),
    item('kimi-no-time', 'kt', [command()], { createdAt: 'invalid' }),
    item('kimi-latest', 'kt', [read()], { createdAt: at(125) }),
    item('kimi-old', 'kt', [command()], { createdAt: at(8) }),
    item('kimi-new-turn', 'next-kt', [read()], { createdAt: at(7) }),
  ]);
  const graph = buildTaskMap(input);
  assert.equal(byPart(graph, 'kimi-late')!.phase, 1); assert.equal(byPart(graph, 'kimi-no-time')!.phase, 1);
  assert.equal(byPart(graph, 'kimi-latest')!.phase, 2); assert.equal(byPart(graph, 'kimi-old')!.phase, 2);
  assert.equal(byPart(graph, 'kimi-new-turn')!.phase, 2);
});

test('late delegate starts clamp their descendants even when provider timestamps precede later root prompts', () => {
  const input = fixtureInput(), items = [...input.items.get('root')!];
  const startIndex = items.findIndex(item => item.id === 'root-delegate-claude');
  const [start] = items.splice(startIndex, 1);
  items.splice(items.findIndex(item => item.id === 'root-prompt-3') + 1, 0, { ...start!, turnId: 'turn-3' });
  input.items = new Map(input.items).set('root', items);
  for (const maxPhases of [40, 1]) {
    const graph = buildTaskMap({ ...input, maxPhases });
    const expected = maxPhases === 1 ? 0 : 2;
    assert.equal(byPart(graph, 'root-delegate-claude')!.phase, expected);
    const descendants = graph.nodes.filter(node => node.laneId === 'agent:claude' || node.laneId === 'agent:grok');
    assert.ok(descendants.length > 0);
    assert.ok(descendants.every(node => node.phase === expected));
    for (const edge of graph.edges.filter(edge => edge.kind === 'delegate')) {
      assert.ok(graph.nodes.find(node => node.id === edge.to)!.phase >= graph.nodes.find(node => node.id === edge.from)!.phase);
    }
  }
});

test('native subagent starts inherit the parent lane phase floor despite earlier provider timestamps', () => {
  const input = fixtureInput();
  const nativePart: ChatPart = { type: 'subagent', data: { key: 'late-native', provider: 'kimi', agentType: 'reviewer', status: 'running' } };
  input.items = new Map(input.items).set('kimi', [
    item('kimi-late', 'kt', [read()], { createdAt: at(75) }),
    item('native-old-time', 'kt', [nativePart], { createdAt: at(5) }),
    item('kimi-next', 'kt', [command()], { createdAt: at(4) }),
    item('native-finish', 'kt', [{ ...nativePart, data: { key: 'late-native', provider: 'kimi', agentType: 'reviewer', status: 'completed' } }], { createdAt: at(3) }),
  ]);
  const graph = buildTaskMap(input), native = byPart(graph, 'native-old-time')!, parent = byPart(graph, 'kimi-late')!;
  assert.equal(native.phase, 1); assert.equal(native.phase, parent.phase);
  assert.equal(native.parts.length, 2); assert.equal(byPart(graph, 'kimi-next')!.phase, 1);
  assert.ok(graph.edges.some(edge => edge.kind === 'delegate' && edge.from === parent.id && edge.to === native.id));
  assert.equal(graph.lanes.find(lane => lane.id === native.laneId)!.subtitle, 'reviewer');
});

test('lane subtitles show branch/worktree/type without duplicating state and localize output counts', () => {
  const input = fixtureInput(), graph = buildTaskMap(input);
  assert.equal(graph.lanes.find(lane => lane.id === 'agent:root')!.subtitle, undefined);
  assert.equal(graph.lanes.find(lane => lane.id === 'agent:claude')!.subtitle, 'task-map/research');
  assert.equal(graph.lanes.find(lane => lane.id === 'agent:kimi')!.subtitle, undefined);
  assert.equal(graph.lanes.find(lane => lane.kind === 'subagent')!.subtitle, 'explorer');
  assert.equal(graph.lanes.at(-1)!.subtitle, '5 outputs');
  assert.equal(buildTaskMap({ ...input, copy: zh, zh: true }).lanes.at(-1)!.subtitle, '5 项产出');
  const claude = input.sessions.find(session => session.id === 'claude')!;
  input.sessions = input.sessions.map(session => session === claude ? { ...claude, delegation: { ...claude.delegation!, branch: undefined } } : session);
  assert.equal(buildTaskMap(input).lanes.find(lane => lane.id === 'agent:claude')!.subtitle, 'Worktree');
  assert.equal(buildTaskMap({ ...input, copy: zh, zh: true }).lanes.find(lane => lane.id === 'agent:claude')!.subtitle, '工作树');
  input.sessions = input.sessions.map(session => session.id === 'claude' ? { ...session, delegation: { ...session.delegation!, workspace: 'shared', branch: 'ignored-shared-branch' } } : session);
  assert.equal(buildTaskMap(input).lanes.find(lane => lane.id === 'agent:claude')!.subtitle, undefined);
  const one = custom([item('edit', 't', [{ type: 'tool', toolName: 'Edit', status: 'completed', data: { input: { file_path: 'one.ts', old_string: 'a', new_string: 'b' } } }])]);
  assert.equal(buildTaskMap(one).lanes.at(-1)!.subtitle, '1 output');
  assert.equal(buildTaskMap({ ...one, copy: zh, zh: true }).lanes.at(-1)!.subtitle, '1 项产出');
  assert.equal(buildTaskMap(fixtureInput('empty')).lanes.at(-1)!.subtitle, '0 outputs');
});

test('fixtures use chat titles and expose the latest item time across every session', () => {
  const expected = { delegation: 123, running: 125, single: 2, long: 5_990 };
  for (const name of ['delegation', 'running', 'single', 'long', 'empty'] as const) {
    const fixture = taskMapFixture(name);
    for (const session of fixture.sessions) {
      assert.ok(session.title.trim()); assert.notEqual(session.title, `${session.provider} · ${session.id}`);
    }
    assert.equal(taskMapFixtureLastTime(fixture), name === 'empty' ? 0 : Date.parse(at(expected[name])));
  }
  const fixture = taskMapFixture('delegation');
  fixture.items.get('grok')!.push(item('latest-child', 'gt', [], { createdAt: at(900) }));
  fixture.items.get('root')!.push(item('invalid-time', 'rt', [], { createdAt: 'invalid' }));
  assert.equal(taskMapFixtureLastTime(fixture), Date.parse(at(900)));
  const next = taskMapFixtureLastTime(fixture) + 1;
  for (const items of fixture.items.values()) for (const item of items) {
    const timestamp = Date.parse(item.createdAt); if (Number.isFinite(timestamp)) assert.ok(next > timestamp);
  }
});

test('ids survive streaming updates and appended calls; model is pure and deterministic', () => {
  const input = custom([item('prompt', 't', [{ type: 'text', text: 'Read' }], { role: 'user', createdAt: at(0) }), item('tools', 't', [read()])]);
  const original = JSON.stringify({ sessions: input.sessions, items: [...input.items] });
  const before = buildTaskMap(input);
  assert.deepEqual(buildTaskMap(input), before);
  assert.equal(JSON.stringify({ sessions: input.sessions, items: [...input.items] }), original);
  input.items = new Map(input.items).set('root', [...input.items.get('root')!, item('stream-more', 't', [{ ...read('src/b.ts'), status: 'running' }])]);
  const after = buildTaskMap(input), group = before.nodes.find(node => node.kind === 'tools')!;
  assert.equal(after.nodes.find(node => node.kind === 'tools')!.id, group.id);
  assert.equal(after.nodes.find(node => node.id === group.id)!.count, 2);
  assert.equal(after.nodes.find(node => node.id === group.id)!.status, 'running');
  const stale = custom([item('stale', 't', [command('running')], { turnStatus: 'completed', elapsedMs: 100 })]);
  assert.equal(buildTaskMap(stale).nodes[0]!.status, 'done');
});

test('malformed parts are skipped or generic and never throw', () => {
  const broken = [null, {}, { type: 'plan', data: null }, { type: 'subagent', data: 'invalid' },
    { type: 'tool', toolName: 7, status: 5, data: 'not JSON' }, { type: 'tool', toolName: 'unknown', data: { input: null } },
    { type: 'approval', data: null }, { type: 'text', text: 42 }];
  const graph = buildTaskMap(custom([item('malformed', 't', broken as ChatPart[])]));
  assert.equal(graph.nodes.some(node => node.step === 'tool'), true);
  assert.equal(graph.nodes.some(node => node.kind === 'approval'), true);
});

test('a root Chat resting after its turn is done; only approvals and parent questions wait', () => {
  const lane = (session: Partial<Session>) => buildTaskMap(custom([], { sessions: [{ ...fixtureInput('single').sessions[0]!, ...session }] })).lanes[0]!.status;
  assert.equal(lane({ status: 'waiting', activity: { state: 'awaiting_input', revision: 1 } }), 'done');
  assert.equal(lane({ status: 'idle', activity: { state: 'idle', revision: 1 } }), 'done');
  assert.equal(lane({ status: 'running', activity: { state: 'idle', revision: 1 } }), 'done', 'a connected worker between turns is not running');
  assert.equal(lane({ status: 'running', activity: { state: 'running', revision: 1 } }), 'running');
  assert.equal(lane({ status: 'waiting', activity: { state: 'awaiting_approval', revision: 1 } }), 'waiting');
  assert.equal(lane({ status: 'running', activity: undefined }), 'running', 'older sessions without activity keep their status');
  assert.equal(lane({ status: 'error', activity: { state: 'idle', revision: 1 } }), 'failed');
});

test('delegation follow-up groups use the delegation labels, not the shared tool summary', () => {
  assert.equal(delegationGroupLabel(['delegate_wait'], en), 'Waited for delegates');
  assert.equal(delegationGroupLabel(['delegate_wait', 'delegate_result'], en), 'Followed delegates (2)');
  assert.equal(delegationGroupLabel(['delegate_wait', 'delegate_result'], zh), '跟进委派（2）');
  const graph = buildTaskMap(fixtureInput('delegation'));
  for (const node of graph.nodes.filter(node => node.kind === 'tools' && node.step === 'delegation')) assert.match(node.label, /delegate/i, node.id);
});
