import { useEffect, useRef, useState } from 'react';
import type { PagePick } from '@threadterm/protocol';
import { cancelPagePick, deletePageShots, markPageTarget, pickPageTarget } from '../bridge';
import type { FileCommentsHost } from '../fileCommentsHost';
import { addPageComment, MAX_REVIEW_COMMENT_BODY, pageCommentLabel, pageTargetRef, type CommentScope } from '../reviewComments';
import { registerPagePreview } from '../pageComments';

/** Frame names are the only renderer identity the desktop picker accepts.  Keep this outside the iframe key so reloads
 * do not strand a pending picker in another frame. */

export function usePageCommentPreview(url:string, scope?:CommentScope, host?:FileCommentsHost, zh=false) {
 const [frameName]=useState(()=>`tt-preview-${crypto.randomUUID()}`), iframe=useRef<HTMLIFrameElement>(null), commentButton=useRef<HTMLButtonElement>(null);
 const [picking,setPicking]=useState(false),[pick,setPick]=useState<PagePick>(),[pickScopeKey,setPickScopeKey]=useState(''),[currentUrl,setCurrentUrl]=useState(''),[issue,setIssue]=useState<string>();
 const pickRef=useRef<PagePick|undefined>(undefined);pickRef.current=pick;
 const generation=useRef(0),pickingRef=useRef(false);
 const enabled=Boolean(scope&&host),scopeKey=scope?`${scope.projectId}\0${scope.root}`:'';
 const error=(value:unknown)=>{const reason=value instanceof Error?value.message:String(value);return reason==='review_comments_full'?(zh?'此文件夹已有 200 条审查意见。请先加入消息或删除一些。':'This folder already has 200 comments. Add them to the message or remove some first.'):reason==='review_comment_empty'?(zh?'请先填写审查意见。':'Enter a comment first.'):reason==='review_comment_too_long'?(zh?'一条审查意见最多 4000 个字符。':'A comment can be at most 4000 characters.'):(zh?'无法完成页面评论。':'The page comment could not be completed.');};
 const fail=(value:unknown)=>setIssue(error(value));
 const visible=()=>Boolean(iframe.current?.getClientRects().length);
 useEffect(()=>registerPagePreview(url,frameName,visible),[url,frameName]);
 useEffect(()=>currentUrl&&currentUrl!==url?registerPagePreview(currentUrl,frameName,visible):undefined,[url,currentUrl,frameName]);
 const clear=()=>void markPageTarget({frameName}).catch(fail);
 const discard=(value:PagePick)=>{ clear(); if(value.shot) void deletePageShots([value.shot.id]).catch(fail); };
 const cancel=(focus=true)=>{ const pending=pickingRef.current,selected=pickRef.current;generation.current++;pickingRef.current=false;if(pending)void cancelPagePick(frameName).catch(fail);if(selected)discard(selected);if(pending||selected){setPicking(false);pickRef.current=undefined;setPick(undefined);setPickScopeKey('');if(focus)requestAnimationFrame(()=>commentButton.current?.focus());} };
 useEffect(()=>()=>cancel(false),[frameName]);
 useEffect(()=>{cancel(false);setCurrentUrl('');},[url,scopeKey,enabled]);
 const begin=async()=>{
  if(!enabled||picking)return;
  const rect=iframe.current?.getBoundingClientRect(); if(!rect)return;
  iframe.current?.focus();setIssue(undefined);pickingRef.current=true;setPicking(true);const current=++generation.current;
  try { const next=await pickPageTarget({frameName,frameRect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}); if(current!==generation.current){if(next?.shot)void deletePageShots([next.shot.id]).catch(fail);return;} pickingRef.current=false;setPicking(false); if(next){pickRef.current=next;setPickScopeKey(scopeKey);setCurrentUrl(next.url);setPick(next);void markPageTarget({frameName,target:pageTargetRef(next.target)}).catch(fail);}else requestAnimationFrame(()=>commentButton.current?.focus()); }
  catch(error){if(current===generation.current){pickingRef.current=false;setPicking(false);fail(error);}}
 };
 const added=()=>{ if(pickRef.current)clear();pickRef.current=undefined;setPick(undefined);setPickScopeKey('');requestAnimationFrame(()=>commentButton.current?.focus()); };
 useEffect(()=>{if(!picking)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();cancel();}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[picking]);
 return {enabled,frameName,iframe,commentButton,picking,pick,pickScopeKey,scopeKey,issue,begin,cancel,added,discard};
}

export function PageCommentControls({preview,zh}:{preview:ReturnType<typeof usePageCommentPreview>;zh:boolean}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 if(!preview.enabled)return null;
 if(preview.pick)return null;
 return <><button ref={preview.commentButton} type="button" className="btn btn-sm" aria-pressed={preview.picking} onClick={preview.picking?()=>preview.cancel():()=>void preview.begin()}>{preview.picking?copy('Cancel','取消'):copy('Comment','评论')}</button>{preview.picking&&<span className="wb-page-comment-hint" role="status">{copy('Click an element or drag an area · ↑ parent · Esc cancels','点击元素或拖动选择区域 · ↑ 选择父级 · Esc 取消')}</span>}</>;
}

export function PageCommentForm({preview,scope,zh}:{preview:ReturnType<typeof usePageCommentPreview>;scope?:CommentScope;zh:boolean}) {
 const [body,setBody]=useState(''),[issue,setIssue]=useState<string>(); const copy=(en:string,cn:string)=>zh?cn:en;
 const pick=preview.pick;
 useEffect(()=>{setBody('');setIssue(undefined);},[pick]);
 if(!scope||!pick||preview.pickScopeKey!==preview.scopeKey)return null;
 const cancel=()=>{preview.discard(pick);preview.added();};
 const add=()=>{if(!body.trim())return;try{addPageComment({...scope,...pick,body});preview.added();}catch(error){const reason=error instanceof Error?error.message:'';setIssue(reason==='review_comments_full'?copy('This folder already has 200 comments. Add them to the message or remove some first.','此文件夹已有 200 条审查意见。请先加入消息或删除一些。'):reason==='review_comment_empty'?copy('Enter a comment first.','请先填写审查意见。'):reason==='review_comment_too_long'?copy('A comment can be at most 4000 characters.','一条审查意见最多 4000 个字符。'):copy('The page comment could not be saved.','无法保存页面评论。'));}};
 return <div className="wb-review-comment-form wb-page-comment-form">
  <div className="wb-page-comment-target">{pick.shot&&<img src={pick.shot.thumbnail} alt={copy('Selected page area','已选页面区域')}/>}<span className="wb-review-comment-where" title={pageCommentLabel(pick.target,zh)}>{pageCommentLabel(pick.target,zh)}</span></div>
  {(issue||preview.issue)&&<p className="wb-issue" role="alert">{issue??preview.issue}</p>}
  <textarea autoFocus aria-label={copy('Comment for the agent','给 Agent 的评论')} maxLength={MAX_REVIEW_COMMENT_BODY} value={body} placeholder={copy('What should the agent do here?','希望 Agent 在这里怎么改？')} onChange={event=>setBody(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();add();}else if(event.key==='Escape'){event.preventDefault();cancel();}}}/>
  <div className="wb-review-comment-actions"><span className="dim">{copy('Ctrl+Enter adds · Esc cancels','Ctrl+Enter 添加 · Esc 取消')}</span><span className="grow"/><button type="button" className="btn btn-sm" onClick={cancel}>{copy('Cancel','取消')}</button><button type="button" className="btn btn-sm btn-primary" disabled={!body.trim()} onClick={add}>{copy('Add comment','添加评论')}</button></div>
 </div>;
}
