import { useEffect, useMemo, useRef, useState } from 'react';
import { operationId, request, subscribeEvents } from '../bridge';
import type { ReviewFile } from '@threadterm/protocol';
import { WbIcon } from '../workbench/icons';
import { Icon } from './PrototypeIcon';
import { MergeEditor, type MergeEditorHandle, type MergeSelection } from './MergeEditor';
import { fileCommentPlace, sameCommentVersion, type CommentVersion } from '../reviewComments';
import type { FileCommentsHost } from '../fileCommentsHost';
import { CommentForm, PendingComments, useFileComments } from './FileComments';
import { SurfaceDialog } from './SurfaceDialog';
import { workbenchError } from '../workbench/errors';
import { registerDirtyEditor } from '../dirtyEditors';
import { FILES_CHANGED_EVENT, notifyFilesChanged } from '../workbench/types';
import { createRefreshQueue } from '../workbench/refreshQueue';
import { eventTouchesWorktree } from '../workbench/refreshTriggers';
import { receiveReviewDiff, reviewSaveFingerprint, reviewDraftNeedsDeferral, type ReviewDiffRefresh, type ReviewOverwrite } from '../reviewDiffRefresh';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { DiffFileNavigation } from './DiffFileNavigation';
import { showContextMenu } from './ContextMenu';
import { diffSurfaceMenuItems } from '../fileSurfaceContextMenuItems';
import { reviewChangeTotals } from '../agentChangeCounts';
import '../workbench/workbench.css';

type Window = {projectId:string;worktreePath?:string;sessionId:string;checkpointId:string;toCheckpointId?:string};
type PaneProps = Window & {
 path:string;editorId:string;zh:boolean;onOpenFile?:(path:string)=>void;
 comments?:FileCommentsHost;worktreeSessionIds?:readonly string[];
 navigationDisabled?:boolean;unified:boolean;
 /** Standalone turn diff: it keeps the checkpoint label and the file navigation group. */
 navigation?:boolean;onNavigate?:(path:string)=>void;
};

/** One checkpoint → current file: editable right side, hunk revert, fenced save and line comments.
 * The stacked review mounts one of these per expanded file so a large review stays fast. */
function ReviewFilePane({projectId,worktreePath,path,sessionId,checkpointId,toCheckpointId,editorId,zh,onOpenFile,comments,worktreeSessionIds,navigationDisabled,unified,navigation=false,onNavigate}:PaneProps) {
 const identity = JSON.stringify([projectId, worktreePath, sessionId, checkpointId, toCheckpointId, path]);
 // Outside the stacked review a single pane carries its own file list and navigation group.
 const [fileList,setFileList]=useState<{scope:string;paths:string[]}>();
 const navigationPaths=navigation&&fileList?.scope===identity?fileList.paths:[];
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
 const host = useRef<HTMLDivElement>(null), writing = useRef(false);
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
   const request_={sessionId, from:checkpointId, ...(toCheckpointId ? {to:toCheckpointId} : {}), path};
   // The file list survives a failed diff: navigation must still reach the other files.
   const [diffResult,filesResult]=await Promise.allSettled([
    request('review.diff', request_),
    navigation ? request('review.changes', {sessionId, from:checkpointId, ...(toCheckpointId ? {to:toCheckpointId} : {})}) : Promise.resolve(undefined),
   ]);
   const before=current.current;
   if(before.scope!==identity || before.ticket!==ticket) return;
   if(filesResult.status==='fulfilled'&&filesResult.value) setFileList({scope:identity,paths:filesResult.value.files?.map(file=>file.path) ?? []});
   if(diffResult.status==='rejected') throw diffResult.reason;
   const value=diffResult.value;
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
  const selected_=menu.selection;
  const canComment=Boolean(scope&&comments&&selected_&&!busy&&!dirty&&!draft);
  const reason=dirty?copy('Save or discard your edits first: they move the lines.','请先保存或放弃修改：修改会让行号变化。'):busy?copy('Wait for the current file action to finish.','请等待当前文件操作完成。'):draft?copy('Finish the current comment first.','请先完成当前评论。'):copy('Comments are unavailable in this workspace.','此工作区无法添加评论。');
  showContextMenu({x:menu.x,y:menu.y,restoreFocus:menu.target,items:diffSurfaceMenuItems({prefix:'review-diff',zh,lines:selected_,canComment,commentReason:reason,comment:()=>setDraft(selected_),hasSelection:menu.hasSelection,copy:menu.copy,copyPath:()=>navigator.clipboard.writeText(path)})});
 };
 return <div ref={host} className={`wb-rs-body${navigation ? ' tt-diff-shell wb-review-diff' : ''}`} data-review-path={path} {...(navigation ? {'data-testid':'review-diff-surface'} : {})}>
  {navigation && <div className="wb-rs-location">
   <Icon name="diff"/>
   <span className="path" title={path}>{path}</span>
   <span className="dim">{live ? copy('Checkpoint → current file', '检查点 → 当前文件') : copy('Checkpoint → next checkpoint (read-only)', '检查点 → 下一个检查点（只读）')}</span>
   <DiffFileNavigation paths={navigationPaths} path={path} zh={zh} disabled={busy||Boolean(navigationDisabled)} onNavigate={onNavigate}/>
  </div>}
  <div className={`wb-rs-actions${dirty ? ' is-dirty' : ''}${selection ? ' is-active' : ''}`}>
   {scope && diff && !diff.binary && <button type="button" className="cg-ghost cg-sm" disabled={busy || dirty || !selection || Boolean(draft)}
    title={dirty ? copy('Save or discard your edits first: they move the lines.', '请先保存或放弃修改：修改会让行号变化。') : selection ? copy(`Comment on ${place(selection)}`, `评论 ${place(selection)}`) : copy('Select lines (or put the cursor on a line) on either side first', '请先在任一侧选中行（或将光标放在某行）')}
    onClick={() => selection && setDraft(selection)}><WbIcon name="to-chat"/>{copy('Comment', '评论')}</button>}
   {editable && chunks > 0 && <button type="button" className="cg-ghost cg-sm" disabled={busy} onClick={() => editor.current?.revertHunk()} title={copy('Put the cursor in a change first', '请先将光标放在某处更改中')}><WbIcon name="undo"/>{copy('Revert hunk', '还原当前块')}</button>}
   {live && diff && <button type="button" className="cg-ghost cg-sm" disabled={busy || dirty} onClick={() => setConfirm(true)}><WbIcon name="trash"/>{copy('Revert file…', '还原文件…')}</button>}
   {editable && dirty && <button type="button" className="cg-ghost cg-sm cg-primary" disabled={busy || Boolean(conflict)} onClick={() => void save()}>{copy('Save', '保存')}</button>}
   <span className="grow" />
   <button type="button" className="cg-ghost cg-icon cg-sm" title={copy('Refresh', '刷新')} aria-label={copy('Refresh', '刷新')} disabled={busy || dirty || shownDraft?.side==='new'} onClick={() => void load()}><WbIcon name="refresh"/></button>
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
    <MergeEditor ref={editor} path={path} oldText={diff.oldText} newText={editable ? text : diff.newText} readOnly={!editable || Boolean(navigationDisabled)} onChange={setText} onSave={() => void save()} onChunks={setChunks} onSelection={scope ? setSelection : undefined} onContextMenu={openContextMenu} marks={scope ? marks : undefined} unified={unified}/>
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
 </div>;
}

/** Checkpoint review: every changed file stacked in one scroll (Cursor's Git review), unified by default and
 * split on demand. Each file mounts its diff only while expanded, so a large review stays fast.
 * `stack` is off for the inline turn diff in chat, which shows its single file. */
export function ReviewDiffView({projectId, worktreePath, path, sessionId, checkpointId, toCheckpointId, editorId, zh, onOpenFile, comments, worktreeSessionIds, navigationDisabled, stack = false, onNavigate}:Window & {
 path:string;editorId:string;zh:boolean;onOpenFile?:(path:string)=>void;
 comments?:FileCommentsHost;worktreeSessionIds?:readonly string[];
 onNavigate?:(path:string)=>void;navigationDisabled?:boolean;stack?:boolean;
}) {
 const copy = (en:string, cn:string) => zh ? cn : en;
 const identity = JSON.stringify([projectId, worktreePath, sessionId, checkpointId, toCheckpointId]);
 const [fileList, setFileList] = useState<{scope:string;files:ReviewFile[]}>();
 const files = fileList?.scope===identity ? fileList.files : [];
 const [expanded, setExpanded] = useState<Set<string>>(() => new Set([path]));
 const [mode, setMode] = useState<'unified'|'split'>('unified');
 const [issue, setIssue] = useState<string>();
 const load = async () => {
  try {
   const value = await request('review.changes', {sessionId, from:checkpointId, ...(toCheckpointId ? {to:toCheckpointId} : {})});
   setFileList({scope:identity, files:value.files ?? []}); setIssue(undefined);
  } catch(error) { setIssue(workbenchError(error, zh)); }
 };
 useEffect(() => { if(!stack) return; void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [identity, stack]);
 // Keep the opened file expanded when the surface first shows it.
 useEffect(() => { setExpanded(current => current.has(path) ? current : new Set(current).add(path)); }, [path]);
 if(!stack) return <ReviewFilePane projectId={projectId} worktreePath={worktreePath} path={path} sessionId={sessionId} checkpointId={checkpointId} toCheckpointId={toCheckpointId} editorId={editorId} zh={zh} onOpenFile={onOpenFile} comments={comments} worktreeSessionIds={worktreeSessionIds} navigationDisabled={navigationDisabled} unified={false} navigation onNavigate={onNavigate}/>;
 const listed: ReviewFile[] = files.length ? files : [{path, status:'M'}];
 const totals = reviewChangeTotals(files);
 const changed = totals.added + totals.removed;
 return <section className="tt-diff-shell wb-review-diff wb-review-stack" data-testid="review-diff-surface">
  <div className="wb-rs-bar">
   <b>{copy(`${listed.length} file${listed.length === 1 ? '' : 's'} changed`, `${listed.length} 个文件已更改`)}</b>
   {changed > 0 && <span className="cg-stat">{totals.added > 0 && <span className="cg-add">+{totals.added}</span>}{totals.removed > 0 && <span className="cg-del">−{totals.removed}</span>}</span>}
   <span className="wb-rs-caption">{toCheckpointId ? copy('Checkpoint → next checkpoint (read-only)', '检查点 → 下一个检查点（只读）') : copy('Checkpoint → current file', '检查点 → 当前文件')}</span>
   <span className="grow" />
   <div className="cg-seg" role="group" aria-label={copy('Diff layout', '差异布局')}>
    <button type="button" aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>{copy('Unified', '统一')}</button>
    <button type="button" aria-pressed={mode === 'split'} onClick={() => setMode('split')}>{copy('Split', '并排')}</button>
   </div>
   <button type="button" className="cg-ghost cg-icon cg-sm" title={copy('Refresh', '刷新')} aria-label={copy('Refresh', '刷新')} onClick={() => void load()}><WbIcon name="refresh"/></button>
  </div>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  <div className="wb-rs-files">
   {listed.map(file => {
    const open = expanded.has(file.path);
    const counts = file.binary ? null : file.added === undefined && file.removed === undefined ? null : {added:file.added ?? 0, removed:file.removed ?? 0};
    return <section key={file.path} className={`cg-hair wb-rs-file${open ? '' : ' closed'}`} data-review-file={file.path}>
     <div className="cg-hair-head wb-rs-head">
      <button type="button" className="cg-ghost cg-icon cg-sm" aria-expanded={open} aria-label={open ? copy('Collapse file', '收起文件') : copy('Expand file', '展开文件')} onClick={() => setExpanded(current => { const next = new Set(current); if(next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })}>
       <Icon name={open ? 'chevD' : 'chevR'} />
      </button>
      <Icon name="file" />
      <b>{file.path.slice(file.path.lastIndexOf('/') + 1)}</b>
      <span className="wb-rs-dir">{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''}</span>
      {counts && (counts.added > 0 || counts.removed > 0) && <span className="cg-stat">{counts.added > 0 && <span className="cg-add">+{counts.added}</span>}{counts.removed > 0 && <span className="cg-del">−{counts.removed}</span>}</span>}
      <span className="wb-rs-head-actions">
       {onOpenFile && <button type="button" className="cg-ghost cg-icon cg-sm" title={copy('Open file', '打开文件')} aria-label={copy('Open file', '打开文件')} onClick={() => onOpenFile(file.path)}><Icon name="popout" /></button>}
      </span>
     </div>
     {open && <ReviewFilePane projectId={projectId} worktreePath={worktreePath} path={file.path} sessionId={sessionId} checkpointId={checkpointId} toCheckpointId={toCheckpointId} editorId={`${editorId}:${file.path}`} zh={zh} onOpenFile={onOpenFile} comments={comments} worktreeSessionIds={worktreeSessionIds} navigationDisabled={navigationDisabled} unified={mode === 'unified'}/>}
    </section>;
   })}
  </div>
 </section>;
}
