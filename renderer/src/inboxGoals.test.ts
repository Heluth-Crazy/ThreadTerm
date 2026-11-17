import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, InboxItem, Session, SessionDelegationState } from '@threadterm/protocol';
import { acceptanceEvidence, inboxWorkbench, isGoalParent, pendingApprovalOf } from './inboxGoals';

const session = (id: string, updatedAt: string, extra: Partial<Session> = {}): Session => ({
  id, title: id, provider: 'codex', mode: 'chat', status: 'running', createdAt: '2026-11-01T00:00:00Z', updatedAt, ...extra,
});

const delegate = (id: string, updatedAt: string, state: SessionDelegationState, extra: Partial<Session> = {}): Session =>
  session(id, updatedAt, { delegation: { id: `d-${id}`, parentSessionId: 'goal', workspace: 'shared', state }, ...extra });

const inboxItem = (over: Partial<InboxItem> & { id: string; sessionId: string }): InboxItem => ({
  kind: 'approval', title: over.id, createdAt: '2026-11-02T00:00:00Z', read: false, ...over,
});

const commandPart = (command: string, exitCode: number | undefined, status: string): ChatItem['parts'][number] => ({
  type: 'tool', toolName: 'Bash', status,
  data: { input: { command }, ...(exitCode === undefined ? {} : { exitCode }) },
});

const item = (id: string, role: ChatItem['role'], turnId: string, parts: ChatItem['parts']): ChatItem => ({
  id, role, turnId, parts, createdAt: '2026-11-02T00:00:00Z',
});

test('a goal is a top-level chat with delegates; chats without children, delegates and archived chats are not', () => {
  const sessions = [
    session('goal', '2026-11-02T00:00:00Z'),
    delegate('child', '2026-11-02T01:00:00Z', 'running'),
    session('lonely', '2026-11-02T00:00:00Z'),
    session('archived goal', '2026-11-02T00:00:00Z', { archived: true }),
    session('archived goal child', '2026-11-02T00:00:00Z', { delegation: { id: 'd-a', parentSessionId: 'archived goal', workspace: 'shared', state: 'running' } }),
    session('terminal', '2026-11-02T00:00:00Z', { mode: 'terminal' }),
  ];
  assert.equal(isGoalParent(sessions[0]!), true);
  assert.equal(isGoalParent(sessions[1]!), false);
  const workbench = inboxWorkbench({ sessions, inbox: [] });
  assert.deepEqual(workbench.goals.map(goal => goal.parent.id), ['goal']);
  assert.deepEqual(workbench.goals[0]!.children.map(child => child.id), ['child']);
});

test('a goal leaves the page once its subtasks are over and handled', () => {
  const done = (id: string, parent: string, state: SessionDelegationState, acceptance?: 'accepted' | 'sent_back') =>
    session(id, '2026-11-02T00:00:00Z', { delegation: { id: `d-${id}`, parentSessionId: parent, workspace: 'shared', state, ...(acceptance ? { acceptance } : {}) } });
  const sessions = [
    session('handled', '2026-11-01T00:00:00Z'),
    done('handled kid', 'handled', 'completed', 'accepted'),
    done('handled failed', 'handled', 'failed'),
    session('waiting', '2026-11-01T00:00:00Z'),
    done('waiting kid', 'waiting', 'awaiting_user'),
    session('to accept', '2026-11-01T00:00:00Z'),
    done('to accept kid', 'to accept', 'completed'),
  ];
  const workbench = inboxWorkbench({ sessions, inbox: [] });
  assert.deepEqual(workbench.goals.map(goal => goal.parent.id).sort(), ['to accept', 'waiting']);
  assert.equal(workbench.processed, 0, 'a hidden goal does not count');
  const kept = inboxWorkbench({ sessions, inbox: [], includeGoalIds: ['handled'] });
  assert.ok(kept.goals.some(goal => goal.parent.id === 'handled'), 'a goal the composer just created stays');
});

test('a just-created chat is listed while it has no delegate yet', () => {
  const created = session('new goal', '2026-11-02T00:00:00Z');
  const workbench = inboxWorkbench({ sessions: [created], inbox: [], includeGoalIds: ['new goal'] });
  assert.deepEqual(workbench.goals.map(goal => goal.parent.id), ['new goal']);
  assert.deepEqual(workbench.goals[0]!.children, []);
});

test('goals with a pending decision come first, then the newest child change', () => {
  const sessions = [
    session('quiet goal', '2026-11-01T00:00:00Z'),
    delegate('quiet child', '2026-11-09T00:00:00Z', 'running', { delegation: { id: 'd-quiet', parentSessionId: 'quiet goal', workspace: 'shared', state: 'running' } }),
    session('busy goal', '2026-11-01T00:00:00Z'),
    delegate('busy child', '2026-11-02T00:00:00Z', 'running', { delegation: { id: 'd-busy', parentSessionId: 'busy goal', workspace: 'shared', state: 'running' } }),
  ];
  const inbox = [inboxItem({ id: 'busy:approval:a1', sessionId: 'busy child' })];
  const workbench = inboxWorkbench({ sessions, inbox });
  assert.deepEqual(workbench.goals.map(goal => goal.parent.id), ['busy goal', 'quiet goal'], 'a decision outranks a newer change');
  assert.deepEqual(workbench.goals[0]!.decisions.map(row => row.item.id), ['busy:approval:a1']);
  const withoutDecision = inboxWorkbench({ sessions, inbox: [] });
  assert.deepEqual(withoutDecision.goals.map(goal => goal.parent.id), ['quiet goal', 'busy goal']);
});

test('decisions are approvals on the parent or a child; other kinds are notices; read items are gone', () => {
  const sessions = [session('goal', '2026-11-01T00:00:00Z'), delegate('child', '2026-11-02T00:00:00Z', 'awaiting_user')];
  const inbox = [
    inboxItem({ id: 'goal:approval:parent', sessionId: 'goal', createdAt: '2026-11-02T01:00:00Z' }),
    inboxItem({ id: 'child:approval:kid', sessionId: 'child', createdAt: '2026-11-02T02:00:00Z' }),
    inboxItem({ id: 'child:autowake_exhausted:x', sessionId: 'child', kind: 'autowake_exhausted' }),
    inboxItem({ id: 'child:quiet:1', sessionId: 'child', kind: 'quiet' }),
    inboxItem({ id: 'child:approval:read', sessionId: 'child', read: true }),
    inboxItem({ id: 'child:stalled:1', sessionId: 'child', kind: 'stalled' }),
    inboxItem({ id: 'child:reply:1', sessionId: 'child', kind: 'reply' }),
  ];
  const workbench = inboxWorkbench({ sessions, inbox });
  const goal = workbench.goals[0]!;
  assert.deepEqual(goal.decisions.map(row => row.item.id), ['child:approval:kid', 'goal:approval:parent'], 'newest decision first');
  assert.deepEqual(goal.notices.map(row => row.item.id).sort(), ['child:autowake_exhausted:x', 'child:quiet:1'], 'read, stalled and reply items never reach the page');
  assert.equal(goal.pending, 4);
  assert.equal(workbench.pending, 4);
  assert.deepEqual(workbench.other, [], 'a goal session is not repeated in 其他会话');
});

test('acceptance lists finished delegates without a decision and counts the processed ones', () => {
  const sessions = [
    session('goal', '2026-11-01T00:00:00Z'),
    delegate('done', '2026-11-02T00:00:00Z', 'completed', { delegation: { id: 'd-done', parentSessionId: 'goal', workspace: 'shared', state: 'completed', outcome: 'all tests pass' } }),
    delegate('accepted', '2026-11-03T00:00:00Z', 'completed', { delegation: { id: 'd-accepted', parentSessionId: 'goal', workspace: 'shared', state: 'completed', acceptance: 'accepted' } }),
    delegate('sent back', '2026-11-04T00:00:00Z', 'completed', { delegation: { id: 'd-sent', parentSessionId: 'goal', workspace: 'shared', state: 'completed', acceptance: 'sent_back' } }),
    delegate('failed', '2026-11-05T00:00:00Z', 'failed'),
    delegate('running', '2026-11-06T00:00:00Z', 'running'),
    delegate('archived done', '2026-11-07T00:00:00Z', 'completed', { archived: true }),
  ];
  const workbench = inboxWorkbench({ sessions, inbox: [] });
  const goal = workbench.goals[0]!;
  assert.deepEqual(goal.acceptances.map(row => row.delegationId), ['d-done']);
  assert.equal(goal.processed, 2);
  assert.equal(goal.pending, 1);
  assert.equal(workbench.processed, 2);
  assert.equal(goal.activity?.child.id, 'running', 'the activity line is the newest visible child change');
});

test('a session in no goal is grouped under 其他会话 with the same decision rows', () => {
  const sessions = [session('goal', '2026-11-01T00:00:00Z'), delegate('child', '2026-11-02T00:00:00Z', 'running'), session('lonely', '2026-11-03T00:00:00Z')];
  const inbox = [
    inboxItem({ id: 'lonely:approval:a', sessionId: 'lonely', createdAt: '2026-11-03T01:00:00Z' }),
    inboxItem({ id: 'child:approval:b', sessionId: 'child' }),
    inboxItem({ id: 'gone:approval:c', sessionId: 'deleted session' }),
  ];
  const workbench = inboxWorkbench({ sessions, inbox });
  assert.deepEqual(workbench.other.map(group => group.session.id), ['lonely']);
  assert.deepEqual(workbench.other[0]!.decisions.map(row => row.item.id), ['lonely:approval:a']);
  assert.equal(workbench.other[0]!.pending, 1);
  assert.equal(workbench.pending, 2, 'an item whose session is gone cannot be drawn or counted');
});

test('evidence is the last two commands of the delegated turn, with their exit codes', () => {
  const items = [
    item('u1', 'user', 'turn-1', [{ type: 'text', text: 'fix it' }]),
    item('a1', 'assistant', 'turn-1', [commandPart('npm run typecheck', 0, 'complete'), commandPart('cargo test --lib chat', 1, 'failed'), commandPart('node scripts/check.mjs', undefined, 'running')]),
    item('old', 'assistant', 'turn-0', [commandPart('git status', 0, 'complete')]),
  ];
  const evidence = acceptanceEvidence(items);
  assert.deepEqual(evidence.map(row => [row.command, row.exitCode, row.failed]), [
    ['cargo test --lib chat', 1, true],
    ['node scripts/check.mjs', undefined, false],
  ]);
  assert.deepEqual(acceptanceEvidence(items, 1).map(row => row.command), ['node scripts/check.mjs']);
  assert.equal(evidence[0]!.status, 'failed');
});

test('evidence is empty when the delegated turn ran no command', () => {
  assert.deepEqual(acceptanceEvidence([item('u1', 'user', 'turn-1', [{ type: 'text', text: 'read only' }])]), []);
});

test('a decision item resolves to its own chat item first, then to the newest pending part', () => {
  const pending = (approvalId: string): ChatItem['parts'][number] => ({ type: 'approval', approvalId, status: 'pending' });
  const resolved = (approvalId: string): ChatItem['parts'][number] => ({ type: 'approval', approvalId, status: 'resolved' });
  const items = [
    item('goal:approval:first', 'assistant', 'turn-1', [resolved('a1')]),
    item('goal:approval:second', 'assistant', 'turn-2', [pending('a2')]),
    item('goal:approval:stale', 'assistant', 'turn-3', [resolved('a3')]),
  ];
  assert.equal(pendingApprovalOf(items, 'goal:approval:second')?.part.approvalId, 'a2');
  assert.equal(pendingApprovalOf(items, 'goal:approval:stale')?.part.approvalId, 'a2', 'a settled item falls back to the newest pending part');
  assert.equal(pendingApprovalOf(items, 'not loaded')?.part.approvalId, 'a2', 'an item the page never loaded still shows the newest pending part');
  assert.equal(pendingApprovalOf([items[0]!], 'goal:approval:first'), undefined);
});
