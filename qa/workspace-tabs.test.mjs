import assert from 'node:assert/strict';
import test from 'node:test';
import { contentTitle, workspaceTabs, focusedWorkspaceTab, removeWorkspaceTabs, tabCloseTargets } from '../renderer/src/workspaceTabs.ts';

const tab = id => ({id,kind:'session',sessionId:id});
const pane = (id,ids,active=ids[0]) => ({kind:'pane',id,tabs:ids.map(tab),activeTabId:active??null});
const layout = () => ({kind:'split',id:'split',direction:'horizontal',ratio:.6,first:pane('a',['one','two'],'two'),second:pane('b',['three'])});

test('top tabs derive only from opened pane contents, and focus selects the actual pane',()=>{
 const tree=layout();
 assert.deepEqual(workspaceTabs(tree).map(x=>[x.paneId,x.tab.id]),[['a','one'],['a','two'],['b','three']]);
 assert.equal(focusedWorkspaceTab(tree,'a').tab.id,'two');
 assert.equal(focusedWorkspaceTab(tree,'b').tab.id,'three');
});
test('context close others uses clicked target, not active tab',()=>{
 const tree=layout();
 assert.deepEqual(tabCloseTargets(tree,{paneId:'a',tabId:'one'},'others'),[{paneId:'a',tabId:'two'},{paneId:'b',tabId:'three'}]);
});
test('a focused empty split has no falsely selected session tab',()=>{
 const tree=layout();tree.second=pane('empty',[]);
 assert.equal(focusedWorkspaceTab(tree,'empty'),undefined);
 assert.equal(focusedWorkspaceTab(tree,'removed').tab.id,'two');
});
test('closing background tab preserves selection and other panes',()=>{
 const tree=layout();const next=removeWorkspaceTabs(tree,[{paneId:'a',tabId:'one'}],'b');
 assert.equal(next.focusedPaneId,'b');assert.equal(next.layout.second,tree.second);
 assert.equal(next.layout.first.activeTabId,'two');assert.equal(tree.first.tabs.length,2);
});
test('closing current prefers a right neighbor, then left',()=>{
 const tree=pane('a',['one','two','three'],'two');
 const right=removeWorkspaceTabs(tree,[{paneId:'a',tabId:'two'}],'a');
 assert.equal(right.layout.activeTabId,'three');
 assert.equal(removeWorkspaceTabs(right.layout,[{paneId:'a',tabId:'three'}],'a').layout.activeTabId,'one');
});
test('pending close targets do not close tabs added while confirming',()=>{
 const tree=layout();const targets=tabCloseTargets(tree,{paneId:'a',tabId:'two'},'all');
 tree.second.tabs.push(tab('new'));tree.second.activeTabId='new';
 const next=removeWorkspaceTabs(tree,targets,'b');
 assert.deepEqual(workspaceTabs(next.layout).map(x=>x.tab.id),['new']);
 assert.equal(next.focusedPaneId,'b');
});
test('closing all retains valid empty leaves and scoped ids cannot close another pane',()=>{
 const tree=layout();
 const missing=removeWorkspaceTabs(tree,[{paneId:'wrong',tabId:'one'}],'a');
 assert.equal(missing.layout,tree);
 const next=removeWorkspaceTabs(tree,tabCloseTargets(tree,{paneId:'a',tabId:'one'},'all'),'a');
 assert.equal(workspaceTabs(next.layout).length,0);
 assert.equal(next.layout.first.activeTabId,null);assert.equal(next.layout.second.activeTabId,null);
 assert.equal(next.focusedPaneId,undefined);
});

test('content tab labels say which view they show, without glyph prefixes', () => {
  const review = {id:'r',kind:'review',projectId:'p',path:'notes/todo.md',sessionId:'s',checkpointId:'c'};
  assert.equal(contentTitle(review,false).label,'todo.md · review');
  assert.equal(contentTitle(review,true).label,'todo.md · 审查');
  assert.equal(contentTitle({id:'d',kind:'diff',projectId:'p',path:'src/app.ts'},false).label,'app.ts · changes');
  assert.equal(contentTitle({id:'d',kind:'diff',projectId:'p',path:'src/app.ts',staged:true},true).label,'app.ts · 已暂存');
  assert.equal(contentTitle({id:'h',kind:'history',projectId:'p'},false).label,'Git history');
});
