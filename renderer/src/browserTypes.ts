/** Desktop-only browser contract. Pages have no access to this bridge. */
import { isBrowserActionTool, isBrowserReadTool, type BrowserTool } from '@threadterm/protocol';

export interface BrowserPreferences { unloadAfterMinutes:number; linkTarget:'builtin'|'system' }
export interface BrowserBounds { x:number; y:number; width:number; height:number }
export type BrowserSharingLevel = 'off'|'read'|'control';
export type BrowserOperationPhase = 'queued'|'running'|'stopping'|'completed'|'failed'|'cancelled'|'outcome_unknown';
export interface BrowserTabOperation {
 operationId:string; tool:BrowserTool; callerSessionId:string; phase:BrowserOperationPhase; admittedAtUnixMs:number;
 finishedAtUnixMs?:number; origin?:string; title?:string; provenanceUnavailable?:boolean; canStop:boolean;
}
export interface BrowserSharingState { level:BrowserSharingLevel; status:'idle'|'sharing'|'stopping'; grantEpoch:number; viewGeneration:number; navigationEpoch:number; origin?:string; reason?:string; reading:boolean; controlAvailable?:boolean; operations?:BrowserTabOperation[] }
export interface BrowserShareWorkspace { id:string; revision:number }
export type BrowserShareCommand = {type:'share';tabId:string;level:'off'} | {type:'share';tabId:string;level:'read'|'control';workspace:BrowserShareWorkspace;expected:{documentGeneration:number;navigationEpoch:number;viewGeneration:number;grantEpoch:number}};
export type BrowserStopAgentOperationCommand = {type:'stopAgentOperation';tabId:string;operationId:string};
export interface BrowserState { tabId:string; url:string; title:string; loading:boolean; canGoBack:boolean; canGoForward:boolean; zoom:number; documentGeneration:number; navigation:'pending'|'load_observed'|'failed'; issue?:string; snapshot?:string; snapshotGeneration?:number; unloaded?:boolean; find?:{activeMatchOrdinal:number;matches:number}; notice?:string; download?:{id:string;name:string}; sharing?:BrowserSharingState }
export type BrowserCommand =
 | BrowserShareCommand
 | BrowserStopAgentOperationCommand
 | {type:'show';tabId:string;url:string;frameName:string;bounds:BrowserBounds}
 | {type:'bounds';tabId:string;bounds:BrowserBounds}
 | {type:'state'|'hide'|'close'|'back'|'forward'|'reload'|'stop'|'focus';tabId:string}
 | {type:'navigate';tabId:string;url:string}
 | {type:'find';tabId:string;text:string;forward?:boolean;findNext?:boolean}
 | {type:'stopFind';tabId:string}
 | {type:'zoom';tabId:string;factor:number}
 | {type:'occlusion';active:boolean}
 | {type:'snapshotReady';tabId:string;generation:number}
 | {type:'preferences';patch?:Partial<BrowserPreferences>}
 | {type:'clearData'}
 | {type:'download';id:string;action:'open'|'show'};
export type BrowserEvent = {type:'state';state:BrowserState}|{type:'popup';openerId:string;tabId:string;url:string}|{type:'shortcut';phase?:'keydown'|'keyup';tabId:string;key:string;code:string;control:boolean;meta:boolean;shift:boolean;alt:boolean};
export interface BrowserBridge { browserCommand(command:BrowserCommand):Promise<BrowserState|BrowserPreferences|void>; onBrowserEvent(listener:(event:BrowserEvent)=>void):()=>void }

export function isBrowserShareCommand(value:unknown):value is BrowserShareCommand {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>,exact=(record:Record<string,unknown>,keys:string[])=>Object.keys(record).length===keys.length&&keys.every(key=>Object.hasOwn(record,key)),counter=(item:unknown)=>Number.isSafeInteger(item)&&Number(item)>=0;
 if(data.type!=='share'||typeof data.tabId!=='string'||!data.tabId||data.tabId.length>128)return false;
 if(data.level==='off')return exact(data,['type','tabId','level']);
 if(typeof data.level!=='string'||!['read','control'].includes(data.level)||!exact(data,['type','tabId','level','workspace','expected'])||!data.workspace||typeof data.workspace!=='object'||Array.isArray(data.workspace)||!data.expected||typeof data.expected!=='object'||Array.isArray(data.expected))return false;
 const workspace=data.workspace as Record<string,unknown>,expected=data.expected as Record<string,unknown>;
 return exact(workspace,['id','revision'])&&typeof workspace.id==='string'&&workspace.id.length>0&&workspace.id.length<=256&&counter(workspace.revision)
  &&exact(expected,['documentGeneration','navigationEpoch','viewGeneration','grantEpoch'])&&Object.values(expected).every(counter);
}

const browserUiText=(value:unknown,limit:number):value is string=>typeof value==='string'&&new TextEncoder().encode(value).length<=limit&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const browserUiCounter=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;

export function isBrowserStopAgentOperationCommand(value:unknown):value is BrowserStopAgentOperationCommand {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>;
 return Object.keys(data).length===3&&data.type==='stopAgentOperation'&&browserUiText(data.tabId,128)&&data.tabId.length>0
  &&browserUiText(data.operationId,512)&&data.operationId.length>0;
}

export function isBrowserTabOperation(value:unknown):value is BrowserTabOperation {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>,required=['operationId','tool','callerSessionId','phase','admittedAtUnixMs','canStop'],optional=['finishedAtUnixMs','origin','title','provenanceUnavailable'];
 return required.every(key=>Object.hasOwn(data,key))&&Object.keys(data).every(key=>required.includes(key)||optional.includes(key))
  &&browserUiText(data.operationId,512)&&data.operationId.length>0&&(isBrowserReadTool(data.tool)||isBrowserActionTool(data.tool))
  &&browserUiText(data.callerSessionId,256)&&data.callerSessionId.length>0&&typeof data.phase==='string'
  &&['queued','running','stopping','completed','failed','cancelled','outcome_unknown'].includes(data.phase)
  &&browserUiCounter(data.admittedAtUnixMs)&&(data.finishedAtUnixMs===undefined||browserUiCounter(data.finishedAtUnixMs))
  &&typeof data.canStop==='boolean'&&(!data.canStop||data.phase==='queued'||data.phase==='running')
  &&(data.origin===undefined||browserUiText(data.origin,4096))&&(data.title===undefined||browserUiText(data.title,512))
  &&(data.provenanceUnavailable===undefined||typeof data.provenanceUnavailable==='boolean');
}

export function isBrowserSharingState(value:unknown):value is BrowserSharingState {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>;
 return (data.level==='off'||data.level==='read'||data.level==='control')&&typeof data.status==='string'&&['idle','sharing','stopping'].includes(data.status)&&['grantEpoch','viewGeneration','navigationEpoch'].every(key=>browserUiCounter(data[key]))
  &&typeof data.reading==='boolean'&&(data.origin===undefined||browserUiText(data.origin,4096))&&(data.reason===undefined||browserUiText(data.reason,1024))
  &&(data.controlAvailable===undefined||typeof data.controlAvailable==='boolean')
  &&(data.operations===undefined||Array.isArray(data.operations)&&data.operations.length<=50&&data.operations.every(isBrowserTabOperation)
   &&new Set(data.operations.map(operation=>operation.operationId)).size===data.operations.length);
}

/** Titles are untrusted page text. Match the saved-layout UTF-8 byte contract. */
export function sanitizeBrowserTitle(value:string):string {
 let title='',bytes=0;
 for(const character of value){
  const point=character.codePointAt(0)!;
  if(point<=0x1f||point>=0x7f&&point<=0x9f)continue;
  const text=point>=0xd800&&point<=0xdfff?'\ufffd':character;
  const size=point>0xffff?4:point>0x7ff?3:point>0x7f?2:1;
  if(bytes+size>512)break;
  title+=text;bytes+=size;
 }
 return title;
}
