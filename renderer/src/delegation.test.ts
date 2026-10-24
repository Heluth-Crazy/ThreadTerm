import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, Session, SessionDelegationState } from '@threadterm/protocol';
import { attachedMessagesLabel, authorityLabel, wideningRequestLabel, delegateOutcomePreview, delegationActive, delegationTool, delegationToolLabel, delegationStateLabel, delegationStateSummary, delegationStripVisible, nestedDelegateIds, withDelegates } from './delegation';

const session = (id: string, createdAt: string, parent?: string, branch?: string): Session => ({
  id, title: id, provider: 'codex', mode: 'chat', status: 'running', createdAt, updatedAt: createdAt,
  ...(parent ? { delegation: { id: `d-${id}`, parentSessionId: parent, workspace: branch ? 'worktree' : 'shared', branch, state: 'running' } } : {}),
});

const delegate = (id: string, state: SessionDelegationState): Session => {
  const item = session(id, '2026-10-20T10:00:00Z', 'parent');
  return { ...item, delegation: { ...item.delegation!, state } };
};

test('strip summary orders attention first and combines starting and running in both languages', () => {
  const states: SessionDelegationState[] = ['completed', 'cancelled', 'starting', 'failed', 'awaiting_parent', 'running', 'awaiting_user', 'completed', 'completed'];
  const delegates = states.map((state, index) => delegate(String(index), state));
  const en = (english: string) => english, zh = (_english: string, chinese: string) => chinese;
  assert.deepEqual(delegationStateSummary(delegates, en), [
    { state: 'awaiting_user', label: '1 needs you' },
    { state: 'awaiting_parent', label: '1 waiting for parent' },
    { state: 'running', label: '2 running' },
    { state: 'failed', label: '1 failed' },
    { state: 'cancelled', label: '1 cancelled' },
    { state: 'completed', label: '3 completed' },
  ]);
  assert.deepEqual(delegationStateSummary(delegates, zh).map(group => group.label), [
    '1 个待你处理', '1 个等待委派方', '2 个执行中', '1 个失败', '1 个已取消', '3 个已完成',
  ]);
  assert.equal(delegationStateSummary([delegate('a', 'awaiting_user'), delegate('b', 'awaiting_user')], en)[0].label, '2 need you');
  assert.deepEqual(delegationStateSummary([], en), []);
});

test('a hidden finished set stays hidden, even when reordered or reduced', () => {
  const finished = [delegate('a', 'completed'), delegate('b', 'failed'), delegate('c', 'cancelled')];
  assert.equal(delegationStripVisible(['a', 'b', 'c'], finished), false);
  assert.equal(delegationStripVisible(['a', 'b', 'c'], [...finished].reverse()), false);
  assert.equal(delegationStripVisible(['a', 'b', 'c'], finished.slice(1)), false);
  assert.equal(delegationStripVisible(undefined, []), false);
  assert.equal(delegationStripVisible([], []), false);
});

test('a new delegate or renewed activity brings the strip back', () => {
  const finished = delegate('a', 'completed');
  assert.equal(delegationStripVisible(undefined, [finished]), true);
  assert.equal(delegationStripVisible(['a'], [finished, delegate('new', 'completed')]), true);
  for (const state of ['starting', 'running', 'awaiting_parent', 'awaiting_user'] as const) {
    assert.equal(delegationStripVisible(['a'], [delegate('a', state)]), true, state);
  }
});

test('delegates follow their parent in creation order, wherever their folder is listed', () => {
  const parent = session('parent', '2026-10-01T10:00:00Z');
  const other = session('other', '2026-10-01T09:00:00Z');
  const second = session('second', '2026-10-01T10:02:00Z', 'parent');
  const first = session('first', '2026-10-01T10:01:00Z', 'parent', 'threadterm/delegate-codex-1');
  const all = [other, second, parent, first];
  // The worktree delegate's own folder list does not repeat it; it sits under its parent.
  assert.deepEqual(withDelegates([other, parent], all).map(item => item.id), ['other', 'parent', 'first', 'second']);
  assert.deepEqual(withDelegates([first], all).map(item => item.id), []);
  assert.deepEqual([...nestedDelegateIds(all)].sort(), ['first', 'second']);
});

test('a delegate whose parent is not shown stays a normal row', () => {
  const orphan = session('orphan', '2026-10-01T10:00:00Z', 'archived-parent');
  assert.deepEqual(withDelegates([orphan], [orphan]).map(item => item.id), ['orphan']);
  assert.equal(nestedDelegateIds([orphan]).size, 0);
});

test('delegation states are bilingual and only unfinished ones are active', () => {
  assert.equal(delegationStateLabel('awaiting_parent', false), 'Waiting for parent agent');
  assert.equal(delegationStateLabel('awaiting_parent', true), '等待委派方');
  assert.equal(delegationStateLabel('awaiting_user', true), '待你处理');
  assert.ok(delegationActive('awaiting_user'));
  assert.ok(!delegationActive('completed'));
  assert.ok(!delegationActive('cancelled'));
});

test('a stop that is not observed yet, or was refused, is its own visible state', () => {
  // The delegate may still be working, so both hold the slot and keep the card open.
  assert.ok(delegationActive('cancelling'));
  assert.ok(delegationActive('cancel_failed'));
  assert.ok(!delegationActive('interrupted'));
  assert.equal(delegationStateLabel('cancelling', false), 'Stopping');
  assert.equal(delegationStateLabel('cancelling', true), '停止中');
  assert.equal(delegationStateLabel('cancel_failed', false), 'Stop failed');
  assert.equal(delegationStateLabel('cancel_failed', true), '停止失败');
  assert.equal(delegationStateLabel('interrupted', false), 'Interrupted');
  assert.equal(delegationStateLabel('interrupted', true), '已中断');
  const en = (english: string) => english, zh = (_english: string, chinese: string) => chinese;
  const stopping = [delegate('a', 'cancel_failed'), delegate('b', 'cancelling'), delegate('c', 'interrupted')];
  assert.deepEqual(delegationStateSummary(stopping, en), [
    { state: 'cancel_failed', label: '1 stop failed' },
    { state: 'cancelling', label: '1 stopping' },
    { state: 'interrupted', label: '1 interrupted' },
  ]);
  assert.deepEqual(delegationStateSummary(stopping, zh).map(group => group.label), ['1 个停止失败', '1 个停止中', '1 个已中断']);
  // A stop request and an interruption are new activity on a hidden strip.
  for (const state of ['cancelling', 'cancel_failed'] as const) {
    assert.equal(delegationStripVisible(['a'], [delegate('a', state)]), true, state);
  }
  assert.equal(delegationStripVisible(['a'], [delegate('a', 'interrupted')]), false);
});

test("a delegate card says how many of the user's messages were attached, in both languages", () => {
  const en = (english: string) => english, zh = (_english: string, chinese: string) => chinese;
  assert.equal(attachedMessagesLabel(3, en).label, '3 of your messages attached');
  assert.equal(attachedMessagesLabel(1, zh).label, '已附上你的 1 条消息');
  assert.match(attachedMessagesLabel(2, en).title, /word for word/);
  assert.match(attachedMessagesLabel(2, zh).title, /原样/);
});

test('a finished delegate previews its answer, or the error it failed with', () => {
  const item = (role: ChatItem['role'], ...parts: ChatItem['parts']): ChatItem => ({ id: `${role}-${parts.length}`, role, parts, createdAt: '2026-10-02T10:00:00Z' });
  const answered = [
    item('user', { type: 'text', text: 'Delegated prompt' }),
    item('assistant', { type: 'thinking', text: 'thinking' }, { type: 'text', text: '  DONE  ' }),
  ];
  assert.equal(delegateOutcomePreview(answered, false), 'DONE');
  const failed = [...answered, item('assistant', { type: 'error', text: 'Authentication required: 403 quota' })];
  assert.equal(delegateOutcomePreview(failed, true), 'Authentication required: 403 quota');
  assert.equal(delegateOutcomePreview(failed, false), 'DONE', 'a completed delegate never previews an error');
  assert.equal(delegateOutcomePreview(answered, true), 'DONE', 'a failed delegate without an error part keeps its last text');
  assert.equal(delegateOutcomePreview([item('user', { type: 'text', text: 'only the prompt' })], false), undefined);
  assert.equal(delegateOutcomePreview([item('assistant', { type: 'text', text: 'x'.repeat(300) })], false), `${'x'.repeat(280)}…`);
});

test("ThreadTerm's own delegation tools are recognised in every agent's tool-call shape", () => {
  assert.equal(delegationTool({ toolName: 'mcp__threadterm__delegate_wait' }), 'delegate_wait');
  assert.equal(delegationTool({ toolName: 'threadterm__delegate_start' }), 'delegate_start');
  assert.equal(delegationTool({ toolName: 'mcpToolCall', data: { type: 'mcpToolCall', server: 'threadterm', tool: 'delegate_respond' } }), 'delegate_respond');
  assert.equal(delegationTool({ toolName: 'mcpToolCall', data: { server: 'other', tool: 'delegate_start' } }), undefined);
  assert.equal(delegationTool({ toolName: 'mcp__threadterm__terminal_read' }), undefined);
  assert.equal(delegationTool({ toolName: 'Read' }), undefined);
  const copy = (en: string, zh: string) => `${en}|${zh}`;
  assert.equal(delegationToolLabel('delegate_result', copy), "Read a delegate's result|读取了委派结果");
});

test("a delegate's fitted authority and a widening request are labelled in both languages", () => {
  const en = (english: string) => english, zh = (_english: string, chinese: string) => chinese;
  assert.equal(authorityLabel('read_only', en), 'Read only');
  assert.equal(authorityLabel('ask_before_writes', en), 'Asks before writes');
  assert.equal(authorityLabel('writes_in_workspace', en), 'Writes in its own folder');
  assert.equal(authorityLabel('full_access', en), 'Full access');
  assert.equal(authorityLabel(undefined, en), 'Unknown access');
  for (const value of ['read_only', 'ask_before_writes', 'writes_in_workspace', 'full_access', undefined] as const) {
    assert.notEqual(authorityLabel(value, zh), authorityLabel(value, en), 'every authority label is translated');
  }
  const request = { agent: 'pi', parentAuthority: 'ask_before_writes', childAuthority: 'full_access' } as const;
  const english = wideningRequestLabel(request, en), chinese = wideningRequestLabel(request, zh);
  assert.match(english.title, /^@pi wants to start with Full access$/);
  assert.match(english.detail, /This chat is limited to Asks before writes.*with Full access anyway/);
  assert.match(english.detail, /Deny starts nothing/);
  assert.notEqual(chinese.title, english.title);
  assert.notEqual(chinese.detail, english.detail);
});
