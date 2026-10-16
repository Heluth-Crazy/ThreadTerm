/** Desktop-only browser contract. Pages have no access to this bridge. */
export interface BrowserPreferences { unloadAfterMinutes:number; linkTarget:'builtin'|'system' }
export interface BrowserBounds { x:number; y:number; width:number; height:number }
export interface BrowserState { tabId:string; url:string; title:string; loading:boolean; canGoBack:boolean; canGoForward:boolean; zoom:number; documentGeneration:number; navigation:'pending'|'load_observed'|'failed'; issue?:string; snapshot?:string; snapshotGeneration?:number; unloaded?:boolean; find?:{activeMatchOrdinal:number;matches:number}; notice?:string; download?:{id:string;name:string} }
export type BrowserCommand =
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
