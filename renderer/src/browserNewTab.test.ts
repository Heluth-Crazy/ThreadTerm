import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaneLayout } from '@threadterm/protocol';
import { BROWSER_NEW_TAB_URL, updateBrowserTab } from './browserNewTab';
import { addTabToPane, closeTab } from './workspaceLayout';

test('late page metadata preserves newer blank tabs and the selected tab',()=>{
 const initial:PaneLayout={kind:'pane',id:'browser',tabs:[{kind:'web',id:'first',url:'https://example.test/'}],activeTabId:'first'};
 const withBlank=addTabToPane(initial,'browser',{kind:'web',id:'blank',url:BROWSER_NEW_TAB_URL});
 const updated=updateBrowserTab(withBlank,'first','https://example.test/loaded','Loaded');
 assert.equal(updated.kind,'pane');
 if(updated.kind!=='pane')throw Error('expected leaf');
 assert.equal(updated.activeTabId,'blank');
 assert.deepEqual(updated.tabs.map(tab=>tab.id),['first','blank']);
 assert.equal(updateBrowserTab(updated,'first','https://example.test/loaded','Loaded'),updated);
});

test('late page metadata cannot recreate a closed tab',()=>{
 const layout:PaneLayout={kind:'pane',id:'browser',tabs:[{kind:'web',id:'first',url:'https://example.test/'}],activeTabId:'first'};
 const closed=closeTab(layout,'browser','first');
 assert.equal(updateBrowserTab(closed,'first','https://example.test/loaded','Loaded'),closed);
});
