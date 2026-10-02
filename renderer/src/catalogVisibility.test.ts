import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Snapshot} from '@threadterm/protocol';
import {visibleCatalogSnapshot} from './catalogVisibility';
import {hasDirtyEditorsInScope,registerDirtyEditor} from './dirtyEditors';
const stamp='2026-09-10T00:00:00Z';
const data:Snapshot={epoch:'fixture',revision:1,settings:{revision:1},projects:[{id:'p',name:'P',path:'C:/project',createdAt:stamp}],sessions:[{id:'s',projectId:'p',title:'S',mode:'terminal',provider:'shell',status:'exited',createdAt:stamp,updatedAt:stamp}],inbox:[{id:'i',sessionId:'s',kind:'waiting',title:'I',createdAt:stamp,read:false}],presets:[],workspaces:[],providers:[]};
test('archive preserves history and marks descendants; removal hides scope and notifications',()=>{
  const archived=visibleCatalogSnapshot(data,[{kind:'project',id:'p',visibility:'archived',revision:1}]);
  assert.equal(archived.projects.length,1);assert.equal(archived.sessions.length,1);assert.equal(archived.sessions[0].archived,true);assert.equal(archived.inbox.length,1);
  const removed=visibleCatalogSnapshot(data,[{kind:'worktree',id:'tree',projectId:'p',worktreePath:'c:\\project\\',visibility:'removed',revision:1}]);
  assert.equal(removed.sessions.length,0);assert.equal(removed.inbox.length,0);
  assert.equal(data.sessions[0].archived,undefined);
});
test('catalogue dirty preflight neither prompts nor discards unrelated editors',()=>{
  let confirmations=0;
  const unregister=registerDirtyEditor('file',async()=>{confirmations++;return true;},{projectId:'p',ownerSessionId:'s',isDirty:()=>true});
  assert.equal(hasDirtyEditorsInScope({projectId:'other'}),false);
  assert.equal(hasDirtyEditorsInScope({projectId:'p',sessionId:'other'}),false);
  assert.equal(hasDirtyEditorsInScope({projectId:'p',sessionId:'s'}),true);
  assert.equal(hasDirtyEditorsInScope({projectId:'p',projectPath:'C:/project',worktreePath:'c:\\project\\'}),true);
  assert.equal(confirmations,0);unregister();assert.equal(hasDirtyEditorsInScope({projectId:'p'}),false);
});
