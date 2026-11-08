import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanion, type LocalStoragePort } from '../src/core/controller';
import { sessionKey, type MachineRecord } from '../src/core/types';
import type { NativePort } from '../src/core/native';

const now='2026-11-06T00:00:00.000Z';
const chat=(id='same')=>({id,title:`Chat ${id}`,provider:'codex',mode:'chat',status:'idle',createdAt:now,updatedAt:now});
const snapshot=(machineId:string, permission:'readonly'|'fullcontrol'='fullcontrol', sessions=[chat()])=>({epoch:`epoch-${machineId}`,revision:1,permission,capabilities:{contract:1 as const,methods:['mobile.snapshot','mobile.events.subscribe','chat.snapshot','chat.options','chat.connection','session.claim','session.release','chat.send','terminal.read','attachment.upload','attachment.read']},projects:[],worktrees:[],sessions,inbox:[],providers:[]});
const transcript={items:[],revision:1,repair:{offered:false,degraded:false},hasEarlier:false};
const ui={options:[],commands:[],loadState:'ready',inputCapabilities:{images:true as boolean}};
const connection=(sessionId:string,epoch:string)=>({sessionId,runtimeEpoch:epoch,connectionGeneration:1,revision:1,phase:'ready' as const,optionsLoadState:'ready' as const});
const record=(id:string,permission:'readonly'|'fullcontrol'='fullcontrol'):MachineRecord=>({id,name:id,color:'#123456',transport:'tls',endpoint:'127.0.0.1:1',tlsFingerprint:'AA',permission,expiresAt:'2099-01-01T00:00:00.000Z'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

class MemoryStorage implements LocalStoragePort { values=new Map<string,string>(); async getItem(key:string){return this.values.get(key)??null;} async setItem(key:string,value:string){this.values.set(key,value);} }
class MockNative implements NativePort {
  readonly available=true; calls:{id:string;method:string;params:any}[]=[]; disconnects:string[]=[]; removed:string[]=[]; locks=0; unlocks=0; connectWait?:Promise<void>; unlockWait?:Promise<void>;
  records:MachineRecord[]; snapshots=new Map<string,any>(); terminalResults:any[]=[]; attachmentChunks:string[]=['YQ==']; runtimeListeners=new Set<(value:{machineId:string;eventJson:string})=>void>(); connectionListeners=new Set<(value:any)=>void>(); lockListeners=new Set<(value:{locked:boolean})=>void>(); deferred=new Map<string,{reply?:(value:string)=>void;fail?:(reason:unknown)=>void}>();
  constructor(records:MachineRecord[]){this.records=records;for(const row of records)this.snapshots.set(row.id,snapshot(row.id,row.permission));}
  async listMachines(){return this.records;} async preparePairing(){throw Error('unused');} async confirmPairing(){throw Error('unused');} async cancelPairing(){return;} async removeMachine(id:string){this.removed.push(id);} async renameMachine(){return;}
  async connect(id:string){await this.connectWait;const s=this.snapshots.get(id);return {epoch:s.epoch,permission:s.permission};} async disconnect(id:string){this.disconnects.push(id);} async unlockControl(){this.unlocks++;await this.unlockWait;return true;} async lockControl(){this.locks++;} async openPreview(){return;} async chooseAttachment(){return null;} async readAttachment(){return 'YQ==';}
  request(id:string,method:string,paramsJson:string){const params=JSON.parse(paramsJson);this.calls.push({id,method,params});const key=`${id}:${method}`;const deferred=this.deferred.get(key);if(deferred)return new Promise<string>((resolve,reject)=>{deferred.reply=resolve;deferred.fail=reject;});
    const s=this.snapshots.get(id);let result:any=method==='mobile.snapshot'?s:method==='mobile.events.subscribe'?{sessionIds:params.sessionIds,revision:s.revision}:method==='chat.snapshot'?transcript:method==='chat.options'?ui:method==='chat.connection'?connection(params.sessionId,s.epoch):method==='session.claim'?{leaseEpoch:7}:method==='session.release'?null:method==='chat.send'?{turnId:'turn-1'}:method==='attachment.upload'?{offset:params.offset+1,...(params.final?{assetId:'asset-1',hostPath:'C:/host/file.txt'}:{})}:method==='attachment.read'?{assetId:params.assetId,hostPath:'C:/host/file.txt',name:'pic.png',size:1,offset:params.offset,chunk:this.attachmentChunks.shift()??'YQ==',eof:true}:method==='terminal.read'?(this.terminalResults.shift()??{sessionId:params.sessionId,fromCursor:params.cursor??0,nextCursor:params.cursor??0,truncated:false,encoding:'base64',data:''}):null;return Promise.resolve(JSON.stringify(result));}
  hold(id:string,method:string){const slot:{reply?:(value:string)=>void;fail?:(reason:unknown)=>void}={};this.deferred.set(`${id}:${method}`,slot);return {resolve:(value:string)=>slot.reply?.(value),reject:(reason:unknown)=>slot.fail?.(reason)};}
  onRuntimeEvent(listener:(value:{machineId:string;eventJson:string})=>void){this.runtimeListeners.add(listener);return()=>this.runtimeListeners.delete(listener);} onConnectionState(listener:(value:any)=>void){this.connectionListeners.add(listener);return()=>this.connectionListeners.delete(listener);} onControlLock(listener:(value:{locked:boolean})=>void){this.lockListeners.add(listener);return()=>this.lockListeners.delete(listener);}
  emitEvent(machineId:string,event:any){for(const listener of this.runtimeListeners)listener({machineId,eventJson:JSON.stringify(event)});} emitConnection(machineId:string,state:any,message?:string){for(const listener of this.connectionListeners)listener({machineId,state,message});} emitLock(locked:boolean){for(const listener of this.lockListeners)listener({locked});}
}
async function ready(records=[record('a'),record('b')]) {const native=new MockNative(records),storage=new MemoryStorage(),app=createCompanion(native,storage,()=> 'operation');await app.controller.initialize();return {native,storage,app};}

test('machine-qualified identity keeps same session ids and drafts separate, and local removal removes only one machine', async()=>{
  const {native,app}=await ready(); const a={machineId:'a',sessionId:'same'},b={machineId:'b',sessionId:'same'};
  app.controller.setDraft(a,'draft A');app.controller.setDraft(b,'draft B');
  await app.controller.openSession(a);await app.controller.openSession(b);
  assert.equal(app.getSnapshot().drafts[sessionKey(a)],'draft A');assert.equal(app.getSnapshot().drafts[sessionKey(b)],'draft B');
  assert.ok(app.getSnapshot().sessions[sessionKey(a)]);assert.ok(app.getSnapshot().sessions[sessionKey(b)]);
  await app.controller.removeMachine('a');
  assert.deepEqual(native.removed,['a']);assert.equal(app.getSnapshot().machines.map(m=>m.id).join(','),'b');assert.equal(app.getSnapshot().drafts[sessionKey(a)],undefined);assert.equal(app.getSnapshot().drafts[sessionKey(b)],'draft B');assert.equal(app.getSnapshot().sessions[sessionKey(b)]?.ref.machineId,'b');await app.dispose();
});

test('readonly refuses before any control dispatch', async()=>{
  const {native,app}=await ready([record('read','readonly')]);const ref={machineId:'read',sessionId:'same'};await app.controller.openSession(ref);
  await assert.rejects(app.controller.terminalInput(ref,'pwd'),/mobile_readonly/);
  assert.equal(native.calls.filter(call=>['session.claim','terminal.input'].includes(call.method)).length,0);await app.dispose();
});

test('terminal input claims the terminal session and writes its CR payload with that session id',async()=>{
  const native=new MockNative([record('a')]);native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal'}]));
  native.snapshots.get('a').capabilities.methods.push('terminal.input');
  const app=createCompanion(native,new MemoryStorage(),()=> 'operation');await app.controller.initialize();
  try {const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);await app.controller.terminalInput(ref,'echo MOBILE_ECHO\r');
    const claim=native.calls.find(call=>call.method==='session.claim');const input=native.calls.find(call=>call.method==='terminal.input');
    assert.equal(claim?.params.sessionId,'same');assert.deepEqual(input?.params,{sessionId:'same',data:'echo MOBILE_ECHO\r',leaseEpoch:7});
  } finally {await app.dispose();}
});

test('terminal bytes serialize in arrival order and reject a stale displayed connection before dispatch',async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};
  native.snapshots.get('a').capabilities.methods.push('terminal.input');await app.controller.refresh('a');
  await app.controller.openSession(ref);await app.controller.claimControl(ref);
  const expected={connectionGeneration:app.getSnapshot().machines[0].connectionGeneration!,leaseEpoch:7};
  const held=native.hold('a','terminal.input');
  const first=app.controller.terminalInput(ref,'testmsg',expected),second=app.controller.terminalInput(ref,'\r',expected);
  try {
    await tick();assert.equal(native.calls.filter(call=>call.method==='terminal.input').length,1);
    native.deferred.delete('a:terminal.input');held.resolve('null');await Promise.all([first,second]);
    assert.deepEqual(native.calls.filter(call=>call.method==='terminal.input').map(call=>call.params.data),['testmsg','\r']);
    await assert.rejects(app.controller.terminalInput(ref,'stale\r',{...expected,connectionGeneration:expected.connectionGeneration-1}),/connection_changed/);
    assert.equal(native.calls.filter(call=>call.method==='terminal.input').length,2);
  } finally {await app.dispose();}
});

test('terminal input queued before reconnect cannot submit after an uncertain preceding write',async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};
  native.snapshots.get('a').capabilities.methods.push('terminal.input');await app.controller.refresh('a');
  await app.controller.openSession(ref);await app.controller.claimControl(ref);
  const held=native.hold('a','terminal.input');
  const first=app.controller.terminalInput(ref,'testmsg'),second=app.controller.terminalInput(ref,'\r');
  const settled=Promise.allSettled([first,second]);
  try {
    await tick();await app.controller.disconnect('a');await app.controller.connect('a');
    held.resolve('null');
    assert.deepEqual((await settled).map(result=>result.status),['rejected','rejected']);
    assert.equal(native.calls.filter(call=>call.method==='terminal.input').length,1,'queued Return is not replayed on a new connection');
  } finally {await app.dispose();}
});

test('terminal output keeps raw bytes and host dimensions until an explicit resize',async()=>{
  const native=new MockNative([record('a')]);
  native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal',cols:5,rows:3}]));
  native.snapshots.get('a').capabilities.methods.push('terminal.resize');
  native.terminalResults.push({sessionId:'same',fromCursor:0,nextCursor:6,truncated:false,encoding:'base64',data:Buffer.from('abcdef').toString('base64')});
  const app=createCompanion(native,new MemoryStorage(),()=> 'operation');
  try {
    await app.controller.initialize();const ref={machineId:'a',sessionId:'same'};
    await app.controller.openSession(ref);await new Promise(resolve=>setTimeout(resolve,450));
    assert.deepEqual(app.getSnapshot().sessions[sessionKey(ref)].terminal,'abcdef');
    await app.controller.terminalResize(ref,40,10);
    assert.deepEqual(native.calls.find(call=>call.method==='terminal.resize')?.params,{sessionId:'same',cols:40,rows:10,leaseEpoch:7});
    const session=app.getSnapshot().machines[0].snapshot?.sessions[0];
    assert.equal(session?.cols,40);assert.equal(session?.rows,10);
  } finally {await app.dispose();}
});

test('terminal overlap and reconnect preserve exactly-once raw output without a self-created gap',async()=>{
  const native=new MockNative([record('a')]);
  native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal',cols:120,rows:40}]));
  const banner='\x1b[36mOpenAI Codex\x1b[0m\r\n',bytes=Buffer.from(banner);
  native.terminalResults.push({sessionId:'same',fromCursor:0,nextCursor:bytes.length,truncated:false,encoding:'base64',data:bytes.toString('base64')});
  const app=createCompanion(native,new MemoryStorage(),()=> 'operation'),ref={machineId:'a',sessionId:'same'};
  try {
    await app.controller.initialize();await app.controller.openSession(ref);await new Promise(resolve=>setTimeout(resolve,450));
    await app.setForeground(false);
    native.terminalResults.push({sessionId:'same',fromCursor:0,nextCursor:bytes.length+2,truncated:false,encoding:'base64',data:Buffer.concat([bytes,Buffer.from('> ')]).toString('base64')});
    await app.setForeground(true);await new Promise(resolve=>setTimeout(resolve,450));
    const view=app.getSnapshot().sessions[sessionKey(ref)];
    assert.equal(view.terminal,banner+'> ');
    assert.equal(view.terminalGap,false);
    assert.equal(view.terminalStream?.epoch,0);
    assert.equal(Buffer.concat(view.terminalStream!.chunks.map(chunk=>Buffer.from(chunk.data,'base64'))).toString(),banner+'> ');
    assert.equal(native.calls.filter(call=>call.method==='terminal.read').at(-1)?.params.cursor,bytes.length);
    assert.equal(native.calls.some(call=>call.method==='terminal.resize'),false);
  } finally {await app.dispose();}
});

test('a host epoch change restarts the terminal stream instead of joining unrelated offsets',async()=>{
  const native=new MockNative([record('a')]);
  native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal'}]));
  native.terminalResults.push({sessionId:'same',fromCursor:0,nextCursor:3,truncated:false,encoding:'base64',data:Buffer.from('old').toString('base64')});
  const app=createCompanion(native,new MemoryStorage(),()=> 'operation'),ref={machineId:'a',sessionId:'same'};
  try {
    await app.controller.initialize();await app.controller.openSession(ref);await new Promise(resolve=>setTimeout(resolve,450));
    await app.setForeground(false);native.snapshots.get('a').epoch='new-host-epoch';
    native.terminalResults.push({sessionId:'same',fromCursor:0,nextCursor:4,truncated:false,encoding:'base64',data:Buffer.from('new!').toString('base64')});
    await app.setForeground(true);await new Promise(resolve=>setTimeout(resolve,450));
    const view=app.getSnapshot().sessions[sessionKey(ref)];
    assert.equal(view.terminal,'new!');assert.equal(view.terminalStream?.epoch,1);
    assert.equal(native.calls.filter(call=>call.method==='terminal.read').at(-1)?.params.tail,true);
  } finally {await app.dispose();}
});

test('an empty page after cursor rewind rebuilds from the actual tail instead of leaving a blank terminal',async()=>{
  const native=new MockNative([record('a')]);
  native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal'}]));
  native.terminalResults.push(
    {sessionId:'same',fromCursor:0,nextCursor:10,truncated:false,encoding:'base64',data:Buffer.from('old stream').toString('base64')},
    {sessionId:'same',fromCursor:10,nextCursor:3,truncated:false,encoding:'base64',data:''},
    {sessionId:'same',fromCursor:0,nextCursor:3,truncated:false,encoding:'base64',data:Buffer.from('new').toString('base64')},
  );
  const app=createCompanion(native,new MemoryStorage(),()=> 'operation'),ref={machineId:'a',sessionId:'same'};
  try {
    await app.controller.initialize();await app.controller.openSession(ref);await new Promise(resolve=>setTimeout(resolve,900));
    const view=app.getSnapshot().sessions[sessionKey(ref)];
    assert.equal(view.terminal,'new');assert.equal(view.terminalGap,true);assert.equal(view.terminalStream?.epoch,1);
    const reads=native.calls.filter(call=>call.method==='terminal.read');
    assert.equal(reads[1].params.cursor,10);assert.equal(reads[2].params.tail,true);
  } finally {await app.dispose();}
});

test('terminal reconnect retains readable output and continues from its retained cursor and marks actual storage gaps',async()=>{
  const native=new MockNative([record('a')]);
  native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal'}]));
  native.terminalResults.push({sessionId:'same',fromCursor:0,nextCursor:3,truncated:false,encoding:'base64',data:Buffer.from('old').toString('base64')});
  const app=createCompanion(native,new MemoryStorage(),()=> 'operation');
  try {
    await app.controller.initialize();const ref={machineId:'a',sessionId:'same'};
    await app.controller.openSession(ref);await new Promise(resolve=>setTimeout(resolve,450));
    await app.setForeground(false);
    assert.equal(app.getSnapshot().sessions[sessionKey(ref)].terminal,'old');
    native.terminalResults.push({sessionId:'same',fromCursor:10,nextCursor:13,truncated:true,encoding:'base64',data:Buffer.from('new').toString('base64')});
    await app.setForeground(true);await new Promise(resolve=>setTimeout(resolve,450));
    const reads=native.calls.filter(call=>call.method==='terminal.read');
    assert.equal(reads.at(-1)?.params.cursor,3);
    assert.deepEqual(app.getSnapshot().sessions[sessionKey(ref)].terminal,'new');
    assert.equal(app.getSnapshot().sessions[sessionKey(ref)].terminalGap,true);
  } finally {await app.dispose();}
});

test('reconnect during a terminal claim cannot dispatch input on the new connection',async()=>{
  const {native,app}=await ready([record('a')]);
  native.snapshots.get('a').capabilities.methods.push('terminal.input');
  const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);
  const held=native.hold('a','session.claim');
  const input=app.controller.terminalInput(ref,'echo once\r');
  const rejected=assert.rejects(input,/outcome_unknown|connection_changed/);
  await tick();await app.setForeground(false);held.resolve(JSON.stringify({leaseEpoch:7}));
  await rejected;
  assert.equal(native.calls.filter(call=>call.method==='terminal.input').length,0);
  await app.dispose();
});

test('reconnect fences an old send result and never replays an uncertain mutation', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);app.controller.setDraft(ref,'do once');
  const held=native.hold('a','chat.send');const sending=app.controller.send(ref);await tick();
  await app.setForeground(false);held.resolve(JSON.stringify({turnId:'turn-1'}));
  await assert.rejects(sending,/outcome_unknown|connection_changed/);
  assert.equal(native.calls.filter(call=>call.method==='chat.send').length,1,'the uncertain mutation was not replayed');assert.equal(app.getSnapshot().drafts[sessionKey(ref)],'do once');await app.dispose();
});

test('background locks control and disconnects every machine', async()=>{
  const {native,app}=await ready();await app.setForeground(false);
  assert.ok(native.locks>=1);assert.deepEqual(new Set(native.disconnects),new Set(['a','b']));assert.equal(app.getSnapshot().controlUnlocked,false);assert.ok(app.getSnapshot().machines.every(machine=>machine.status==='disconnected'&&machine.syncing));await app.dispose();
});

test('snapshot event ordering buffers chat events until the session snapshot commits', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};
  const held=native.hold('a','chat.snapshot');const opening=app.controller.openSession(ref);await tick();
  native.emitEvent('a',{v:1,event:'chat.item',epoch:'epoch-a',seq:2,data:{sessionId:'same',item:{id:'late',role:'assistant',createdAt:now,parts:[{type:'text',text:'arrived during snapshot'}]}}});
  held.resolve(JSON.stringify(transcript));await opening;
  assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.items[0]?.id,'late');await app.dispose();
});

test('terminal reads start with a bounded tail and mark a cursor discontinuity as a gap', async()=>{
  const native=new MockNative([record('a')]);native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal'}]));const app=createCompanion(native,new MemoryStorage(),()=> 'operation');await app.controller.initialize();native.terminalResults.push(
    {sessionId:'same',fromCursor:0,nextCursor:3,truncated:false,encoding:'base64',data:'YQ=='},
    {sessionId:'same',fromCursor:5,nextCursor:6,truncated:false,encoding:'base64',data:'Yg=='},
  );
  try {const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);await new Promise(resolve=>setTimeout(resolve,900));
    const reads=native.calls.filter(call=>call.method==='terminal.read');assert.ok(reads.length,JSON.stringify({machine:app.getSnapshot().machines[0],calls:native.calls}));assert.equal(reads[0]?.params.tail,true);assert.equal(reads[1]?.params.cursor,3);assert.equal(app.getSnapshot().sessions[sessionKey(ref)]?.terminalGap,true);
  } finally {await app.dispose();}
});

test('a truncated terminal page marks a gap and preserves split UTF-8 decoding across cursors', async()=>{
  const native=new MockNative([record('a')]);native.snapshots.set('a',snapshot('a','fullcontrol',[{...chat(),mode:'terminal'}]));const app=createCompanion(native,new MemoryStorage(),()=> 'operation');await app.controller.initialize();native.terminalResults.push(
    {sessionId:'same',fromCursor:0,nextCursor:2,truncated:true,encoding:'base64',data:'4g=='}, // first byte of €
    {sessionId:'same',fromCursor:2,nextCursor:4,truncated:false,encoding:'base64',data:'gqw='},
  );
  try {const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);await new Promise(resolve=>setTimeout(resolve,900));
    const view=app.getSnapshot().sessions[sessionKey(ref)]!;assert.ok(native.calls.some(call=>call.method==='terminal.read'),JSON.stringify({machine:app.getSnapshot().machines[0],calls:native.calls}));assert.equal(view.terminal,'€');assert.equal(view.terminalGap,true,'truncated output is an explicit durable gap');
  } finally {await app.dispose();}
});

test('read-only session creation fails before requesting biometric control unlock', async()=>{
  const {native,app}=await ready([record('read','readonly')]);
  await assert.rejects(app.controller.createSession('read',{projectId:'project',provider:'codex',mode:'chat'}),/control_locked|mobile_readonly/);
  assert.equal(native.unlocks,0);assert.equal(native.calls.filter(call=>call.method==='mobile.session.create').length,0);await app.dispose();
});

test('backgrounding an unresolved connect cannot strand the foreground reconnect', async()=>{
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});const native=new MockNative([record('a')]);native.connectWait=wait;const app=createCompanion(native,new MemoryStorage(),()=> 'operation');
  const initializing=app.controller.initialize();await tick();await app.setForeground(false);const foreground=app.setForeground(true);release();await initializing;await foreground;await tick();await tick();
  assert.equal(app.getSnapshot().machines[0]?.status,'connected');assert.equal(app.getSnapshot().machines[0]?.syncing,false);await app.dispose();
});

test('a disconnected connection invalidates the epoch and blocks writes until a fresh snapshot', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);native.emitConnection('a','disconnected','lost');
  await assert.rejects(app.controller.terminalInput(ref,'pwd'),/connection_syncing/);assert.equal(native.calls.filter(call=>call.method==='terminal.input').length,0);await app.dispose();
});

test('a late biometric unlock cannot re-unlock a backgrounded companion', async()=>{
  let release!:()=>void;const native=new MockNative([record('a')]);native.unlockWait=new Promise<void>(resolve=>{release=resolve;});const app=createCompanion(native,new MemoryStorage(),()=> 'operation');await app.controller.initialize();
  const unlocking=app.controller.unlockControl();await tick();await app.setForeground(false);release();assert.equal(await unlocking,false);assert.equal(app.getSnapshot().controlUnlocked,false);await app.dispose();
});

test('a late biometric unlock cannot re-unlock after an explicit foreground lock', async()=>{
  let release!:()=>void;const native=new MockNative([record('a')]);native.unlockWait=new Promise<void>(resolve=>{release=resolve;});const app=createCompanion(native,new MemoryStorage(),()=> 'operation');await app.controller.initialize();
  const unlocking=app.controller.unlockControl();await tick();await app.controller.lockControl();release();assert.equal(await unlocking,false);assert.equal(app.getSnapshot().controlUnlocked,false);await app.dispose();
});

test('uploaded attachment provenance is machine-qualified and a confirmed send clears only its draft and files', async()=>{
  const {native,app}=await ready();const a={machineId:'a',sessionId:'same'},b={machineId:'b',sessionId:'same'};await app.controller.openSession(a);await app.controller.openSession(b);
  const file=await app.controller.uploadAttachment(a,{name:'note.txt',size:1,uri:'private://note'});app.controller.setDraft(a,'look');app.controller.setDraft(b,'other');
  assert.deepEqual(file.ref,a);assert.equal(app.getSnapshot().attachments[sessionKey(b)],undefined);
  await app.controller.openSession(a);await app.controller.send(a);
  const sent=native.calls.filter(call=>call.method==='chat.send').at(-1)!;assert.match(sent.params.text,/Attached file "note.txt": "C:\/host\/file.txt"/);assert.equal(app.getSnapshot().drafts[sessionKey(a)],'');assert.equal(app.getSnapshot().attachments[sessionKey(a)]?.length,0);assert.equal(app.getSnapshot().drafts[sessionKey(b)],'other');await app.dispose();
});

test('an uncertain attachment send preserves the local draft and uploaded attachment for user review', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);await app.controller.uploadAttachment(ref,{name:'note.txt',size:1,uri:'private://note'});app.controller.setDraft(ref,'keep me');
  const held=native.hold('a','chat.send');const sending=app.controller.send(ref);await tick();await app.setForeground(false);held.resolve(JSON.stringify({turnId:'turn-1'}));await assert.rejects(sending,/outcome_unknown|connection_changed/);
  assert.equal(app.getSnapshot().drafts[sessionKey(ref)],'keep me');assert.equal(app.getSnapshot().attachments[sessionKey(ref)]?.[0]?.assetId,'asset-1');await app.dispose();
});

test('supported image attachments are read into data URLs, never forwarded as host paths', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);await app.controller.uploadAttachment(ref,{name:'pic.png',size:1,uri:'private://pic'});await app.controller.send(ref);
  const sent=native.calls.filter(call=>call.method==='chat.send').at(-1)!;assert.deepEqual(sent.params.images,['data:image/png;base64,YQ==']);assert.equal(sent.params.images[0].includes('C:/'),false);await app.dispose();
});

test('an image becomes a prompt-path file when provider image capability is absent', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);ui.inputCapabilities.images=false;try {await app.controller.openSession(ref);await app.controller.uploadAttachment(ref,{name:'pic.webp',size:1,uri:'private://pic'});await app.controller.send(ref);const sent=native.calls.filter(call=>call.method==='chat.send').at(-1)!;assert.equal(sent.params.images,undefined);assert.match(sent.params.text,/Attached file "pic.webp": "C:\/host\/file.txt"/);} finally {ui.inputCapabilities.images=true;await app.dispose();}
});

test('image read failure preserves attachments and does not dispatch chat.send', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};await app.controller.openSession(ref);await app.controller.uploadAttachment(ref,{name:'pic.gif',size:1,uri:'private://pic'});native.attachmentChunks=['@@@'];
  await assert.rejects(app.controller.send(ref));assert.equal(native.calls.filter(call=>call.method==='chat.send').length,0);assert.equal(app.getSnapshot().attachments[sessionKey(ref)]?.length,1);await app.dispose();
});

test('removing the final paired computer clears its session, draft, attention and lease', async()=>{
  const {native,app}=await ready([record('only')]);const ref={machineId:'only',sessionId:'same'};
  await app.controller.openSession(ref);await app.controller.claimControl(ref);app.controller.setDraft(ref,'private draft');
  await app.controller.removeMachine('only');
  const state=app.getSnapshot();
  assert.deepEqual(native.removed,['only']);assert.deepEqual(state.machines,[]);assert.deepEqual(state.attention,[]);
  assert.equal(state.sessions[sessionKey(ref)],undefined);assert.equal(state.drafts[sessionKey(ref)],undefined);
  assert.equal(state.initialized,true);await app.dispose();
});

test('live permission downgrade clears cached leases and upgrade requires a fresh claim', async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};
  await app.controller.openSession(ref);await app.controller.claimControl(ref);
  assert.equal(app.getSnapshot().sessions[sessionKey(ref)].leaseEpoch,7);
  app.controller.setDraft(ref,'permission regression');
  native.snapshots.set('a',{...snapshot('a','readonly'),revision:2});
  await app.controller.refresh('a');
  assert.equal(app.getSnapshot().machines[0].permission,'readonly');
  assert.equal(app.getSnapshot().sessions[sessionKey(ref)].leaseEpoch,undefined);
  await assert.rejects(app.controller.send(ref),/mobile_readonly/);
  native.snapshots.set('a',{...snapshot('a','fullcontrol'),revision:3});
  await app.controller.refresh('a');await app.controller.send(ref);
  assert.equal(native.calls.filter(call=>call.method==='session.claim').length,2);
  await app.dispose();
});

test('a late control claim cannot restore a lease after a downgrade and upgrade',async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};
  try {
    await app.controller.openSession(ref);await app.controller.unlockControl();
    const held=native.hold('a','session.claim');const claiming=app.controller.claimControl(ref);await tick();
    native.snapshots.set('a',{...snapshot('a','readonly'),revision:2});await app.controller.refresh('a');
    native.snapshots.set('a',{...snapshot('a','fullcontrol'),revision:3});await app.controller.refresh('a');
    held.resolve(JSON.stringify({leaseEpoch:7}));
    await assert.rejects(claiming,/outcome_unknown|permission_changed/);
    assert.equal(app.getSnapshot().sessions[sessionKey(ref)].leaseEpoch,undefined);
    native.deferred.delete('a:session.claim');app.controller.setDraft(ref,'fresh authority');await app.controller.send(ref);
    assert.equal(native.calls.filter(call=>call.method==='session.claim').length,2,'next action takes a fresh lease');
  } finally {await app.dispose();}
});

test('a permission-change event fences a late claim even when snapshots coalesce back to Control',async()=>{
  const {native,app}=await ready([record('a')]);const ref={machineId:'a',sessionId:'same'};
  try {
    await app.controller.openSession(ref);await app.controller.unlockControl();
    const held=native.hold('a','session.claim');const claiming=app.controller.claimControl(ref);await tick();
    native.emitEvent('a',{v:1,event:'mobile.changed',epoch:'epoch-a',seq:2,data:{permissionChanged:true}});
    native.snapshots.set('a',{...snapshot('a','fullcontrol'),revision:3});await app.controller.refresh('a');
    held.resolve(JSON.stringify({leaseEpoch:7}));
    await assert.rejects(claiming,/outcome_unknown/);
    assert.equal(app.getSnapshot().sessions[sessionKey(ref)].leaseEpoch,undefined);
  } finally {await app.dispose();}
});
