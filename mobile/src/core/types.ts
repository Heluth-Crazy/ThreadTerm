import type { ChatAnswerResponse, ChatApprovalData, ChatConnectionState, ChatItem, ChatUiState, Session } from '@threadterm/protocol';
import type { MobileMethod, MobileParams, MobileResult, MobileSessionCreate, MobileSnapshot } from '@threadterm/protocol/mobile';

export type Locale = 'en' | 'zh-CN';
export type Appearance = 'system' | 'light' | 'dark';
export interface MachineRecord { id:string; name:string; color:string; transport:'iroh'|'tls'; endpoint:string; tlsFingerprint:string; permission:'readonly'|'fullcontrol'; expiresAt:string }
export type ConnectionStatus = 'connecting'|'connected'|'disconnected'|'incompatible'|'pin-mismatch'|'revoked';
export interface MachineState extends MachineRecord { status:ConnectionStatus; syncing:boolean; snapshot?:MobileSnapshot; error?:string; syncedAt?:number }
export interface SessionRef { machineId:string; sessionId:string }
export interface SessionView {
  ref:SessionRef; items:ChatItem[]; loading:boolean; syncing:boolean; error?:string;
  connection?:ChatConnectionState; chatUi?:ChatUiState; leaseEpoch?:number;
  optionsLoading?:boolean; optionPending?:string; optionsError?:string;
  terminal:string; terminalLines?:{text:string;cursor?:boolean;cursorColumn?:number}[]; terminalCursor:number; terminalGap:boolean; hasOlder:boolean; olderCursor?:string;
}
export interface AttentionItem { key:string; ref:SessionRef; machineName:string; session:Session; title:string; createdAt:string; inboxId?:string; turnId?:string; approvalId?:string; approval?:ChatApprovalData; stale:boolean }
export interface CompanionState {
  initialized:boolean; nativeAvailable:boolean; machines:MachineState[];
  sessions:Record<string,SessionView>; drafts:Record<string,string>; attachments:Record<string,UploadedAttachment[]>;
  attention:AttentionItem[]; controlUnlocked:boolean;
  preferences:{locale:Locale;appearance:Appearance}; error?:string;
}
export interface PairingPreview { pendingId:string;checkCode:string;endpoint:string;transport:'iroh'|'tls' }
export interface PickedAttachment { name:string;size:number;uri:string }
export interface UploadedAttachment { name:string;assetId:string;hostPath:string;size:number;ref:SessionRef;kind:'image'|'file' }
export interface CompanionController {
  initialize():Promise<void>;
  refresh(machineId?:string):Promise<void>;
  connect(machineId:string):Promise<void>;
  disconnect(machineId:string):Promise<void>;
  removeMachine(machineId:string):Promise<void>;
  renameMachine(machineId:string,name:string,color:string):Promise<void>;
  preparePairing(text:string):Promise<PairingPreview>;
  confirmPairing(pendingId:string,deviceName:string,name:string,color:string):Promise<MachineRecord>;
  cancelPairing(pendingId:string):Promise<void>;
  openSession(ref:SessionRef):Promise<void>;
  closeSession():Promise<void>;
  loadOlder(ref:SessionRef):Promise<void>;
  claimControl(ref:SessionRef,takeover?:boolean):Promise<void>;
  releaseControl(ref:SessionRef):Promise<void>;
  connectChat(ref:SessionRef):Promise<void>;
  refreshChatOptions(ref:SessionRef):Promise<void>;
  setChatOption(ref:SessionRef,optionId:string,value:string):Promise<void>;
  send(ref:SessionRef):Promise<void>;
  setDraft(ref:SessionRef,text:string):void;
  approve(ref:SessionRef,turnId:string,approvalId:string,choiceId:string):Promise<void>;
  answer(ref:SessionRef,turnId:string,approvalId:string,response:ChatAnswerResponse):Promise<void>;
  stop(ref:SessionRef):Promise<void>;
  cancelTurn(ref:SessionRef,turnId:string):Promise<void>;
  resume(ref:SessionRef):Promise<void>;
  createSession(machineId:string,params:Omit<MobileSessionCreate,'operationId'>):Promise<Session>;
  terminalInput(ref:SessionRef,text:string):Promise<void>;
  terminalResize(ref:SessionRef,cols:number,rows:number):Promise<void>;
  read<M extends MobileMethod>(machineId:string,method:M,params:MobileParams<M>):Promise<MobileResult<M>>;
  openPreview(machineId:string,url:string):Promise<void>;
  chooseAttachment():Promise<PickedAttachment|null>;
  uploadAttachment(ref:SessionRef,attachment:PickedAttachment):Promise<UploadedAttachment>;
  removeAttachment(ref:SessionRef,assetId:string):void;
  acknowledge(item:AttentionItem):Promise<void>;
  setPreferences(patch:Partial<CompanionState['preferences']>):void;
  lockControl():Promise<void>;
  unlockControl():Promise<boolean>;
  clearError():void;
}
export function sessionKey(ref:SessionRef):string { return JSON.stringify([ref.machineId,ref.sessionId]); }
export type { MobileSnapshot };
