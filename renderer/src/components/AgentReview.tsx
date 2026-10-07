import { useEffect, useState } from 'react';
import type { AgentReview, AgentReviewFinding, Session } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { agentName } from '../agents';
import { addFileComment, loadReviewComments, MAX_FILE_COMMENTS } from '../reviewComments';
import { findingCommentInput, reviewScopeLabel } from '../agentReview';
import { AgentIcon } from './PrototypeIcon';
import { workbenchError } from '../workbench/errors';
import './agent-review.css';

type Props = { reviews:AgentReview[];session:Session;root?:string;zh:boolean;scopeLabels?:Readonly<Record<string,string>>;anchorRevision?:number;onChanged:()=>void;onOpenReviewer?:(id:string)=>void };
const stateLabel=(state:AgentReview['state'],zh:boolean)=>({starting:zh?'正在启动':'Starting',running:zh?'正在审查':'Reviewing',completed:zh?'已完成':'Completed',failed:zh?'失败':'Failed'}[state]);
const severityLabel=(severity:AgentReviewFinding['severity'],zh:boolean)=>({high:zh?'高':'High',medium:zh?'中':'Medium',low:zh?'低':'Low',info:zh?'信息':'Info'}[severity]);

export function AgentReviewSection({reviews,session,root,zh,scopeLabels,anchorRevision,onChanged,onOpenReviewer}:Props) {
 const [selected,setSelected]=useState<Record<string,Set<string>>>({}),[unavailable,setUnavailable]=useState<Set<string>>(new Set()),[busy,setBusy]=useState<string>(),[issue,setIssue]=useState<string>();
 const text=(en:string,cn:string)=>zh?cn:en;
 // One read per distinct file (not per finding) when reviews or files change; Add re-checks before writing comments.
 useEffect(()=>{let active=true;const findings=reviews.flatMap(review=>review.findings?.filter(finding=>finding.state==='open'&&finding.path&&finding.line)??[]);if(!session.projectId||!findings.length){setUnavailable(new Set());return()=>{active=false;};}const paths=[...new Set(findings.map(finding=>finding.path!))];void Promise.allSettled(paths.map(path=>request('filesystem.read',{projectId:session.projectId!,...(session.worktreePath?{worktreePath:session.worktreePath}:{}),path}))).then(results=>{if(!active)return;const lines=new Map(paths.map((path,index)=>{const result=results[index];return [path,result.status==='fulfilled'?result.value.content.split(/\r?\n/).length:0];}));setUnavailable(new Set(findings.filter(finding=>finding.line!>(lines.get(finding.path!)??0)).map(finding=>finding.id)));});return()=>{active=false;};},[reviews,session.projectId,session.worktreePath,anchorRevision]);
 const changeSelection=(reviewId:string,id:string,checked:boolean)=>setSelected(current=>{const next=new Set(current[reviewId]??[]);checked?next.add(id):next.delete(id);return {...current,[reviewId]:next};});
 const mark=async(review:AgentReview,ids:string[],state:'added'|'dismissed'|'open')=>{if(!ids.length)return;setBusy(`${review.id}:${state}`);try{await request('agentReview.mark',{reviewId:review.id,findingIds:ids,state,operationId:operationId()});onChanged();}catch(error){setIssue(workbenchError(error,zh));}finally{setBusy(undefined);}};
 const add=async(review:AgentReview)=>{
  const findings=review.findings?.filter(finding=>selected[review.id]?.has(finding.id)&&finding.path&&finding.line&&!unavailable.has(finding.id))??[];
  if(!root||!session.projectId||!findings.length)return;
  if(loadReviewComments({projectId:session.projectId,root}).length+findings.length>MAX_FILE_COMMENTS){setIssue(text('There is not enough space for all selected comments.','没有足够空间添加所有选中的评论。'));return;}
  setBusy(`${review.id}:added`);
  try {
   const settled=await Promise.allSettled(findings.map(async finding=>({finding,document:await request('filesystem.read',{projectId:session.projectId!,...(session.worktreePath?{worktreePath:session.worktreePath}:{}),path:finding.path!})})));
   const documents=settled.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
   const stale=[...settled.flatMap((result,index)=>result.status==='rejected'?[findings[index].id]:[]),...documents.filter(({finding,document})=>document.content.split(/\r?\n/)[finding.line!-1]===undefined).map(({finding})=>finding.id)];
   if(stale.length){setUnavailable(current=>new Set([...current,...stale]));setIssue(text('Some findings no longer point to a current file line. They are available to copy instead.','部分发现项不再指向当前文件行，现可复制。'));return;}
   for(const {finding,document} of documents){const input=findingCommentInput(finding,{projectId:session.projectId,root,text:document.content.split(/\r?\n/)[finding.line!-1]});if(!input)throw new Error('agent_review_anchor_unavailable');addFileComment(input);}
   await request('agentReview.mark',{reviewId:review.id,findingIds:findings.map(finding=>finding.id),state:'added',operationId:operationId()});onChanged();
  }catch(error){setIssue(workbenchError(error,zh));}finally{setBusy(undefined);}
 };
 if(!reviews.length)return null;
 return <section className="agent-review-section" data-testid="agent-review-list" aria-label={text('Reviews','审查')}><h3>{text('Reviews','审查')}</h3>{issue&&<p className="wb-issue" role="alert">{issue}</p>}{reviews.map(review=><ReviewCard key={review.id} review={review} session={session} root={root} zh={zh} labels={scopeLabels} selected={selected[review.id]??new Set()} unavailable={unavailable} busy={Boolean(busy)} onSelect={(id,checked)=>changeSelection(review.id,id,checked)} onAdd={()=>void add(review)} onMark={(ids,state)=>void mark(review,ids,state)} onOpen={()=>onOpenReviewer?.(review.reviewerSessionId)}/>)}</section>;
}

function ReviewCard({review,session,root,zh,labels,selected,unavailable,busy,onSelect,onAdd,onMark,onOpen}:{review:AgentReview;session:Session;root?:string;zh:boolean;labels?:Readonly<Record<string,string>>;selected:Set<string>;unavailable:Set<string>;busy:boolean;onSelect:(id:string,checked:boolean)=>void;onAdd:()=>void;onMark:(ids:string[],state:'dismissed'|'open')=>void;onOpen:()=>void}) {
 const text=(en:string,cn:string)=>zh?cn:en, findings=review.findings??[],open=findings.filter(finding=>finding.state==='open'),added=findings.filter(finding=>finding.state==='added'),dismissed=findings.filter(finding=>finding.state==='dismissed'),selectable=open.filter(finding=>finding.path&&finding.line&&!unavailable.has(finding.id));
 return <article className={`agent-review-card is-${review.state}`}><header><AgentIcon provider={review.agent}/><strong>{agentName(review.agent)}</strong><span className="agent-review-state">{stateLabel(review.state,zh)}</span></header><p className="agent-review-meta">{reviewScopeLabel(review.scope,zh,labels)} · {review.files} {text(review.files===1?'file':'files','个文件')}</p><button type="button" className="btn btn-sm" onClick={onOpen}>{text('Open reviewer','打开审查智能体')}</button>{review.error&&<p className="agent-review-error" role="alert">{review.error}</p>}{review.truncated.length>0&&<p className="agent-review-note">{text(`The snapshot omitted: ${review.truncated.join(', ')}`,`快照未包含：${review.truncated.join('、')}`)}</p>}{review.unparsed&&<p data-testid="agent-review-unparsed" className="agent-review-note">{text('The reviewer did not return findings in the expected format — open its reply.','审查智能体未按预期格式返回发现项，请打开其回复。')}</p>}{open.map(finding=><Finding key={finding.id} finding={finding} checked={selected.has(finding.id)} unavailable={unavailable.has(finding.id)} zh={zh} onSelect={checked=>onSelect(finding.id,checked)}/>)}{added.map(finding=><Finding key={finding.id} finding={finding} checked={false} unavailable zh={zh} added/>)}{open.length>0&&<div className="agent-review-actions"><button type="button" data-testid="agent-review-add-comments" className="btn btn-sm btn-primary" disabled={busy||!root||!session.projectId||!selectable.some(finding=>selected.has(finding.id))} onClick={onAdd}>{text('Add to comments','添加到评论')}</button><button type="button" className="btn btn-sm" disabled={busy||!open.some(finding=>selected.has(finding.id))} onClick={()=>onMark(open.filter(finding=>selected.has(finding.id)).map(finding=>finding.id),'dismissed')}>{text('Dismiss','忽略')}</button></div>}{dismissed.length>0&&<details className="agent-review-dismissed"><summary>{text(`Dismissed (${dismissed.length})`,`已忽略（${dismissed.length}）`)}</summary>{dismissed.map(finding=><div key={finding.id} className="agent-review-dismissed-row"><span>{finding.title}</span><button type="button" className="btn btn-sm" disabled={busy} onClick={()=>onMark([finding.id],'open')}>{text('Restore','恢复')}</button></div>)}</details>}</article>;
}

function Finding({finding,checked,unavailable,zh,added,onSelect}:{finding:AgentReviewFinding;checked:boolean;unavailable:boolean;zh:boolean;added?:boolean;onSelect?:(checked:boolean)=>void}) {
 const text=(en:string,cn:string)=>zh?cn:en,anchor=finding.path&&finding.line?`${finding.path}:${finding.line}`:undefined,copyOnly=!anchor||(unavailable&&!added);
 const Head=(copyOnly?'div':'label') as 'label',copy=()=>void navigator.clipboard?.writeText(`[${finding.severity}] ${finding.title} — ${finding.body}`).catch(()=>undefined);
 // Two lines that fit the side bar: severity + title, then the anchor (or "General") with Added / Copy at the end.
 return <article className={`agent-review-finding severity-${finding.severity}`} data-testid="agent-review-finding">
  <Head className="agent-review-finding-head">{copyOnly?<span className="agent-review-check" aria-hidden="true"/>:<input type="checkbox" checked={checked} disabled={added} onChange={event=>onSelect?.(event.target.checked)}/>}<span className="agent-review-severity">{severityLabel(finding.severity,zh)}</span><strong>{finding.title}</strong></Head>
  <div className="agent-review-finding-meta">{anchor?<code title={anchor}>{anchor}</code>:<span>{text('General','通用')}</span>}{added&&<span className="agent-review-added">{text('Added','已添加')}</span>}{copyOnly&&<button type="button" className="btn btn-sm agent-review-copy" aria-label={text('Copy finding','复制发现项')} onClick={copy}>{text('Copy','复制')}</button>}</div>
  {finding.body&&<details><summary>{text('Details','详情')}</summary><p>{finding.body}</p></details>}
 </article>;
}
