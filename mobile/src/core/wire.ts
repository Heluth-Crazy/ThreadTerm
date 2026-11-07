import { validateRequest, validateResult, type Method } from '@threadterm/protocol';
import { isMobileSnapshot, type MobileMethod, type MobileResult } from '@threadterm/protocol/mobile';

export const CONTROL_METHODS=new Set<MobileMethod>(['mobile.session.create','session.stop','session.resume','session.claim','session.renew','session.release','chat.connect','chat.send','chat.cancel','chat.approve','chat.answer','terminal.input','terminal.resize','attachment.upload']);
export const READ_METHODS=new Set<MobileMethod>(['runtime.health','project.catalog.list','worktree.list','worktree.branches','session.lookup','chat.snapshot','chat.read','chat.subagent.read','chat.options','chat.connection','terminal.read','filesystem.list','filesystem.read','filesystem.files','filesystem.search','filesystem.image','git.status','git.diff','git.log','git.commit.show','git.commit.diff','git.branches','inbox.read','session.attention.acknowledge','chat.image.read','attachment.read']);
export function validateMobileRequest(method:MobileMethod,params:unknown):void {
  if(!method.startsWith('mobile.')) {
    if(!READ_METHODS.has(method)&&!CONTROL_METHODS.has(method)) throw new Error('mobile_forbidden');
    validateRequest(method,params);return;
  }
  if(!params||typeof params!=='object'||Array.isArray(params)) throw new Error('invalid_request');
  const p=params as Record<string,unknown>;
  if(method==='mobile.snapshot') {if(Object.keys(p).length) throw new Error('invalid_request');return;}
  if(method==='mobile.events.subscribe') {
    if(Object.keys(p).some(key=>key!=='sessionIds')||!Array.isArray(p.sessionIds)||p.sessionIds.length>4||!p.sessionIds.every(id=>typeof id==='string'&&id.length>0)) throw new Error('invalid_subscription');return;
  }
  if(method==='mobile.session.create') {
    if(Object.keys(p).some(key=>!['projectId','worktreeId','provider','mode','title','operationId'].includes(key))||!['projectId','provider','operationId'].every(key=>typeof p[key]==='string'&&String(p[key]).trim())||!['chat','terminal'].includes(String(p.mode))) throw new Error('invalid_session_request');return;
  }
  throw new Error('mobile_forbidden');
}
export function mobileResult<M extends MobileMethod>(method:M,value:unknown):MobileResult<M> {
  if(method==='mobile.snapshot') {
    if(!isMobileSnapshot(value)) throw new Error('invalid_mobile_snapshot');
  } else if(method==='mobile.events.subscribe') {
    const v=value as {sessionIds?:unknown;revision?:unknown}|null;
    if(!v||!Array.isArray(v.sessionIds)||!v.sessionIds.every(id=>typeof id==='string')||!Number.isSafeInteger(v.revision)) throw new Error('invalid_subscription_result');
  } else if(method==='mobile.session.create') validateResult('session.create',value);
  else validateResult(method as Method,value);
  return value as MobileResult<M>;
}

/** Portable base64 decoder: Hermes and Node test paths use identical byte boundaries. */
export function base64Bytes(value:string):Uint8Array {
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid_base64');
  const table='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes=new Uint8Array(value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0));
  let at=0;
  for(let i=0;i<value.length;i+=4) {
    const n=(table.indexOf(value[i]!)<<18)|(table.indexOf(value[i+1]!)<<12)|(Math.max(0,table.indexOf(value[i+2]!))<<6)|Math.max(0,table.indexOf(value[i+3]!));
    if(at<bytes.length) bytes[at++]=(n>>>16)&255;
    if(at<bytes.length) bytes[at++]=(n>>>8)&255;
    if(at<bytes.length) bytes[at++]=n&255;
  }
  return bytes;
}
