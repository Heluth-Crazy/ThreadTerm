/** Desktop-only browser contract. Pages have no access to this bridge. */
export interface BrowserPreferences { unloadAfterMinutes:number; linkTarget:'builtin'|'system' }
export interface BrowserBounds { x:number; y:number; width:number; height:number }
export interface BrowserSharingState { level:'off'|'read'; status:'idle'|'sharing'|'stopping'; grantEpoch:number; viewGeneration:number; navigationEpoch:number; origin?:string; reason?:string; reading:boolean }
export interface BrowserShareWorkspace { id:string; revision:number }
export type BrowserShareCommand = {type:'share';tabId:string;level:'off'} | {type:'share';tabId:string;level:'read';workspace:BrowserShareWorkspace;expected:{documentGeneration:number;navigationEpoch:number;viewGeneration:number;grantEpoch:number}};
export interface BrowserState { tabId:string; url:string; title:string; loading:boolean; canGoBack:boolean; canGoForward:boolean; zoom:number; documentGeneration:number; navigation:'pending'|'load_observed'|'failed'; issue?:string; snapshot?:string; snapshotGeneration?:number; unloaded?:boolean; find?:{activeMatchOrdinal:number;matches:number}; notice?:string; download?:{id:string;name:string}; sharing?:BrowserSharingState }
export type BrowserCommand =
 | BrowserShareCommand
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
 if(data.level!=='read'||!exact(data,['type','tabId','level','workspace','expected'])||!data.workspace||typeof data.workspace!=='object'||Array.isArray(data.workspace)||!data.expected||typeof data.expected!=='object'||Array.isArray(data.expected))return false;
 const workspace=data.workspace as Record<string,unknown>,expected=data.expected as Record<string,unknown>;
 return exact(workspace,['id','revision'])&&typeof workspace.id==='string'&&workspace.id.length>0&&workspace.id.length<=256&&counter(workspace.revision)
  &&exact(expected,['documentGeneration','navigationEpoch','viewGeneration','grantEpoch'])&&Object.values(expected).every(counter);
}

export function isBrowserSharingState(value:unknown):value is BrowserSharingState {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>;
 return (data.level==='off'||data.level==='read')&&['idle','sharing','stopping'].includes(String(data.status))&&['grantEpoch','viewGeneration','navigationEpoch'].every(key=>Number.isSafeInteger(data[key])&&Number(data[key])>=0)
  &&typeof data.reading==='boolean'&&(data.origin===undefined||typeof data.origin==='string'&&data.origin.length<=4096)&&(data.reason===undefined||typeof data.reason==='string'&&data.reason.length<=1024);
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
