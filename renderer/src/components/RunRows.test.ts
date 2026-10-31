import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@threadterm/protocol';
import { isPinnedDetectedTwin, RunEntryRow, runCatalogReady, unpinNeedsConfirm } from './RunRows';

test('run commands wait for the initial repo catalog read', () => {
 assert.equal(runCatalogReady({loading:false,detecting:false,repoLoading:true}),false);
 assert.equal(runCatalogReady({loading:true,detecting:false,repoLoading:false}),false);
 assert.equal(runCatalogReady({loading:false,detecting:true,repoLoading:false}),false);
 assert.equal(runCatalogReady({loading:false,detecting:false,repoLoading:false}),true);
});

const detected={name:'dev',kind:'service' as const,command:'npm run dev',cwd:'',shell:'cmd' as const};
const saved={...detected,env:[],dependsOn:[],previewUrl:undefined};
test('a pin hides only its exact detected launch twin', () => {
 assert.equal(isPinnedDetectedTwin(saved,detected),true);
 assert.equal(isPinnedDetectedTwin(saved,{...detected,cwd:'app'}),false);
 assert.equal(isPinnedDetectedTwin(saved,{...detected,shell:'pwsh'}),false);
 assert.equal(isPinnedDetectedTwin(saved,{...detected,command:'npm run other'}),false);
});
test('unpin confirmation protects settings not present in project files', () => {
 assert.equal(unpinNeedsConfirm(saved,detected),false);
 assert.equal(unpinNeedsConfirm({...saved,env:[{name:'TOKEN',value:'x'}]},detected),true);
 assert.equal(unpinNeedsConfirm(saved,undefined),true);
 assert.equal(unpinNeedsConfirm({...saved,name:'custom name'},detected),true);
 assert.equal(unpinNeedsConfirm({...saved,kind:'task'},detected),true);
 assert.equal(unpinNeedsConfirm({...saved,previewUrl:'http://localhost:3000'},detected),true);
 assert.equal(unpinNeedsConfirm({...saved,dependsOn:['install']},detected),true);
});

test('an active entry primary opens output instead of running and retains roving focus', () => {
 let opened:string|undefined, launches=0;
 const entry={key:'dev',commandId:'dev',source:'saved' as const,name:'dev',command:'npm run dev',kind:'service' as const,cwd:''};
 const session={id:'active-dev',status:'running',run:{commandId:'dev',name:'dev',kind:'service',shell:'cmd'}} as Session;
 for(const zh of [false,true]){
  const row=RunEntryRow({entry,session,zh,actions:null,onOpen:id=>{opened=id;},onRun:()=>{launches++;}});
  const primary=row.props.children[0];
  assert.equal(primary.props['data-run-primary'],'true');
  assert.equal(primary.props['aria-label'],zh?'打开输出':'Open output');
  assert.equal(primary.props.title,zh?'打开输出':'Open output');
  primary.props.onClick();
  assert.equal(opened,session.id);
 }
 assert.equal(launches,0);
});

test('dependency progress replaces the command and exposes its cancel action', () => {
 let cancelled=0;
 const entry={key:'api',commandId:'api',source:'saved' as const,name:'api',command:'node api.mjs',kind:'service' as const,cwd:''};
 const row=RunEntryRow({entry,zh:false,actions:null,sequenceText:'Starting db (1/2)…',onCancelSequence:()=>{cancelled++;}});
 const chip=row.props.children[2];
 assert.equal(chip.props['data-testid'],'run-sequence-chip');
 assert.equal(chip.props.children[0].props.children,'Starting db (1/2)…');
 const cancel=chip.props.children[1];
 assert.equal(cancel.props.children,'Cancel');
 cancel.props.onClick();
 assert.equal(cancelled,1);
 const failed=RunEntryRow({entry,zh:true,actions:null,sequenceText:'依赖失败：db'}).props.children[2];
 assert.equal(failed.props.children[1],undefined,'failed sequences have no active Cancel action');
});
