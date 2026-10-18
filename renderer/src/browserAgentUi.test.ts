import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_ACTION_TOOLS, BROWSER_READ_TOOLS } from '@threadterm/protocol';
import { browserControlOrigin, browserOperationActive, browserOperationName, browserOperationStatus, browserShareFence, canRequestBrowserControl, canStopBrowserOperation, createBrowserShareIntents, createBrowserStateSequence, prepareBrowserShareCommand, recentBrowserOperations } from './browserAgentUi';
import { isBrowserShareCommand, isBrowserSharingState, isBrowserStopAgentOperationCommand, isBrowserTabOperation, type BrowserState, type BrowserTabOperation } from './browserTypes';

const page:BrowserState={tabId:'tab-a',url:'https://example.test/page',title:'Page',loading:false,canGoBack:false,canGoForward:false,zoom:1,documentGeneration:2,navigation:'load_observed',unloaded:false,
 sharing:{level:'read',status:'idle',reading:false,grantEpoch:3,viewGeneration:4,navigationEpoch:5,controlAvailable:true}};
const operation=(index=1):BrowserTabOperation=>({operationId:`op-${index}`,tool:'browser_type',callerSessionId:'chat-a',phase:'running',admittedAtUnixMs:index,canStop:true});

test('delayed Stop state cannot replace newer completed, unknown or newly admitted activity with the same share tuple',async()=>{
 const stale:BrowserState={...page,sharing:{...page.sharing!,operations:[operation()]}};
 for(const newerOperations of [[{...operation(),phase:'completed' as const,canStop:false}],[{...operation(),phase:'outcome_unknown' as const,canStop:false}],[operation(),operation(2)]]){
  const updates=createBrowserStateSequence();let current=stale;
  const accept=(state:BrowserState)=>{updates.advance();current=state;};
  let resolveReply!:(state:BrowserState)=>void;
  const reply=new Promise<BrowserState>(resolve=>{resolveReply=resolve;});
  const pending=updates.reply(()=>reply,accept);
  const newer:BrowserState={...page,sharing:{...page.sharing!,operations:newerOperations}};
  assert.deepEqual(browserShareFence(page.tabId,stale,'workspace',true),browserShareFence(page.tabId,newer,'workspace',true),'operation changes do not change the share tuple');
  accept(newer);resolveReply(stale);await pending;assert.equal(current,newer);
 }
});

test('current Stop reply is accepted while an intervening share decision invalidates its captured sequence',async()=>{
 for(const shareChanged of [false,true]){
  const updates=createBrowserStateSequence();let applied:BrowserState|undefined;
  let resolveReply!:(state:BrowserState)=>void;const reply=new Promise<BrowserState>(resolve=>{resolveReply=resolve;});
  const pending=updates.reply(()=>reply,state=>{updates.advance();applied=state;});
  if(shareChanged)updates.advance();
  resolveReply(page);await pending;assert.equal(applied,shareChanged?undefined:page);
 }
 const updates=createBrowserStateSequence();let applied=false;
 await updates.reply(async()=>{updates.advance();return page;},()=>{applied=true;});
 assert.equal(applied,false,'an event emitted synchronously by command dispatch already owns the state');
 await assert.rejects(updates.reply(async()=>{throw new Error('stop failed');},()=>{applied=true;}),/stop failed/);
 assert.equal(applied,false,'transport failure cannot apply a synthetic successful state');
});

test('Control requires explicit current main capability and a loaded visible saved page',()=>{
 assert.equal(canRequestBrowserControl(page,true,true),true);
 for(const changed of [{sharing:undefined},{sharing:{...page.sharing!,controlAvailable:undefined}},{sharing:{...page.sharing!,controlAvailable:false}},
  {sharing:{...page.sharing!,status:'sharing' as const}},{sharing:{...page.sharing!,viewGeneration:0}},{loading:true},{unloaded:true},{navigation:'pending' as const}]){
  assert.equal(canRequestBrowserControl({...page,...changed},true,true),false);
 }
 assert.equal(canRequestBrowserControl(page,false,true),false);
 assert.equal(canRequestBrowserControl(page,true,false),false);
 for(const url of ['file:///private','data:text/html,a','http://user:secret@example.test','invalid'])assert.equal(browserControlOrigin({...page,url}),undefined);
 assert.equal(browserControlOrigin(page),'https://example.test');
});

test('Control and Read commands share an exact saved-workspace generation fence; operation Stop is distinct',()=>{
 const expected={documentGeneration:2,navigationEpoch:5,viewGeneration:4,grantEpoch:3};
 for(const level of ['read','control']){
  const command={type:'share',tabId:'tab-a',level,workspace:{id:'saved-workspace',revision:8},expected};
  assert.equal(isBrowserShareCommand(command),true);
  for(const bad of [{...command,expected:{...expected,grantEpoch:-1}},{...command,workspace:{...command.workspace,callerSessionId:'forged'}},
   {...command,expected:undefined},{...command,level:'eval'},{...command,level:{toString:()=>level}},{...command,callerToken:'forged'}])assert.equal(isBrowserShareCommand(bad),false);
 }
 assert.equal(isBrowserShareCommand({type:'share',tabId:'tab-a',level:'off'}),true);
 assert.equal(isBrowserStopAgentOperationCommand({type:'stopAgentOperation',tabId:'tab-a',operationId:'op-a'}),true);
 for(const bad of [{type:'stop',tabId:'tab-a'},{type:'stopAgentOperation',tabId:'tab-a',operationId:''},
  {type:'stopAgentOperation',tabId:'tab-a',operationId:'op-a',callerSessionId:'other'},
  {type:'stopAgentOperation',tabId:'tab-a',operationId:'\nprivate'},{type:'stopAgentOperation',tabId:'tab-a',operationId:'界'.repeat(171)}])assert.equal(isBrowserStopAgentOperationCommand(bad),false);
});

test('Off, downgrade and unmount invalidate a Control workspace await without blocking the newer choice',async()=>{
 for(const invalidate of ['off','read','unmount'] as const){
  const gate=createBrowserShareIntents(),fence=browserShareFence(page.tabId,page,'project/worktree',true),intent=gate.capture(fence);
  let resolveWorkspace!:(value:{id:string;revision:number})=>void;const workspace=new Promise<{id:string;revision:number}>(resolve=>{resolveWorkspace=resolve;}),dispatched:string[]=[];
  const pending=prepareBrowserShareCommand('control',intent,()=>gate.current(intent,fence),()=>workspace);
  if(invalidate==='unmount')gate.invalidate();else{
   const next=gate.capture(fence),request=await prepareBrowserShareCommand(invalidate,next,()=>gate.current(next,fence),async()=>({id:'saved-workspace',revision:2}));
   if(request)dispatched.push(request.level);
  }
  resolveWorkspace({id:'saved-workspace',revision:2});const stale=await pending;if(stale)dispatched.push(stale.level);
  assert.deepEqual(dispatched,invalidate==='unmount'?[]:[invalidate]);
 }
});

test('workspace preparation preserves the captured tuple and propagates failure without a share request',async()=>{
 const gate=createBrowserShareIntents(),fence=browserShareFence(page.tabId,page,'project/worktree',true),intent=gate.capture(fence);
 const workspace={id:'saved-workspace',revision:9},command=await prepareBrowserShareCommand('control',intent,()=>gate.current(intent,fence),async tabId=>{assert.equal(tabId,page.tabId);return workspace;});
 assert.deepEqual(command,{type:'share',tabId:page.tabId,level:'control',workspace,expected:{documentGeneration:2,navigationEpoch:5,viewGeneration:4,grantEpoch:3}});
 await assert.rejects(prepareBrowserShareCommand('read',intent,()=>true,async()=>{throw new Error('save failed');}),/save failed/);
 await assert.rejects(prepareBrowserShareCommand('control',intent,()=>true),/Save this tab/);
 let prepared=false;assert.equal(await prepareBrowserShareCommand('read',intent,()=>false,async()=>{prepared=true;return workspace;}),undefined);assert.equal(prepared,false);
 assert.deepEqual(await prepareBrowserShareCommand('off',intent,()=>true,async()=>{throw new Error('Off must not await workspace');}),{type:'share',tabId:page.tabId,level:'off'});
});

test('confirmation keeps its original tuple and cannot revive after replacement or cancellation',()=>{
 const fence=browserShareFence(page.tabId,page,'project/worktree',true);
 for(const change of [{tabId:'other'},{scope:'other/worktree'},{visible:false},{level:'off' as const},{controlAvailable:false},
  {documentGeneration:3},{navigationEpoch:6},{viewGeneration:5},{grantEpoch:4}]){
  const gate=createBrowserShareIntents(),intent=gate.capture(fence);
  assert.equal(gate.current(intent,{...fence,...change}),false);
  gate.invalidate();
  assert.equal(gate.current(intent,fence),false,'restoring the old state must not resurrect a cancelled confirmation');
 }
 const gate=createBrowserShareIntents(),input={...fence},intent=gate.capture(input);input.grantEpoch++;
 assert.equal(intent.fence.grantEpoch,fence.grantEpoch,'capture owns an immutable snapshot');
 assert.equal(gate.current(intent,fence),true,'unrelated activity/temporary modal occlusion does not change the fence');
 gate.capture(fence);assert.equal(gate.current(intent,fence),false,'a newer explicit choice invalidates the old one');
});

test('main operation contract bounds identities, metadata and count and admits only the exact ten tools',()=>{
 for(const tool of [...BROWSER_READ_TOOLS,...BROWSER_ACTION_TOOLS])assert.equal(isBrowserTabOperation({...operation(),tool}),true);
 for(const bad of [{...operation(),tool:'browser_eval'},{...operation(),text:'PRIVATE'},{...operation(),arguments:{text:'PRIVATE'}},
  {...operation(),phase:'completed'},{...operation(),phase:'outcome_unknown'},{...operation(),callerSessionId:'界'.repeat(86)},
  {...operation(),origin:'bad\norigin'},{...operation(),title:'界'.repeat(171)},{...operation(),admittedAtUnixMs:Infinity},
  {...operation(),finishedAtUnixMs:-1},{...operation(),provenanceUnavailable:'yes'}])assert.equal(isBrowserTabOperation(bad),false);
 assert.equal(isBrowserSharingState({...page.sharing,operations:Array.from({length:50},(_,index)=>operation(index))}),true);
 assert.equal(isBrowserSharingState({...page.sharing,operations:Array.from({length:51},(_,index)=>operation(index))}),false);
 assert.equal(isBrowserSharingState({...page.sharing,operations:[operation(),operation()]}),false);
 assert.equal(isBrowserSharingState({...page.sharing,operations:[{...operation(),result:'PRIVATE'}]}),false);
 assert.equal(isBrowserSharingState({...page.sharing,controlAvailable:'true'}),false);
 assert.equal(isBrowserSharingState({...page.sharing,controlAvailable:undefined,operations:undefined}),true,'older native state is compatible and cannot imply Control');
});

test('activity keeps newest fifty stable identities without mutation and unknown stays visibly settled',()=>{
 const operations=Array.from({length:57},(_,index)=>operation(index)),before=operations.map(item=>item.operationId),recent=recentBrowserOperations(operations);
 assert.equal(recent.length,50);assert.deepEqual(recent.map(item=>item.operationId),before.slice(-50).reverse());assert.deepEqual(operations.map(item=>item.operationId),before);
 const copy=(en:string,_zh:string)=>en;
 for(const phase of ['completed','failed','cancelled','outcome_unknown'] as const){const item={...operation(),phase,canStop:false};assert.equal(browserOperationActive(item),false);assert.equal(canStopBrowserOperation(item),false);}
 assert.equal(browserOperationStatus({...operation(),phase:'outcome_unknown',canStop:false},copy),'Outcome unknown');
 assert.equal(browserOperationStatus({...operation(),phase:'cancelled',canStop:false},copy),'Interrupted');
 assert.equal(canStopBrowserOperation({...operation(),canStop:false}),false);
 assert.equal(canStopBrowserOperation({...operation(),phase:'stopping',canStop:false}),false);
 for(const tool of [...BROWSER_READ_TOOLS,...BROWSER_ACTION_TOOLS]){assert.ok(browserOperationName(tool,copy));assert.ok(browserOperationName(tool,(_en,zh)=>zh));}
});
