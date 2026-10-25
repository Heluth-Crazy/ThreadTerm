import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WbIcon } from '../workbench/icons';
import type { AgentReview, AgentReviewScope, ProviderCapability, ReviewCheckpoint, ReviewFile, ReviewState, Session } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { AgentIcon, Icon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import { Select } from './ui/Select';
import { relativeTime } from './CodeEditor';
import { workbenchError } from '../workbench/errors';
import { baseName, FILES_CHANGED_EVENT, notifyFilesChanged, parentPath, type WorkbenchActions } from '../workbench/types';
import { agentReviewError, defaultReviewAgent } from '../agentReview';
import { createRefreshQueue } from '../workbench/refreshQueue';
import { eventTouchesWorktree } from '../workbench/refreshTriggers';
import { AgentReviewSection } from './AgentReview';

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
 const [reviews, setReviews] = useState<AgentReview[]>([]);
 const [reviewDialog, setReviewDialog] = useState(false);
 const [reviewAgent, setReviewAgent] = useState('');
 const [reviewScope, setReviewScope] = useState<'turns'|'session'|'uncommitted'>('session');
 const [providers, setProviders] = useState<ProviderCapability[]>([]);
 const generation = useRef(0);
 const reviewGeneration = useRef(0), reviewSessionId = useRef(sessionId), visibleRef = useRef(visible);
 const reviewerIds = useRef<Set<string>>(new Set());
 // The session list changes on every status tick; keep it out of the effect's dependencies.
 const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
 const [anchorRevision, setAnchorRevision] = useState(0);
 visibleRef.current = visible;
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
 const loadAgentReviews = useCallback(async () => {
  if(!visible || !sessionId) return;
  const ticket = ++reviewGeneration.current, requested = sessionId;
  try {
   const value = await request('agentReview.list', {sessionId});
   if(ticket !== reviewGeneration.current || !visibleRef.current || reviewSessionId.current !== requested) return;
   reviewerIds.current = new Set(value.map(review => review.reviewerSessionId));
   setReviews(value);
  } catch(error) { if(ticket === reviewGeneration.current && visibleRef.current && reviewSessionId.current === requested) setIssue(workbenchError(error, zh)); }
 }, [sessionId, visible, zh]);
 useEffect(() => { reviewSessionId.current=sessionId; reviewGeneration.current++; reviewerIds.current=new Set(); setReviews([]); setTurns({}); setOpen(new Set()); setState(undefined); setLatest(undefined); void load(); }, [sessionId]);
 // The reviewer's rows are event driven. The existing file-refresh timer never calls agentReview.list.
 useEffect(() => {
  if(!visible) return;
  const queue = createRefreshQueue(load);
  // The worktree of this session: only its own sessions' turns say an agent may have changed files.
  const target = sessionsRef.current.find(candidate => candidate.id === sessionId);
  const projectId = target?.projectId ?? '', worktreePath = target?.worktreePath;
  const ids = new Set(sessionsRef.current.filter(candidate => candidate.projectId === projectId && (candidate.worktreePath ?? '') === (worktreePath ?? '')).map(candidate => candidate.id));
  void queue.request(); void loadAgentReviews();
  const changed = () => { setAnchorRevision(value=>value+1); void queue.request(); };
  const shown = () => { if(document.visibilityState === 'visible') void queue.request(); };
  addEventListener(FILES_CHANGED_EVENT, changed); addEventListener('visibilitychange', shown);
  const unsubscribe = subscribeEvents(event => {
   const data = event.data as {kind?:unknown;sessionId?:unknown}|undefined;
   if(event.event === 'state.changed' && data?.kind === 'agentReview' && data.sessionId === sessionId) void loadAgentReviews();
   if((event.event === 'session.status' || event.event === 'session.activity') && reviewerIds.current.has(String(data?.sessionId ?? ''))) void loadAgentReviews();
   if(eventTouchesWorktree(event, {projectId, worktreePath}, ids)) void queue.request();
  });
  return () => { queue.stop(); removeEventListener(FILES_CHANGED_EVENT, changed); removeEventListener('visibilitychange', shown); unsubscribe(); };
 }, [visible, load, loadAgentReviews, sessionId]);
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
 const ready = checkpoints.filter(checkpoint => checkpoint.status === 'ready');
 const selectedCheckpoint = checkpoints.find(checkpoint => open.has(checkpoint.id) && checkpoint.status === 'ready');
 const canReview = Boolean(session && (ready.length || state?.available));
 const openAgentReview = async () => {
  if(!session) return;
  setBusy(true);
  try {
   const available = await request('provider.list', {});
   setProviders(available);
   setReviewAgent(defaultReviewAgent(available, session.provider) ?? '');
   setReviewScope(selectedCheckpoint ? 'turns' : ready.length ? 'session' : 'uncommitted');
   setReviewDialog(true);
  } catch(error) { setIssue(workbenchError(error, zh)); }
  finally { setBusy(false); }
 };
 const startAgentReview = async () => {
  if(!session || !reviewAgent || (reviewScope !== 'uncommitted' && !ready.length)) return;
  const selectedIndex = selectedCheckpoint ? checkpoints.indexOf(selectedCheckpoint) : -1;
  const next = selectedIndex > 0 ? checkpoints.slice(0, selectedIndex).reverse().find(checkpoint => checkpoint.status === 'ready') : undefined;
  const scope:AgentReviewScope = reviewScope === 'uncommitted' ? {kind:'uncommitted'} : {kind:'checkpoints', from:reviewScope === 'turns' && selectedCheckpoint ? selectedCheckpoint.id : ready.at(-1)?.id ?? ready[0].id, ...(reviewScope === 'turns' && next ? {to:next.id} : {})};
  setBusy(true);
  try { await request('agentReview.start', {sessionId:session.id, agent:reviewAgent, scope, operationId:operationId()}); setReviewDialog(false); await loadAgentReviews(); }
  catch(error) { setIssue(agentReviewError(error, zh)); }
  finally { setBusy(false); }
 };
 const openReview = (checkpoint:ReviewCheckpoint, path:string, next?:ReviewCheckpoint) => {
  if(sessionId) actions.openReview?.({sessionId, checkpointId:checkpoint.id, ...(next ? {toCheckpointId:next.id} : {}), path});
 };
 const toolbar = toolbarHost ? createPortal(<><button type="button" className="icon-btn" data-testid="agent-review-start" title={text('Review with agent', '请智能体审查')} aria-label={text('Review with agent', '请智能体审查')} disabled={!canReview || busy} onClick={() => void openAgentReview()}><Icon name="spark"/></button><button type="button" className="icon-btn" title={text('Refresh', '刷新')} aria-label={text('Refresh', '刷新')} disabled={!sessionId} onClick={() => void load()}><WbIcon name="refresh"/></button></>, toolbarHost) : null;
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
   {session && <AgentReviewSection reviews={reviews} session={session} root={state.worktreePath} zh={zh} scopeLabels={Object.fromEntries(checkpoints.map(checkpoint => [checkpoint.id, checkpoint.label ?? kindLabel(checkpoint, zh)]))} anchorRevision={anchorRevision} onChanged={() => void loadAgentReviews()} onOpenReviewer={actions.openSession}/>}
  </>}
  {confirm && <SurfaceDialog size="sm" icon="trash" title={confirm.files.length > 1 ? text(`Revert ${confirm.files.length} files?`, `还原 ${confirm.files.length} 个文件？`) : text('Revert file?', '还原文件？')}
   subtitle={confirm.files.map(file => file.path).join(', ')} onClose={() => { if(!busy) setConfirm(undefined); }}
   footer={<><button type="button" className="btn" disabled={busy} onClick={() => setConfirm(undefined)}>{text('Cancel', '取消')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revert()}>{text('Revert', '还原')}</button></>}>
   <p>{text('Files return to their content at the checkpoint. Files created since then move to the Recycle Bin; deleted files are restored. A file that changes again before you confirm is left untouched.', '文件将恢复为检查点时的内容；之后新建的文件移到回收站，被删除的文件会恢复。确认前若文件再次变化，将不会被覆盖。')}</p>
  </SurfaceDialog>}
  {reviewDialog && <SurfaceDialog title={text('Review with agent', '请智能体审查')} icon="spark" size="sm" className="agent-review-start-dialog" onClose={() => { if(!busy) setReviewDialog(false); }} footer={<><button type="button" className="btn" disabled={busy} onClick={() => setReviewDialog(false)}>{text('Cancel', '取消')}</button><button type="button" className="btn btn-primary" disabled={busy || !reviewAgent} onClick={() => void startAgentReview()}>{text('Start review', '开始审查')}</button></>}><div className="agent-review-dialog" data-testid="agent-review-dialog"><label>{text('Reviewer agent', '审查智能体')}<Select value={reviewAgent} onChange={event => setReviewAgent(event.target.value)}>{providers.filter(provider => provider.installed && provider.chat).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></label><fieldset><legend>{text('What to review', '审查范围')}</legend>{selectedCheckpoint && <label><input type="radio" name="agent-review-scope" checked={reviewScope === 'turns'} onChange={() => setReviewScope('turns')}/><span>{text('Selected turn', '选中的回合')}<small>{text('Only the changes of the expanded checkpoint.', '仅审查展开的检查点中的改动。')}</small></span></label>}{ready.length > 0 && <label><input type="radio" name="agent-review-scope" checked={reviewScope === 'session'} onChange={() => setReviewScope('session')}/><span>{text('Whole session', '整个会话')}<small>{text('Everything changed since the first checkpoint.', '自第一个检查点以来的全部改动。')}</small></span></label>}{state?.available && <label><input type="radio" name="agent-review-scope" checked={reviewScope === 'uncommitted'} onChange={() => setReviewScope('uncommitted')}/><span>{text('Uncommitted changes', '未提交的改动')}<small>{text('The worktree against its last commit, new files included.', '工作树相对最近一次提交的改动，包括新文件。')}</small></span></label>}</fieldset><p className="agent-review-dialog-note">{text('The reviewer gets a snapshot of these changes and is asked not to edit files.', '审查智能体会收到这些改动的快照，并被要求不要编辑文件。')}</p>{issue&&<p className="wb-issue" role="alert">{issue}</p>}</div></SurfaceDialog>}
 </div>;
}
