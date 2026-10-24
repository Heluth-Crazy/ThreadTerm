import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GroupSummary, Session } from '@threadterm/protocol';
import { catalogGroups, groupCatalogLabel, groupCatalogState, groupCatalogStatusClass, groupMemberIds, groupMemberLabel } from './groupCatalog';

const session = (id: string, archived = false): Session => ({ id, title: id, provider: 'codex', mode: 'chat', status: 'idle', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', archived });
const group = (id: string, updatedAt: string, members: { sessionId: string; handle: string; state?: GroupSummary['members'][number]['state'] }[]): GroupSummary => ({ id, title: id, updatedAt, members: members.map(member => ({ provider: 'codex', state: 'idle', ...member })) });

test('catalog groups newest rooms first and keeps runtime member order', () => {
  const grouped = catalogGroups([group('older', '2026-10-23T10:00:00Z', [{ sessionId: 'b', handle: 'b' }, { sessionId: 'a', handle: 'a' }]), group('newer', '2026-10-23T11:00:00Z', [{ sessionId: 'c', handle: 'c' }])], [session('a'), session('b'), session('c')]);
  assert.deepEqual(grouped.map(value => value.group.id), ['newer', 'older']);
  assert.deepEqual(grouped[1].members.map(value => value.id), ['b', 'a']);
});

test('catalog omits unavailable nested rows but keeps all group members hidden from standalone rows', () => {
  const groups = [group('group', '2026-10-23T10:00:00Z', [{ sessionId: 'shown', handle: 'shown' }, { sessionId: 'archived', handle: 'archived' }, { sessionId: 'missing', handle: 'missing' }])];
  assert.deepEqual(catalogGroups(groups, [session('shown'), session('archived', true)])[0].members.map(value => value.id), ['shown']);
  assert.deepEqual([...groupMemberIds(groups)], ['shown', 'archived', 'missing']);
});

test('status aggregation prioritizes attention and labels working members bilingually', () => {
  const members = group('summary', '2026-10-23T10:00:00Z', [{ sessionId: 'a', handle: 'a', state: 'working' }, { sessionId: 'b', handle: 'b', state: 'needs_user' }]).members;
  assert.equal(groupCatalogState(members), 'needs');
  assert.equal(groupCatalogLabel(group('working', '2026-10-23T10:00:00Z', [{ sessionId: 'a', handle: 'a', state: 'queued' }, { sessionId: 'b', handle: 'b', state: 'working' }]).members, false), '2 working');
  assert.equal(groupCatalogLabel(members, true), '需要你处理');
  assert.equal(groupCatalogState(group('idle', '2026-10-23T10:00:00Z', [{ sessionId: 'a', handle: 'a' }]).members, [{ ...session('a'), activity: { state: 'running', revision: 1 } }]), 'working');
});

test('ignores unread completion activity while retaining pending group attention', () => {
  const members = group('completion', '2026-10-23T10:00:00Z', [{ sessionId: 'a', handle: 'a', state: 'needs_user' }]).members;
  const awaitingInput = { state: 'awaiting_input' as const, revision: 1 };
  const completed = group('corrected-runtime', '2026-10-23T10:00:00Z', [{ sessionId: 'a', handle: 'a', state: 'idle' }]).members;
  assert.equal(groupCatalogState(completed, [{ ...session('a'), status: 'idle', activity: awaitingInput }]), 'idle');
  assert.equal(groupCatalogLabel(completed, false, [{ ...session('a'), status: 'idle', activity: awaitingInput }]), 'Idle');

  assert.equal(groupCatalogState(members, [{ ...session('a'), status: 'idle', activity: awaitingInput }]), 'idle');
  assert.equal(groupCatalogState(members, [{ ...session('a'), status: 'waiting', activity: awaitingInput }]), 'needs');
  assert.equal(groupCatalogState(members), 'needs');
});

test('uses shared sidebar chip classes and handle-only member labels', () => {
  assert.equal(groupCatalogStatusClass('working'), 'chip st-running');
  assert.equal(groupCatalogStatusClass('needs'), 'chip st-needs');
  assert.equal(groupCatalogStatusClass('failed'), 'chip st-failed');
  assert.equal(groupCatalogStatusClass('idle'), 'chip flat');
  assert.equal(groupMemberLabel('designer'), '@designer');
});
