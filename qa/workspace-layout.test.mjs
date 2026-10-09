import assert from 'node:assert/strict';
import test from 'node:test';
import { addPane, addTabToPane, closePane, paneCount, paneIdsIn, placeWebTabBesideSession, reconcileSessionLayout, resizeSplit, sessionIdsIn, sessionOnlyLayout, splitPane } from '../renderer/src/workspaceLayout.ts';
import { paneGeometry } from '../renderer/src/paneGeometry.ts';

const tab = id => ({ id: `tab-${id}`, kind: 'session', sessionId: id });
const pane = id => ({ kind: 'pane', id, tabs: [tab(id)], activeTabId: `tab-${id}` });
const pair = () => ({ kind: 'split', id: 'outer', direction: 'horizontal', ratio: .65, first: pane('left'), second: pane('right') });
const paneById = (layout, id) => layout.kind === 'pane'
  ? (layout.id === id ? layout : undefined)
  : paneById(layout.first, id) ?? paneById(layout.second, id);

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

test('runtime web presentation reuses an existing browser leaf without URL deduplication', () => {
  const layout = {kind:'split',id:'root',direction:'horizontal',ratio:.5,
    first:{kind:'pane',id:'chat',tabs:[tab('owner')],activeTabId:'tab-owner'},
    second:{kind:'pane',id:'browser',tabs:[{id:'manual',kind:'web',url:'http://127.0.0.1:3000'}],activeTabId:'manual'}};
  const page = {id:'runtime-page',kind:'web',url:'http://127.0.0.1:3000'};
  const result = placeWebTabBesideSession(layout, 'owner', page);
  assert.equal(result.status, 'placed');
  assert.equal(result.paneId, 'browser');
  const browser = paneById(result.layout, 'browser');
  assert.deepEqual(browser.tabs.map(item => item.id), ['manual', 'runtime-page']);
  assert.equal(browser.activeTabId, 'runtime-page');
  assert.deepEqual(paneById(result.layout, 'chat'), layout.first, 'chat tab state stays stable while the sibling browser leaf updates');
});

test('a web tab sharing its owner Chat is not reused as a browser surface', () => {
  const layout={kind:'pane',id:'mixed',tabs:[tab('owner'),{id:'manual',kind:'web',url:'https://example.test'}],activeTabId:'manual'};
  const result=placeWebTabBesideSession(layout,'owner',{id:'runtime',kind:'web',url:'https://example.test'});
  assert.equal(result.status,'placed');
  assert.equal(paneCount(result.layout),2);
  assert.deepEqual(paneById(result.layout,'mixed').tabs.map(item=>item.id),['tab-owner','manual']);
  assert.deepEqual(paneById(result.layout,result.paneId).tabs.map(item=>item.id),['runtime']);
});

test('runtime web presentation creates a sibling leaf or refuses cleanly at the pane cap', () => {
  const layout = {kind:'pane',id:'chat',tabs:[tab('owner')],activeTabId:'owner'};
  const page = {id:'runtime-page',kind:'web',url:'http://127.0.0.1:3000'};
  const result = placeWebTabBesideSession(layout, 'owner', page);
  assert.equal(result.status, 'placed');
  assert.equal(paneCount(result.layout), 2);
  assert.equal(paneById(result.layout, 'chat'), layout, 'the chat leaf stays intact after splitting');
  assert.equal(paneById(result.layout, result.paneId).activeTabId, 'runtime-page');
  const capped = splitPane(splitPane(splitPane(result.layout, 'chat', 'vertical', 'third'), 'third', 'vertical', 'fourth'), 'fourth', 'vertical', 'ignored');
  const refused = placeWebTabBesideSession(capped, 'owner', {id:'other-page',kind:'web',url:'http://127.0.0.1:3001'});
  assert.equal(refused.status, 'placed', 'an existing browser leaf remains reusable at the pane cap');
  const noBrowser = splitPane(splitPane(splitPane(layout, 'chat', 'vertical', 'two'), 'two', 'vertical', 'three'), 'three', 'vertical', 'four');
  const unavailable = placeWebTabBesideSession(noBrowser, 'owner', page);
  assert.equal(unavailable.status, 'layout_unavailable');
  assert.equal(unavailable.layout, noBrowser);
});

test('compact pane geometry stacks horizontal leaves without changing the saved split tree', () => {
  const layout={kind:'split',id:'root',direction:'horizontal',ratio:.4,
    first:{kind:'pane',id:'chat',tabs:[tab('owner')],activeTabId:'tab-owner'},
    second:{kind:'pane',id:'browser',tabs:[{id:'page',kind:'web',url:'https://example.test/app'}],activeTabId:'page'}};
  const before=structuredClone(layout),wide=paneGeometry(layout),compact=paneGeometry(layout,{stackHorizontal:true});
  assert.deepEqual(layout,before,'responsive geometry never mutates the saved layout');
  assert.equal(layout.direction,'horizontal','the persisted split direction remains horizontal');
  assert.deepEqual(compact.panes.map(item=>item.node.id),['chat','browser'],'the same keyed leaf nodes are retained');
  assert.equal(wide.panes[0].rect.width.fraction,.4);
  assert.equal(compact.panes[0].rect.width.fraction,1,'each compact leaf receives the full pane width');
  assert.equal(compact.panes[1].rect.top.fraction,.4,'the second leaf is presented below the first using the saved ratio');
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

test('session-only projection retains independent web tabs without mutating their saved leaf', () => {
  const web={id:'saved-browser-page',kind:'web',url:'https://example.test/manual'};
  const history={id:'saved-history',kind:'history',projectId:'p'};
  const file={id:'saved-file',kind:'file',projectId:'p',path:'notes.md'};
  const saved={kind:'pane',id:'restored-leaf',tabs:[tab('owner'),web,history,file],activeTabId:'saved-history'};
  const before=structuredClone(saved),restored=sessionOnlyLayout(saved,item=>item.kind==='web');
  assert.equal(restored.id,'restored-leaf','browser tab stays in its saved leaf for stable surface identity');
  assert.deepEqual(restored.tabs,[tab('owner'),web]);
  assert.equal(restored.activeTabId,'tab-owner');
  assert.deepEqual(saved,before,'projection never erases a saved manual or runtime page');
});
