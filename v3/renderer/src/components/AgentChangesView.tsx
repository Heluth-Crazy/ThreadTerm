import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WbIcon } from '../workbench/icons';
import type { ReviewCheckpoint, ReviewFile, ReviewState, Session } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { AgentIcon, Icon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import { Select } from './ui/Select';
import { relativeTime } from './CodeEditor';
import { workbenchError } from '../workbench/errors';
import { baseName, FILES_CHANGED_EVENT, notifyFilesChanged, parentPath, type WorkbenchActions } from '../workbench/types';

const kindLabel = (checkpoint:ReviewCheckpoint, zh:boolean) => ({
 turn:zh ? '对话回合' : 'Turn',
 launch:zh ? '终端启动' : 'Terminal launch',
 manual:zh ? '手动检查点' : 'Manual checkpoint',
 baseline:zh ? '标记为已审查' : 'Marked reviewed',
}[checkpoint.kind]);

function FileRows({files, zh, onOpen, onRevert}:{files:ReviewFile[];zh:boolean;onOpen:(path:string)=>void;onRevert?:(file:ReviewFile)=>void}) {
 if(!files.length) return <p className="wb-empty">{zh ? '没有文件更改。' : 'No file changes.'}</p>;
 return <div role="list">{files.map(file => <div key={file.path} role="listitem" className={`wb-change-row tone-${file.status === 'A' ? 'added' : file.status === 'D' ? 'deleted' : 'modified'}`}>
  <button type="button" className="wb-change-open" title={file.path} onClick={() => onOpen(file.path)}><Icon name="file"/><span className="wb-name">{baseName(file.path)}</span><span className="wb-dir">{parentPath(file.path)}</span></button>
  {onRevert && <span className="wb-row-actions"><button type="button" className="icon-btn" title={zh ? '还原到检查点' : 'Revert to checkpoint'} aria-label={zh ? '还原到检查点' : 'Revert to checkpoint'} onClick={() => onRevert(file)}><WbIcon name="undo"/></button></span>}
  <span className="wb-deco">{file.status}</span>
 </div>)}</div>;
}

export function AgentChangesView({sessions, activeSessionId, actions, zh, visible, toolbarHost}:{sessions:Session[];activeSessionId?:string;actions:WorkbenchActions;zh:boolean;visible:boolean;toolbarHost?:HTMLElement|null}) {
 const [sessionId, setSessionId] = useState(activeSessionId ?? sessions[0]?.id);
 const [state, setState] = useState<ReviewState>();
 const [latest, setLatest] = useState<ReviewFile[]>();
 const [turns, setTurns] = useState<Record<string,ReviewFile[]|'loading'>>({});
 const [open, setOpen] = useState<Set<string>>(new Set());
 const [issue, setIssue] = useState<string>();
 const [busy, setBusy] = useState(false);
 const [confirm, setConfirm] = useState<{checkpoint:ReviewCheckpoint;files:ReviewFile[];expected:Record<string,string|null>}>();
 const generation = useRef(0);
 const text = (en:string, cn:string) => zh ? cn : en;
 useEffect(() => { if(activeSessionId && sessions.some(session => session.id === activeSessionId)) setSessionId(activeSessionId); }, [activeSessionId]);
 useEffect(() => { if(!sessionId || !sessions.some(session => session.id === sessionId)) setSessionId(sessions[0]?.id); }, [sessions]);
 const checkpoints = state?.checkpoints ?? [];
 const newest = checkpoints.find(checkpoint => checkpoint.status === 'ready');
 const load = useCallback(async () => {
  if(!sessionId) return;
  const ticket = ++generation.current;
  try {
   const value = await request('review.list', {sessionId});
   if(ticket !== generation.current) return;
   setState(value); setIssue(undefined);
   const head = value.checkpoints.find(checkpoint => checkpoint.status === 'ready');
   if(value.available && head) {
    const changes = await request('review.changes', {sessionId, from:head.id});
    if(ticket === generation.current) setLatest(changes.files);
   } else setLatest(undefined);
  } catch(error) { if(ticket === generation.current) { setIssue(workbenchError(error, zh)); setState(undefined); setLatest(undefined); } }
 }, [sessionId]);
 useEffect(() => { setTurns({}); setOpen(new Set()); setState(undefined); setLatest(undefined); void load(); }, [sessionId]);
 // Agents edit files outside ThreadTerm's control; refresh while the view is visible.
 useEffect(() => {
  if(!visible) return;
  void load();
  const timer = setInterval(() => { if(document.visibilityState === 'visible') void load(); }, 5000);
  const changed = () => void load();
  addEventListener(FILES_CHANGED_EVENT, changed);
  return () => { clearInterval(timer); removeEventListener(FILES_CHANGED_EVENT, changed); };
 }, [visible, load]);
 const toggleTurn = async (checkpoint:ReviewCheckpoint, next?:ReviewCheckpoint) => {
  const id = checkpoint.id;
  setOpen(current => { const value = new Set(current); if(value.has(id)) value.delete(id); else value.add(id); return value; });
  if(turns[id] || checkpoint.status !== 'ready' || !sessionId) return;
  setTurns(current => ({...current, [id]:'loading'}));
  try {
   const value = await request('review.changes', {sessionId, from:id, ...(next ? {to:next.id} : {})});
   setTurns(current => ({...current, [id]:value.files}));
  } catch(error) { setIssue(workbenchError(error, zh)); setTurns(current => { const value = {...current}; delete value[id]; return value; }); }
 };
 const checkpointNow = async (kind:'manual'|'baseline') => {
  if(!sessionId) return;
  setBusy(true);
  try { await request('review.checkpoint', {sessionId, kind, operationId:operationId()}); setTurns({}); await load(); }
  catch(error) { setIssue(workbenchError(error, zh)); }
  finally { setBusy(false); }
 };
 const revert = async () => {
  if(!confirm || !sessionId) return;
  setBusy(true);
  try {
   await request('review.revert', {sessionId, checkpointId:confirm.checkpoint.id, paths:confirm.files.map(file => file.path), expectedFingerprints:confirm.expected, operationId:operationId()});
   // The view's own FILES_CHANGED listener reloads this list; the shared Git status hears it too.
   setConfirm(undefined); setTurns({}); notifyFilesChanged();
  } catch(error) { setIssue(workbenchError(error, zh)); setConfirm(undefined); }
  finally { setBusy(false); }
 };
 // Fingerprints are captured when the dialog opens: anything that changes while it is
 // shown makes the runtime refuse the revert instead of overwriting newer work.
 const beginRevert = async (checkpoint:ReviewCheckpoint, files:ReviewFile[]) => {
  if(!sessionId) return;
  const dirty = actions.dirtyPaths().filter(path => files.some(file => file.path === path));
  if(dirty.length) { setIssue(text(`Save or close unsaved editors first: ${dirty.join(', ')}`, `请先保存或关闭未保存的编辑器：${dirty.join('、')}`)); return; }
  setBusy(true);
  try {
   const expected:Record<string,string|null> = {};
   for(const file of files) {
    const current = await request('review.diff', {sessionId, from:checkpoint.id, path:file.path});
    expected[file.path] = current.exists ? current.fingerprint ?? null : null;
   }
   setConfirm({checkpoint, files, expected});
  } catch(error) { setIssue(workbenchError(error, zh)); }
  finally { setBusy(false); }
 };
 const session = sessions.find(candidate => candidate.id === sessionId);
 const openReview = (checkpoint:ReviewCheckpoint, path:string, next?:ReviewCheckpoint) => {
  if(sessionId) actions.openReview?.({sessionId, checkpointId:checkpoint.id, ...(next ? {toCheckpointId:next.id} : {}), path});
 };
 const toolbar = toolbarHost ? createPortal(<button type="button" className="icon-btn" title={text('Refresh', '刷新')} aria-label={text('Refresh', '刷新')} disabled={!sessionId} onClick={() => void load()}><WbIcon name="refresh"/></button>, toolbarHost) : null;
 if(!sessions.length) return <div className="wb-review"><div className="wb-empty-state"><Icon name="spark"/><strong>{text('No sessions in this workspace', '此工作区没有会话')}</strong><p>{text('Start an agent session to review what it changes.', '启动 Agent 会话后即可审查其改动。')}</p></div></div>;
 return <div className="wb-review">
  {toolbar}
  {sessions.length > 1 && <Select className="wb-session-select" value={sessionId ?? ''} aria-label={text('Session', '会话')} onChange={event => setSessionId(event.target.value)}>
   {sessions.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
  </Select>}
  {session && sessions.length === 1 && <div className="wb-review-session"><AgentIcon provider={session.provider}/><span>{session.title}</span></div>}
  {issue && <p className="wb-issue" role="alert">{issue}<button type="button" className="icon-btn" aria-label={text('Dismiss', '关闭提示')} onClick={() => setIssue(undefined)}><Icon name="close"/></button></p>}
  {state && !state.available && <div className="wb-empty-state"><Icon name="spark"/><strong>{text('Change review is unavailable', '无法审查改动')}</strong>
   <p>{state.reason === 'git_unavailable' ? text('Checkpoints need a Git repository. Files and search still work.', '检查点需要 Git 仓库；文件和搜索功能仍可使用。') : text('This session is not attached to a project folder.', '此会话未关联项目目录。')}</p></div>}
  {state?.available && <>
   <div className="wb-review-head">
    <div className="wb-review-title">
     <span className="wb-section-label">{newest ? text('Since latest checkpoint', '最新检查点以来') : text('No checkpoint yet', '暂无检查点')}</span>
     {newest && <span className="wb-time">{kindLabel(newest, zh)} · {relativeTime(newest.createdAt, zh)}</span>}
    </div>
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void checkpointNow('manual')} title={text('Snapshot the working tree now', '立即为工作区拍快照')}><WbIcon name="checkpoint"/>{text('Checkpoint', '检查点')}</button>
   </div>
   <p className="wb-hint">{text('Any edit in this worktree since then counts, whether from this agent, another session or you.', '包含此后此工作树中的所有编辑，可能来自此 Agent、其他会话或你自己。')}</p>
   {newest && latest && <>
    <FileRows files={latest} zh={zh} onOpen={path => openReview(newest, path)} onRevert={file => void beginRevert(newest, [file])}/>
    {latest.length > 0 && <div className="wb-review-actions">
     <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void beginRevert(newest, latest)}>{text('Revert all…', '全部还原…')}</button>
     <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void checkpointNow('baseline')}>{text('Mark reviewed', '标记为已审查')}</button>
    </div>}
   </>}
   {!newest && <p className="wb-empty">{text('Checkpoints are captured before each chat turn and when an agent terminal starts.', '每次发送对话前、以及 Agent 终端启动时都会自动创建检查点。')}</p>}
   {checkpoints.length > 0 && <div className="wb-checkpoints">
    <div className="wb-section-label">{text('Checkpoints', '检查点')}</div>
    {checkpoints.map((checkpoint, index) => {
     // The next newer ready checkpoint closes this turn's window; the newest compares to now.
     const next = checkpoints.slice(0, index).reverse().find(candidate => candidate.status === 'ready');
     const files = turns[checkpoint.id], expanded = open.has(checkpoint.id);
     return <div key={checkpoint.id} className={`wb-checkpoint${checkpoint.status === 'failed' ? ' failed' : ''}`}>
      <button type="button" className="wb-checkpoint-head" aria-expanded={expanded} disabled={checkpoint.status !== 'ready'} onClick={() => void toggleTurn(checkpoint, next)} title={checkpoint.label}>
       <span className={`wb-chevron${expanded ? ' open' : ''}`} aria-hidden="true">{checkpoint.status === 'ready' && <Icon name="chevR"/>}</span>
       <span className="wb-checkpoint-kind">{kindLabel(checkpoint, zh)}</span>
       <span className="wb-name">{checkpoint.label ?? ''}</span>
       <span className="wb-time">{relativeTime(checkpoint.createdAt, zh)}</span>
      </button>
      {checkpoint.status === 'failed' && <p className="wb-muted">{text('Snapshot failed: ', '快照失败：')}{checkpoint.error}</p>}
      {checkpoint.skipped.length > 0 && <p className="wb-muted">{text(`${checkpoint.skipped.length} large file(s) were not captured.`, `${checkpoint.skipped.length} 个大文件未被记录。`)}</p>}
      {expanded && (files === 'loading' ? <p className="wb-summary">{text('Loading…', '正在读取…')}</p> : files && <FileRows files={files} zh={zh} onOpen={path => openReview(checkpoint, path, next)}/>)}
     </div>;
    })}
   </div>}
  </>}
  {confirm && <SurfaceDialog size="sm" icon="trash" title={confirm.files.length > 1 ? text(`Revert ${confirm.files.length} files?`, `还原 ${confirm.files.length} 个文件？`) : text('Revert file?', '还原文件？')}
   subtitle={confirm.files.map(file => file.path).join(', ')} onClose={() => { if(!busy) setConfirm(undefined); }}
   footer={<><button type="button" className="btn" disabled={busy} onClick={() => setConfirm(undefined)}>{text('Cancel', '取消')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revert()}>{text('Revert', '还原')}</button></>}>
   <p>{text('Files return to their content at the checkpoint. Files created since then move to the Recycle Bin; deleted files are restored. A file that changes again before you confirm is left untouched.', '文件将恢复为检查点时的内容；之后新建的文件移到回收站，被删除的文件会恢复。确认前若文件再次变化，将不会被覆盖。')}</p>
  </SurfaceDialog>}
 </div>;
}
