import { isRuntimeEvent, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, type ChatItem, type ChatUiState, type RuntimeEvent } from '@threadterm/protocol';
import type { MobileMethod, MobileParams, MobileResult } from '@threadterm/protocol/mobile';
import { restoreChat, upsertChatItem, chatUiFromEvent } from '../../../renderer/src/chatState';
import { mergeEarlierPage } from '../../../renderer/src/chatPaging';
import { attachmentImageMime } from '../../../renderer/src/chatAttachments';
import type { NativePort } from './native';
import type { CompanionController, CompanionState, MachineState, SessionRef, SessionView, UploadedAttachment } from './types';
import { sessionKey } from './types';
import { attentionItems, chatOptionsPermissionRecovery, emptySession, errorMessage } from './projection';
import { base64Bytes, CONTROL_METHODS, READ_METHODS, mobileResult, validateMobileRequest } from './wire';

export interface LocalStoragePort { getItem(key:string):Promise<string|null>;setItem(key:string,value:string):Promise<void> }
type Timer=ReturnType<typeof setTimeout>;
type Resync={ticket:number;buffered:{seq:number;item:ChatItem}[];ui?:ChatUiState};
const PREFERENCES_KEY='threadterm.mobile.preferences.v1';
const DRAFTS_KEY='threadterm.mobile.drafts.v1';
const ATTACHMENTS_KEY='threadterm.mobile.attachments.v1';
const TERMINAL_LIMIT=256*1024;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const isChatItem=(value:unknown):value is ChatItem=>record(value)&&typeof value.id==='string'&&typeof value.createdAt==='string'&&['user','assistant','system','tool'].includes(String(value.role))&&Array.isArray(value.parts);

/** Platform-free coordinator. Native owns secrets and transport; the host owns all work. */
export function createCompanion(native:NativePort,storage:LocalStoragePort,uuid:()=>string,options:{initialLocale?:'en'|'zh-CN';retryDelay?:number}={}) {
  let state:CompanionState={initialized:false,nativeAvailable:native.available,machines:[],sessions:{},drafts:{},attachments:{},attention:[],controlUnlocked:false,preferences:{locale:options.initialLocale??'en',appearance:'system'}};
  const listeners=new Set<()=>void>();
  const generation=new Map<string,number>(),sequences=new Map<string,number>(),attempts=new Map<string,number>();
  const connectingEvents=new Map<string,RuntimeEvent[]>();
  const reconnects=new Map<string,Timer>(),refreshTimers=new Map<string,Timer>();
  const connections=new Map<string,Promise<void>>(),refreshes=new Map<string,Promise<void>>();
  const connectionTickets=new Map<string,number>();
  const refreshAgain=new Set<string>(),manualDisconnect=new Set<string>(),resyncs=new Map<string,Resync>();
  const sessionTickets=new Map<string,number>(),pendingSends=new Set<string>(),leaseTimers=new Map<string,Timer>();
  const optionRevisions=new Map<string,number>(),optionWrites=new Set<string>();
  const optionReads=new Map<string,{transport:number;promise:Promise<void>}>();
  const terminalDecoders=new Map<string,TextDecoder>();
  let foreground=true,disposed=false,initialized:Promise<void>|undefined,active:SessionRef|undefined,terminalTimer:Timer|undefined;
  let draftTimer:Timer|undefined,storageWrites:Promise<void>=Promise.resolve(),unlocking:Promise<boolean>|undefined;
  let controlGeneration=0;
  const noop=()=>{};
  function emit(patch:Partial<CompanionState>) {
    if(disposed)return;
    state={...state,...patch};
    state={...state,attention:attentionItems(state.machines,state.sessions)};
    for(const listener of listeners)listener();
  }
  function machine(id:string):MachineState { const value=state.machines.find(m=>m.id===id);if(!value)throw new Error('machine_removed');return value; }
  function patchMachine(id:string,patch:Partial<MachineState>) {emit({machines:state.machines.map(m=>m.id===id?{...m,...patch}:m)});}
  function view(ref:SessionRef):SessionView {return state.sessions[sessionKey(ref)]??emptySession(ref);}
  function patchView(ref:SessionRef,patch:Partial<SessionView>) {emit({sessions:{...state.sessions,[sessionKey(ref)]:{...view(ref),...patch}}});}
  function session(ref:SessionRef) {const found=machine(ref.machineId).snapshot?.sessions.find(s=>s.id===ref.sessionId);if(!found)throw new Error('session_unavailable');return found;}
  function gen(id:string) {return generation.get(id)??0;}
  function current(id:string,ticket:number) {return !disposed&&foreground&&gen(id)===ticket&&state.machines.some(m=>m.id===id);}
  function persist(key:string,value:unknown) {
    const text=JSON.stringify(value);
    storageWrites=storageWrites.catch(noop).then(()=>storage.setItem(key,text));
    void storageWrites.catch(error=>emit({error:`local_storage_failed: ${errorMessage(error)}`}));
  }
  function flushDrafts() {clearTimeout(draftTimer);draftTimer=undefined;persist(DRAFTS_KEY,state.drafts);persist(ATTACHMENTS_KEY,state.attachments);}
  function clearLease(ref:SessionRef) {const key=sessionKey(ref);clearTimeout(leaseTimers.get(key));leaseTimers.delete(key);patchView(ref,{leaseEpoch:undefined});}
  function invalidate(id:string) {
    generation.set(id,gen(id)+1);
    connectingEvents.delete(id);
    refreshes.delete(id);refreshAgain.delete(id);
    for(const entry of Object.values(state.sessions)) if(entry.ref.machineId===id) {
      const key=sessionKey(entry.ref);clearTimeout(leaseTimers.get(key));leaseTimers.delete(key);resyncs.delete(key);sessionTickets.set(key,(sessionTickets.get(key)??0)+1);
    }
    emit({sessions:Object.fromEntries(Object.entries(state.sessions).map(([key,value])=>[key,value.ref.machineId===id?{...value,syncing:true,leaseEpoch:undefined,optionsLoading:false}:value]))});
    clearTimeout(refreshTimers.get(id));refreshTimers.delete(id);
  }
  async function raw<M extends MobileMethod>(id:string,method:M,params:MobileParams<M>):Promise<MobileResult<M>> {
    validateMobileRequest(method,params);
    const value=JSON.parse(await native.request(id,method,JSON.stringify(params))) as unknown;
    return mobileResult(method,value);
  }
  function ensureReady(id:string) {
    const m=machine(id);
    if(!foreground||m.status!=='connected'||m.syncing||!m.snapshot) throw new Error('connection_syncing: Wait for this computer to reconnect and synchronize.');
    return m;
  }
  async function read<M extends MobileMethod>(id:string,method:M,params:MobileParams<M>):Promise<MobileResult<M>> {
    if(!READ_METHODS.has(method)) throw new Error('mobile_forbidden: Use an explicit control action.');
    const m=ensureReady(id),ticket=gen(id);
    if(!m.snapshot?.capabilities.methods.includes(method)) throw new Error(`mobile_unsupported: ${method}`);
    const result=await raw(id,method,params);
    if(!current(id,ticket))throw new Error('connection_changed');
    return result;
  }
  function retry(id:string) {
    if(disposed||!foreground||manualDisconnect.has(id)||reconnects.has(id)||!state.machines.some(m=>m.id===id))return;
    const count=attempts.get(id)??0;
    attempts.set(id,count+1);
    const timer=setTimeout(()=>{reconnects.delete(id);void connect(id).catch(noop);},Math.min(30_000,(options.retryDelay??1_000)*2**Math.min(count,5)));
    reconnects.set(id,timer);
  }
  async function connect(id:string) {
    machine(id);if(!foreground)throw new Error('app_backgrounded');
    manualDisconnect.delete(id);clearTimeout(reconnects.get(id));reconnects.delete(id);
    const existing=connections.get(id);
    if(existing) {
      if(connectionTickets.get(id)===gen(id))return existing;
      await existing.catch(noop);
      if(disposed||!foreground||manualDisconnect.has(id)||!state.machines.some(m=>m.id===id))return;
      return connect(id);
    }
    const ticket=gen(id)+1;generation.set(id,ticket);connectingEvents.set(id,[]);patchMachine(id,{status:'connecting',syncing:true,error:undefined});
    connectionTickets.set(id,ticket);
    const promise=(async()=>{
      try {
        const auth=await native.connect(id);
        if(!current(id,ticket))return;
        await raw(id,'mobile.events.subscribe',{sessionIds:active?.machineId===id?[active.sessionId]:[]});
        const snapshot=await raw(id,'mobile.snapshot',{});
        if(!current(id,ticket))return;
        if(snapshot.epoch!==auth.epoch||snapshot.permission!==auth.permission)throw new Error('mobile_identity_mismatch');
        patchMachine(id,{snapshot,permission:snapshot.permission,status:'connected',syncing:false,syncedAt:Date.now(),error:undefined});
        sequences.set(id,snapshot.revision);attempts.delete(id);
        const buffered=connectingEvents.get(id)??[];connectingEvents.delete(id);
        for(const event of buffered)onEvent(id,event);
        if(active?.machineId===id) {
          if(snapshot.sessions.some(s=>s.id===active?.sessionId))await syncSession(active).catch(noop);
          else {patchView(active,{loading:false,syncing:true,error:'session_unavailable'});active=undefined;}
        }
        await refreshAttention(id);
        if(current(id,ticket))scheduleTerminal();
      } catch(error) {
        if(current(id,ticket)) {
          const message=errorMessage(error);
          const status=/pin|fingerprint|certificate/i.test(message)?'pin-mismatch':/incompatible|contract|version_mismatch/i.test(message)?'incompatible':/revoked|expired|invalid_device_token/i.test(message)?'revoked':'disconnected';
          invalidate(id);patchMachine(id,{status,syncing:true,error:message});
          await native.disconnect(id).catch(noop);
          if(status==='disconnected')retry(id);
        }
        throw error;
      }
    })().finally(()=>{if(connections.get(id)===promise){connections.delete(id);connectionTickets.delete(id);}});
    connections.set(id,promise);return promise;
  }
  async function refreshOne(id:string):Promise<void> {
    if(refreshes.has(id)){refreshAgain.add(id);return refreshes.get(id)!;}
    if(machine(id).status!=='connected')return;
    const ticket=gen(id);
    const pending=(async()=>{
      do {
        refreshAgain.delete(id);
        const snapshot=await raw(id,'mobile.snapshot',{});
        if(!current(id,ticket))return;
        const m=machine(id);
        if(m.snapshot && snapshot.epoch!==m.snapshot.epoch) {
          invalidate(id);patchMachine(id,{syncing:true,error:'runtime_changed'});
          await native.disconnect(id).catch(noop);retry(id);return;
        }
        if(!m.snapshot||snapshot.revision>=m.snapshot.revision)patchMachine(id,{snapshot,permission:snapshot.permission,syncedAt:Date.now(),error:undefined});
        await refreshAttention(id);
      } while(refreshAgain.has(id)&&current(id,ticket));
    })().catch(error=>{if(current(id,ticket))patchMachine(id,{error:errorMessage(error)});throw error;}).finally(()=>{if(refreshes.get(id)===pending)refreshes.delete(id);});
    refreshes.set(id,pending);return pending;
  }
  function scheduleRefresh(id:string) {
    if(refreshTimers.has(id)||disposed||!foreground)return;
    refreshTimers.set(id,setTimeout(()=>{refreshTimers.delete(id);void refreshOne(id).catch(noop);},250));
  }
  async function refreshAttention(id:string) {
    const m=machine(id),ticket=gen(id);
    const waiting=m.snapshot?.sessions.filter(s=>s.mode==='chat'&&['awaiting_approval','awaiting_input'].includes(s.activity?.state??''))??[];
    // Bounded concurrency; don't subscribe every waiting session to high frequency output.
    for(let index=0;index<waiting.length;index+=4) {
      await Promise.all(waiting.slice(index,index+4).map(async s=>{
        const ref={machineId:id,sessionId:s.id};
        if(active&&sessionKey(active)===sessionKey(ref))return;
        try {
          const snapshot=await raw(id,'chat.snapshot',{sessionId:s.id,maxBytes:256*1024});
          if(current(id,ticket))patchView(ref,{items:snapshot.items,hasOlder:snapshot.hasEarlier,olderCursor:snapshot.nextBefore,loading:false,syncing:false});
        } catch(error) {if(current(id,ticket))patchView(ref,{loading:false,error:errorMessage(error)});}
      }));
      if(!current(id,ticket))return;
    }
  }
  async function syncSession(ref:SessionRef) {
    const s=session(ref),key=sessionKey(ref),transport=gen(ref.machineId);
    const ticket=(sessionTickets.get(key)??0)+1;sessionTickets.set(key,ticket);
    patchView(ref,{loading:!view(ref).items.length,syncing:true,error:undefined,optionsLoading:s.mode==='chat'});
    if(s.mode==='terminal') {patchView(ref,{loading:false,syncing:false});return;}
    const pending:Resync={ticket,buffered:resyncs.get(key)?.buffered??[]};resyncs.set(key,pending);
    try {
      const [snapshot,ui,connection]=await Promise.all([
        raw(ref.machineId,'chat.snapshot',{sessionId:ref.sessionId,maxBytes:1024*1024}),
        raw(ref.machineId,'chat.options',{sessionId:ref.sessionId}),
        raw(ref.machineId,'chat.connection',{sessionId:ref.sessionId}),
      ]);
      if(!current(ref.machineId,transport)||sessionTickets.get(key)!==ticket)return;
      if(connection.sessionId!==ref.sessionId||connection.runtimeEpoch!==machine(ref.machineId).snapshot?.epoch)throw new Error('chat_identity_mismatch');
      optionRevisions.set(key,(optionRevisions.get(key)??0)+1);
      patchView(ref,{items:restoreChat(snapshot,pending.buffered),chatUi:pending.ui??ui,connection,loading:false,syncing:false,error:undefined,optionsLoading:false,optionsError:undefined,hasOlder:snapshot.hasEarlier,olderCursor:snapshot.nextBefore});
    } catch(error) {
      if(current(ref.machineId,transport)&&sessionTickets.get(key)===ticket)patchView(ref,{items:restoreChat({items:view(ref).items,revision:-1},pending.buffered),loading:false,syncing:true,error:errorMessage(error),optionsLoading:false});
      throw error;
    } finally {if(resyncs.get(key)===pending)resyncs.delete(key);}
  }
  function acceptChatUi(ref:SessionRef,ui:ChatUiState) {
    const key=sessionKey(ref),resync=resyncs.get(key);
    optionRevisions.set(key,(optionRevisions.get(key)??0)+1);
    if(resync)resync.ui=ui;else patchView(ref,{chatUi:ui});
  }
  async function refreshChatOptions(ref:SessionRef) {
    ensureReady(ref.machineId);
    if(session(ref).mode!=='chat')throw new Error('chat_unavailable');
    const key=sessionKey(ref),transport=gen(ref.machineId),revision=optionRevisions.get(key)??0;
    const existing=optionReads.get(key);if(existing?.transport===transport)return existing.promise;
    patchView(ref,{optionsLoading:true});
    const promise=(async()=>{
      try {
        const ui=await read(ref.machineId,'chat.options',{sessionId:ref.sessionId});
        // A later chat.ui event or full session sync wins over a cached read response.
        if((optionRevisions.get(key)??0)===revision)acceptChatUi(ref,ui);
        patchView(ref,{optionsError:undefined});
      }catch(error){if(current(ref.machineId,transport))patchView(ref,{optionsError:errorMessage(error)});throw error;}
      finally{if(current(ref.machineId,transport))patchView(ref,{optionsLoading:false});}
    })().finally(()=>{if(optionReads.get(key)?.promise===promise)optionReads.delete(key);});
    optionReads.set(key,{transport,promise});return promise;
  }
  function requireOptionControl(ref:SessionRef,optionId:string,value:string) {
    const m=ensureReady(ref.machineId),s=session(ref),v=view(ref);
    if(m.permission!=='fullcontrol')throw new Error('mobile_readonly: This computer allows viewing only.');
    if(s.readOnly||s.archived||s.mode!=='chat')throw new Error('session_readonly');
    if(!state.controlUnlocked)throw new Error('control_locked');
    if(!m.snapshot?.capabilities.methods.includes('chat.option.set'))throw new Error('mobile_unsupported: chat.option.set');
    if(v.syncing)throw new Error('connection_syncing: Wait for this session to synchronize.');
    const recovering=chatOptionsPermissionRecovery(v);
    if(v.connection?.phase!=='ready'&&!recovering)throw new Error('provider_not_ready');
    if(v.optionsLoading||!v.chatUi||['idle','loading','unknown'].includes(v.chatUi.loadState??'')||v.chatUi.loadState==='error'&&!recovering)throw new Error('options_not_ready');
    const option=v.chatUi.options.find(row=>row.id===optionId);
    if(!option||!option.choices.some(choice=>choice.value===value))throw new Error('invalid_option: Choose an option offered by this computer.');
    if(recovering&&option.category!=='mode')throw new Error('options_not_ready');
  }
  async function setChatOption(ref:SessionRef,optionId:string,value:string) {
    const key=sessionKey(ref);if(optionWrites.has(key))throw new Error('option_pending');
    requireOptionControl(ref,optionId,value);
    const transport=gen(ref.machineId),unlock=controlGeneration;
    optionWrites.add(key);patchView(ref,{optionPending:optionId,optionsError:undefined});
    let dispatched=false;
    try {
      const leaseEpoch=await control(ref);
      if(!current(ref.machineId,transport))throw new Error('connection_changed');
      if(controlGeneration!==unlock)throw new Error('control_locked');
      requireOptionControl(ref,optionId,value);
      const revision=optionRevisions.get(key)??0;
      dispatched=true;
      const ui=await write(ref,'chat.option.set',{sessionId:ref.sessionId,optionId,value,leaseEpoch,operationId:uuid()});
      if((optionRevisions.get(key)??0)===revision)acceptChatUi(ref,ui);
    }catch(error){
      const failure=dispatched&&!current(ref.machineId,transport)?new Error('outcome_unknown: Check the current options after reconnecting before trying again.'):error;
      if(state.machines.some(m=>m.id===ref.machineId))patchView(ref,{optionsError:errorMessage(failure)});
      throw failure;
    }finally{
      optionWrites.delete(key);
      if(state.machines.some(m=>m.id===ref.machineId))patchView(ref,{optionPending:undefined});
    }
  }
  function onEvent(id:string,event:RuntimeEvent) {
    const m=state.machines.find(value=>value.id===id);
    const connecting=connectingEvents.get(id);
    if(connecting) {if(connecting.length<512)connecting.push(event);else connecting.splice(0,connecting.length,{...event,event:'runtime.degraded',data:{reason:'mobile_event_buffer_full'}});return;}
    if(!m||m.status!=='connected'||!m.snapshot||!foreground)return;
    if(event.epoch!==m.snapshot.epoch){invalidate(id);patchMachine(id,{syncing:true});void native.disconnect(id).finally(()=>retry(id)).catch(noop);return;}
    const last=sequences.get(id)??-1;
    if(event.seq<=last)return;
    sequences.set(id,event.seq);
    if(event.event==='runtime.degraded') {
      const ticket=gen(id);patchMachine(id,{syncing:true});
      void refreshOne(id).then(async()=>{if(!current(id,ticket))return;if(active?.machineId===id)await syncSession(active).catch(noop);if(current(id,ticket))patchMachine(id,{syncing:false});}).catch(noop);return;
    }
    if(event.event==='mobile.changed'||event.event==='state.changed')scheduleRefresh(id);
    const data=record(event.data)?event.data:{};
    if(typeof data.sessionId!=='string')return;
    const ref={machineId:id,sessionId:data.sessionId},key=sessionKey(ref),currentView=state.sessions[key];
    if(!currentView)return;
    if(event.event==='chat.item'&&isChatItem(data.item)) {
      const resync=resyncs.get(key);
      if(resync)resync.buffered.push({seq:event.seq,item:data.item});
      else patchView(ref,{items:upsertChatItem(currentView.items,data.item)});
    } else if(event.event==='chat.ui'||event.event==='chat.options') {
      acceptChatUi(ref,chatUiFromEvent(data));
    } else if(event.event==='chat.connection') {
      const candidate={...data,sessionId:ref.sessionId,runtimeEpoch:event.epoch};
      try {
        const connection=mobileResult('chat.connection',candidate);
        if(!currentView.syncing&&(!currentView.connection||connection.revision>=currentView.connection.revision))patchView(ref,{connection});
      }catch{void syncSession(ref).catch(noop);}
    }
  }
  function scheduleTerminal() {
    clearTimeout(terminalTimer);terminalTimer=undefined;
    if(!foreground||disposed||!active)return;
    const ref=active,key=sessionKey(ref),m=state.machines.find(m=>m.id===ref.machineId);
    if(m?.status!=='connected'||m.syncing||m.snapshot?.sessions.find(s=>s.id===ref.sessionId)?.mode!=='terminal')return;
    terminalTimer=setTimeout(()=>{void readTerminal(ref,key).finally(scheduleTerminal);},400);
  }
  async function readTerminal(ref:SessionRef,key:string) {
    const ticket=gen(ref.machineId),before=view(ref);
    try {
      const result=await raw(ref.machineId,'terminal.read',{sessionId:ref.sessionId,...(before.terminalCursor?{cursor:before.terminalCursor,limit:64*1024}:{tail:true,limit:8192})});
      if(!current(ref.machineId,ticket)||!active||sessionKey(active)!==key)return;
      const gap=!!result.storageDegraded||result.truncated||(before.terminalCursor>0&&result.fromCursor>before.terminalCursor)||result.nextCursor<before.terminalCursor;
      let decoder=terminalDecoders.get(key);
      if(!decoder||gap){decoder=new TextDecoder();terminalDecoders.set(key,decoder);}
      const text=decoder.decode(base64Bytes(result.data),{stream:true});
      const accumulated=(gap?'':before.terminal)+text;
      patchView(ref,{terminal:accumulated.slice(-TERMINAL_LIMIT),terminalCursor:result.nextCursor,terminalGap:before.terminalGap||gap||accumulated.length>TERMINAL_LIMIT,loading:false,error:undefined});
    } catch(error) {if(current(ref.machineId,ticket)&&active&&sessionKey(active)===key)patchView(ref,{error:errorMessage(error),loading:false});}
  }
  async function control(ref:SessionRef):Promise<number> {
    const m=ensureReady(ref.machineId);
    if(m.permission!=='fullcontrol')throw new Error('mobile_readonly: This computer granted viewing access only.');
    if(session(ref).readOnly||session(ref).archived)throw new Error('session_readonly');
    if(!state.controlUnlocked && !(await controller.unlockControl()))throw new Error('control_locked');
    if(view(ref).syncing)await syncSession(ref);
    if(view(ref).leaseEpoch===undefined)await controller.claimControl(ref);
    const epoch=view(ref).leaseEpoch;if(epoch===undefined)throw new Error('control_unavailable');
    return epoch;
  }
  async function write<M extends MobileMethod>(ref:SessionRef,method:M,params:MobileParams<M>):Promise<MobileResult<M>> {
    const m=ensureReady(ref.machineId);
    if(!CONTROL_METHODS.has(method)||m.permission!=='fullcontrol'||!state.controlUnlocked)throw new Error('control_locked');
    if(!m.snapshot?.capabilities.methods.includes(method))throw new Error(`mobile_unsupported: ${method}`);
    const ticket=gen(ref.machineId);
    const result=await raw(ref.machineId,method,params);
    if(!current(ref.machineId,ticket))throw new Error('outcome_unknown: Reconnected before the result could be confirmed. Check the computer before trying again.');
    return result;
  }
  async function attachmentImage(ref:SessionRef,file:UploadedAttachment):Promise<string> {
    const mime=attachmentImageMime(file.name);
    if(!mime||!Number.isSafeInteger(file.size)||file.size<=0||4*Math.ceil(file.size/3)+64>MAX_CHAT_IMAGE_BYTES)throw new Error('invalid_image');
    const chunks:string[]=[];let offset=0;
    while(offset<file.size) {
      // Multiples of three keep intermediate base64 chunks unpadded and joinable.
      const value=await read(ref.machineId,'attachment.read',{assetId:file.assetId,offset,limit:3*256*1024});
      const length=base64Bytes(value.chunk).length;
      if(value.assetId!==file.assetId||value.offset!==offset||value.size!==file.size||length!==Math.min(3*256*1024,file.size-offset)||value.eof!==(offset+length===file.size))throw new Error('attachment_changed');
      chunks.push(value.chunk);offset+=length;
    }
    return `data:${mime};base64,${chunks.join('')}`;
  }
  const subscriptions=[
    native.onRuntimeEvent(({machineId,eventJson})=>{try{const event:unknown=JSON.parse(eventJson);if(isRuntimeEvent(event))onEvent(machineId,event);}catch{scheduleRefresh(machineId);}}),
    native.onConnectionState(({machineId,state:status,message})=>{
      if(!state.machines.some(m=>m.id===machineId))return;
      if(status==='connected')return; // Ready only after our authoritative snapshot.
      if(status==='connecting'){patchMachine(machineId,{status,syncing:true});return;}
      const currentStatus=machine(machineId).status;
      if(currentStatus==='incompatible'||currentStatus==='pin-mismatch'||currentStatus==='revoked')return;
      invalidate(machineId);patchMachine(machineId,{status,syncing:true,error:message});
      if(status==='disconnected')retry(machineId);
    }),
    native.onControlLock(({locked})=>{if(locked){controlGeneration++;emit({controlUnlocked:false});for(const entry of Object.values(state.sessions))if(entry.leaseEpoch!==undefined)clearLease(entry.ref);}}),
  ];
  const controller:CompanionController={
    initialize() {
      if(initialized)return initialized;
      initialized=(async()=>{
        try {
          const [records,prefs,drafts,attachments]=await Promise.all([native.listMachines(),storage.getItem(PREFERENCES_KEY),storage.getItem(DRAFTS_KEY),storage.getItem(ATTACHMENTS_KEY)]);
          let preferences=state.preferences,parsedDrafts:Record<string,string>={};
          const parsedAttachments:Record<string,UploadedAttachment[]>={};
          try {const p:unknown=JSON.parse(prefs??'null');if(record(p))preferences={locale:p.locale==='zh-CN'?'zh-CN':p.locale==='en'?'en':preferences.locale,appearance:p.appearance==='light'||p.appearance==='dark'?p.appearance:'system'};}catch{}
          try {const d:unknown=JSON.parse(drafts??'null');if(record(d))parsedDrafts=Object.fromEntries(Object.entries(d).filter(([key,value])=>key.length<1024&&typeof value==='string'&&value.length<=256*1024)) as Record<string,string>;}catch{}
          try {
            const saved:unknown=JSON.parse(attachments??'null');
            if(record(saved))for(const [key,rows] of Object.entries(saved))if(Array.isArray(rows)) {
              parsedAttachments[key]=rows.filter((row):row is UploadedAttachment=>{
                if(!record(row)||!record(row.ref))return false;
                const ref=row.ref;
                return typeof ref.machineId==='string'&&typeof ref.sessionId==='string'
                  &&sessionKey({machineId:ref.machineId,sessionId:ref.sessionId})===key
                  &&records.some(m=>m.id===ref.machineId)
                  &&['name','assetId','hostPath'].every(field=>typeof row[field]==='string')&&Number.isSafeInteger(row.size)&&Number(row.size)>=0
                  &&['image','file'].includes(String(row.kind));
              }).slice(0,16);
            }
          }catch{}
          emit({initialized:true,machines:records.map(m=>({...m,status:'disconnected',syncing:true})),preferences,drafts:parsedDrafts,attachments:parsedAttachments});
          await Promise.allSettled(records.map(m=>connect(m.id)));
        }catch(error){emit({initialized:true,error:errorMessage(error)});}
      })();return initialized;
    },
    async refresh(id) {if(id){const m=machine(id);if(m.status!=='connected')return connect(id);await refreshOne(id);if(active?.machineId===id)await syncSession(active);}else await Promise.all(state.machines.map(m=>controller.refresh(m.id)));},
    connect,
    async disconnect(id) {manualDisconnect.add(id);clearTimeout(reconnects.get(id));reconnects.delete(id);invalidate(id);patchMachine(id,{status:'disconnected',syncing:true});await native.disconnect(id);},
    async removeMachine(id) {
      await controller.disconnect(id);await native.removeMachine(id);
      if(active?.machineId===id)active=undefined;
      const belongs=(key:string)=>{try{return JSON.parse(key)[0]===id;}catch{return false;}};
      emit({machines:state.machines.filter(m=>m.id!==id),sessions:Object.fromEntries(Object.entries(state.sessions).filter(([key])=>!belongs(key))),drafts:Object.fromEntries(Object.entries(state.drafts).filter(([key])=>!belongs(key))),attachments:Object.fromEntries(Object.entries(state.attachments).filter(([key])=>!belongs(key)))});flushDrafts();
    },
    async renameMachine(id,name,color) {await native.renameMachine(id,name,color);patchMachine(id,{name:name.trim(),color});},
    preparePairing:text=>native.preparePairing(text.trim()),
    async confirmPairing(id,deviceName,name,color) {const paired=await native.confirmPairing(id,deviceName,name,color);emit({machines:[...state.machines.filter(m=>m.id!==paired.id),{...paired,status:'disconnected',syncing:true}]});await connect(paired.id).catch(noop);return paired;},
    cancelPairing:id=>native.cancelPairing(id),
    async openSession(ref) {
      session(ref);const previous=active;active=ref;
      if(previous&&sessionKey(previous)!==sessionKey(ref))await controller.releaseControl(previous).catch(noop);
      if(previous&&previous.machineId!==ref.machineId&&machine(previous.machineId).status==='connected')await raw(previous.machineId,'mobile.events.subscribe',{sessionIds:[]}).catch(noop);
      ensureReady(ref.machineId);
      await raw(ref.machineId,'mobile.events.subscribe',{sessionIds:[ref.sessionId]});
      await syncSession(ref);scheduleTerminal();
    },
    async closeSession() {const previous=active;active=undefined;clearTimeout(terminalTimer);if(previous){await controller.releaseControl(previous).catch(noop);if(state.machines.some(m=>m.id===previous.machineId&&m.status==='connected'))await raw(previous.machineId,'mobile.events.subscribe',{sessionIds:[]}).catch(noop);}},
    async loadOlder(ref) {
      const before=view(ref),ticket=gen(ref.machineId);if(!before.hasOlder||!before.olderCursor||before.loading)return;
      patchView(ref,{loading:true});
      try{const result=await read(ref.machineId,'chat.snapshot',{sessionId:ref.sessionId,before:before.olderCursor,maxBytes:1024*1024});if(current(ref.machineId,ticket))patchView(ref,{items:mergeEarlierPage(view(ref).items,result.items),loading:false,hasOlder:result.hasEarlier&&result.nextBefore!==before.olderCursor,olderCursor:result.nextBefore});}
      catch(error){if(current(ref.machineId,ticket))patchView(ref,{loading:false,error:errorMessage(error)});throw error;}
    },
    async claimControl(ref,takeover=false) {
      const m=ensureReady(ref.machineId);if(m.permission!=='fullcontrol')throw new Error('mobile_readonly');
      if(session(ref).readOnly||session(ref).archived)throw new Error('session_readonly');
      if(!state.controlUnlocked && !(await controller.unlockControl()))throw new Error('control_locked');
      const {leaseEpoch}=await write(ref,'session.claim',{sessionId:ref.sessionId,clientId:'threadterm-mobile',...(takeover?{takeover:true}:{})});
      clearLease(ref);patchView(ref,{leaseEpoch});
      const key=sessionKey(ref),renew=async()=>{
        if(view(ref).leaseEpoch!==leaseEpoch||!state.controlUnlocked)return;
        try{await write(ref,'session.renew',{sessionId:ref.sessionId,leaseEpoch});if(view(ref).leaseEpoch===leaseEpoch)leaseTimers.set(key,setTimeout(()=>void renew(),10_000));}
        catch(error){clearLease(ref);patchView(ref,{error:errorMessage(error)});}
      };
      leaseTimers.set(key,setTimeout(()=>void renew(),10_000));
    },
    async releaseControl(ref) {const epoch=view(ref).leaseEpoch;clearLease(ref);if(epoch!==undefined&&state.machines.some(m=>m.id===ref.machineId&&m.status==='connected'))await raw(ref.machineId,'session.release',{sessionId:ref.sessionId,leaseEpoch:epoch}).catch(noop);},
    async connectChat(ref) {const leaseEpoch=await control(ref);await write(ref,'chat.connect',{sessionId:ref.sessionId,leaseEpoch,operationId:uuid()});await syncSession(ref);},
    refreshChatOptions,
    setChatOption,
    async send(ref) {
      const key=sessionKey(ref),text=state.drafts[key]??'',attachments=state.attachments[key]??[];if(!text.trim()&&!attachments.length)return;if(pendingSends.has(key))throw new Error('send_pending');
      if(attachments.some(file=>sessionKey(file.ref)!==key))throw new Error('attachment_identity_mismatch');
      pendingSends.add(key);
      try {
        const leaseEpoch=await control(ref);
        if(view(ref).connection?.phase!=='ready')throw new Error('provider_not_ready: Connect the agent before sending.');
        const images:string[]=[],files:UploadedAttachment[]=[];
        for(const file of attachments) {
          if(file.kind==='image'&&view(ref).chatUi?.inputCapabilities?.images&&images.length<MAX_CHAT_IMAGES) {
            const image=await attachmentImage(ref,file);
            if(images.reduce((bytes,value)=>bytes+value.length,0)+image.length<=MAX_CHAT_IMAGE_BYTES){images.push(image);continue;}
          }
          files.push(file);
        }
        const prompt=files.length?`${text}${text?'\n\n':''}${files.map(file=>`Attached file ${JSON.stringify(file.name)}: ${JSON.stringify(file.hostPath)}`).join('\n')}`:text;
        await write(ref,'chat.send',{sessionId:ref.sessionId,text:prompt,...(images.length?{images}:{}),leaseEpoch,operationId:uuid()});
        if(state.drafts[key]===text)controller.setDraft(ref,'');
        const sent=new Set(attachments.map(file=>file.assetId));
        emit({attachments:{...state.attachments,[key]:(state.attachments[key]??[]).filter(file=>!sent.has(file.assetId))}});flushDrafts();
        scheduleRefresh(ref.machineId);
      }catch(error){patchView(ref,{error:errorMessage(error)});throw error;}finally{pendingSends.delete(key);}
    },
    setDraft(ref,text) {if(text.length>256*1024)throw new Error('draft_too_large');emit({drafts:{...state.drafts,[sessionKey(ref)]:text}});clearTimeout(draftTimer);draftTimer=setTimeout(flushDrafts,250);},
    async approve(ref,turnId,approvalId,choiceId) {const leaseEpoch=await control(ref);await write(ref,'chat.approve',{sessionId:ref.sessionId,turnId,approvalId,choiceId,leaseEpoch,operationId:uuid()});await syncSession(ref);scheduleRefresh(ref.machineId);},
    async answer(ref,turnId,approvalId,response) {const leaseEpoch=await control(ref);await write(ref,'chat.answer',{sessionId:ref.sessionId,turnId,approvalId,response,leaseEpoch,operationId:uuid()});await syncSession(ref);scheduleRefresh(ref.machineId);},
    async stop(ref) {await control(ref);await write(ref,'session.stop',{sessionId:ref.sessionId,operationId:uuid()});clearLease(ref);await refreshOne(ref.machineId);await syncSession(ref);},
    async cancelTurn(ref,turnId) {const leaseEpoch=await control(ref);await write(ref,'chat.cancel',{sessionId:ref.sessionId,turnId,leaseEpoch});await syncSession(ref);},
    async resume(ref) {await control(ref);await write(ref,'session.resume',{sessionId:ref.sessionId,operationId:uuid()});await refreshOne(ref.machineId);await syncSession(ref);},
    async createSession(machineId,params) {
      if(ensureReady(machineId).permission!=='fullcontrol')throw new Error('mobile_readonly');if(!state.controlUnlocked && !(await controller.unlockControl()))throw new Error('control_locked');
      const created=await write({machineId,sessionId:''},'mobile.session.create',{...params,operationId:uuid()});
      const snapshot=machine(machineId).snapshot;
      if(snapshot)patchMachine(machineId,{snapshot:{...snapshot,sessions:[...snapshot.sessions.filter(s=>s.id!==created.id),created]}});
      const ref={machineId,sessionId:created.id};
      try {await refreshOne(machineId);await controller.openSession(ref);if(created.mode==='chat')await controller.connectChat(ref);}
      catch(error) {patchView(ref,{error:`session_created: ${errorMessage(error)}`,loading:false});}
      return created;
    },
    async terminalInput(ref,text) {const leaseEpoch=await control(ref);await write(ref,'terminal.input',{sessionId:ref.sessionId,data:text,leaseEpoch});},
    async terminalResize(ref,cols,rows) {const leaseEpoch=await control(ref);await write(ref,'terminal.resize',{sessionId:ref.sessionId,cols,rows,leaseEpoch});},
    read,
    async openPreview(id,url) {ensureReady(id);const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('invalid_preview_url');await native.openPreview(id,url);},
    chooseAttachment:()=>native.chooseAttachment(),
    async uploadAttachment(ref,attachment) {
      await control(ref);const key=sessionKey(ref);if((state.attachments[key]?.length??0)>=16)throw new Error('attachment_limit');if(attachment.size>256*1024*1024||attachment.size<0)throw new Error('attachment_too_large');
      const uploadId=uuid();let offset=0;let result:{offset:number;assetId?:string;hostPath?:string}|undefined;
      do {
        const length=Math.min(1024*1024,attachment.size-offset),chunk=await native.readAttachment(attachment.uri,offset,length);
        if(base64Bytes(chunk).length!==length)throw new Error('attachment_changed');
        result=await write(ref,'attachment.upload',{uploadId,sessionId:ref.sessionId,name:attachment.name,size:attachment.size,offset,chunk,final:offset+length===attachment.size});
        if(result.offset!==offset+length)throw new Error('attachment_offset_mismatch');offset=result.offset;
      }while(offset<attachment.size);
      if(!result?.assetId||!result.hostPath)throw new Error('attachment_incomplete');
      const uploaded:UploadedAttachment={name:attachment.name,assetId:result.assetId,hostPath:result.hostPath,size:attachment.size,ref:{...ref},kind:attachmentImageMime(attachment.name)&&attachment.size>0&&4*Math.ceil(attachment.size/3)+64<=MAX_CHAT_IMAGE_BYTES?'image':'file'};
      emit({attachments:{...state.attachments,[key]:[...(state.attachments[key]??[]),uploaded]}});flushDrafts();return uploaded;
    },
    removeAttachment(ref,assetId) {const key=sessionKey(ref);emit({attachments:{...state.attachments,[key]:(state.attachments[key]??[]).filter(file=>file.assetId!==assetId)}});flushDrafts();},
    async acknowledge(item) {if(item.inboxId)await read(item.ref.machineId,'inbox.read',{ids:[item.inboxId],operationId:uuid()});else {const s=session(item.ref);if(s.activity)await read(item.ref.machineId,'session.attention.acknowledge',{sessionId:s.id,expectedRevision:s.activity.revision,operationId:uuid()});}await refreshOne(item.ref.machineId);},
    setPreferences(patch) {const preferences={...state.preferences,...patch};emit({preferences});persist(PREFERENCES_KEY,preferences);},
    async lockControl() {controlGeneration++;emit({controlUnlocked:false});await native.lockControl();for(const entry of Object.values(state.sessions))if(entry.leaseEpoch!==undefined)await controller.releaseControl(entry.ref);},
    unlockControl() {if(unlocking)return unlocking;const ticket=controlGeneration;unlocking=native.unlockControl().then(ok=>{const accepted=ok&&foreground&&!disposed&&ticket===controlGeneration;if(accepted)emit({controlUnlocked:true});return accepted;}).finally(()=>{unlocking=undefined;});return unlocking;},
    clearError() {emit({error:undefined});},
  };
  return {
    controller,
    getSnapshot:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    async setForeground(value:boolean) {
      if(value===foreground)return;
      foreground=value;flushDrafts();
      if(!value) {
        controlGeneration++;clearTimeout(terminalTimer);emit({controlUnlocked:false});
        for(const timer of reconnects.values())clearTimeout(timer);reconnects.clear();
        for(const m of state.machines){invalidate(m.id);patchMachine(m.id,{status:'disconnected',syncing:true});}
        await native.lockControl();await Promise.allSettled(state.machines.map(m=>native.disconnect(m.id)));
      } else await Promise.allSettled(state.machines.filter(m=>!manualDisconnect.has(m.id)).map(m=>connect(m.id)));
    },
    async dispose() {
      flushDrafts();await storageWrites.catch(noop);disposed=true;foreground=false;
      for(const off of subscriptions)off();listeners.clear();
      clearTimeout(terminalTimer);clearTimeout(draftTimer);
      for(const timers of [reconnects,refreshTimers,leaseTimers]){for(const timer of timers.values())clearTimeout(timer);timers.clear();}
      await Promise.allSettled(state.machines.map(m=>native.disconnect(m.id)));
    },
  };
}
