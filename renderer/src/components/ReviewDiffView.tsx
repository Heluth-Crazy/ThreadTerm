import { useEffect, useMemo, useRef, useState } from 'react';
import { operationId, request, subscribeEvents } from '../bridge';
import { Icon } from './PrototypeIcon';
import { MergeEditor, type MergeEditorHandle, type MergeSelection } from './MergeEditor';
import { fileCommentPlace, sameCommentVersion, type CommentVersion } from '../reviewComments';
import type { FileCommentsHost } from '../fileCommentsHost';
import { CommentForm, PendingComments, useFileComments } from './FileComments';
import { SurfaceDialog } from './SurfaceDialog';
import { workbenchError } from '../workbench/errors';
import { registerDirtyEditor } from '../dirtyEditors';
import { DiffFileNavigation } from './DiffFileNavigation';
import { FILES_CHANGED_EVENT, notifyFilesChanged } from '../workbench/types';
import { createRefreshQueue } from '../workbench/refreshQueue';
import { eventTouchesWorktree } from '../workbench/refreshTriggers';
import { receiveReviewDiff, reviewSaveFingerprint, reviewDraftNeedsDeferral, type ReviewDiffRefresh, type ReviewOverwrite } from '../reviewDiffRefresh';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { WbIcon } from '../workbench/icons';
import { showContextMenu } from './ContextMenu';
import { diffSurfaceMenuItems } from '../fileSurfaceContextMenuItems';
import '../workbench/workbench.css';

/** Checkpoint → current file (editable, hunk revert + fenced save) or checkpoint → next checkpoint (read-only).
 * Lines can be commented on; pending comments can be inserted, unsent, into a chosen session's message box. */
export function ReviewDiffView({projectId, worktreePath, path, sessionId, checkpointId, toCheckpointId, editorId, zh, onOpenFile, comments, worktreeSessionIds, onNavigate, navigationDisabled}:{
 projectId:string;worktreePath?:string;path:string;sessionId:string;checkpointId:string;toCheckpointId?:string;editorId:string;zh:boolean;onOpenFile?:(path:string)=>void;
 comments?:FileCommentsHost;worktreeSessionIds?:readonly string[];
 onNavigate?:(path:string)=>void;navigationDisabled?:boolean;
}) {
 const identity = JSON.stringify([projectId, worktreePath, sessionId, checkpointId, toCheckpointId, path]);
 const [fileList,setFileList]=useState<{scope:string;paths:string[]}>();
 const paths=fileList?.scope===identity?fileList.paths:[];
 const [, setState] = useState<ReviewDiffRefresh>();
 const current = useRef<ReviewDiffRefresh>({scope:identity,ticket:0,text:''});
 if(current.current.scope!==identity) current.current={scope:identity,ticket:current.current.ticket+1,text:''};
 const {diff, text, conflict} = current.current;
 const publish = (value:ReviewDiffRefresh) => { current.current=value; setState(value); };
 const setText = (value:string) => { if(current.current.scope===identity) publish({...current.current,text:value}); };
 const [issue, setIssue] = useState<string>();
 const [busy, setBusy] = useState(false);
 const [confirm, setConfirm] = useState(false);
 const [chunks, setChunks] = useState(0);
 const [closePrompt, setClosePrompt] = useState(false);
 const closeResolver = useRef<((value:boolean) => void)|undefined>(undefined);
 const editor = useRef<MergeEditorHandle>(null);
 const host = useRef<HTMLElement>(null), writing = useRef(false);
 const restore = useRef<{scope:string;ticket:number;text:string;positions:{view:EditorView;selection:EditorSelection;top:number;left:number}[]}|undefined>(undefined);
 const [diskPrompt, setDiskPrompt] = useState<'reload'|ReviewOverwrite>();
 const sessionIdsKey=JSON.stringify([...new Set([sessionId,...(worktreeSessionIds ?? [])])].sort());
 const live = !toCheckpointId;
 const editable = live && !!diff?.exists && !diff.binary;
 const dirty = editable && !!diff && text !== diff.newText;
 const copy = (en:string, cn:string) => zh ? cn : en;
 const root = comments ? worktreePath ?? comments.projectRoot(projectId) : undefined;
 const scope = root ? {projectId, root} : undefined;
 const pending = useFileComments(scope);
 const version:CommentVersion = {kind:'checkpoint', sessionId, checkpointId, ...(toCheckpointId ? {toCheckpointId} : {})};
 const [selection, setSelection] = useState<MergeSelection>();
 const [draft, setDraft] = useState<MergeSelection>();
 const canShowDraft=Boolean(scope && comments && !dirty && diff && !diff.binary);
 const shownDraft=canShowDraft ? draft : undefined;
 const draftRef=useRef(shownDraft);draftRef.current=shownDraft;
 const [pendingRefresh,setPendingRefresh]=useState(false);
 const refresh=useRef<(()=>void)|undefined>(undefined);
 useEffect(() => { setSelection(undefined); setDraft(undefined); }, [projectId, root, sessionId, checkpointId, toCheckpointId, path]);
 useEffect(() => { if(draft && !canShowDraft) {setDraft(undefined);setPendingRefresh(false);} }, [draft,canShowDraft]);
 const marks = useMemo(() => pending.filter(item => item.path === path && sameCommentVersion(item.version, version))
  .map(({side, startLine, endLine}) => ({side, startLine, endLine})), [pending, path, sessionId, checkpointId, toCheckpointId]);
 const place = (lines:MergeSelection) => fileCommentPlace({path, version, ...lines}, {fileRoot:root ?? '', sessionRoot:root}, zh);
 const load = async (discardText?:string) => {
  if(current.current.scope!==identity) return;
  const ticket = ++current.current.ticket;
  try {
   const window={sessionId, from:checkpointId, ...(toCheckpointId ? {to:toCheckpointId} : {})};
   const [diffResult,filesResult]=await Promise.allSettled([
    request('review.diff', {...window,path}), request('review.changes',window),
   ]);
   if(current.current.scope!==identity || current.current.ticket!==ticket)return;
   setFileList({scope:identity,paths:filesResult.status==='fulfilled'?filesResult.value.files?.map(file=>file.path) ?? []:[]});
   if(diffResult.status==='rejected')throw diffResult.reason;
   const value=diffResult.value;
   const before=current.current;
   if(before.scope!==identity || before.ticket!==ticket) return;
   // Keep a current-file comment's body and anchor together until it is finished or cancelled.
   if(draftRef.current?.side==='new' && reviewDraftNeedsDeferral(before.diff,value)) { setPendingRefresh(true); return; }
   const next=receiveReviewDiff(before,identity,ticket,value,discardText);
   if(next===before) return;
   // Preserve the existing editor instance and restore bounded positions after its document effects.
   const positions=Array.from(host.current?.querySelectorAll<HTMLElement>('.cm-editor') ?? []).flatMap(element=>{
    const view=EditorView.findFromDOM(element);return view?[{view,selection:view.state.selection,top:view.scrollDOM.scrollTop,left:view.scrollDOM.scrollLeft}]:[];
   });
   if(next.text!==before.text) restore.current={scope:identity,ticket,text:next.text,positions};
   publish(next); setIssue(undefined);
  } catch(error) { if(current.current.scope===identity && current.current.ticket===ticket) setIssue(workbenchError(error, zh)); }
 };
 useEffect(()=>{
  const saved=restore.current;restore.current=undefined;
  if(!saved || current.current.scope!==saved.scope || current.current.ticket!==saved.ticket || current.current.text!==saved.text) return;
  for(const {view,selection,top,left} of saved.positions) if(view.dom.isConnected) {
   const limit=view.state.doc.length;
   view.dispatch({selection:EditorSelection.create(selection.ranges.map(range=>EditorSelection.range(Math.min(range.anchor,limit),Math.min(range.head,limit))),selection.mainIndex)});
   view.scrollDOM.scrollTop=top;view.scrollDOM.scrollLeft=left;
  }
 });
 const loadRef=useRef(load);loadRef.current=load;
 useEffect(() => {
  setDiskPrompt(undefined); setConfirm(false); setIssue(undefined);
  setPendingRefresh(false);
  void loadRef.current();
  return () => { current.current.ticket++; };
 }, [identity]);
 useEffect(() => {
  if(!live) return;
  const ids=new Set<string>(JSON.parse(sessionIdsKey));
  const queue=createRefreshQueue(async()=>{
   if(draftRef.current?.side==='new') {setPendingRefresh(true);return;}
   if(!writing.current) await loadRef.current();
  });
  const changed=()=>{void queue.request();};
  refresh.current=changed;
  const shown=()=>{if(document.visibilityState==='visible') changed();};
  const unsubscribe=subscribeEvents(event=>{
   if(eventTouchesWorktree(event,{projectId,worktreePath},ids)) changed();
  });
  window.addEventListener(FILES_CHANGED_EVENT,changed);window.addEventListener('focus',changed);document.addEventListener('visibilitychange',shown);
  return ()=>{refresh.current=undefined;queue.stop();unsubscribe();window.removeEventListener(FILES_CHANGED_EVENT,changed);window.removeEventListener('focus',changed);document.removeEventListener('visibilitychange',shown);};
 }, [identity,sessionIdsKey]);
 useEffect(()=>{if(pendingRefresh && shownDraft?.side!=='new') {setPendingRefresh(false);refresh.current?.();}},[pendingRefresh,shownDraft]);
 // Unsaved review edits take part in the same close/leave confirmation as file editors.
 useEffect(() => registerDirtyEditor(editorId, () => {
  const {diff: shown, text: value} = current.current;
  if(!shown || value === shown.newText) return Promise.resolve(true);
  if(closeResolver.current) return Promise.resolve(false);
  return new Promise<boolean>(resolve => { closeResolver.current = resolve; setClosePrompt(true); });
 }, {projectId, worktreePath, isDirty:() => Boolean(current.current.diff && current.current.text !== current.current.diff.newText), path:() => path}), [editorId, projectId, worktreePath, path]);
 const save = async (overwrite?:ReviewOverwrite) => {
  const snapshot=current.current, expectedFingerprint=reviewSaveFingerprint(snapshot,overwrite);
  if(snapshot.scope!==identity || !live || !expectedFingerprint || writing.current) return false;
  writing.current=true; setBusy(true); current.current.ticket++;
  const content=snapshot.text;
  try {
   const saved=await request('filesystem.write', {projectId, ...(worktreePath ? {worktreePath} : {}), path, content, expectedFingerprint, operationId:operationId()});
   notifyFilesChanged();
   if(current.current.scope!==identity) return false;
   // Acknowledge only the submitted text: edits typed during Save remain dirty.
   publish({...current.current,diff:{...snapshot.diff!,newText:content,fingerprint:saved.fingerprint},conflict:undefined});
   await load();
   return current.current.scope===identity && current.current.text===content && !current.current.conflict;
  } catch(error) {
   if(current.current.scope===identity) {
    setIssue(workbenchError(error, zh));
    if(/file_conflict/.test(error instanceof Error ? error.message : String(error))) { publish({...current.current,conflict:true}); await load(); }
   }
   return false;
  } finally { writing.current=false; setBusy(false); }
 };
 const settleClose = async (choice:'save'|'discard'|'cancel') => {
  if(choice === 'save' && !(await save())) return;
  if(choice === 'discard' && diff) setText(diff.newText);
  setClosePrompt(false);
  closeResolver.current?.(choice !== 'cancel');
  closeResolver.current = undefined;
 };
 const revertFile = async () => {
  if(!diff) return;
  setBusy(true); setConfirm(false);
  try {
   await request('review.revert', {sessionId, checkpointId, paths:[path], expectedFingerprints:{[path]:diff.exists ? diff.fingerprint ?? null : null}, operationId:operationId()});
   notifyFilesChanged();
   await load(current.current.text);
  } catch(error) { setIssue(workbenchError(error, zh)); }
  finally { setBusy(false); }
 };
 const openContextMenu=(menu:{x:number;y:number;selection:MergeSelection;hasSelection:boolean;target:HTMLElement;copy:()=>Promise<void>})=>{
  const selected=menu.selection;
  const canComment=Boolean(scope&&comments&&selected&&!busy&&!dirty&&!draft);
  const reason=dirty?copy('Save or discard your edits first: they move the lines.','请先保存或放弃修改：修改会让行号变化。'):busy?copy('Wait for the current file action to finish.','请等待当前文件操作完成。'):draft?copy('Finish the current comment first.','请先完成当前评论。'):copy('Comments are unavailable in this workspace.','此工作区无法添加评论。');
  showContextMenu({x:menu.x,y:menu.y,restoreFocus:menu.target,items:diffSurfaceMenuItems({prefix:'review-diff',zh,lines:selected,canComment,commentReason:reason,comment:()=>setDraft(selected),hasSelection:menu.hasSelection,copy:menu.copy,copyPath:()=>navigator.clipboard.writeText(path)})});
 };
 return <section ref={host} className="tt-diff-shell wb-review-diff" data-testid="review-diff-surface">
  <div className="file-bar">
   <Icon name="spark"/>
   <span className="path" title={path}>{path}</span>
   <span className="dim">{live ? copy('Checkpoint → current file', '检查点 → 当前文件') : copy('Checkpoint → next checkpoint (read-only)', '检查点 → 下一个检查点（只读）')}</span>
   <span className="grow"/>
   <DiffFileNavigation paths={paths} path={path} zh={zh} disabled={busy||navigationDisabled} onNavigate={onNavigate}/>
   {scope && diff && !diff.binary && <button type="button" className="btn btn-sm" disabled={busy || dirty || !selection || Boolean(draft)}
    title={dirty ? copy('Save or discard your edits first: they move the lines.', '请先保存或放弃修改：修改会让行号变化。') : selection ? copy(`Comment on ${place(selection)}`, `评论 ${place(selection)}`) : copy('Select lines (or put the cursor on a line) on either side first', '请先在任一侧选中行（或将光标放在某行）')}
    onClick={() => selection && setDraft(selection)}>{copy('Comment', '评论')}</button>}
   {editable && chunks > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => editor.current?.revertHunk()} title={copy('Put the cursor in a change first', '请先将光标放在某处更改中')}>{copy('Revert hunk', '还原当前块')}</button>}
   {editable && <button type="button" className="btn btn-sm" disabled={busy || !dirty || Boolean(conflict)} onClick={() => void save()}>{copy('Save', '保存')}</button>}
   {live && diff && <button type="button" className="btn btn-sm" disabled={busy || dirty} onClick={() => setConfirm(true)}>{copy('Revert file…', '还原文件…')}</button>}
   {onOpenFile && diff?.exists && <button type="button" className="btn btn-sm" onClick={() => onOpenFile(path)}>{copy('Open file', '打开文件')}</button>}
   <button type="button" className="icon-btn icon-btn-sm" title={copy('Refresh', '刷新')} aria-label={copy('Refresh', '刷新')} disabled={busy || dirty || shownDraft?.side==='new'} onClick={() => void load()}><WbIcon name="refresh"/></button>
  </div>
  {conflict && <div className="wb-notice" role="status">
   <span>{copy('This file changed on disk while you were editing.', '编辑期间此文件已在磁盘上发生更改。')}</span>{' '}
   <button type="button" className="btn btn-sm" disabled={busy} onClick={()=>setDiskPrompt('reload')}>{copy('Reload from disk', '从磁盘重新载入')}</button>{' '}
   <button type="button" className="btn btn-sm" disabled={busy || conflict===true || !conflict.fingerprint} onClick={()=>{if(conflict!==true && conflict.fingerprint)setDiskPrompt({scope:identity,fingerprint:conflict.fingerprint});}}>{copy('Overwrite with my version', '用我的版本覆盖')}</button>
  </div>}
  {pendingRefresh && <p className="wb-notice" role="status">{copy('File updates are pending. Finish or cancel this comment to refresh.', '文件有待更新。请先完成或取消此评论，再刷新文件。')}</p>}
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  {scope && comments && <>
   {shownDraft && <CommentForm scope={scope} path={path} version={version} selection={shownDraft} zh={zh} onCancel={() => setDraft(undefined)} onAdded={() => setDraft(undefined)}/>}
   <PendingComments scope={scope} host={comments} comments={pending} zh={zh}/>
  </>}
  {diff?.binary ? <p className="tt-editor-state">{copy('Binary file — no text diff.', '二进制文件，无法显示文本对比。')}</p>
   : diff ? <>
    {!diff.exists && live && <p className="wb-notice">{copy('This file was deleted after the checkpoint.', '此文件在检查点之后被删除。')}</p>}
    {!diff.oldText && diff.exists && <p className="wb-notice">{copy('This file was created after the checkpoint.', '此文件在检查点之后创建。')}</p>}
    {diff.exists && diff.oldText === diff.newText && !dirty && <p className="wb-notice">{copy('No differences: the file matches the checkpoint.', '没有差异：文件与检查点一致。')}</p>}
    <MergeEditor ref={editor} path={path} oldText={diff.oldText} newText={editable ? text : diff.newText} readOnly={!editable || Boolean(navigationDisabled)} onChange={setText} onSave={() => void save()} onChunks={setChunks} onSelection={scope ? setSelection : undefined} onContextMenu={openContextMenu} marks={scope ? marks : undefined}/>
   </> : !issue && <p className="tt-editor-state">{copy('Loading…', '正在读取…')}</p>}
  {closePrompt && <SurfaceDialog size="sm" icon="file" title={copy('Save changes to this file?', '保存此文件的更改？')} subtitle={path} onClose={() => void settleClose('cancel')}
   footer={<><button type="button" className="btn" onClick={() => void settleClose('cancel')}>{copy('Cancel', '取消')}</button><button type="button" className="btn" onClick={() => void settleClose('discard')}>{copy('Discard', '放弃更改')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void settleClose('save')}>{copy('Save', '保存')}</button></>}>
   <p>{copy('Your edits in this review are not saved yet.', '此审查中的修改尚未保存。')}</p>
  </SurfaceDialog>}
  {diskPrompt && <SurfaceDialog size="sm" icon="file" title={diskPrompt==='reload'?copy('Reload from disk?', '从磁盘重新载入？'):copy('Overwrite with my version?', '用我的版本覆盖？')} subtitle={path} onClose={()=>setDiskPrompt(undefined)}
   footer={<><button type="button" className="btn" onClick={()=>setDiskPrompt(undefined)}>{copy('Cancel', '取消')}</button><button type="button" className="btn btn-danger" disabled={busy || (diskPrompt!=='reload' && !reviewSaveFingerprint(current.current,diskPrompt))} onClick={()=>{const choice=diskPrompt;setDiskPrompt(undefined);if(choice==='reload')void load(current.current.text);else void save(choice);}}>{diskPrompt==='reload'?copy('Reload from disk', '从磁盘重新载入'):copy('Overwrite with my version', '用我的版本覆盖')}</button></>}>
   <p>{diskPrompt==='reload'?copy('Discard your edits and reload the file from disk?', '放弃你的修改并从磁盘重新载入此文件？'):copy('Replace the disk version with your edits? If the file changes again, nothing is overwritten.', '用你的修改替换磁盘版本？若文件再次发生变化，将不会覆盖。')}</p>
  </SurfaceDialog>}
  {confirm && <SurfaceDialog size="sm" icon="trash" title={copy('Revert to checkpoint?', '还原到检查点？')} subtitle={path} onClose={() => { if(!busy) setConfirm(false); }}
   footer={<><button type="button" className="btn" onClick={() => setConfirm(false)}>{copy('Cancel', '取消')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revertFile()}>{copy('Revert', '还原')}</button></>}>
   <p>{!diff?.oldText && diff?.exists ? copy('The file did not exist at the checkpoint and will be moved to the Recycle Bin.', '检查点时此文件不存在，将移到回收站。') : copy('The file returns to its content at the checkpoint. If it changes before you confirm, nothing is overwritten.', '文件将恢复为检查点时的内容；确认前若文件发生变化，将不会被覆盖。')}</p>
  </SurfaceDialog>}
 </section>;
}
