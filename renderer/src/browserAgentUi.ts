import type { BrowserTool } from '@threadterm/protocol';
import type { BrowserShareCommand, BrowserShareWorkspace, BrowserSharingLevel, BrowserState, BrowserTabOperation } from './browserTypes';

type Copy=(en:string,zh:string)=>string;
export interface BrowserShareFence {
 tabId:string; scope:string; visible:boolean; level:BrowserSharingLevel; controlAvailable:boolean;
 documentGeneration:number; navigationEpoch:number; viewGeneration:number; grantEpoch:number;
}
export interface BrowserShareIntent { sequence:number; fence:BrowserShareFence }

/** A newer state event or explicit sharing decision owns subsequent UI state. */
export function createBrowserStateSequence() {
 let sequence=0n;
 return {
  advance():void { sequence++; },
  async reply<T>(request:()=>Promise<T>,accept:(result:T)=>void):Promise<void> {
   const captured=sequence,result=await request();
   if(captured===sequence)accept(result);
  },
 };
}

export function browserControlOrigin(state:Pick<BrowserState,'url'>):string|undefined {
 try{const url=new URL(state.url);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.origin:undefined;}catch{return undefined;}
}

export function canRequestBrowserControl(state:Omit<BrowserState,'tabId'>,visible:boolean,canPrepare:boolean):boolean {
 return canPrepare&&visible&&state.sharing?.controlAvailable===true&&state.sharing.status==='idle'
  &&state.sharing.viewGeneration>0&&!state.loading&&!state.unloaded&&state.navigation==='load_observed'&&browserControlOrigin(state)!==undefined;
}

export function browserShareFence(tabId:string,state:Omit<BrowserState,'tabId'>,scope:string,visible:boolean):BrowserShareFence {
 const sharing=state.sharing;
 return {tabId,scope,visible,level:sharing?.level??'off',controlAvailable:sharing?.controlAvailable===true,
  documentGeneration:state.documentGeneration,navigationEpoch:sharing?.navigationEpoch??0,viewGeneration:sharing?.viewGeneration??0,grantEpoch:sharing?.grantEpoch??0};
}

export function sameBrowserShareFence(left:BrowserShareFence,right:BrowserShareFence):boolean {
 return (Object.keys(left) as (keyof BrowserShareFence)[]).every(key=>left[key]===right[key]);
}

/** Every explicit choice invalidates older confirmation and workspace awaits. */
export function createBrowserShareIntents() {
 let sequence=0;
 return {
  capture(fence:BrowserShareFence):BrowserShareIntent { return {sequence:++sequence,fence:{...fence}}; },
  current(intent:BrowserShareIntent,fence:BrowserShareFence):boolean { return intent.sequence===sequence&&sameBrowserShareFence(intent.fence,fence); },
  invalidate():void { sequence++; },
 };
}

/** Workspace preparation cannot change the user's captured authority tuple. */
export async function prepareBrowserShareCommand(level:BrowserSharingLevel,intent:BrowserShareIntent,current:()=>boolean,prepare?: (tabId:string)=>Promise<BrowserShareWorkspace>):Promise<BrowserShareCommand|undefined> {
 if(!current())return;
 const tabId=intent.fence.tabId;
 if(level==='off')return {type:'share',tabId,level};
 if(!prepare)throw new Error('Save this tab in a project workspace before sharing.');
 const workspace=await prepare(tabId);
 if(!current())return;
 const {documentGeneration,navigationEpoch,viewGeneration,grantEpoch}=intent.fence;
 return {type:'share',tabId,level,workspace,expected:{documentGeneration,navigationEpoch,viewGeneration,grantEpoch}};
}

export function browserOperationName(tool:BrowserTool,copy:Copy):string {
 const names:Record<BrowserTool,string>={
  browser_list_tabs:copy('List tabs','列出标签页'),browser_snapshot:copy('Read page','读取页面'),
  browser_screenshot:copy('Take screenshot','截取页面'),browser_console_messages:copy('Read console','读取控制台'),
  browser_navigate:copy('Open page','打开页面'),browser_click:copy('Click element','点击元素'),
  browser_type:copy('Fill content','填写内容'),browser_hover:copy('Hover element','悬停元素'),
  browser_press_key:copy('Press key','按键'),browser_select_option:copy('Select option','选择选项'),
 };
 return names[tool];
}

export function browserOperationStatus(operation:BrowserTabOperation,copy:Copy):string {
 const labels:Record<BrowserTabOperation['phase'],string>={queued:copy('Queued','排队中'),running:copy('Running','运行中'),stopping:copy('Stopping…','正在停止…'),
  completed:copy('Completed','已完成'),failed:copy('Failed','失败'),cancelled:copy('Interrupted','已中断'),outcome_unknown:copy('Outcome unknown','操作结果未知')};
 return labels[operation.phase];
}

export const browserOperationActive=(operation:BrowserTabOperation):boolean=>['queued','running','stopping'].includes(operation.phase);
export const canStopBrowserOperation=(operation:BrowserTabOperation):boolean=>operation.canStop&&['queued','running'].includes(operation.phase);
export const recentBrowserOperations=(operations:readonly BrowserTabOperation[]):BrowserTabOperation[]=>operations.slice(-50).reverse();
