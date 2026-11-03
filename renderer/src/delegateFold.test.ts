import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, SessionDelegationState } from '@threadterm/protocol';
import { foldedDelegateRows, boundedExpandedParents, readExpandedParents } from './delegateFold';

const parent: Session = { id: 'parent', title: 'Parent', provider: 'codex', mode: 'chat', status: 'idle', createdAt: '2026-11-03', updatedAt: '2026-11-03' };
const child = (id: string, state: SessionDelegationState): Session => ({ ...parent, id,
  delegation: { id: `d-${id}`, parentSessionId: parent.id, workspace: 'shared', state } });
const ids = (rows: ReturnType<typeof foldedDelegateRows>) => rows.map(row => row.kind === 'session' ? row.session.id : `fold:${row.parentId}:${row.count}`);

test('only terminal delegates fold, after all unfinished delegates; expansion preserves creation order', () => {
  const active: SessionDelegationState[] = ['starting', 'running', 'awaiting_parent', 'awaiting_user', 'cancelling', 'cancel_failed'];
  const finished: SessionDelegationState[] = ['completed', 'failed', 'cancelled', 'interrupted'];
  const all = [parent, ...finished.map(state => child(state, state)), ...active.map(state => child(state, state))];
  assert.deepEqual(ids(foldedDelegateRows(all, all, undefined, [])), ['parent', ...active, 'fold:parent:4']);
  assert.deepEqual(ids(foldedDelegateRows(all, all, undefined, ['parent'])), ['parent', ...active, 'fold:parent:4', ...finished]);
  assert.equal(all.length, 11, 'folding does not mutate the catalog');
});

test('selected finished delegates and pending approval/input always remain above the fold', () => {
  const all = [parent, child('selected', 'completed'),
    { ...child('approval', 'failed'), activity: { state: 'awaiting_approval' as const, revision: 1 } },
    { ...child('input', 'completed'), activity: { state: 'awaiting_input' as const, revision: 1 } }, child('hidden', 'cancelled')];
  assert.deepEqual(ids(foldedDelegateRows(all, all, 'selected', [])), ['parent', 'selected', 'approval', 'input', 'fold:parent:1']);
  assert.deepEqual(ids(foldedDelegateRows(all.slice(0, 4), all.slice(0, 4), 'selected', [])), ['parent', 'selected', 'approval', 'input']);
});

test('absent parents keep delegates in place; cross-folder delegates appear only under their parent', () => {
  const orphan = child('orphan', 'completed');
  assert.deepEqual(ids(foldedDelegateRows([orphan], [orphan], undefined, [])), ['orphan']);
  const all = [parent, orphan];
  assert.deepEqual(ids(foldedDelegateRows([orphan], all, undefined, [])), []);
  assert.deepEqual(ids(foldedDelegateRows([parent], all, undefined, [])), ['parent', 'fold:parent:1']);
  assert.deepEqual(foldedDelegateRows([], [], undefined, []), []);
});

test('expanded preference is bounded, deduplicated, pruned and tolerates malformed storage', () => {
  const many = Array.from({ length: 250 }, (_, i) => `p${i}`);
  assert.deepEqual(boundedExpandedParents([...many, 'p249']), many.slice(-200));
  assert.deepEqual(boundedExpandedParents(['deleted', 'parent'], new Set(['parent'])), ['parent']);
  assert.deepEqual(readExpandedParents('invalid'), []);
  assert.deepEqual(readExpandedParents('{"parent":true}'), []);
  assert.deepEqual(readExpandedParents('["parent",7,null,"parent"]'), ['parent']);
});
