import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PaneLayout, Preset, Snapshot} from '@threadterm/protocol';
import {restorePreset,selectPresetLayout,sessionIds} from './presetRestore';

const layout:PaneLayout={kind:'split',id:'split',direction:'horizontal',ratio:0.5,first:{kind:'pane',id:'a-pane',activeTabId:'a-session',tabs:[{id:'a-session',kind:'session',sessionId:'a'},{id:'a-file',kind:'file',projectId:'p',worktreePath:'C:/project/a',path:'README.md'}]},second:{kind:'pane',id:'b-pane',activeTabId:'b-file',tabs:[{id:'b-session',kind:'session',sessionId:'b'},{id:'b-file',kind:'diff',projectId:'p',worktreePath:'C:/project/b',path:'index.ts'}]}};
const scopes=[{sessionId:'a',projectId:'p',cwd:'C:/project/a'},{sessionId:'b',projectId:'p',cwd:'C:/project/b'}];
test('choosing one tree removes unchecked sessions and its file scope, collapses the split',()=>{
  const selected=selectPresetLayout(layout,new Set(['a']),scopes);
  assert.equal(selected?.kind,'pane');assert.deepEqual(selected&&sessionIds(selected),['a']);
  if(selected?.kind==='pane'){assert.deepEqual(selected.tabs.map(tab=>tab.id),['a-session','a-file']);assert.equal(selected.activeTabId,'a-session');}
  assert.equal(selectPresetLayout(layout,new Set(),scopes),null);
});
test('file/diff retention compares canonical Windows paths and preserves selected layout IDs',()=>{
  const selected=selectPresetLayout(layout,new Set(['a','b']),[{...scopes[0],cwd:'c:\\project\\a\\'},scopes[1]]);
  assert.deepEqual(selected,layout);
});
test('restoring live, ended and imported history views reuses identities without lifecycle or input calls',async()=>{
  const stamp='2026-09-10T14:00:00Z';
  const data:Snapshot={epoch:'test',revision:1,projects:[{id:'p',name:'P',path:'C:/project',createdAt:stamp}],sessions:scopes.map(scope=>({id:scope.sessionId,projectId:'p',worktreePath:scope.cwd,title:scope.sessionId,provider:'shell',mode:'terminal',status:'running',createdAt:stamp,updatedAt:stamp})),settings:{revision:1},workspaces:[],presets:[],inbox:[],providers:[]};
  const calls:string[]=[];let missing=false;let removed=false;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{threadterm:{request:async(method:string)=>{calls.push(method);if(method==='runtime.snapshot')return structuredClone(data);if(method==='catalog.visibility.list')return removed?[{kind:'session',id:'a',visibility:'removed',revision:1}]:[];if(method==='worktree.list')return missing?[{path:'C:/project/a',missing:true}]:[];throw new Error('Unexpected mutation: '+method);}}}});
  const preset:Preset={id:'preset',name:'Preset',revision:1,layout,sessions:[],commands:['echo must-never-run']};
  const result=await restorePreset(preset,new Set(['a']));assert.equal(result.sessionId,'a');assert.deepEqual(sessionIds(result.layout),['a']);assert.deepEqual(calls,['runtime.snapshot','catalog.visibility.list','worktree.list']);
  for(const status of ['exited','interrupted','error'] as const){data.sessions[0].status=status;calls.length=0;assert.equal((await restorePreset(preset,new Set(['a']))).sessionId,'a');assert.deepEqual(calls,['runtime.snapshot','catalog.visibility.list','worktree.list']);}
  data.sessions[0].readOnly=true;calls.length=0;assert.equal((await restorePreset(preset,new Set(['a']))).sessionId,'a');assert.deepEqual(calls,['runtime.snapshot','catalog.visibility.list','worktree.list']);
  data.sessions[0].archived=true;await assert.rejects(restorePreset(preset,new Set(['a'])),/unavailable/);
  data.sessions[0].archived=false;missing=true;await assert.rejects(restorePreset(preset,new Set(['a'])),/directory is missing/);missing=false;removed=true;await assert.rejects(restorePreset(preset,new Set(['a'])),/unavailable/);
});
