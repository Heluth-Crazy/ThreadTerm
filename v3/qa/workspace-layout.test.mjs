import assert from 'node:assert/strict';
import test from 'node:test';
import { addPane, addTabToPane, closePane, paneCount, paneIdsIn, reconcileSessionLayout, resizeSplit, sessionIdsIn, sessionOnlyLayout, splitPane } from '../renderer/src/workspaceLayout.ts';

const tab = id => ({ id: `tab-${id}`, kind: 'session', sessionId: id });
const pane = id => ({ kind: 'pane', id, tabs: [tab(id)], activeTabId: `tab-${id}` });
const pair = () => ({ kind: 'split', id: 'outer', direction: 'horizontal', ratio: .65, first: pane('left'), second: pane('right') });

test('splitting the left leaf preserves the outer ratio and the right pane', () => {
  const original = pair();
  const next = splitPane(original, 'left', 'horizontal', 'new-pane');
  assert.equal(paneCount(next), 3);
  assert.equal(next.id, original.id);
  assert.equal(next.ratio, .65);
  assert.equal(next.second, original.second);
  assert.equal(next.first.first, original.first);
  assert.equal(original.first.kind, 'pane', 'input tree is not mutated');
});

test('the new leaf starts empty, takes the given direction and the caller pane id', () => {
  const next = splitPane(pair(), 'left', 'vertical', 'new-pane');
  assert.equal(next.first.kind, 'split');
  assert.equal(next.first.direction, 'vertical');
  assert.equal(next.first.ratio, .5);
  assert.equal(next.first.first.id, 'left');
  assert.deepEqual(next.first.second, { kind: 'pane', id: 'new-pane', tabs: [], activeTabId: null });
});

test('a nested right leaf splits without replacing unrelated branches or orientation', () => {
  const left = pair();
  const original = { kind: 'split', id: 'top', direction: 'vertical', ratio: .4, first: left, second: pane('bottom') };
  const next = splitPane(original, 'right', 'horizontal', 'fourth-pane');
  assert.equal(paneCount(next), 4);
  assert.equal(next.direction, 'vertical');
  assert.equal(next.ratio, .4);
  assert.equal(next.second, original.second);
  assert.equal(next.first.first, left.first);
  assert.equal(next.first.second.first, left.second);
  assert.deepEqual(next.first.second.second, { kind: 'pane', id: 'fourth-pane', tabs: [], activeTabId: null });
});

test('missing targets and the workspace-wide four-pane limit are no-ops', () => {
  const two = pair();
  assert.equal(splitPane(two, 'missing', 'horizontal'), two);
  const four = splitPane(splitPane(two, 'left', 'horizontal'), 'right', 'vertical');
  assert.equal(splitPane(four, 'left', 'horizontal'), four);
  assert.equal(addPane(four, tab('fifth')), four);
});

test('inner resize changes only the addressed ratio and retains persisted layout shape', () => {
  const original = splitPane(pair(), 'left', 'horizontal');
  const next = resizeSplit(original, original.first.id, .8);
  assert.equal(next.ratio, original.ratio);
  assert.equal(next.first.ratio, .8);
  assert.deepEqual(next.second, original.second);
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
  assert.equal(resizeSplit(original, original.first.id, -1).first.ratio, .1);
  assert.equal(resizeSplit(original, original.first.id, 2).first.ratio, .9);
});

test('closing the added leaf restores the original layout and global add still wraps the root', () => {
  const original = pair();
  const next = splitPane(original, 'left', 'horizontal');
  assert.deepEqual(closePane(next, next.first.second.id), original);
  const global = addPane(original, tab('global'));
  assert.equal(global.first, original);
  assert.equal(global.second.tabs[0].sessionId, 'global');
});

test('addTabToPane appends the tab to the addressed leaf and activates it', () => {
  const original = splitPane(pair(), 'left', 'horizontal', 'new-pane');
  const next = addTabToPane(original, 'new-pane', tab('third'));
  assert.deepEqual(next.first.second.tabs, [tab('third')]);
  assert.equal(next.first.second.activeTabId, 'tab-third');
  assert.equal(next.first.first, original.first.first);
  assert.equal(next.second, original.second);
  assert.equal(addTabToPane(original, 'missing', tab('third')), original);
  assert.equal(addTabToPane(next, 'new-pane', tab('third')), next, 'same tab id is not duplicated');
});

test('paneIdsIn and sessionIdsIn collect across the whole tree', () => {
  const layout = addTabToPane(splitPane(pair(), 'left', 'vertical', 'new-pane'), 'new-pane', tab('third'));
  assert.deepEqual(paneIdsIn(layout), ['left', 'new-pane', 'right']);
  assert.deepEqual(sessionIdsIn(layout), ['left', 'third', 'right']);
  assert.deepEqual(sessionIdsIn(splitPane(pair(), 'left', 'horizontal')), ['left', 'right'], 'empty panes contribute no sessions');
});

test('reconciling a restored layout replaces a removed-only tab with the routed session', () => {
  const original = pane('removed');
  const next = reconcileSessionLayout(original, new Set(['current']), 'current');
  assert.deepEqual(next.tabs, [{ id: 'session-current', kind: 'session', sessionId: 'current' }]);
  assert.equal(next.activeTabId, 'session-current');
  assert.deepEqual(original, pane('removed'), 'persisted input is not mutated');
});

test('reconciling prunes stale tabs and activates an existing routed session without changing siblings', () => {
  const original = pair();
  const file = { id: 'readme', kind: 'file', projectId: 'project', path: 'README.md' };
  original.first.tabs = [tab('removed'), file, tab('current')];
  original.first.activeTabId = 'tab-removed';
  const next = reconcileSessionLayout(original, new Set(['current', 'right']), 'current');
  assert.deepEqual(next.first.tabs, [file, tab('current')]);
  assert.equal(next.first.activeTabId, 'tab-current');
  assert.equal(next.second, original.second);
  assert.deepEqual(sessionIdsIn(next), ['current', 'right']);
});

test('a session opens alone: non-session tabs drop, emptied panes collapse, unsaved file tabs stay', () => {
  const history = { id: 'h', kind: 'history', projectId: 'p' };
  const diff = { id: 'd', kind: 'diff', projectId: 'p', path: 'src/a.ts' };
  const draft = { id: 'f', kind: 'file', projectId: 'p', path: 'notes.md' };
  // left: session A + history (history active); right: a file-only column (diff).
  const layout = { kind: 'split', id: 'outer', direction: 'horizontal', ratio: .5,
    first: { kind: 'pane', id: 'left', tabs: [tab('a'), history], activeTabId: 'h' },
    second: { kind: 'pane', id: 'right', tabs: [diff], activeTabId: 'd' } };
  const alone = sessionOnlyLayout(layout, () => false);
  assert.deepEqual(alone, { kind: 'pane', id: 'left', tabs: [tab('a')], activeTabId: 'tab-a' });
  // A file tab with unsaved edits keeps its column and the split.
  const kept = sessionOnlyLayout({ ...layout, second: { ...layout.second, tabs: [diff, draft], activeTabId: 'd' } }, item => item.id === 'f');
  assert.equal(kept.kind, 'split');
  assert.deepEqual(kept.second.tabs.map(item => item.id), ['f']);
  assert.equal(kept.second.activeTabId, 'f');
  assert.equal(kept.first.activeTabId, 'tab-a');
  // Splits between sessions survive; nothing to drop returns the same object.
  const sessions = pair();
  assert.equal(sessionOnlyLayout(sessions, () => false), sessions);
  // Only non-session content: an empty leaf remains for the routed session.
  const only = sessionOnlyLayout({ kind: 'pane', id: 'solo', tabs: [history], activeTabId: 'h' }, () => false);
  assert.deepEqual(only, { kind: 'pane', id: 'solo', tabs: [], activeTabId: null });
  assert.deepEqual(sessionIdsIn(reconcileSessionLayout(only, new Set(['b']), 'b')), ['b']);
});
