import assert from 'node:assert/strict';
import test from 'node:test';
import { addPane, closePane, paneCount, resizeSplit, splitPane } from '../renderer/src/workspaceLayout.ts';

const tab = id => ({ id: `tab-${id}`, kind: 'session', sessionId: id });
const pane = id => ({ kind: 'pane', id, tabs: [tab(id)], activeTabId: `tab-${id}` });
const pair = () => ({ kind: 'split', id: 'outer', direction: 'horizontal', ratio: .65, first: pane('left'), second: pane('right') });

test('splitting the left leaf preserves the outer ratio and the right pane', () => {
  const original = pair();
  const next = splitPane(original, 'left', tab('new'));
  assert.equal(paneCount(next), 3);
  assert.equal(next.id, original.id);
  assert.equal(next.ratio, .65);
  assert.equal(next.second, original.second);
  assert.equal(next.first.first, original.first);
  assert.deepEqual(next.first.second.tabs, [tab('new')]);
  assert.equal(original.first.kind, 'pane', 'input tree is not mutated');
});

test('a nested right leaf splits without replacing unrelated branches or orientation', () => {
  const left = pair();
  const original = { kind: 'split', id: 'top', direction: 'vertical', ratio: .4, first: left, second: pane('bottom') };
  const next = splitPane(original, 'right', tab('fourth'));
  assert.equal(paneCount(next), 4);
  assert.equal(next.direction, 'vertical');
  assert.equal(next.ratio, .4);
  assert.equal(next.second, original.second);
  assert.equal(next.first.first, left.first);
  assert.equal(next.first.second.first, left.second);
  assert.equal(next.first.second.second.tabs[0].sessionId, 'fourth');
});

test('missing targets and the workspace-wide four-pane limit are no-ops', () => {
  const two = pair();
  assert.equal(splitPane(two, 'missing', tab('new')), two);
  const four = splitPane(splitPane(two, 'left', tab('third')), 'right', tab('fourth'));
  assert.equal(splitPane(four, 'left', tab('fifth')), four);
  assert.equal(addPane(four, tab('fifth')), four);
});

test('inner resize changes only the addressed ratio and retains persisted layout shape', () => {
  const original = splitPane(pair(), 'left', tab('third'));
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
  const next = splitPane(original, 'left', tab('new'));
  assert.deepEqual(closePane(next, next.first.second.id), original);
  const global = addPane(original, tab('global'));
  assert.equal(global.first, original);
  assert.equal(global.second.tabs[0].sessionId, 'global');
});
