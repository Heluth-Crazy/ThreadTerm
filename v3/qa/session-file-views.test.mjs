import assert from 'node:assert/strict';
import test from 'node:test';
import { fileSelectionKey, visibleSessionLayout, sessionWorkspaceKey, workspaceNavigationLayout, workspaceNavigationTarget, withSessionCompanions, removeClosedViews, fileViewPlacement } from '../renderer/src/sessionFileViews.ts';
import { workspaceTabs, focusedWorkspaceTab, tabCloseTargets } from '../renderer/src/workspaceTabs.ts';

const file=(id,ownerSessionId)=>({id,kind:'preview',path:id+'.md',projectId:'p',...(ownerSessionId?{ownerSessionId}:{})});
const pane=(id,tabs,activeTabId=tabs[0]?.id??null)=>({id,kind:'pane',tabs,activeTabId});
const split=(first,second)=>({id:'split',kind:'split',direction:'horizontal',ratio:.5,first,second});
const sessions=pane('sessions',[{id:'a',kind:'session',sessionId:'a'},{id:'b',kind:'session',sessionId:'b'}]);

test('independent and unknown-source files remain visible without inventing session ownership',()=>{
 const full=split(sessions,pane('files',[file('independent'),file('a-file','a'),file('b-file','b')],'independent'));
 for(const owner of ['a','b']){
  const visible=visibleSessionLayout(full,owner);
  assert.deepEqual(workspaceTabs(visible).map(x=>x.tab.id),['a','b','independent',owner+'-file']);
  assert.equal(visible.second.activeTabId,'independent');
  assert.equal(visible.second.tabs[0].ownerSessionId,undefined);
 }
 assert.equal(full.second.tabs[0].ownerSessionId,undefined);
});

test('upper tabs contain sessions and independent files, never companions from either owner',()=>{
 const full=split(sessions,pane('files',[file('independent'),file('a-file','a'),file('b-file','b')],'a-file'));
 const bar=workspaceNavigationLayout(full);
 assert.deepEqual(workspaceTabs(bar).map(x=>x.tab.id),['a','b','independent']);
 for(const owner of ['a','b'])assert.deepEqual(workspaceTabs(workspaceNavigationLayout(visibleSessionLayout(full,owner))).map(x=>x.tab.id),['a','b','independent']);
 assert.equal(full.second.tabs.length,3,'filtering never removes cached views');
 assert.equal(bar.second.activeTabId,null,'companion active id must not leak into bar');
 assert.deepEqual(tabCloseTargets(bar,{paneId:'sessions',tabId:'a'},'others'),[{paneId:'sessions',tabId:'b'},{paneId:'files',tabId:'independent'}]);
});

test('companion focus selects its owner in the upper bar, independent files select themselves',()=>{
 const full=split(sessions,pane('files',[file('a-file','a'),file('independent')],'a-file'));
 assert.deepEqual(workspaceNavigationTarget(full,focusedWorkspaceTab(full,'files')),{paneId:'sessions',tabId:'a'});
 assert.deepEqual(workspaceNavigationTarget(full,workspaceTabs(full).find(x=>x.tab.id==='independent')),{paneId:'files',tabId:'independent'});
 assert.equal(workspaceNavigationTarget(full),undefined);
 const orphan=pane('files',[file('orphan','missing')]);
 assert.equal(workspaceNavigationTarget(orphan,focusedWorkspaceTab(orphan)),undefined,'never select an unrelated session');
});

test('tab and pane closure capture cross-pane companions, retaining unrelated or newly opened views',()=>{
 const full=split(pane('source',[sessions.tabs[0]]),pane('files',[file('a-file','a'),file('b-file','b'),file('independent')]));
 const targets=withSessionCompanions(full,[{paneId:'source',tabId:'a'}]);
 assert.deepEqual(targets,[{paneId:'source',tabId:'a'},{paneId:'files',tabId:'a-file'}]);
 const later={...full,second:{...full.second,tabs:[...full.second.tabs,file('new','a')]}};
 const blocked=removeClosedViews(later,targets,'source','source');
 assert.equal(blocked.blocked,true);
 assert.equal(blocked.layout,later,'keep the owner too, rather than orphaning a late companion');
 const next=removeClosedViews(full,targets,'source','source');
 assert.equal(next.layout.id,'files');
 assert.deepEqual(workspaceTabs(next.layout).map(x=>x.tab.id),['b-file','independent']);
 assert.equal(full.second.tabs.length,3);
});

test('last companion closes its column while hidden foreign views and intentional empty panes survive',()=>{
 const full=split(sessions,pane('files',[file('a-file','a')]));
 assert.equal(removeClosedViews(full,[{paneId:'files',tabId:'a-file'}],'files').layout,sessions);
 const mixed=split(sessions,pane('files',[file('a-file','a'),file('b-file','b')]));
 const next=removeClosedViews(mixed,[{paneId:'files',tabId:'a-file'}]);
 assert.deepEqual(workspaceTabs(next.layout).map(x=>x.tab.id),['a','b','b-file']);
 const empty=pane('intentional',[]);
 const fullWithEmpty=split(full,empty);
 assert.equal(removeClosedViews(fullWithEmpty,[{paneId:'files',tabId:'a-file'}]).layout.second,empty);
});

test('full and narrow layouts place inspector files in their owner session, not the first or another mixed pane',()=>{
 const other=pane('other',[sessions.tabs[1],file('b-file','b')],'b-file');
 const source=pane('source',[sessions.tabs[0]]);
 const full=split(split(other,pane('third',[{id:'c',kind:'session',sessionId:'c'}])),split(source,pane('fourth',[{id:'d',kind:'session',sessionId:'d'}])));
 assert.deepEqual(fileViewPlacement(full,'a',undefined,true),{paneId:'source',split:false});
 assert.deepEqual(fileViewPlacement(split(other,source),'a',undefined,false),{paneId:'source',split:false});
 const withFiles=split(source,pane('files',[file('b-file','b')]));
 assert.deepEqual(fileViewPlacement(withFiles,'a',undefined,true),{paneId:'files',split:false},'dedicated companion column can be shared');
 const independent=split(source,pane('independent',[file('independent')]));
 assert.deepEqual(fileViewPlacement(independent,'a',undefined,true),{paneId:'source',split:true},'independent column is not silently repurposed');
 assert.deepEqual(fileViewPlacement(independent,undefined,undefined,true),{paneId:'independent',split:false});
});

test('only current owner files are visible, original saved layout is unchanged',()=>{
 const full=split(sessions,pane('files',[file('one','a'),file('two','a'),file('three','b')],'three'));
 const remembered=new Map([[fileSelectionKey('a','files'),'two']]);
 const a=visibleSessionLayout(full,'a',remembered);
 assert.deepEqual(workspaceTabs(a).map(x=>x.tab.id),['a','b','one','two']);
 assert.equal(a.second.activeTabId,'two');
 assert.equal(full.second.activeTabId,'three');
 assert.deepEqual(workspaceTabs(visibleSessionLayout(full,'b')).map(x=>x.tab.id),['a','b','three']);
 assert.equal(visibleSessionLayout(full,undefined),full,'independent workspace remains unfiltered');
});

test('foreign file-only pane collapses visually, intentional empty pane does not',()=>{
 const full=split(sessions,pane('files',[file('a-file','a')]));
 assert.equal(visibleSessionLayout(full,'b'),sessions);
 const empty=pane('empty',[]);
 assert.equal(visibleSessionLayout(split(sessions,empty),'b').second,empty);
});

test('mixed panes keep routed session selection instead of remembered file',()=>{
 const full=pane('mixed',[...sessions.tabs,file('a-file','a')],'b');
 assert.equal(visibleSessionLayout(full,'a',new Map([[fileSelectionKey('a','mixed'),'a-file']])).activeTabId,'b');
});

test('navigation reuse matches canonical project/worktree scope and never aliases projects',()=>{
 const projects=[{id:'p',path:'D:/repo'}];
 assert.equal(sessionWorkspaceKey({id:'a',projectId:'p'},projects),sessionWorkspaceKey({id:'b',projectId:'p',worktreePath:'\\\\?\\D:\\repo\\'},projects));
 assert.notEqual(sessionWorkspaceKey({id:'a',projectId:'p'},projects),sessionWorkspaceKey({id:'b',projectId:'p',worktreePath:'D:/other'},projects));
 assert.notEqual(sessionWorkspaceKey({id:'a'},projects),sessionWorkspaceKey({id:'b'},projects));
 assert.notEqual(sessionWorkspaceKey({id:'a',projectId:'p'},projects),sessionWorkspaceKey({id:'a',projectId:'q',worktreePath:'D:/repo'},projects));
});

test('closing the last tab of any pane closes that pane: ownerless side-bar views and split sessions too',()=>{
 // A Git history or file view opened from the side bar is ownerless; closing it must not leave an empty pane.
 const history={id:'history',kind:'history',projectId:'p'};
 const withHistory=split(sessions,pane('views',[history]));
 const closed=removeClosedViews(withHistory,[{paneId:'views',tabId:'history'}],'views');
 assert.equal(closed.layout,sessions);
 assert.equal(closed.focusedPaneId,'sessions','focus moves to a pane that still exists');
 const withFile=split(sessions,pane('views',[file('independent')]));
 assert.equal(removeClosedViews(withFile,[{paneId:'views',tabId:'independent'}]).layout,sessions);
 // The last session in a split pane: its pane goes as well.
 const twoSessions=split(pane('left',[{id:'a',kind:'session',sessionId:'a'}]),pane('right',[{id:'b',kind:'session',sessionId:'b'}]));
 assert.equal(removeClosedViews(twoSessions,[{paneId:'right',tabId:'b'}],'right').layout.id,'left');
 // A pane that still has tabs stays; the root pane stays even when emptied (the workspace then goes back).
 const kept=removeClosedViews(split(sessions,pane('views',[history,file('independent')])),[{paneId:'views',tabId:'history'}]);
 assert.deepEqual(workspaceTabs(kept.layout).map(x=>x.tab.id),['a','b','independent']);
 const root=removeClosedViews(pane('solo',[history]),[{paneId:'solo',tabId:'history'}]);
 assert.deepEqual(root.layout,{id:'solo',kind:'pane',tabs:[],activeTabId:null});
});
