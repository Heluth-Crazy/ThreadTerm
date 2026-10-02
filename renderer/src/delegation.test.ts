import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatItem, Session } from '@threadterm/protocol';
import { delegateOutcomePreview, delegationActive, delegationTool, delegationToolLabel, delegationStateLabel, nestedDelegateIds, withDelegates } from './delegation';

const session = (id: string, createdAt: string, parent?: string, branch?: string): Session => ({
  id, title: id, provider: 'codex', mode: 'chat', status: 'running', createdAt, updatedAt: createdAt,
  ...(parent ? { delegation: { id: `d-${id}`, parentSessionId: parent, workspace: branch ? 'worktree' : 'shared', branch, state: 'running' } } : {}),
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
