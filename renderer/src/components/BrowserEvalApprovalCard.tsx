import { useEffect, useRef, useState } from 'react';
import type { ChatPart } from '@threadterm/protocol';
import { operationId,request } from '../bridge';
import { browserEvalReviewEnabled,browserEvalReviewKey,browserEvalSummary,createBrowserEvalDecision,createBrowserEvalReviewRequests,type BrowserEvalChoice,type BrowserEvalContext,type BrowserEvalReview } from '../browserEvalApproval';
import './browser-eval-approval.css';

export function BrowserEvalApprovalCard({part,context,copy}:{part:ChatPart;context?:BrowserEvalContext;copy:(en:string,zh:string)=>string}) {
 const summary=browserEvalSummary(part),key=browserEvalReviewKey(summary,context,part.status),enabled=browserEvalReviewEnabled(summary,context,part.status);
 const latest=useRef({key,enabled});latest.current={key,enabled};
 const [requests]=useState(createBrowserEvalReviewRequests),[decisions]=useState(()=>createBrowserEvalDecision(operationId));
 const [loaded,setLoaded]=useState<{key:string;review:BrowserEvalReview}>(),[failure,setFailure]=useState<{key:string;kind:'read'|'decision'}>();
 const [decision,setDecision]=useState<{key:string;choice:BrowserEvalChoice;state:'sending'|'retry'|'sent'}>(),[expired,setExpired]=useState<string>();
 const active=enabled&&expired!==key,review=active&&loaded?.key===key?loaded.review:undefined,currentDecision=decision?.key===key?decision:undefined;
 const current=()=>latest.current.key===key&&latest.current.enabled&&Boolean(summary&&summary.expiresAtUnixMs>Date.now());
 useEffect(()=>{
  requests.cancel();decisions.clear();setLoaded(undefined);setFailure(undefined);setDecision(undefined);setExpired(undefined);
  if(!enabled||!summary||!context)return;
  let live=true;
  void requests.read(()=>request('browser.approval.read',{sessionId:context.sessionId,turnId:context.turnId,approvalId:summary.approvalId,leaseEpoch:context.leaseEpoch}),summary,
   ()=>live&&current(),value=>setLoaded({key,review:value})).catch(()=>{if(live&&current())setFailure({key,kind:'read'});});
  const timer=setTimeout(()=>{requests.cancel();setLoaded(undefined);setExpired(key);},Math.min(2_147_483_647,Math.max(0,summary.expiresAtUnixMs-Date.now())));
  return()=>{live=false;clearTimeout(timer);requests.cancel();decisions.clear();};
 },[key,enabled,requests,decisions]);
 const choose=async(choice:BrowserEvalChoice)=>{
  if(!active||!summary||!context||!current()||choice==='approve_once'&&!review)return;
  const attempt=decisions.begin(key,choice);if(!attempt)return;
  setDecision({key,choice,state:'sending'});setFailure(undefined);
  try{
   const result=await request('browser.approval.resolve',{sessionId:context.sessionId,turnId:context.turnId,approvalId:summary.approvalId,leaseEpoch:context.leaseEpoch,
    operationId:attempt.operationId,codeHash:choice==='approve_once'?review!.codeHash:summary.codeHash,choice});
   if(result.status!==(choice==='approve_once'?'approved':'denied'))throw new Error('Decision was not confirmed');
   if(current()){decisions.settle(attempt.operationId,true);requests.cancel();setLoaded(undefined);setDecision({key,choice,state:'sent'});}
  }catch{if(current()){decisions.settle(attempt.operationId,false);setDecision({key,choice,state:'retry'});setFailure({key,kind:'decision'});}}
 };
 const stopped=!active||currentDecision?.state==='sent',locked=currentDecision?.state==='sending'||currentDecision?.state==='sent';
 return <section className="chat-approval-card browser-eval-approval" aria-label={copy('Browser code approval','浏览器代码审批')}>
  <strong>{copy('Run code in this browser page?','在此浏览器页面中运行代码？')}</strong>
  {summary&&<div className="browser-eval-source"><p>{copy('Page','页面')}: {summary.origin}</p><p>{copy('Chat','对话')}: {summary.callerSessionId}</p></div>}
  <p>{copy('This snippet can read or change the page and may have external effects. Approval applies once to this exact snippet. Stopping does not undo changes.','此代码可以读取或修改页面，并可能产生外部影响。批准仅对这段确切代码生效一次。停止不会撤销更改。')}</p>
  {review&&!stopped&&<BrowserEvalCodeReview review={review} copy={copy}/>}
  {currentDecision?.state==='sent'?<p role="status">{currentDecision.choice==='deny'?copy('Denied. The snippet was not approved.','已拒绝，未批准此代码。'):copy('Approved once. This does not confirm that the code ran.','已批准一次。这不代表代码已经执行。')}</p>
   :stopped?<p role="status">{copy('This approval is inactive. Code is available only for a current writable pending request.','此审批已失效。仅当前可写的待处理请求可以查看代码。')}</p>
   :!review&&failure?.key!==key?<p role="status">{copy('Loading exact code for review…','正在读取待审批的确切代码…')}</p>:null}
  {failure?.key===key&&<p className="surface-error" role="alert">{failure.kind==='read'?copy('Code could not be verified. Approval is unavailable; you can deny this request.','无法验证代码，不能批准；你仍可拒绝此请求。'):copy('The decision could not be confirmed. Retry the same decision.','无法确认决定，请重试相同决定。')}</p>}
  {active&&currentDecision?.state!=='sent'&&<div className="chat-approval-actions">
   <button type="button" className="btn btn-sm" disabled={locked||Boolean(currentDecision&&currentDecision.choice!=='deny')} onClick={()=>void choose('deny')}>{currentDecision?.state==='sending'&&currentDecision.choice==='deny'?copy('Submitting…','提交中…'):copy('Deny','拒绝')}</button>
   <button type="button" className="btn btn-sm btn-primary" disabled={!review||locked||Boolean(currentDecision&&currentDecision.choice!=='approve_once')} onClick={()=>void choose('approve_once')}>{currentDecision?.state==='sending'&&currentDecision.choice==='approve_once'?copy('Submitting…','提交中…'):copy('Approve once','批准一次')}</button>
  </div>}
 </section>;
}

export function BrowserEvalCodeReview({review,copy}:{review:BrowserEvalReview;copy:(en:string,zh:string)=>string}) {
 return <><pre className="browser-eval-code" role="region" tabIndex={0} aria-label={copy('Exact code to review','待审批的确切代码')}><code>{review.code}</code></pre><p className="browser-eval-hash">SHA-256: <code>{review.codeHash}</code> · {review.codeByteLength} {copy('bytes','字节')}</p></>;
}
