import { validateResult,type BrowserEvalApprovalRead,type ChatPart } from '@threadterm/protocol';

export interface BrowserEvalSummary {
 approvalId:string;operationId:string;callerSessionId:string;tabId:string;origin:string;codeHash:string;codeByteLength:number;expiresAtUnixMs:number;settingsGeneration:string;
}
export type BrowserEvalReview=BrowserEvalApprovalRead;
export interface BrowserEvalContext {sessionId:string;turnId:string;leaseEpoch:number;generation:string;writable:boolean;live:boolean}
export type BrowserEvalChoice='approve_once'|'deny';
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,limit=512):value is string=>typeof value==='string'&&value.length>0&&new TextEncoder().encode(value).length<=limit&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const counter=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const origin=(value:unknown):value is string=>{if(!text(value,4096))return false;try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&url.origin===value;}catch{return false;}};

export function isBrowserEvalApproval(part:{type?:string;data?:unknown}):boolean {
 return part?.type==='approval'&&record(part.data)&&part.data.runtimeOwned===true&&part.data.requestType==='threadterm.browser_eval';
}

export function browserEvalSummary(part:ChatPart):BrowserEvalSummary|undefined {
 if(!isBrowserEvalApproval(part)||!record(part.data))return;
 const data=part.data;
 if(!text(data.approvalId)||data.approvalId!==part.approvalId||!text(data.operationId)||!text(data.callerSessionId,256)
  ||!text(data.tabId,256)||!origin(data.origin)||!hash(data.codeHash)||!counter(data.codeByteLength)||data.codeByteLength<1||data.codeByteLength>16*1024
  ||!counter(data.expiresAtUnixMs)||!text(data.settingsGeneration))return;
 return {approvalId:data.approvalId,operationId:data.operationId,callerSessionId:data.callerSessionId,tabId:data.tabId,origin:data.origin,codeHash:data.codeHash,
  codeByteLength:data.codeByteLength,expiresAtUnixMs:data.expiresAtUnixMs,settingsGeneration:data.settingsGeneration};
}

export function browserEvalReviewKey(summary:BrowserEvalSummary|undefined,context:BrowserEvalContext|undefined,status:string|undefined):string {
 return JSON.stringify([summary,context,status]);
}

export function browserEvalReviewEnabled(summary:BrowserEvalSummary|undefined,context:BrowserEvalContext|undefined,status:string|undefined,now=Date.now()):boolean {
 return Boolean(summary&&context?.writable&&context.live&&context.sessionId===summary.callerSessionId&&context.turnId&&Number.isSafeInteger(context.leaseEpoch)
  &&context.leaseEpoch>0&&status==='pending'&&summary.expiresAtUnixMs>now);
}

/** The code stays in this ephemeral review path; no summary or error contains it. */
export async function verifyBrowserEvalReview(value:unknown,summary:BrowserEvalSummary,digest:(bytes:Uint8Array)=>Promise<ArrayBuffer>=bytes=>crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)):Promise<BrowserEvalReview> {
 try{validateResult('browser.approval.read',value);}catch{throw new Error('Browser code review unavailable');}
 if(value.status!=='pending')throw new Error('Browser code review unavailable');
 for(const key of ['approvalId','operationId','tabId','origin','codeHash','codeByteLength','expiresAtUnixMs','settingsGeneration'] as const){if(value[key]!==summary[key])throw new Error('Browser code review changed');}
 const bytes=new TextEncoder().encode(value.code);
 if(bytes.length!==summary.codeByteLength)throw new Error('Browser code review changed');
 const actual=Array.from(new Uint8Array(await digest(bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 if(actual!==summary.codeHash)throw new Error('Browser code review changed');
 return {approvalId:summary.approvalId,operationId:summary.operationId,tabId:summary.tabId,origin:summary.origin,codeHash:summary.codeHash,
  codeByteLength:summary.codeByteLength,expiresAtUnixMs:summary.expiresAtUnixMs,settingsGeneration:summary.settingsGeneration,code:value.code,status:'pending'};
}

/** Cancellation invalidates both a late read and its asynchronous hash result. */
export function createBrowserEvalReviewRequests() {
 let sequence=0;
 return {
  cancel():void {sequence++;},
  async read(read:()=>Promise<unknown>,summary:BrowserEvalSummary,current:()=>boolean,accept:(review:BrowserEvalReview)=>void,verify=verifyBrowserEvalReview):Promise<void> {
   const captured=++sequence;if(!current())return;
   const value=await read();
   if(captured!==sequence||!current())return;
   const reviewed=await verify(value,summary);
   if(captured===sequence&&current())accept(reviewed);
  },
 };
}

/** A transport retry keeps the exact decision identity and cannot switch choice. */
export function createBrowserEvalDecision(createId:()=>string) {
 let decision:{key:string;choice:BrowserEvalChoice;operationId:string;state:'sending'|'retry'|'sent'}|undefined;
 return {
  clear():void {decision=undefined;},
  begin(key:string,choice:BrowserEvalChoice){
   if(decision&&decision.key!==key)decision=undefined;
   if(decision&&(decision.choice!==choice||decision.state!=='retry'))return;
   decision=decision?{...decision,state:'sending'}:{key,choice,operationId:createId(),state:'sending'};
   return {...decision};
  },
  settle(operationId:string,success:boolean):void {if(decision?.operationId===operationId)decision={...decision,state:success?'sent':'retry'};},
 };
}
