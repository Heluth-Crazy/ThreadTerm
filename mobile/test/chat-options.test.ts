import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanion, type LocalStoragePort } from '../src/core/controller';
import { sessionKey, type MachineRecord, type SessionRef } from '../src/core/types';
import type { NativePort } from '../src/core/native';
import { chatOptionsDisabledReason, chatOptionsSummary } from '../src/core/projection';

const now='2026-11-07T00:00:00.000Z';
const ref:SessionRef={machineId:'a',sessionId:'same'};
const options=(model='gpt-5')=>({options:[
  {id:'model',name:'Model',value:model,category:'model' as const,choices:[{value:'gpt-5',name:'GPT-5'},{value:'gpt-5-mini',name:'GPT-5 mini'}]},
  {id:'reasoning',name:'Reasoning effort',value:'high',category:'thinking' as const,choices:[{value:'low',name:'Low'},{value:'high',name:'High'}]},
],commands:[],loadState:'ready' as const,inputCapabilities:{}});
const session=(id='same')=>({id,title:`Chat ${id}`,provider:'codex',mode:'chat' as const,status:'idle',createdAt:now,updatedAt:now});
const machine=(id='a',permission:'readonly'|'fullcontrol'='fullcontrol'):MachineRecord=>({id,name:id,color:'#456',transport:'tls',endpoint:'127.0.0.1:1',tlsFingerprint:'AA',permission,expiresAt:'2099-01-01T00:00:00.000Z'});
const snapshot=(id:string,permission:'readonly'|'fullcontrol'='fullcontrol',methods?:string[])=>({epoch:`epoch-${id}`,revision:1,permission,capabilities:{contract:1 as const,methods:methods??['mobile.snapshot','mobile.events.subscribe','chat.snapshot','chat.options','chat.connection','session.claim','session.release','chat.option.set']},projects:[],worktrees:[],sessions:[session()],inbox:[],providers:[]});
const transcript={items:[],revision:1,repair:{offered:false,degraded:false},hasEarlier:false};
const connection=(id:string,s='same')=>({sessionId:s,runtimeEpoch:`epoch-${id}`,connectionGeneration:1,revision:1,phase:'ready' as const,optionsLoadState:'ready' as const});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

class Memory implements LocalStoragePort { async getItem(){return null;} async setItem(){return;} }
class Native implements NativePort {
  readonly available=true; calls:{id:string;method:string;params:any}[]=[]; records:MachineRecord[]; snapshots=new Map<string,any>(); ui=new Map<string,any>();
  listeners=new Set<(event:{machineId:string;eventJson:string})=>void>(); locks=new Set<(event:{locked:boolean})=>void>(); deferred=new Map<string,{resolve?:(text:string)=>void;reject?:(error:unknown)=>void}>();
  constructor(records=[machine()]){this.records=records;for(const record of records){this.snapshots.set(record.id,snapshot(record.id,record.permission));this.ui.set(record.id,options());}}
  async listMachines(){return this.records;} async connect(id:string){const s=this.snapshots.get(id);return {epoch:s.epoch,permission:s.permission};} async disconnect(){return;}
  request(id:string,method:string,text:string){const params=JSON.parse(text);this.calls.push({id,method,params});const hold=this.deferred.get(`${id}:${method}`);if(hold)return new Promise<string>((resolve,reject)=>{hold.resolve=resolve;hold.reject=reject;});const s=this.snapshots.get(id);let value:any=method==='mobile.snapshot'?s:method==='mobile.events.subscribe'?{sessionIds:params.sessionIds,revision:1}:method==='chat.snapshot'?transcript:method==='chat.connection'?connection(id,params.sessionId):method==='chat.options'?this.ui.get(id):method==='session.claim'?{leaseEpoch:7}:method==='session.release'?null:method==='chat.option.set'?({...this.ui.get(id),options:this.ui.get(id).options.map((row:any)=>row.id===params.optionId?{...row,value:params.value}:row)}):null;return Promise.resolve(JSON.stringify(value));}
  hold(id:string,method:string){const item:{resolve?:(text:string)=>void;reject?:(error:unknown)=>void}={};this.deferred.set(`${id}:${method}`,item);return {resolve:(value:any)=>item.resolve?.(JSON.stringify(value)),reject:(error:unknown)=>item.reject?.(error)};}
  emitUi(id:string,value:any,seq=2){for(const listener of this.listeners)listener({machineId:id,eventJson:JSON.stringify({v:1,event:'chat.ui',epoch:`epoch-${id}`,seq,data:{sessionId:'same',...value}})});}
  emitLock(locked:boolean){for(const listener of this.locks)listener({locked});}
  async preparePairing(){throw Error('unused');} async confirmPairing(){throw Error('unused');} async cancelPairing(){return;} async removeMachine(){return;} async renameMachine(){return;} async unlockControl(){return true;} async lockControl(){return;} async openPreview(){return;} async chooseAttachment(){return null;} async readAttachment(){return '';}
  onRuntimeEvent(listener:(event:{machineId:string;eventJson:string})=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);} onConnectionState(){return()=>{};} onControlLock(listener:(event:{locked:boolean})=>void){this.locks.add(listener);return()=>this.locks.delete(listener);}
}
async function ready(native=new Native()){const app=createCompanion(native,new Memory(),()=> 'operation');await app.controller.initialize();await app.controller.openSession(ref);await app.controller.unlockControl();return {native,app};}

test('options load from the host, accept a later chat.ui event, and fence a stale refresh',async()=>{
  const {native,app}=await ready();assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.chatUi?.options[0]?.value,'gpt-5');
  const held=native.hold('a','chat.options');const refresh=app.controller.refreshChatOptions(ref);await tick();assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.optionsLoading,true);
  native.emitUi('a',options('gpt-5-mini'));held.resolve(options('gpt-5'));await refresh;
  const view=app.getSnapshot().sessions[sessionKey(ref)]!;assert.equal(view.chatUi?.options[0]?.value,'gpt-5-mini');assert.equal(view.optionsLoading,false);await app.dispose();
});

test('a failed option refresh retains the previous host state, reports its error, and a retry clears it',async()=>{
  const {native,app}=await ready();const held=native.hold('a','chat.options');const refreshing=app.controller.refreshChatOptions(ref);await tick();held.reject!(Error('options offline'));
  await assert.rejects(refreshing,/options offline/);let view=app.getSnapshot().sessions[sessionKey(ref)]!;assert.equal(view.chatUi?.options[0]?.value,'gpt-5');assert.equal(view.optionsLoading,false);assert.match(view.optionsError??'',/options offline/);
  native.deferred.delete('a:chat.options');native.ui.set('a',options('gpt-5-mini'));await app.controller.refreshChatOptions(ref);view=app.getSnapshot().sessions[sessionKey(ref)]!;assert.equal(view.chatUi?.options[0]?.value,'gpt-5-mini');assert.equal(view.optionsError,undefined);await app.dispose();
});

test('empty, idle, loading, unknown, and error host option states cannot mutate',async()=>{
  const empty=new Native();empty.ui.set('a',{...options(),options:[]});const {app}=await ready(empty);assert.equal(chatOptionsSummary(app.getSnapshot().sessions[sessionKey(ref)]?.chatUi,'en'),'Session options');await assert.rejects(app.controller.setChatOption(ref,'model','gpt-5-mini'),/invalid_option/);assert.equal(empty.calls.filter(row=>row.method==='chat.option.set').length,0);await app.dispose();
  for(const loadState of ['idle','loading','unknown','error'] as const){const native=new Native();native.ui.set('a',{...options(),loadState});const {app}=await ready(native);await assert.rejects(app.controller.setChatOption(ref,'model','gpt-5-mini'),/options_not_ready/);assert.equal(native.calls.filter(row=>row.method==='chat.option.set').length,0);await app.dispose();}
});

test('an old-generation option reply after reconnect cannot replace the current host UI',async()=>{
  const {native,app}=await ready();const held=native.hold('a','chat.options');const refreshing=app.controller.refreshChatOptions(ref);await tick();await app.setForeground(false);native.deferred.delete('a:chat.options');native.ui.set('a',options('gpt-5-mini'));await app.setForeground(true);held.resolve(options('gpt-5'));await assert.rejects(refreshing,/connection_changed|connection_syncing/);assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.chatUi?.options[0]?.value,'gpt-5-mini');await app.dispose();
});

test('option selection is host-offered, lease-bound, pending once, and adopts the normalized host result',async()=>{
  const {native,app}=await ready();const held=native.hold('a','chat.option.set');const changing=app.controller.setChatOption(ref,'model','gpt-5-mini');await tick();
  assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.optionPending,'model');await assert.rejects(app.controller.setChatOption(ref,'model','gpt-5'),/option_pending/);
  const call=native.calls.find(row=>row.method==='chat.option.set')!;assert.deepEqual(call.params,{sessionId:'same',optionId:'model',value:'gpt-5-mini',leaseEpoch:7,operationId:'operation'});
  held.resolve(options('gpt-5'));await changing;const view=app.getSnapshot().sessions[sessionKey(ref)]!;assert.equal(view.chatUi?.options[0]?.value,'gpt-5','the host-confirmed value, rather than the requested value, wins');assert.equal(view.optionPending,undefined);
  await assert.rejects(app.controller.setChatOption(ref,'model','invented'),/invalid_option/);assert.equal(native.calls.filter(row=>row.method==='chat.option.set').length,1);await app.dispose();
});

test('view access can read options but cannot claim or change them; locked and unsupported controls do not write',async()=>{
  const readonly=new Native([machine('a','readonly')]),app=createCompanion(readonly,new Memory(),()=> 'operation');await app.controller.initialize();await app.controller.openSession(ref);
  await app.controller.refreshChatOptions(ref);assert.ok(readonly.calls.some(row=>row.method==='chat.options'));await assert.rejects(app.controller.setChatOption(ref,'model','gpt-5-mini'),/mobile_readonly/);assert.equal(readonly.calls.filter(row=>['session.claim','chat.option.set'].includes(row.method)).length,0);await app.dispose();
  const {native,app:locked}=await ready();await locked.controller.lockControl();await assert.rejects(locked.controller.setChatOption(ref,'model','gpt-5-mini'),/control_locked/);assert.equal(native.calls.filter(row=>row.method==='chat.option.set').length,0);await locked.dispose();
  const noCapability=new Native();noCapability.snapshots.set('a',snapshot('a','fullcontrol',['mobile.snapshot','mobile.events.subscribe','chat.snapshot','chat.options','chat.connection','session.claim','session.release']));const {app:unsupported}=await ready(noCapability);await assert.rejects(unsupported.controller.setChatOption(ref,'model','gpt-5-mini'),/mobile_unsupported/);await unsupported.dispose();
});

test('a reconnect makes an in-flight option change uncertain and it is never replayed',async()=>{
  const {native,app}=await ready();const held=native.hold('a','chat.option.set');const changing=app.controller.setChatOption(ref,'model','gpt-5-mini');await tick();await app.setForeground(false);held.resolve(options('gpt-5-mini'));
  await assert.rejects(changing,/outcome_unknown|connection_changed/);assert.equal(native.calls.filter(row=>row.method==='chat.option.set').length,1);await app.dispose();
});

test('a native relock during lease acquisition prevents an option write',async()=>{
  const {native,app}=await ready();const held=native.hold('a','session.claim');const changing=app.controller.setChatOption(ref,'model','gpt-5-mini');await tick();
  native.emitLock(true);held.resolve({leaseEpoch:7});await assert.rejects(changing,/control_locked/);assert.equal(native.calls.filter(row=>row.method==='chat.option.set').length,0);await app.dispose();
});

test('desktop permission-restore recovery permits only the host mode choices',async()=>{
  const native=new Native(),request=native.request.bind(native);
  const recovery={...options(),loadState:'error',error:{code:'chat_permission_restore_failed',message:'Choose permissions to reconnect.'},options:[...options().options,{id:'mode',name:'Permission mode',category:'mode',value:'saved',choices:[{value:'saved',name:'Saved'},{value:'default',name:'Default'}]}]};
  native.ui.set('a',recovery);
  native.request=(id,method,text)=>method==='chat.connection'?Promise.resolve(JSON.stringify({...connection(id),phase:'failed',error:{code:'chat_permission_restore_failed',message:'Choose permissions to reconnect.',retryable:true}})):request(id,method,text);
  const {app}=await ready(native);
  assert.equal(chatOptionsDisabledReason(app.getSnapshot(),ref),undefined);
  await assert.rejects(app.controller.setChatOption(ref,'model','gpt-5-mini'),/options_not_ready/);
  await app.controller.setChatOption(ref,'mode','default');
  const writes=native.calls.filter(call=>call.method==='chat.option.set');
  assert.equal(writes.length,1);assert.equal(writes[0]?.params.optionId,'mode');
  assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.chatUi?.options.find(option=>option.id==='mode')?.value,'default');
  await app.dispose();
});

test('same session IDs on two computers change only the selected computer',async()=>{
  const native=new Native([machine('a'),machine('b')]),{app}=await ready(native),other={machineId:'b',sessionId:'same'};await app.controller.openSession(other);await app.controller.setChatOption(other,'model','gpt-5-mini');
  const write=native.calls.filter(row=>row.method==='chat.option.set');assert.equal(write.length,1);assert.equal(write[0]?.id,'b');assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.chatUi?.options[0]?.value,'gpt-5');assert.equal(app.getSnapshot().sessions[sessionKey(other)]?.chatUi?.options[0]?.value,'gpt-5-mini');await app.dispose();
});

test('option writes stay blocked until the authoritative session snapshot has completed',async()=>{
  const native=new Native(),app=createCompanion(native,new Memory(),()=> 'operation');await app.controller.initialize();await app.controller.unlockControl();const held=native.hold('a','chat.snapshot');const opening=app.controller.openSession(ref);await tick();
  await assert.rejects(app.controller.setChatOption(ref,'model','gpt-5-mini'),/connection_syncing/);assert.equal(native.calls.filter(row=>row.method==='chat.option.set').length,0);held.resolve(transcript);await opening;await app.dispose();
});

test('summary and disabled copy preserve host names, localized effort, withdrawn models, and control reasons',async()=>{
  assert.equal(chatOptionsSummary(options(),'en'),'GPT-5 · High');assert.equal(chatOptionsSummary(options(),'zh-CN'),'GPT-5 · 高');
  const withdrawn={...options(),options:[{...options().options[0],value:'retired-model',choices:[{value:'gpt-5',name:'GPT-5'}]},options().options[1]]};assert.equal(chatOptionsSummary(withdrawn,'en'),'retired-model (no longer listed) · High');
  const {app}=await ready();const base=app.getSnapshot(),view=base.sessions[sessionKey(ref)]!;
  const reason=(patch:any)=>chatOptionsDisabledReason({...base,...patch},ref);
  assert.match(reason({machines:[{...base.machines[0],permission:'readonly'}]} )??'',/viewing only/);
  assert.match(reason({controlUnlocked:false})??'',/Locked/);
  assert.match(reason({machines:[{...base.machines[0],syncing:true}]})??'',/Waiting/);
  assert.match(reason({machines:[{...base.machines[0],snapshot:{...base.machines[0]!.snapshot!,capabilities:{contract:1,methods:[]}}}]})??'',/Update ThreadTerm/);
  for(const loadState of ['idle','loading','unknown','error'] as const) assert.match(chatOptionsDisabledReason({...base,sessions:{...base.sessions,[sessionKey(ref)]:{...view,optionsLoading:loadState==='loading',chatUi:{...options(),loadState}}}},ref)??'',loadState==='error'?/could not be loaded/:/Loading options/);
  await app.dispose();
});
