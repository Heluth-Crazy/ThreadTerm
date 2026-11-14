import { MAX_CHAT_IMAGES } from '@threadterm/protocol';
import { readPageShot } from './bridge';
import type { FileCommentsHost } from './fileCommentsHost';
import { formatReviewComments, isPageComment, releaseReviewComments, type CommentScope, type ReviewComment } from './reviewComments';
import { canonicalScopePath } from './projectScope';

const inFlight=new Map<string,Promise<{attached:number}>>(),receiptMemory=new Set<string>(),receiptStorage='threadterm.design-delivery.receipts',MAX_RECEIPTS=1000;
function receiptKey(scope:CommentScope,receiverId:string,toChat:boolean,id:string):string{return JSON.stringify([scope.projectId,canonicalScopePath(scope.root)??scope.root,receiverId,toChat,id]);}
function validReceipt(value:unknown):value is string {try{const tuple=typeof value==='string'?JSON.parse(value):undefined;return Array.isArray(tuple)&&tuple.length===5&&typeof tuple[0]==='string'&&typeof tuple[1]==='string'&&typeof tuple[2]==='string'&&typeof tuple[3]==='boolean'&&typeof tuple[4]==='string';}catch{return false;}}
function persistedReceipts():Set<string>{try{const value=JSON.parse(localStorage.getItem(receiptStorage)??'[]');if(Array.isArray(value))for(const item of value)if(validReceipt(item))receiptMemory.add(item);}catch{}return receiptMemory;}
function rememberReceipts(keys:readonly string[]){const receipts=persistedReceipts(),newKeys=keys.filter(key=>!receipts.has(key));if(receipts.size+newKeys.length>MAX_RECEIPTS)throw new Error('Design note delivery receipt storage is full. Clear pending notes before sending more.');for(const key of newKeys)receipts.add(key);try{localStorage.setItem(receiptStorage,JSON.stringify([...receipts]));}catch{}}
function forgetReceipts(keys:readonly string[]){const receipts=persistedReceipts();for(const key of keys)receipts.delete(key);try{localStorage.setItem(receiptStorage,JSON.stringify([...receipts]));}catch{}}
async function releaseDelivered(scope:CommentScope,comments:readonly ReviewComment[],keys:readonly string[]):Promise<void>{for(let index=0;index<comments.length;index++){await releaseReviewComments(scope,[comments[index]!.id]);forgetReceipts([keys[index]!]);}}

/** Delivers stored design notes through the existing composer and normal Chat submit path. */
export async function deliverDesignNotes(options:{scope:CommentScope;host:FileCommentsHost;comments:readonly ReviewComment[];receiverId?:string;zh:boolean;toChat?:boolean;readShot?:(id:string)=>Promise<string|undefined>}):Promise<{attached:number}> {
 const {scope,host,comments,zh,toChat=false}=options;
 if(!comments.length)throw new Error(zh?'没有可发送的标注。':'There are no design notes to send.');
 const receiverId=options.receiverId??host.defaultReceiverId;
 const receiver=receiverId&&host.receivers.find(item=>item.id===receiverId);
 if(!receiver)throw new Error(zh?'请选择目标会话。':'Choose a destination session.');
 const owners=[...new Set(comments.filter(isPageComment).map(comment=>comment.provenance?.sessionId).filter((id):id is string=>Boolean(id)))];
 if(owners.length&&(owners.length!==1||owners[0]!==receiver.id))throw new Error(zh?'请选择页面所属的会话。':'Choose the page owner session.');
 const keys=comments.map(comment=>receiptKey(scope,receiver.id,toChat,comment.id)),key=JSON.stringify([...keys].sort()),running=inFlight.get(key);if(running)return running;
 const deliver=(async()=>{
 const receipts=persistedReceipts(),fresh=comments.filter((_,index)=>!receipts.has(keys[index]!));
 if(fresh.length&&receipts.size+fresh.length>MAX_RECEIPTS)throw new Error(zh?'设计标注的发送记录已满。请先清理待发送标注。':'Design note delivery receipt storage is full. Clear pending notes before sending more.');
 if(!fresh.length){await releaseDelivered(scope,comments,keys);return {attached:0};}
 const read=options.readShot??readPageShot,images:string[]=[];
 for(const comment of fresh)if(isPageComment(comment)&&comment.shot){
  const image=await read(comment.shot.id);
  if(!image)throw new Error(zh?'页面截图不可用。标注已保留。':'A page screenshot is unavailable. The notes were kept.');
  if(images.length<MAX_CHAT_IMAGES)images.push(image);
 }
 const text=formatReviewComments(fresh,{fileRoot:scope.root,sessionRoot:receiver.root},zh);
 // Ctrl+L intentionally stops at the composer. Batch/single Send invokes the already-registered Chat submitter,
 // whose queue decision is identical to typing Return in that composer.
 if(toChat)await host.insert(receiver.id,text,images.length?images:undefined);
 else {
  if(!host.send)throw new Error(zh?'目标会话无法发送标注。':'The destination session cannot send design notes.');
  await host.send(receiver.id,{text,images:images.length?images:undefined});
 }
 rememberReceipts(fresh.map(comment=>receiptKey(scope,receiver.id,toChat,comment.id)));
 await releaseDelivered(scope,comments,keys);
 return {attached:toChat?images.length:images.length};
 })();inFlight.set(key,deliver);try{return await deliver;}finally{if(inFlight.get(key)===deliver)inFlight.delete(key);}
}
