import { useEffect, useState } from 'react';
import type { FileCommentsHost } from '../fileCommentsHost';
import { readPageShot } from '../bridge';
import { MAX_CHAT_IMAGES } from '../chatImages';
import { flashPageComment } from '../pageComments';
import { canonicalScopePath } from '../projectScope';
import { addFileComment, fileCommentPlace, fileCommentShortPlace, formatReviewComments, isPageComment, loadReviewComments, pageCommentLabel, pageCommentLocation, releaseReviewComments, removeReviewComments, type ReviewComment, loadFileComments, MAX_FILE_COMMENTS, MAX_REVIEW_COMMENT_BODY, subscribeFileComments, type CommentScope, type CommentVersion, type FileComment } from '../reviewComments';
import { Icon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import { Select } from './ui/Select';

export type CommentSelection = {side:'old'|'new';startLine:number;endLine:number;text:string};

/** One folder's pending comments, shared by every file view and refreshed across windows. */
export function useFileComments(scope?:CommentScope):FileComment[] {
 const scopeKey = scope ? `${scope.projectId}:${canonicalScopePath(scope.root)}` : undefined;
 const [state, setState] = useState<{key:string|undefined;comments:FileComment[]}>({key:scopeKey,comments:[]});
 useEffect(() => {
  if(!scope) { setState({key:undefined, comments:[]}); return; }
  let active=true; const refresh = () => { void loadFileComments(scope).then(comments=>{if(active)setState({key:scopeKey,comments});}).catch(()=>undefined); };
  refresh();
  const unsubscribe=subscribeFileComments(scope, refresh); return () => {active=false;unsubscribe();};
 }, [scopeKey]);
 return state.key === scopeKey ? state.comments : [];
}

/** The pending strip includes pages; file-view line marks continue using useFileComments. */
export function useReviewComments(scope?:CommentScope):ReviewComment[] {
 const scopeKey=scope?`${scope.projectId}:${canonicalScopePath(scope.root)}`:undefined;
 const [state,setState]=useState<{key:string|undefined;comments:ReviewComment[]}>({key:scopeKey,comments:[]});
 useEffect(()=>{
  if(!scope){setState({key:undefined,comments:[]});return;}
  let active=true;const refresh=()=>{void loadReviewComments(scope).then(comments=>{if(active)setState({key:scopeKey,comments});}).catch(()=>undefined);};
  refresh();const unsubscribe=subscribeFileComments(scope,refresh);return()=>{active=false;unsubscribe();};
 },[scopeKey]);
 return state.key===scopeKey?state.comments:[];
}

function commentError(error:unknown, zh:boolean):string {
 const copy = (en:string, cn:string) => zh ? cn : en;
 const reason = error instanceof Error ? error.message : String(error);
 return reason === 'review_comments_full' ? copy(`This folder already has ${MAX_FILE_COMMENTS} comments. Add them to the message or remove some first.`, `此文件夹已有 ${MAX_FILE_COMMENTS} 条审查意见。请先加入消息或删除一些。`)
  : reason === 'review_comment_empty' ? copy('Enter a comment first.', '请先填写审查意见。')
  : reason === 'review_comment_too_long' ? copy(`A comment can be at most ${MAX_REVIEW_COMMENT_BODY} characters.`, `一条审查意见最多 ${MAX_REVIEW_COMMENT_BODY} 个字符。`)
  : reason === 'review_comments_conflict' ? copy('Comments changed in another window. The latest comments were loaded; try again.', '评论已在另一个窗口更改。已加载最新评论，请重试。')
  : reason === 'review_comments_unavailable' ? copy('Comments cannot be stored in this window.', '此窗口无法保存审查意见。') : reason;
}

export function CommentForm({scope, path, version, selection, zh, onCancel, onAdded}:{scope:CommentScope;path:string;version:CommentVersion;selection:CommentSelection;zh:boolean;onCancel:()=>void;onAdded:()=>void}) {
 const [body, setBody] = useState('');
 const [saving, setSaving] = useState(false);
 const [issue, setIssue] = useState<string>();
 const copy = (en:string, cn:string) => zh ? cn : en;
 const place = fileCommentPlace({path, version, ...selection}, {fileRoot:scope.root, sessionRoot:scope.root}, zh);
 const addComment = async () => {
  if(saving || !body.trim()) return;
  setSaving(true);
  try {
   await addFileComment({...scope, path, version, ...selection, body});
   onAdded();
  } catch(error) { setIssue(commentError(error, zh)); } finally { setSaving(false); }
 };
 return <div className="wb-review-comment-form">
  <span className="wb-review-comment-where" title={selection.text}>{place}</span>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  <textarea autoFocus disabled={saving} aria-label={copy('Comment for the agent', '给 Agent 的评论')} maxLength={MAX_REVIEW_COMMENT_BODY} value={body}
   placeholder={copy('What should the agent do here?', '希望 Agent 在这里怎么改？')}
   onChange={event => setBody(event.target.value)}
   onKeyDown={event => { if(event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void addComment(); } else if(event.key === 'Escape') { event.preventDefault(); onCancel(); } }}/>
  <div className="wb-review-comment-actions"><span className="dim">{copy('Ctrl+Enter adds · Esc cancels', 'Ctrl+Enter 添加 · Esc 取消')}</span><span className="grow"/>
   <button type="button" className="btn btn-sm" disabled={saving} onClick={onCancel}>{copy('Cancel', '取消')}</button>
   <button type="button" className="btn btn-sm btn-primary" disabled={saving || !body.trim()} onClick={()=>void addComment()}>{copy('Add comment', '添加评论')}</button></div>
 </div>;
}

/** `previewId` selects one immutable page queue. File callers omit it and retain their batch UI. */
export function PendingComments({scope, host, comments:providedComments, zh, previewId}:{scope:CommentScope;host:FileCommentsHost;comments:ReviewComment[];zh:boolean;previewId?:string}) {
 const storedComments=useReviewComments(scope);
 const comments=previewId ? storedComments.filter(item=>isPageComment(item)&&item.provenance?.previewId===previewId) : (storedComments.some(isPageComment)?storedComments:providedComments);
 const [receiverId, setReceiverId] = useState<string>();
 const [busy, setBusy] = useState(false);
 const [issue, setIssue] = useState<string>();
 const [issueCode, setIssueCode] = useState<'page_shot_read'|'page_shot_unavailable'>();
 const [notice, setNotice] = useState<string>();
 const [noticeCode, setNoticeCode] = useState<'page_shots_file_path'>();
 const [confirmClear, setConfirmClear] = useState(false);
 const [transfer, setTransfer] = useState<{comments:ReviewComment[];receiverId:string} | undefined>();
 const copy = (en:string, cn:string) => zh ? cn : en;
 const screenshotIssue = issueCode === 'page_shot_read' ? copy('A page screenshot could not be read. The comments were kept.','页面截图无法读取。评论已保留。') : issueCode === 'page_shot_unavailable' ? copy('A page screenshot is unavailable. The comments were kept.','页面截图不可用。评论已保留。') : issue;
 const screenshotNotice = noticeCode === 'page_shots_file_path' ? copy('Some screenshots were added by file path only. The receiving session can read those files.', '部分截图仅以文件路径加入，接收会话可以读取这些文件。') : notice;
 const pageOwners=[...new Set(comments.filter(isPageComment).map(item=>item.provenance?.sessionId).filter((id):id is string=>Boolean(id)))];
 const pageOwnerLabels=[...new Set(comments.filter(isPageComment).flatMap(item=>{const id=item.provenance?.sessionId;if(!id)return [];const receiver=host.receivers.find(candidate=>candidate.id===id),title=receiver?.title??item.provenance?.sessionTitle??id;return [`${title} (${receiver?.provider??item.provenance?.providerId??'unknown'})`];}))];
 const sourcePages=[...new Set(comments.filter(isPageComment).map(item=>`${item.title ? `${item.title} — ` : ''}${item.url}`))];
 const hasUnownedPage=comments.some(item=>isPageComment(item)&&!item.provenance?.sessionId);
 const defaultReceiverId=previewId ? (pageOwners.length===1&&!hasUnownedPage?pageOwners[0]:undefined) : (pageOwners.length===1&&!hasUnownedPage?pageOwners[0]:(pageOwners.length||hasUnownedPage?undefined:(host.defaultReceiverId??host.receivers[0]?.id)));
 const receiver = host.receivers.find(item => item.id === (receiverId??defaultReceiverId));
 const roots = {fileRoot:scope.root, sessionRoot:receiver?.root ?? scope.root};
 const files = new Set(comments.filter((item):item is FileComment=>!isPageComment(item)).map(item => item.path)).size;
 const pages = new Set(comments.filter(isPageComment).map(item=>item.url)).size;
 useEffect(() => { setIssue(undefined); setIssueCode(undefined); setNotice(undefined); setNoticeCode(undefined); setConfirmClear(false); setTransfer(undefined); }, [scope.projectId, scope.root, previewId]);
 useEffect(() => { if(noticeCode==='page_shots_file_path')host.notice?.(copy('Some screenshots were added by file path only. The receiving session can read those files.', '部分截图仅以文件路径加入，接收会话可以读取这些文件。')); }, [zh, noticeCode]);
 useEffect(() => { setTransfer(undefined); }, [comments.map(item=>item.id).join('|')]);
 useEffect(() => { if(!notice) return; const timer = setTimeout(() => {setNotice(undefined);setNoticeCode(undefined);}, 4000); return () => clearTimeout(timer); }, [notice]);
 const removeComments = async (ids:string[]) => {
  try { await removeReviewComments(scope, ids); setIssue(undefined); setIssueCode(undefined); }
  catch(error) { setIssueCode(undefined); setIssue(commentError(error, zh)); }
 };
 const insertToMessage = async (inserted:ReviewComment[], pinnedReceiverId:string) => {
  const pinnedReceiver=host.receivers.find(item=>item.id===pinnedReceiverId);
  if(!pinnedReceiver || !inserted.length || busy){setIssueCode(undefined);setIssue(copy('The selected destination is no longer available. Comments were kept.','所选目标已不可用。评论已保留。'));return;}
  setBusy(true); setNotice(undefined); setIssue(undefined); setIssueCode(undefined);
  try {
   const shots=inserted.filter(isPageComment).flatMap(item=>item.shot?[item.shot]:[]),images:string[]=[];
   // Validate every path before releasing its comment. Only the first four data URLs are
   // transferred, but a later missing screenshot must not leave the agent a dead path.
   for(const shot of shots){
    let image:string|undefined;
    try{image=await readPageShot(shot.id);}catch{throw new Error('page_shot_read');}
    if(!image)throw new Error('page_shot_unavailable');
    if(images.length<MAX_CHAT_IMAGES)images.push(image);
   }
   const attached=await host.insert(pinnedReceiver.id, formatReviewComments(inserted, {fileRoot:scope.root,sessionRoot:pinnedReceiver.root}, zh), images.length?images:undefined);
   await releaseReviewComments(scope, inserted.map(item => item.id));
   if(shots.length>(attached??0)){const message=copy('Some screenshots were added by file path only. The receiving session can read those files.', '部分截图仅以文件路径加入，接收会话可以读取这些文件。');setNoticeCode('page_shots_file_path');setNotice(message);host.notice?.(message);}
  } catch(error) { const message=error instanceof Error ? error.message : String(error);if(message==='page_shot_read'||message==='page_shot_unavailable'){setIssue(undefined);setIssueCode(message);}else{setIssueCode(undefined);setIssue(message);} }
  finally { setBusy(false); }
 };
 const addToMessage = () => {
  if(!receiver || !comments.length || busy){if(!receiver){setIssueCode(undefined);setIssue(copy('Choose a destination session first. Comments were kept.','请先选择目标会话。评论已保留。'));}return;}
  const inserted=[...comments], mismatched=inserted.filter(isPageComment).filter(item=>item.provenance?.sessionId&&item.provenance.sessionId!==receiver.id);
  if(mismatched.length){setTransfer({comments:inserted,receiverId:receiver.id});return;}
  void insertToMessage(inserted,receiver.id);
 };
 const copyComments = () => void navigator.clipboard.writeText(formatReviewComments(comments, roots, zh))
  .then(() => { setNoticeCode(undefined);setNotice(copy('Copied. The comments stay here until you add them or clear them.', '已复制。审查意见会保留，直到加入消息或清除。')); setIssue(undefined);setIssueCode(undefined); })
  .catch(error => {setIssueCode(undefined);setIssue(error instanceof Error ? error.message : String(error));});
 if(!comments.length) return null;
 return <div className="wb-review-comments" role="region" aria-label={copy('Review comments', '审查意见')}>
  <div className="wb-review-comment-actions">
   <b>{copy(`${comments.length} comment${comments.length === 1 ? '' : 's'}`, `${comments.length} 条审查意见`)}</b>
   <span className="dim">{pages ? copy(`in ${pages} page${pages===1?'':'s'}${files?` and ${files} file${files===1?'':'s'}`:''} · not sent yet`, `涉及 ${pages} 个页面${files?`、${files} 个文件`:''} · 尚未发送`) : files > 1 ? copy(`in ${files} files · not sent yet`, `涉及 ${files} 个文件 · 尚未发送`) : copy('not sent yet', '尚未发送')}</span>
   {previewId&&<span className="dim">{pageOwnerLabels.length===1?copy(`Owner: ${pageOwnerLabels[0]}`,`所有者：${pageOwnerLabels[0]}`):copy('Owner: unavailable or manual page', '所有者：不可用或手动页面')}</span>}
   {host.receivers.length ? <Select value={receiver?.id??''} disabled={busy} aria-label={copy('Destination session', '目标会话')} onChange={event => {setReceiverId(event.target.value||undefined);setTransfer(undefined);}}>
    {!receiver&&<option value="" disabled>{copy('Choose destination', '选择目标会话')}</option>}
    {host.receivers.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
   </Select> : <span className="dim">{copy('Open an agent Chat in this workspace to add them to its message.', '在此工作区打开一个 Agent 聊天，即可加入其消息。')}</span>}
   <span className="wb-review-comment-buttons">
    {host.receivers.length>0 && <button type="button" className="btn btn-sm btn-primary" disabled={busy||!receiver} onClick={addToMessage}
     title={copy('Insert all comments into the chosen session message box. Nothing is sent.', '把全部审查意见插入所选会话的消息框，不会发送。')}>{copy('Add to message', '加入消息')}</button>}
    <button type="button" className="btn btn-sm" disabled={busy} onClick={copyComments}>{copy('Copy', '复制')}</button>
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmClear(true)}>{copy('Clear', '清除')}</button>
   </span>
  </div>
  {screenshotIssue && <p className="wb-issue" role="alert">{screenshotIssue}</p>}
  {screenshotNotice && <p className="dim" role="status">{screenshotNotice}</p>}
  <ul>{comments.map(item => <li key={item.id}>
   {isPageComment(item)?<button type="button" className="wb-page-comment-row" onClick={()=>void flashPageComment(item).catch(()=>{setIssueCode(undefined);setIssue(copy('Could not highlight this page target.', '无法高亮此页面目标。'));})} title={item.url} aria-label={copy(`Highlight ${pageCommentLabel(item.target,zh)}`, `高亮 ${pageCommentLabel(item.target,zh)}`)}>
    {item.shot&&<img src={item.shot.thumbnail} alt={copy('Page screenshot', '页面截图')}/>}<span><b>{pageCommentLabel(item.target,zh)}</b><small>{pageCommentLocation(item.url)}</small></span>
   </button>:<span className="wb-review-comment-where" title={`${fileCommentPlace(item, roots, zh)}\n${item.excerpt}`}>{fileCommentShortPlace(item, zh)}</span>}
   <span className="body" title={item.body}>{item.body}</span>
   <button type="button" className="icon-btn" disabled={busy} aria-label={copy('Remove comment', '删除评论')} title={copy('Remove comment', '删除评论')} onClick={() => void removeComments([item.id])}><Icon name="close"/></button>
  </li>)}</ul>
   {transfer&&<SurfaceDialog size="sm" icon="warning" className="page-comment-transfer-dialog" title={copy('Transfer page comments?', '转移页面评论？')} subtitle={copy(`${transfer.comments.filter(isPageComment).length} page comment${transfer.comments.filter(isPageComment).length===1?'':'s'} will be added to the destination draft. Nothing is sent.`, `${transfer.comments.filter(isPageComment).length} 条页面评论将加入目标草稿，不会发送。`)} onClose={()=>setTransfer(undefined)}
    footer={<><button type="button" className="btn" disabled={busy} onClick={()=>setTransfer(undefined)}>{copy('Cancel','取消')}</button><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={()=>{const current=host.receivers.find(item=>item.id===transfer.receiverId);if(!current){setTransfer(undefined);setIssueCode(undefined);setIssue(copy('The selected destination is no longer available. Comments were kept.','所选目标已不可用。评论已保留。'));return;}const pinned=transfer;setTransfer(undefined);void insertToMessage(pinned.comments,pinned.receiverId);}}>{copy('Add to draft','加入草稿')}</button></>}>
    <dl className="page-comment-transfer-details">
     <div><dt>{copy(sourcePages.length===1?'Source page':'Source pages','来源页面')}</dt><dd>{sourcePages.map(source=><span key={source} title={source}>{source}</span>)}</dd></div>
     <div><dt>{copy(pageOwnerLabels.length===1?'Source owner':'Source owners','来源页面会话')}</dt><dd>{pageOwnerLabels.map(owner=><span key={owner}>{owner}</span>)}</dd></div>
     <div><dt>{copy('Destination','目标会话')}</dt><dd>{`${host.receivers.find(item=>item.id===transfer.receiverId)?.title??transfer.receiverId} (${host.receivers.find(item=>item.id===transfer.receiverId)?.provider??(zh?'未知':'unknown')})`}</dd></div>
    </dl>
   </SurfaceDialog>}
   {confirmClear && <SurfaceDialog size="sm" icon="trash" title={copy('Clear all review comments?', '清除全部审查意见？')} subtitle={pages?copy(`${comments.length} comments in ${pages} pages and ${files} files`, `${comments.length} 条，涉及 ${pages} 个页面、${files} 个文件`):copy(`${comments.length} comments in ${files} files`, `${comments.length} 条，涉及 ${files} 个文件`)} onClose={() => setConfirmClear(false)}
   footer={<><button type="button" className="btn" onClick={() => setConfirmClear(false)}>{copy('Cancel', '取消')}</button><button type="button" className="btn btn-danger" onClick={() => { void removeComments(comments.map(item => item.id)); setConfirmClear(false); setNotice(undefined); setNoticeCode(undefined); }}>{copy('Clear', '清除')}</button></>}>
   <p>{copy('They have not been sent to the agent and cannot be restored.', '这些意见尚未发给 Agent，清除后无法恢复。')}</p>
  </SurfaceDialog>}
 </div>;
}
