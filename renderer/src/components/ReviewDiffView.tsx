import { useEffect, useRef, useState } from 'react';
import type { ReviewDiff } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { Icon } from './PrototypeIcon';
import { MergeEditor, type MergeEditorHandle } from './MergeEditor';
import { SurfaceDialog } from './SurfaceDialog';
import { workbenchError } from '../workbench/errors';
import { registerDirtyEditor } from '../dirtyEditors';
import { notifyFilesChanged } from '../workbench/types';
import { WbIcon } from '../workbench/icons';
import '../workbench/workbench.css';

/** Checkpoint → current file (editable, hunk revert + fenced save) or checkpoint → next checkpoint (read-only). */
export function ReviewDiffView({projectId, worktreePath, path, sessionId, checkpointId, toCheckpointId, editorId, zh, onOpenFile}:{
 projectId:string;worktreePath?:string;path:string;sessionId:string;checkpointId:string;toCheckpointId?:string;editorId:string;zh:boolean;onOpenFile?:(path:string)=>void;
}) {
 const [diff, setDiff] = useState<ReviewDiff>();
 const [text, setText] = useState('');
 const [issue, setIssue] = useState<string>();
 const [busy, setBusy] = useState(false);
 const [confirm, setConfirm] = useState(false);
 const [chunks, setChunks] = useState(0);
 const [closePrompt, setClosePrompt] = useState(false);
 const closeResolver = useRef<((value:boolean) => void)|undefined>(undefined);
 const editor = useRef<MergeEditorHandle>(null);
 const current = useRef({diff, text}); current.current = {diff, text};
 const live = !toCheckpointId;
 const editable = live && !!diff?.exists && !diff.binary;
 const dirty = editable && !!diff && text !== diff.newText;
 const copy = (en:string, cn:string) => zh ? cn : en;
 const load = async () => {
  try {
   const value = await request('review.diff', {sessionId, from:checkpointId, ...(toCheckpointId ? {to:toCheckpointId} : {}), path});
   setDiff(value); setText(value.newText); setIssue(undefined);
  } catch(error) { setIssue(workbenchError(error, zh)); }
 };
 useEffect(() => { void load(); }, [sessionId, checkpointId, toCheckpointId, path]);
 // Unsaved review edits take part in the same close/leave confirmation as file editors.
 useEffect(() => registerDirtyEditor(editorId, () => {
  const {diff: shown, text: value} = current.current;
  if(!shown || value === shown.newText) return Promise.resolve(true);
  if(closeResolver.current) return Promise.resolve(false);
  return new Promise<boolean>(resolve => { closeResolver.current = resolve; setClosePrompt(true); });
 }, {projectId, worktreePath, isDirty:() => Boolean(current.current.diff && current.current.text !== current.current.diff.newText), path:() => path}), [editorId, projectId, worktreePath, path]);
 const save = async () => {
  if(!diff?.fingerprint || !dirty || busy) return false;
  setBusy(true);
  try {
   await request('filesystem.write', {projectId, ...(worktreePath ? {worktreePath} : {}), path, content:text, expectedFingerprint:diff.fingerprint, operationId:operationId()});
   notifyFilesChanged();
   await load();
   return true;
  } catch(error) { setIssue(workbenchError(error, zh)); return false; }
  finally { setBusy(false); }
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
   await load();
  } catch(error) { setIssue(workbenchError(error, zh)); }
  finally { setBusy(false); }
 };
 return <section className="tt-diff-shell wb-review-diff">
  <div className="file-bar">
   <Icon name="spark"/>
   <span className="path" title={path}>{path}</span>
   <span className="dim">{live ? copy('Checkpoint → current file', '检查点 → 当前文件') : copy('Checkpoint → next checkpoint (read-only)', '检查点 → 下一个检查点（只读）')}</span>
   <span className="grow"/>
   {editable && chunks > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => editor.current?.revertHunk()} title={copy('Put the cursor in a change first', '请先将光标放在某处更改中')}>{copy('Revert hunk', '还原当前块')}</button>}
   {editable && <button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => void save()}>{copy('Save', '保存')}</button>}
   {live && diff && <button type="button" className="btn btn-sm" disabled={busy || dirty} onClick={() => setConfirm(true)}>{copy('Revert file…', '还原文件…')}</button>}
   {onOpenFile && diff?.exists && <button type="button" className="btn btn-sm" onClick={() => onOpenFile(path)}>{copy('Open file', '打开文件')}</button>}
   <button type="button" className="icon-btn" title={copy('Refresh', '刷新')} aria-label={copy('Refresh', '刷新')} disabled={busy || dirty} onClick={() => void load()}><WbIcon name="refresh"/></button>
  </div>
  {issue && <p className="wb-issue" role="alert">{issue}</p>}
  {diff?.binary ? <p className="tt-editor-state">{copy('Binary file — no text diff.', '二进制文件，无法显示文本对比。')}</p>
   : diff ? <>
    {!diff.exists && live && <p className="wb-notice">{copy('This file was deleted after the checkpoint.', '此文件在检查点之后被删除。')}</p>}
    {!diff.oldText && diff.exists && <p className="wb-notice">{copy('This file was created after the checkpoint.', '此文件在检查点之后创建。')}</p>}
    {diff.exists && diff.oldText === diff.newText && !dirty && <p className="wb-notice">{copy('No differences: the file matches the checkpoint.', '没有差异：文件与检查点一致。')}</p>}
    <MergeEditor ref={editor} path={path} oldText={diff.oldText} newText={editable ? text : diff.newText} readOnly={!editable} onChange={setText} onSave={() => void save()} onChunks={setChunks}/>
   </> : !issue && <p className="tt-editor-state">{copy('Loading…', '正在读取…')}</p>}
  {closePrompt && <SurfaceDialog size="sm" icon="file" title={copy('Save changes to this file?', '保存此文件的更改？')} subtitle={path} onClose={() => void settleClose('cancel')}
   footer={<><button type="button" className="btn" onClick={() => void settleClose('cancel')}>{copy('Cancel', '取消')}</button><button type="button" className="btn" onClick={() => void settleClose('discard')}>{copy('Discard', '放弃更改')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void settleClose('save')}>{copy('Save', '保存')}</button></>}>
   <p>{copy('Your edits in this review are not saved yet.', '此审查中的修改尚未保存。')}</p>
  </SurfaceDialog>}
  {confirm && <SurfaceDialog size="sm" icon="trash" title={copy('Revert to checkpoint?', '还原到检查点？')} subtitle={path} onClose={() => { if(!busy) setConfirm(false); }}
   footer={<><button type="button" className="btn" onClick={() => setConfirm(false)}>{copy('Cancel', '取消')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revertFile()}>{copy('Revert', '还原')}</button></>}>
   <p>{!diff?.oldText && diff?.exists ? copy('The file did not exist at the checkpoint and will be moved to the Recycle Bin.', '检查点时此文件不存在，将移到回收站。') : copy('The file returns to its content at the checkpoint. If it changes before you confirm, nothing is overwritten.', '文件将恢复为检查点时的内容；确认前若文件发生变化，将不会被覆盖。')}</p>
  </SurfaceDialog>}
 </section>;
}
