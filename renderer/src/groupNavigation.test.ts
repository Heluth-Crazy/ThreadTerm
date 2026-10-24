import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeGroupNavigation, observeGroupNavigation, openGroup, retitleGroupTabs, startGroup } from './groupNavigation';

test('Group navigation preserves an event until the mounted listener acknowledges it', () => {
 const seen: string[] = [];
 openGroup({ id: 'group-1', title: 'Review', members: [{ sessionId: 'chat-1', provider: 'codex', handle: 'codex', state: 'idle' }] });
 const unsubscribe = observeGroupNavigation(event => {
  seen.push(event.kind === 'open' ? event.group.id : 'start');
  acknowledgeGroupNavigation(event);
 });
 assert.deepEqual(seen, ['group-1']);
 unsubscribe();
 const later: string[] = [];
 const unsubscribeLater = observeGroupNavigation(event => later.push(event.kind));
 assert.deepEqual(later, []);
 unsubscribeLater();
});

test('starting a Group carries the source Chat session through navigation', () => {
 let received: { sessionId: string } | undefined;
 const unsubscribe = observeGroupNavigation(event => {
  if (event.kind === 'start') received = event.context;
  acknowledgeGroupNavigation(event);
 });
 startGroup({ sessionId: 'chat-source' });
 assert.deepEqual(received, { sessionId: 'chat-source' });
 unsubscribe();
});

test('retitling a Group updates matching Group and legacy Roundtable tabs only', () => {
 const other = { id: 'file', kind: 'file' as const, projectId: 'project', path: 'notes.md' };
 const layout = {
  kind: 'split' as const, id: 'root', direction: 'horizontal' as const, ratio: .5,
  first: { kind: 'pane' as const, id: 'left', activeTabId: 'group', tabs: [
   { id: 'group', kind: 'group' as const, groupId: 'shared', title: 'Before' },
   other,
  ] },
  second: { kind: 'pane' as const, id: 'right', activeTabId: 'legacy', tabs: [
   { id: 'legacy', kind: 'roundtable' as const, roundtableId: 'shared', title: 'Before' },
   { id: 'unrelated', kind: 'group' as const, groupId: 'other', title: 'Other' },
  ] },
 };
 const next = retitleGroupTabs(layout, 'shared', 'After');
 if(next.kind!=='split'||next.first.kind!=='pane'||next.second.kind!=='pane') throw new Error('Expected split panes');
 assert.notEqual(next, layout);
 assert.deepEqual(next.first.tabs[0], { id: 'group', kind: 'group', groupId: 'shared', title: 'After' });
 assert.deepEqual(next.second.tabs[0], { id: 'legacy', kind: 'roundtable', roundtableId: 'shared', title: 'After' });
 assert.equal(next.first.tabs[1], other);
 assert.equal(next.second.tabs[1], layout.second.tabs[1]);
 assert.equal(retitleGroupTabs(next, 'shared', 'After'), next);
});
