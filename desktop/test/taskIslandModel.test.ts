import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem, ChatPart, Project, Session } from '@threadterm/protocol';
import type { MachineTree, MachineTreeSessionMetadata } from '../../renderer/src/machineTypes.js';
import type { IslandItem } from '../../renderer/src/island/model.js';
import {
  fullscreenState, IslandTracker, islandHandlesToasts, islandKey, islandPreferences, islandSources, islandVisible, liveState,
  pendingApproval, resultLine, taskbarBadge, type IslandSource,
} from '../src/taskIslandModel.js';

/* The task island's pure decisions (desktop/src/taskIslandModel.ts), tested without Electron. */

const session = (overrides: Partial<MachineTreeSessionMetadata> = {}): MachineTreeSessionMetadata => ({
  id: 's1', title: 'Fix the build', provider: 'codex', mode: 'chat', status: 'running',
  createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z',
  activity: { state: 'running', revision: 1 }, ...overrides,
} as MachineTreeSessionMetadata);
const project = (id: string, name: string): Project => ({ id, name, path: `D:/projects/${id}`, createdAt: '2026-11-16T00:00:00.000Z' });
const tree = (sessions: MachineTreeSessionMetadata[], options: { local?: boolean; name?: string; projects?: Project[] } = {}): MachineTree => ({
  machine: { id: options.local === false ? 'orbit' : 'local', name: options.name ?? 'This PC', color: 'blue', state: 'connected' },
  projects: options.projects ?? [], worktrees: [], sessions: sessions.map(entry => ({ session: entry, needsYou: 0 })), needsYou: 0,
});
const raw = (id: string, codeReview?: boolean): Session => ({ id, ...(codeReview === undefined ? {} : { codeReview: {} }) } as unknown as Session);
const source = (overrides: Partial<IslandSource> = {}): IslandSource => ({
  key: islandKey('local', 's1'), machineId: 'local', sessionId: 's1', mode: 'chat', title: 'Fix the build', provider: 'codex',
  providerName: 'Codex', state: 'running', updatedAt: 0, ...overrides,
});
const liveItem = (overrides: Partial<IslandItem> = {}): IslandItem => ({
  key: islandKey('local', 's1'), machineId: 'local', sessionId: 's1', title: 'Fix the build', provider: 'codex', providerName: 'Codex',
  state: 'running', since: 0, ...overrides,
});
const text = (value: string, phase?: 'commentary' | 'final_answer'): ChatPart => ({ type: 'text', text: value, ...(phase ? { phase } : {}) });
const item = (overrides: Partial<ChatItem> = {}): ChatItem => ({ id: 'i1', role: 'assistant', parts: [], createdAt: '2026-11-16T00:00:00.000Z', ...overrides });

test('the island is on by default, expands on alerts, leaves toasts standard, and badges the taskbar', () => {
  assert.deepEqual(islandPreferences(undefined), { enabled: true, alert: true, toasts: false, badge: true });
  assert.deepEqual(islandPreferences({}), { enabled: true, alert: true, toasts: false, badge: true });
  assert.deepEqual(islandPreferences({ island: false, islandAlert: false, islandToasts: true, taskbarBadge: false }),
    { enabled: false, alert: false, toasts: true, badge: false });
  assert.deepEqual(islandPreferences('nonsense'), { enabled: true, alert: true, toasts: false, badge: true }, 'an unreadable setting reads as the defaults');
});

test('the island carries session toasts only while it is on, out of lightweight mode, and not asked to double up', () => {
  const preferences = islandPreferences(undefined);
  assert.equal(islandHandlesToasts(preferences, false), true);
  assert.equal(islandHandlesToasts(preferences, true), false, 'lightweight mode draws no island, so toasts stay');
  assert.equal(islandHandlesToasts(islandPreferences({ island: false }), false), false);
  assert.equal(islandHandlesToasts(islandPreferences({ islandToasts: true }), false), false, 'the user asked for both');
});

test('the island is up only in the background, with something on it, outside full-screen apps and lightweight mode', () => {
  const base = { preferences: islandPreferences(undefined), lightweight: false, appFocused: false, fullscreen: false, items: 1 };
  assert.equal(islandVisible(base), true);
  for (const change of [{ appFocused: true }, { fullscreen: true }, { lightweight: true }, { items: 0 }, { preferences: islandPreferences({ island: false }) }]) {
    assert.equal(islandVisible({ ...base, ...change }), false, JSON.stringify(change));
  }
});

test('only the full-screen and presentation words hide the island; an unknown answer never does', () => {
  for (const state of ['busy', 'fullscreen', 'presentation']) assert.equal(fullscreenState(state), true, state);
  for (const state of ['acceptsNotifications', 'quietTime', 'unknown', undefined, 'runningD3DFullScreen']) assert.equal(fullscreenState(state), false, String(state));
});

test('a session that ended, is read-only or is plain idle shows nothing; waiting and running do', () => {
  assert.equal(liveState(session()), 'running');
  assert.equal(liveState(session({ activity: { state: 'awaiting_approval', revision: 2 } })), 'approval');
  assert.equal(liveState(session({ activity: { state: 'awaiting_input', revision: 3 } })), 'input');
  assert.equal(liveState(session({ activity: { state: 'idle', revision: 4 } })), undefined);
  assert.equal(liveState(session({ readOnly: true })), undefined);
  for (const status of ['exited', 'interrupted', 'error'] as const) assert.equal(liveState(session({ status })), undefined, status);
});

test('without an activity report a Chat session falls back to its status, while a terminal stays quiet', () => {
  assert.equal(liveState(session({ activity: undefined, status: 'waiting' })), 'approval');
  assert.equal(liveState(session({ activity: undefined, status: 'running' })), 'running');
  assert.equal(liveState(session({ activity: undefined, status: 'waiting', mode: 'terminal' })), undefined);
});

test('the tree contributes unarchived, live sessions with their project, provider and computer', () => {
  const sources = islandSources(
    tree([
      session({ id: 'a', title: 'Ship it', projectId: 'p1', terminalAgent: 'claude' }),
      session({ id: 'b', archived: true }),
      session({ id: 'c', activity: { state: 'idle', revision: 5 } }),
    ], { local: false, name: 'Orbit', projects: [project('p1', 'ThreadTerm')] }),
    [],
    [{ id: 'codex', name: 'Codex CLI' }],
  );
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0], {
    key: islandKey('orbit', 'a'), machineId: 'orbit', sessionId: 'a', machineName: 'Orbit', mode: 'chat', title: 'Ship it',
    project: 'ThreadTerm', provider: 'claude', providerName: 'Codex CLI', state: 'running', updatedAt: Date.parse('2026-11-16T00:00:00.000Z'),
  });
});

test('this PC has no computer name and a provider without a title falls back to its id', () => {
  const [entry] = islandSources(tree([session({ id: 'a' })]), [], []);
  assert.equal(entry?.machineName, undefined);
  assert.equal(entry?.providerName, 'codex');
  assert.equal(entry?.project, undefined);
});

test('a delegated agent or a code reviewer only shows its requests for the user, never its running turn', () => {
  const delegate = session({ id: 'd', delegation: { parentSessionId: 'p', state: 'running' } });
  const reviewer = session({ id: 'r' });
  const sessions = tree([delegate, reviewer]);
  const running = islandSources(sessions, [raw('r', true)], []);
  assert.deepEqual(running, [], 'their running turns belong to the agent that started them');

  delegate.activity = { state: 'awaiting_approval', revision: 9 };
  reviewer.activity = { state: 'awaiting_approval', revision: 9 };
  const waiting = islandSources(sessions, [raw('r', true)], []);
  assert.deepEqual(waiting.map(entry => entry.sessionId).sort(), ['d', 'r'], 'their approvals still reach the user');
});

test('a running session is measured from the runtime’s last update when the island meets it mid-turn', () => {
  const tracker = new IslandTracker();
  const now = Date.parse('2026-11-16T12:00:00.000Z');
  tracker.update([source({ state: 'running', updatedAt: now - 120_000 })], now);
  const [entry] = tracker.items();
  assert.equal(entry?.state, 'running');
  assert.equal(entry?.since, now - 120_000);
  assert.equal(entry?.started, now - 120_000);
  // A source with no usable time starts the elapsed clock now rather than at the epoch.
  const second = new IslandTracker();
  second.update([source({ updatedAt: 0 })], now);
  assert.equal(second.items()[0]?.since, now);
  assert.equal(second.items()[0]?.started, now);
});

test('waiting moves the elapsed display to the wait, and going back to running restores the turn start', () => {
  const tracker = new IslandTracker();
  assert.deepEqual(tracker.update([source()], 1000), []);
  assert.equal(tracker.items()[0]?.since, 1000);
  assert.deepEqual(tracker.update([source({ state: 'approval' })], 5000), [source().key], 'a new wait is worth reading the approval');
  assert.equal(tracker.items()[0]?.state, 'approval');
  assert.equal(tracker.items()[0]?.since, 5000);
  assert.deepEqual(tracker.update([source({ state: 'running' })], 9000), []);
  assert.equal(tracker.items()[0]?.since, 1000, 'the running clock is the turn, not the wait');
});

test('an approval read is kept while the session waits and dropped as soon as it runs again', () => {
  const tracker = new IslandTracker();
  const approval: ChatPart = { type: 'approval', approvalId: 'a1', status: 'pending', data: { approvalId: 'a1', title: 'Run tests' } };
  tracker.update([source({ state: 'approval' })], 1000);
  assert.equal(tracker.setApproval(source().key, approval), true);
  assert.equal(tracker.items()[0]?.approval, approval);
  assert.equal(tracker.setApproval('missing', approval), false, 'only a live waiting session takes one');
  tracker.update([source({ state: 'running' })], 2000);
  assert.equal(tracker.items()[0]?.approval, undefined, 'the approval is resolved once the agent works');
  assert.equal(tracker.setApproval(source().key, approval), false, 'a running session has nothing to show');
});

test('only a session the island saw working can announce a finished turn', () => {
  const tracker = new IslandTracker();
  assert.equal(tracker.finish('local\u0000other', 'done', 1000, 4000), false);
  tracker.update([source()], 1000);
  assert.equal(tracker.finish(source().key, 'done', 2000, 4000), true);
  const [finished] = tracker.items();
  assert.equal(finished?.state, 'done');
  assert.equal(finished?.since, 2000);
  assert.equal(finished?.started, 1000, 'the duration ends where the turn started');
  assert.equal(tracker.finish(source().key, 'error', 3000, 4000), true, 'a failure replaces the same session’s announcement');
  assert.equal(tracker.items()[0]?.state, 'error');
});

test('a reply that lands a moment after the activity goes idle still announces the turn', () => {
  const tracker = new IslandTracker();
  tracker.update([source()], 0);
  tracker.update([], 1000);
  assert.deepEqual(tracker.items(), [], 'nothing live is left');
  assert.equal(tracker.finish(source().key, 'done', 30_000, 4000), true, 'inside the recent window');
  const late = new IslandTracker();
  late.update([source()], 0);
  late.update([], 0);
  late.update([], 60_001);
  assert.equal(late.finish(source().key, 'done', 60_001, 4000), false, 'after a minute the session is forgotten');
});

test('a finished announcement expires on its own and reports when the next one is due', () => {
  const tracker = new IslandTracker();
  tracker.update([source()], 0);
  tracker.finish(source().key, 'done', 1000, 5000);
  assert.equal(tracker.nextExpiry(), 6000);
  assert.equal(tracker.expire(5999), false);
  assert.equal(tracker.items().length, 1);
  assert.equal(tracker.expire(6000), true);
  assert.deepEqual(tracker.items(), []);
  assert.equal(tracker.nextExpiry(), undefined);
});

test('a result line attaches to the finished item, and the next turn replaces it with a running one', () => {
  const tracker = new IslandTracker();
  tracker.update([source()], 0);
  tracker.finish(source().key, 'done', 1000, 5000);
  assert.equal(tracker.setResult(source().key, 'All tests pass.'), true);
  assert.equal(tracker.items()[0]?.result, 'All tests pass.');
  assert.equal(tracker.setResult('local\u0000other', 'nope'), false);
  tracker.update([source({ updatedAt: 9000 })], 10_000);
  const [working] = tracker.items();
  assert.equal(working?.state, 'running', 'the finished card is replaced when the session works again');
  assert.equal(working?.result, undefined);
});

test('a reply that arrives before the activity goes idle keeps its finished card on screen', () => {
  const tracker = new IslandTracker();
  tracker.update([source({ updatedAt: 500 })], 0);
  tracker.finish(source().key, 'done', 1000, 5000);
  // The tree still reports the old running turn: not a new turn, so the announcement stays and no pill comes back.
  tracker.update([source({ updatedAt: 400 })], 1200);
  assert.deepEqual(tracker.items().map(entry => entry.state), ['done']);
  // Needing the user outranks the card: the hidden entry asking for approval shows at once.
  assert.deepEqual(tracker.update([source({ updatedAt: 400, state: 'approval' })], 1500), [source().key]);
  assert.deepEqual(tracker.items().map(entry => entry.state), ['approval']);
});

test('a session that asks for the user right after finishing replaces its finished card', () => {
  const tracker = new IslandTracker();
  tracker.update([source({ updatedAt: 500 })], 0);
  tracker.finish(source().key, 'done', 1000, 5000);
  tracker.update([], 1100);
  assert.deepEqual(tracker.update([source({ updatedAt: 900, state: 'input' })], 1300), [source().key]);
  assert.deepEqual(tracker.items().map(entry => entry.state), ['input']);
});

test('remembers whether a finished session was a Chat or a terminal', () => {
  const tracker = new IslandTracker();
  tracker.update([source({ mode: 'terminal' })], 0);
  assert.equal(tracker.mode(source().key), 'terminal');
  tracker.update([], 1000);
  assert.equal(tracker.mode(source().key), 'terminal', 'a reply arrives after the activity goes idle');
  assert.equal(tracker.mode('local\u0000other'), undefined);
});

test('items are ordered by when each began and carry no expiry field', () => {
  const tracker = new IslandTracker();
  const a = source({ key: islandKey('local', 'a'), sessionId: 'a' }), b = source({ key: islandKey('local', 'b'), sessionId: 'b' });
  tracker.update([b, a], 1000);
  tracker.update([a, { ...b, state: 'approval' }], 3000);
  assert.deepEqual(tracker.items().map(entry => entry.sessionId), ['a', 'b']);
  assert.equal('until' in (tracker.items()[0] ?? {}), false);
});

test('the newest pending approval is the one the island words', () => {
  const first: ChatPart = { type: 'approval', approvalId: 'a1', status: 'pending', data: {} };
  const answered: ChatPart = { type: 'approval', approvalId: 'a2', status: 'resolved', data: {} };
  const newest: ChatPart = { type: 'approval', approvalId: 'a3', status: 'pending', data: {} };
  assert.equal(pendingApproval([item({ parts: [first] }), item({ id: 'i2', parts: [answered] }), item({ id: 'i3', parts: [newest] })]), newest);
  assert.equal(pendingApproval([item({ parts: [answered] })]), undefined);
  assert.equal(pendingApproval([]), undefined);
});

test('an oversized approval keeps its identity and title and drops the bulk', () => {
  const huge: ChatPart = {
    type: 'approval', approvalId: 'a1', status: 'pending',
    data: { approvalId: 'a1', title: 'Apply this plan', interaction: 'plan', requestType: 'plan', diff: 'x'.repeat(4000) },
  };
  const trimmed = pendingApproval([item({ parts: [huge] })], 500);
  assert.deepEqual(trimmed, { type: 'approval', approvalId: 'a1', status: 'pending', data: { approvalId: 'a1', title: 'Apply this plan', interaction: 'plan', requestType: 'plan' } });
  assert.equal(pendingApproval([item({ parts: [huge] })], 24_000), huge, 'a reasonable approval is passed through untouched');
});

test('a finished reply reads as one plain line, preferring the final answer', () => {
  const items = [
    item({ id: 'u', role: 'user', parts: [text('please fix the build')] }),
    item({ id: 'a1', parts: [text('Looking at the failing test.')] }),
    item({ id: 'a2', parts: [text('Checking the log.'), text('**The build is fixed.** See [the diff](https://example.com/1).', 'final_answer')] }),
  ];
  assert.equal(resultLine(items, 'done'), 'The build is fixed. See the diff.');
});

test('markdown, list markers and code fences do not reach the island', () => {
  assert.equal(resultLine([item({ parts: [text('```sh\nnpm test\n```\n1. Ran the suite')] })], 'done'), 'Ran the suite');
  assert.equal(resultLine([item({ parts: [text('## Summary\n- Added the guard\n- Updated the test')] })], 'done'), 'Summary');
  assert.equal(resultLine([item({ parts: [text('`no colour` #tag')] })], 'done'), 'no colour tag');
});

test('a long result is cut with an ellipsis and a missing one reads as undefined', () => {
  const line = resultLine([item({ parts: [text('a'.repeat(200))] })], 'done', 40);
  assert.equal(line?.length, 40);
  assert.match(line ?? '', /…$/);
  assert.equal(resultLine([item({ parts: [text('   ')] })], 'done'), undefined);
  assert.equal(resultLine([item({ role: 'user', parts: [text('hi')] })], 'done'), undefined);
  assert.equal(resultLine([], 'done'), undefined);
});

test('a failed turn shows the error’s own message', () => {
  const items = [
    item({ id: 'a1', parts: [text('I will run the tests.')] }),
    item({ id: 'a2', parts: [{ type: 'error', text: '  provider exited with code 1  ' }] }),
  ];
  assert.equal(resultLine(items, 'error'), 'provider exited with code 1');
  assert.equal(resultLine(items, 'done'), 'I will run the tests.', 'a reply ignores error parts');
});

test('a needs-you session outranks a running one on the taskbar', () => {
  assert.equal(taskbarBadge([]), undefined);
  assert.equal(taskbarBadge([liveItem()]), 'running');
  assert.equal(taskbarBadge([liveItem({ state: 'done' })]), undefined);
  assert.equal(taskbarBadge([liveItem({ state: 'error' })]), undefined);
  assert.equal(taskbarBadge([liveItem(), liveItem({ key: 'x', state: 'approval' })]), 'needs');
  assert.equal(taskbarBadge([liveItem({ state: 'input' })]), 'needs');
});
