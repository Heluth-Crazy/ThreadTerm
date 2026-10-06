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
 const [state, setState] = useState(() => ({key:scopeKey, comments:scope ? loadFileComments(scope) : []}));
 useEffect(() => {
  if(!scope) { setState({key:undefined, comments:[]}); return; }
  const refresh = () => setState({key:scopeKey, comments:loadFileComments(scope)});
  refresh();
  return subscribeFileComments(scope, refresh);
 }, [scopeKey]);
 return state.key === scopeKey ? state.comments : [];
}

/** The pending strip includes pages; file-view line marks continue using useFileComments. */
export function useReviewComments(scope?:CommentScope):ReviewComment[] {
 const scopeKey=scope?`${scope.projectId}:${canonicalScopePath(scope.root)}`:undefined;
 const [state,setState]=useState(()=>({key:scopeKey,comments:scope?loadReviewComments(scope):[]}));
 useEffect(()=>{
  if(!scope){setState({key:undefined,comments:[]});return;}
  const refresh=()=>setState({key:scopeKey,comments:loadReviewComments(scope)});
  refresh(); return subscribeFileComments(scope,refresh);
 },[scopeKey]);
 return state.key===scopeKey?state.comments:[];
}

function commentError(error:unknown, zh:boolean):string {
 const copy = (en:string, cn:string) => zh ? cn : en;
 const reason = error instanceof Error ? error.message : String(error);
 return reason === 'review_comments_full' ? copy(`This folder already has ${MAX_FILE_COMMENTS} comments. Add them to the message or remove some first.`, `此文件夹已有 ${MAX_FILE_COMMENTS} 条审查意见。请先加入消息或删除一些。`)
  : reason === 'review_comment_empty' ? copy('Enter a comment first.', '请先填写审查意见。')
  : reason === 'review_comment_too_long' ? copy(`A comment can be at most ${MAX_REVIEW_COMMENT_BODY} characters.`, `一条审查意见最多 ${MAX_REVIEW_COMMENT_BODY} 个字符。`)
  : reason === 'review_comments_unavailable' ? copy('Comments cannot be stored in this window.', '此窗口无法保存审查意见。') : reason;
}

export function CommentForm({scope, path, version, selection, zh, onCancel, onAdded}:{scope:CommentScope;path:string;version:CommentVersion;selection:CommentSelection;zh:boolean;onCancel:()=>void;onAdded:()=>void}) {
 const [body, setBody] = useState('');
 const [issue, setIssue] = useState<string>();
 const copy = (en:string, cn:string) => zh ? cn : en;
 const place = fileCommentPlace({path, version, ...selection}, {fileRoot:scope.root, sessionRoot:scope.root}, zh);
 const addComment = () => {
  if(!body.trim()) return;
  try {
   addFileComment({...scope, path, version, ...selection, body});
   onAdded();
  } catch(error) { setIssue(commentError(error, zh)); }
 };
 return <div className="wb-review-comment-form">
  <span className="wb-review-comment-where" title={selection.text}>{place}</span>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  <textarea autoFocus aria-label={copy('Comment for the agent', '给 Agent 的评论')} maxLength={MAX_REVIEW_COMMENT_BODY} value={body}
   placeholder={copy('What should the agent do here?', '希望 Agent 在这里怎么改？')}
   onChange={event => setBody(event.target.value)}
   onKeyDown={event => { if(event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addComment(); } else if(event.key === 'Escape') { event.preventDefault(); onCancel(); } }}/>
  <div className="wb-review-comment-actions"><span className="dim">{copy('Ctrl+Enter adds · Esc cancels', 'Ctrl+Enter 添加 · Esc 取消')}</span><span className="grow"/>
   <button type="button" className="btn btn-sm" onClick={onCancel}>{copy('Cancel', '取消')}</button>
   <button type="button" className="btn btn-sm btn-primary" disabled={!body.trim()} onClick={addComment}>{copy('Add comment', '添加评论')}</button></div>
 </div>;
}

export function PendingComments({scope, host, comments:providedComments, zh}:{scope:CommentScope;host:FileCommentsHost;comments:ReviewComment[];zh:boolean}) {
 const storedComments=useReviewComments(scope);
 const comments=storedComments.some(isPageComment)?storedComments:providedComments;
 // Follows the workspace's current session until the user picks another one here.
 const [receiverId, setReceiverId] = useState<string>();
 const [busy, setBusy] = useState(false);
 const [issue, setIssue] = useState<string>();
 const [notice, setNotice] = useState<string>();
 const [confirmClear, setConfirmClear] = useState(false);
 const copy = (en:string, cn:string) => zh ? cn : en;
 const receiver = host.receivers.find(item => item.id === receiverId) ?? host.receivers.find(item => item.id === host.defaultReceiverId) ?? host.receivers[0];
 const roots = {fileRoot:scope.root, sessionRoot:receiver?.root ?? scope.root};
 const files = new Set(comments.filter((item):item is FileComment=>!isPageComment(item)).map(item => item.path)).size;
 const pages = new Set(comments.filter(isPageComment).map(item=>item.url)).size;
 useEffect(() => { setIssue(undefined); setNotice(undefined); setConfirmClear(false); }, [scope.projectId, scope.root]);
 useEffect(() => { if(!notice) return; const timer = setTimeout(() => setNotice(undefined), 4000); return () => clearTimeout(timer); }, [notice]);
 const removeComments = (ids:string[]) => {
  try { removeReviewComments(scope, ids); setIssue(undefined); }
  catch(error) { setIssue(commentError(error, zh)); }
 };
 const addToMessage = async () => {
  if(!receiver || !comments.length || busy) return;
  const inserted = [...comments];
  setBusy(true); setNotice(undefined); setIssue(undefined);
  try {
   const shots=inserted.filter(isPageComment).flatMap(item=>item.shot?[item.shot]:[]),images:string[]=[];
   // Validate every path before releasing its comment. Only the first four data URLs are
   // transferred, but a later missing screenshot must not leave the agent a dead path.
   for(const shot of shots){
    let image:string|undefined;
    try{image=await readPageShot(shot.id);}catch{throw new Error(copy('A page screenshot could not be read. The comments were kept.','页面截图无法读取。评论已保留。'));}
    if(!image)throw new Error(copy('A page screenshot is unavailable. The comments were kept.','页面截图不可用。评论已保留。'));
    if(images.length<MAX_CHAT_IMAGES)images.push(image);
   }
   const attached=await host.insert(receiver.id, formatReviewComments(inserted, roots, zh), images.length?images:undefined);
   releaseReviewComments(scope, inserted.map(item => item.id));
   if(shots.length>(attached??0)){const message=copy('Some screenshots were added by file path only. The receiving session can read those files.', '部分截图仅以文件路径加入，接收会话可以读取这些文件。');setNotice(message);host.notice?.(message);}
  } catch(error) { setIssue(error instanceof Error ? error.message : String(error)); }
  finally { setBusy(false); }
 };
 const copyComments = () => void navigator.clipboard.writeText(formatReviewComments(comments, roots, zh))
  .then(() => { setNotice(copy('Copied. The comments stay here until you add them or clear them.', '已复制。审查意见会保留，直到加入消息或清除。')); setIssue(undefined); })
  .catch(error => setIssue(error instanceof Error ? error.message : String(error)));
 if(!comments.length) return null;
 return <div className="wb-review-comments" role="region" aria-label={copy('Review comments', '审查意见')}>
  <div className="wb-review-comment-actions">
   <b>{copy(`${comments.length} comment${comments.length === 1 ? '' : 's'}`, `${comments.length} 条审查意见`)}</b>
   <span className="dim">{pages ? copy(`in ${pages} page${pages===1?'':'s'}${files?` and ${files} file${files===1?'':'s'}`:''} · not sent yet`, `涉及 ${pages} 个页面${files?`、${files} 个文件`:''} · 尚未发送`) : files > 1 ? copy(`in ${files} files · not sent yet`, `涉及 ${files} 个文件 · 尚未发送`) : copy('not sent yet', '尚未发送')}</span>
   {receiver ? <Select value={receiver.id} disabled={busy} aria-label={copy('Send to session', '发送到会话')} onChange={event => setReceiverId(event.target.value)}>
    {host.receivers.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
   </Select> : <span className="dim">{copy('Open an agent Chat in this workspace to add them to its message.', '在此工作区打开一个 Agent 聊天，即可加入其消息。')}</span>}
   <span className="wb-review-comment-buttons">
    {receiver && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void addToMessage()}
     title={copy('Insert all comments into the chosen session message box. Nothing is sent.', '把全部审查意见插入所选会话的消息框，不会发送。')}>{copy('Add to message', '加入消息')}</button>}
    <button type="button" className="btn btn-sm" disabled={busy} onClick={copyComments}>{copy('Copy', '复制')}</button>
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmClear(true)}>{copy('Clear', '清除')}</button>
   </span>
  </div>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  {notice && <p className="dim" role="status">{notice}</p>}
  <ul>{comments.map(item => <li key={item.id}>
   {isPageComment(item)?<button type="button" className="wb-page-comment-row" onClick={()=>void flashPageComment(item).catch(()=>setIssue(copy('Could not highlight this page target.', '无法高亮此页面目标。')))} title={item.url} aria-label={copy(`Highlight ${pageCommentLabel(item.target,zh)}`, `高亮 ${pageCommentLabel(item.target,zh)}`)}>
    {item.shot&&<img src={item.shot.thumbnail} alt={copy('Page screenshot', '页面截图')}/>}<span><b>{pageCommentLabel(item.target,zh)}</b><small>{pageCommentLocation(item.url)}</small></span>
   </button>:<span className="wb-review-comment-where" title={`${fileCommentPlace(item, roots, zh)}\n${item.excerpt}`}>{fileCommentShortPlace(item, zh)}</span>}
   <span className="body" title={item.body}>{item.body}</span>
   <button type="button" className="icon-btn" disabled={busy} aria-label={copy('Remove comment', '删除评论')} title={copy('Remove comment', '删除评论')} onClick={() => removeComments([item.id])}><Icon name="close"/></button>
  </li>)}</ul>
  {confirmClear && <SurfaceDialog size="sm" icon="trash" title={copy('Clear all review comments?', '清除全部审查意见？')} subtitle={pages?copy(`${comments.length} comments in ${pages} pages and ${files} files`, `${comments.length} 条，涉及 ${pages} 个页面、${files} 个文件`):copy(`${comments.length} comments in ${files} files`, `${comments.length} 条，涉及 ${files} 个文件`)} onClose={() => setConfirmClear(false)}
   footer={<><button type="button" className="btn" onClick={() => setConfirmClear(false)}>{copy('Cancel', '取消')}</button><button type="button" className="btn btn-danger" onClick={() => { removeComments(comments.map(item => item.id)); setConfirmClear(false); setNotice(undefined); }}>{copy('Clear', '清除')}</button></>}>
   <p>{copy('They have not been sent to the agent and cannot be restored.', '这些意见尚未发给 Agent，清除后无法恢复。')}</p>
  </SurfaceDialog>}
 </div>;
}
