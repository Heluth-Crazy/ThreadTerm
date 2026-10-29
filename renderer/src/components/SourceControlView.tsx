import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WbIcon } from '../workbench/icons';
import type { GitBranches, GitChange, GitPushPreview, GitSelectedCommitResult, GitStashApply, GitStashEntry, GitStashFile } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { Icon } from './PrototypeIcon';
import { CatalogPopover } from './CatalogActions';
import { SurfaceDialog } from './SurfaceDialog';
import { changeGroups, decorationFor, type ChangeGroup } from '../workbench/gitDecorations';
import { gitOperationState, mergeResultMessage, pullDivergence } from '../workbench/gitOperation';
import { pushDestination, pushRejectionAction, requiresForcePushBranchConfirmation } from '../workbench/gitPushPreview';
import { stashDropInterference, stashInterferenceError, workbenchError } from '../workbench/errors';
import { selectedCommitUnsupportedText } from '../workbench/selectedCommitSupport';
import { absolutePath, baseName, parentPath, scopeParams, type GitState, type WorkbenchActions, type WorkbenchScope } from '../workbench/types';
import { ContextSendAction, sendContextToAgent } from './ContextSendAction';
import { changedFileContext } from './GitContextActions';
import { showContextMenu } from './ContextMenu';
import { sourceControlMenuItems } from '../contextMenuSurfaceItems';
import { useConflictStates } from './useConflictStates';
import { conflictStageReason } from '../workbench/conflictStage';
import { useConflictStageGuard } from './useConflictStageGuard';
import { clearSelectedChanges, selectedChanges, selectedCommitKey, setGroupSelection, toggleSelectedChange, type SelectedCommitGroup } from '../workbench/selectedCommitSelection';
import { branchRowState, checkoutLocalPaths, sortBranches, worktreeName } from '../workbench/branchMenu';
import { stashConflictNotice } from '../workbench/stashNotice';
import { changeFocusAfterToggle, changeFocusKey, isKeyboardEditableTarget, orderedChangeRows, rovingChangeTarget, type ChangeFocus } from '../workbench/scmKeyboard';
import type { GitWorkbenchCommand } from '../workbench/gitKeyboardCommand';
import { relativeTime } from './CodeEditor';

type Confirm =
 | {kind:'discard';paths:string[];untracked:number;token:number;fingerprints?:Record<string,string|null>;indexFingerprints?:Record<string,string|null>;snapshotError?:string}
 | {kind:'abort-merge'}
 | {kind:'amend';subject:string}
 | {kind:'delete-branch';branch:string;force:boolean}
 | {kind:'checkout-overwrite';branch:string;paths:string[]}
 | {kind:'stash-drop';entry:GitStashEntry};
function GroupSelectionToggle({checked,mixed,label,onChange}:{checked:boolean;mixed:boolean;label:string;onChange:()=>void}) {
 const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(input.current)input.current.indeterminate=mixed;},[mixed]);
 return <input ref={input} type="checkbox" className="wb-change-select" aria-label={label} checked={checked} onChange={onChange}/>;
}

export function SourceControlView({scope, actions, git, zh, compact = false, toolbarHost, command, onCommandHandled, visible=true}:{scope:WorkbenchScope;actions:WorkbenchActions;git:GitState;zh:boolean;compact?:boolean;toolbarHost?:HTMLElement|null;command?:GitWorkbenchCommand;onCommandHandled?:(key:string)=>void;visible?:boolean}) {
 const [message, setMessage] = useState('');
 const [diverged, setDiverged] = useState<{ahead:number;behind:number;branch:string;upstream:string}>();
 const prefilledMerge=useRef<string|undefined>(undefined);
 const [busy, setBusy] = useState<string>();
 const [issue, setIssue] = useState<ReactNode>();
 const [notice, setNotice] = useState<ReactNode>();
 const [committedWarning, setCommittedWarning] = useState<ReactNode>();
 const [pushPreview, setPushPreview] = useState<GitPushPreview>();
 const [pushDialog, setPushDialog] = useState(false);
 const [forcePushConfirmation, setForcePushConfirmation] = useState(false);
 const [forcePushBranch, setForcePushBranch] = useState('');
 const [pushFailure, setPushFailure] = useState<'force'|'refresh'|'review'>();
 const [collapsed, setCollapsed] = useState<Set<ChangeGroup>>(new Set());
 const [confirm, setConfirm] = useState<Confirm>();
 const [commitMenu, setCommitMenu] = useState<HTMLElement>();
 const [branchMenu, setBranchMenu] = useState<HTMLElement>();
 const [branches, setBranches] = useState<GitBranches>();
 const [branchQuery, setBranchQuery] = useState('');
 const [creating, setCreating] = useState(false);
 const [branchBase, setBranchBase] = useState('HEAD');
 const [stashes, setStashes] = useState<GitStashEntry[]>();
 const [stashFiles, setStashFiles] = useState<Record<string,GitStashFile[]>>({});
 const [stashLoading, setStashLoading] = useState<string>();
 const [stashDialog, setStashDialog] = useState(false);
 const [stashMessage, setStashMessage] = useState('');
 const [stashUntracked, setStashUntracked] = useState(true);
 const [stashesCollapsed, setStashesCollapsed] = useState(true);
 const [selection, setSelection] = useState<Set<string>>(() => new Set());
 const messageRef = useRef<HTMLTextAreaElement>(null);
 const branchButton=useRef<HTMLButtonElement>(null),consumedCommand=useRef<string|undefined>(undefined);
 const changesRef=useRef<HTMLDivElement>(null);
 const [focusedRow,setFocusedRow]=useState<ChangeFocus>();
 const rowButtons=useRef(new Map<string,HTMLButtonElement>()),listOwnsFocus=useRef(false);
 const scopeEpoch=useRef(0);
 const discardEpoch=useRef(0);
 const renderedScope=useRef(`${scope.projectId}\u0000${scope.worktreePath ?? ''}\u0000${scope.rootPath}`);
 const text = (en:string, cn:string) => zh ? cn : en;
 const params = scopeParams(scope);
 const status = git.status;
 const rootKey=scope.rootPath;
 const scopeKey=`${scope.projectId}\u0000${scope.worktreePath ?? ''}\u0000${scope.rootPath}`;
 if(renderedScope.current!==scopeKey) { renderedScope.current=scopeKey; scopeEpoch.current++; }
 const operation=status && gitOperationState(status,zh);
 useEffect(() => {
  if(!status) return;
  if(status.operation?.kind!=='merge') { prefilledMerge.current=undefined; return; }
  const key=`${scopeKey}\0${status.operation.head ?? ''}`;
  if(prefilledMerge.current===key) return;
  prefilledMerge.current=key;
  setMessage(current=>current || status.operation?.message || '');
 }, [scopeKey,status?.operation?.kind,status?.operation?.head,status?.operation?.message]);
 const selectedCommit=status?.selectedCommit;
 const selectedCommitReason=selectedCommitUnsupportedText(selectedCommit?.unsupportedReason,zh);
 const groups = useMemo(() => {
  const value:Record<ChangeGroup,GitChange[]> = {conflicts:[], staged:[], changes:[], untracked:[]};
  for(const change of status?.changes ?? []) for(const group of changeGroups(change)) value[group].push(change);
  return value;
 }, [status]);
 const conflictStates = useConflictStates(scope, groups.conflicts.map(change=>change.path), status);
 const keyboardRows=orderedChangeRows(groups,collapsed);
 const tabRow=keyboardRows.find(row=>focusedRow&&changeFocusKey(row)===changeFocusKey(focusedRow)) ?? keyboardRows[0];
 useLayoutEffect(()=>{
  if(listOwnsFocus.current&&tabRow)rowButtons.current.get(changeFocusKey(tabRow))?.focus();
 },[status,collapsed,focusedRow]);
 useEffect(()=>{setFocusedRow(undefined);listOwnsFocus.current=false;},[scopeKey]);
 const stageGuard = useConflictStageGuard(scope, zh);
 const selectedIn = (group:SelectedCommitGroup) => selectedChanges(selection, rootKey, group, groups[group]);
 const selectedStaged=selectedIn('staged');
 const toggleSelection = (group:SelectedCommitGroup, path:string) => setSelection(current => toggleSelectedChange(current,rootKey,group,path));
 const toggleGroupSelection = (group:SelectedCommitGroup) => {
  const items=groups[group], all=items.length>0&&items.every(change=>selection.has(selectedCommitKey(rootKey,group,change.path)));
  setSelection(current=>setGroupSelection(current,rootKey,group,items,!all));
 };
 useEffect(() => { discardEpoch.current++; setDiverged(undefined); setBusy(undefined); setIssue(undefined); setNotice(undefined); setCommittedWarning(undefined); setPushPreview(undefined); setPushDialog(false); setForcePushConfirmation(false); setForcePushBranch(''); setPushFailure(undefined); setConfirm(undefined); setCommitMenu(undefined); setBranchMenu(undefined); setBranches(undefined); setBranchQuery(''); setCreating(false); setStashes(undefined); setStashFiles({}); setStashLoading(undefined); setStashDialog(false); setStashMessage(''); setStashUntracked(true); setStashesCollapsed(true); }, [scope.projectId, scope.worktreePath, scope.rootPath]);
 // Success notices are transient; errors stay until dismissed.
 useEffect(() => { if(!notice) return; const timer = setTimeout(() => setNotice(undefined), 4000); return () => clearTimeout(timer); }, [notice]);

 const run = async <T,>(label:string, action:() => Promise<T>, done?:string|((result:T)=>string|undefined)) => {
  const epoch=scopeEpoch.current; let succeeded=false;
  setBusy(label); setIssue(undefined); setNotice(undefined); setCommittedWarning(undefined);
  try { const result=await action(); succeeded=true; const text=typeof done==='function'?done(result):done; if(epoch===scopeEpoch.current&&text)setNotice(text); }
  catch(error) {
   if(epoch===scopeEpoch.current) {
    const counts=label==='pull' ? pullDivergence(error) : undefined;
    if(counts && status?.upstream) setDiverged({...counts,branch:status.branch ?? 'HEAD',upstream:status.upstream});
    else setIssue(workbenchError(error, zh));
   }
  }
  // Most actions refresh through the runtime's scoped state.changed event.
  // Upstream merge also refreshes explicitly to reveal its operation banner immediately.
  finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
  return succeeded&&epoch===scopeEpoch.current;
 };
 const stagePaths = async (paths:string[]) => {
  const epoch=scopeEpoch.current;
  const expectedFingerprints=await stageGuard.check(paths, groups.conflicts.map(change=>change.path));
  if(!expectedFingerprints || epoch!==scopeEpoch.current) return false;
  await request('git.stage', {...params, paths, ...(Object.keys(expectedFingerprints).length?{expectedFingerprints}:{}), operationId:operationId()});
  return epoch===scopeEpoch.current;
 };
 const stage = async (paths:string[]) => {
  let staged=false;
  await run('stage', async()=>{staged=await stagePaths(paths);});
  return staged;
 };
 const unstage = (paths:string[]) => run('unstage', () => request('git.unstage', {...params, paths, operationId:operationId()}));
 const runSelected = async <T,>(label:string, action:()=>Promise<T>, clear:readonly [SelectedCommitGroup, GitChange[]][], done?:string):Promise<T|undefined> => {
  const epoch=scopeEpoch.current; let result:T|undefined, succeeded=false;
  setBusy(label); setIssue(undefined); setNotice(undefined); setCommittedWarning(undefined);
  try {
   result=await action(); succeeded=true;
   if(epoch===scopeEpoch.current) { setSelection(current=>clear.reduce((next,[group,changes])=>clearSelectedChanges(next,rootKey,group,changes),current)); if(done)setNotice(done); }
  } catch(error) {
   if(epoch===scopeEpoch.current)setIssue(workbenchError(error,zh));
  } finally {
   if(epoch===scopeEpoch.current) setBusy(undefined);
  }
  return succeeded&&epoch===scopeEpoch.current?result:undefined;
 };
 const stageSelected = async (group:Extract<SelectedCommitGroup,'changes'|'untracked'>) => {
  const selected=selectedIn(group); if(!selected.length)return;
  if(await stage(selected.map(change=>change.path))) { setSelection(current=>clearSelectedChanges(current,rootKey,group,selected)); setNotice(text('Selected files staged.','已暂存所选文件。')); }
 };
 const unstageSelected = async () => {
  const selected=selectedStaged; if(!selected.length)return;
  await runSelected('unstage-selected',()=>request('git.unstage',{...params,paths:selected.map(change=>change.path),operationId:operationId()}),[['staged',selected]],text('Selected files unstaged.','已取消暂存所选文件。'));
 };
 const discard = (changes:GitChange[]) => {
  const paths=changes.map(change => change.path), token=++discardEpoch.current, epoch=scopeEpoch.current;
  setConfirm({kind:'discard', paths, untracked:changes.filter(change => change.untracked).length, token});
  void request('git.fingerprints', {...params, paths}).then(snapshot => {
   if(epoch!==scopeEpoch.current || token!==discardEpoch.current) return;
   setConfirm(current => current?.kind === 'discard' && current.token === token ? {...current, fingerprints:snapshot.fingerprints, indexFingerprints:snapshot.indexFingerprints} : current);
  }, error => {
   if(epoch!==scopeEpoch.current || token!==discardEpoch.current) return;
   setConfirm(current => current?.kind === 'discard' && current.token === token ? {...current, snapshotError:workbenchError(error,zh)} : current);
  });
 };
 const openChange = (change:GitChange, group:ChangeGroup) => group === 'conflicts' ? actions.openFile(change.path) : actions.openDiff(change.path, group === 'staged');
 const changeMenu = (change:GitChange, group:ChangeGroup, event:{clientX:number;clientY:number;currentTarget:HTMLElement}) => {
  const staged = group === 'staged';
  showContextMenu({x:event.clientX, y:event.clientY, restoreFocus:event.currentTarget, items:sourceControlMenuItems({zh, staged, conflict:group === 'conflicts', discardable:group === 'changes' || group === 'untracked', busy:Boolean(busy), stageReason:group==='conflicts'?conflictStageReason(conflictStates[change.path],zh):undefined, canSend:Boolean(actions.comments?.attachContext)}).map(item => ({...item, testId:item.id, onSelect:item.id === 'source-control-send-diff' ? async () => actions.comments?.attachContext && sendContextToAgent({host:actions.comments, context:await changedFileContext(params, change.path, staged, zh), zh, sourceRoot:scope.rootPath}) : item.id === 'source-control-unstage' ? () => void unstage([change.path]) : item.id === 'source-control-stage' ? () => void stage([change.path]) : item.id === 'source-control-open-changes' ? () => openChange(change, group) : item.id === 'source-control-copy-path' ? () => navigator.clipboard.writeText(absolutePath(scope.rootPath, change.path)) : item.id === 'source-control-discard' ? () => discard([change]) : undefined}))});
 };
 const onChangeContext = (event:MouseEvent<HTMLDivElement>) => {
  const target = event.target as HTMLElement;
  const element = target.closest<HTMLElement>('[data-change-path][data-change-group]');
  if(!element || !event.currentTarget.contains(element)) return;
  const group = element.dataset.changeGroup as ChangeGroup;
  const change = groups[group]?.find(candidate => candidate.path === element.dataset.changePath);
  if(!change) return;
  event.preventDefault();
  changeMenu(change, group, {clientX:event.clientX, clientY:event.clientY, currentTarget:element});
 };
 const onChangeKey = (event:KeyboardEvent<HTMLDivElement>) => {
  if(isKeyboardEditableTarget(event.target))return;
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-change-path][data-change-group]');
  if(!element || !event.currentTarget.contains(element)) return;
  const group = element.dataset.changeGroup as ChangeGroup, change = groups[group]?.find(candidate => candidate.path === element.dataset.changePath);
  if(!change) return;
  if(event.key==='ContextMenu'||(event.key==='F10'&&event.shiftKey)) {
   event.preventDefault(); const rect=element.getBoundingClientRect();
   changeMenu(change,group,{clientX:rect.left+Math.min(16,rect.width/2),clientY:rect.top+Math.min(16,rect.height/2),currentTarget:event.target as HTMLElement});return;
  }
  if(!(event.target as HTMLElement).matches('.wb-change-open')||event.altKey)return;
  const current={group,path:change.path};
  if(event.key===' '&&(event.ctrlKey||event.metaKey)) {
   if(group!=='conflicts'){event.preventDefault();toggleSelection(group,change.path);}return;
  }
  if(event.ctrlKey||event.metaKey)return;
  const target=rovingChangeTarget(keyboardRows,current,event.key);
  if(target&&!event.shiftKey){event.preventDefault();setFocusedRow(target);rowButtons.current.get(changeFocusKey(target))?.focus();return;}
  if(event.key==='Enter'){event.preventDefault();if(event.shiftKey)actions.openFile(change.path);else openChange(change,group);return;}
  if(event.shiftKey)return;
  if(event.key==='Delete'&&(group==='changes'||group==='untracked')){event.preventDefault();if(!busy)discard([change]);return;}
  if(event.key===' ') {
   event.preventDefault();if(busy||event.repeat)return;
   const next=changeFocusAfterToggle(keyboardRows,current),epoch=scopeEpoch.current;
   void (async()=>{
    const ok=group==='staged'?await unstage([change.path]):await stage([change.path]);
    if(!ok||epoch!==scopeEpoch.current)return;
    setFocusedRow(next);
   })();
  }
 };
 const commit = async (mode:'commit'|'push'|'amend') => {
  const trimmed = message.trim();
  if(!trimmed) { messageRef.current?.focus(); setIssue(text('Write a commit message first.', '请先填写提交说明。')); return; }
  if(mode === 'amend') {
   const epoch=scopeEpoch.current;
   try {
    const log = await request('git.log', {...params, limit:1});
    if(epoch===scopeEpoch.current)setConfirm({kind:'amend', subject:log.commits[0]?.subject ?? ''});
   } catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error, zh)); }
   return;
  }
  const ok = await run('commit', () => request('git.commit', {...params, message:trimmed, operationId:operationId()}), text('Committed.', '已提交。'));
  if(!ok) return;
  setMessage('');
  if(mode === 'push') await openPushPreview();
 };
 const commitSelected = async () => {
  const trimmed=message.trim();
  if(!trimmed) { messageRef.current?.focus(); setIssue(text('Write a commit message first.', '请先填写提交说明。')); return; }
  if(!selectedStaged.length) return;
  if(!selectedCommit?.supported) { setIssue(selectedCommitReason); return; }
  const selected=[...selectedStaged];
  const result=await runSelected<GitSelectedCommitResult>('commit-selected',()=>request('git.commit.selected',{...params,message:trimmed,selected:selected.map(change=>({path:change.path,indexStatus:change.indexStatus,...(change.originalPath?{originalPath:change.originalPath}:{})})),expectedHead:selectedCommit.head,expectedIndexFingerprint:selectedCommit.indexFingerprint,operationId:operationId()}),[['staged',selected]],text('Selected staged files committed.','已提交所选暂存文件。'));
  if(!result) return;
  setMessage('');
  if(result.postCommitError||result.cleanupError) setCommittedWarning([result.postCommitError&&text(`Committed, but the post-commit hook reported: ${result.postCommitError}`, `已提交，但提交后钩子报告：${result.postCommitError}`),result.cleanupError&&text('Committed, but cleanup after publication reported an error.', '已提交，但发布后的清理报告错误。')].filter(Boolean).join(' '));
 };
 const plainPush = () => run('push', () => request('git.push', {...params, ...(status?.upstream ? {} : {setUpstream:true}), operationId:operationId()}), status?.upstream ? text('Pushed.', '已推送。') : text('Branch published.', '分支已发布。'));
 const openPushPreview = async (allowPlainFallback=true) => {
  const epoch=scopeEpoch.current;
  if(!allowPlainFallback) { setPushDialog(false); setPushPreview(undefined); setForcePushConfirmation(false); setForcePushBranch(''); }
  setBusy('push-preview'); setIssue(undefined); setNotice(undefined); setPushFailure(undefined);
  try {
   const preview=await request('git.push.preview',params);
   if(epoch===scopeEpoch.current) { setPushPreview(preview); setPushDialog(true); }
  } catch(error) {
   if(epoch!==scopeEpoch.current) return;
   if(allowPlainFallback&&/push_preview_unavailable/.test(error instanceof Error ? error.message : String(error))) { setBusy(undefined); await plainPush(); return; }
   setIssue(workbenchError(error,zh));
  } finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
 };
 const refreshPushPreview = async () => {
  const epoch=scopeEpoch.current;
  setBusy('push-preview'); setIssue(undefined); setPushFailure(undefined);
  try { await request('git.fetch',{...params,remote:pushPreview?.remote,operationId:operationId()}); const preview=await request('git.push.preview',params); if(epoch===scopeEpoch.current) { setPushPreview(preview); setForcePushConfirmation(false); setForcePushBranch(''); } }
  catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error,zh)); }
  finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
 };
 const pushFromPreview = async (force=false) => {
  const preview=pushPreview, epoch=scopeEpoch.current;
  if(!preview) return;
  if(force&&!preview.remoteOid) { setIssue(text('The remote branch has no lease value. Fetch and review it again before force pushing.','远程分支没有可用的租约值。强制推送前请获取并重新检查。')); return; }
  setBusy(force?'force-push':'push'); setIssue(undefined); setNotice(undefined); setPushFailure(undefined);
  try {
   await request('git.push',{...params,...(force ? {force:'with-lease' as const,expectedRemoteOid:preview.remoteOid!,remote:preview.remote,remoteBranch:preview.remoteBranch,localBranch:preview.localBranch} : {...(preview.setUpstream ? {setUpstream:true} : {})}),operationId:operationId()});
   if(epoch===scopeEpoch.current) { setForcePushConfirmation(false); setPushDialog(false); setNotice(force ? text('Force pushed with a lease.','已使用租约强制推送。') : preview.setUpstream ? text('Branch published.','分支已发布。') : text('Pushed.','已推送。')); }
  } catch(error) {
   if(epoch!==scopeEpoch.current) return;
   const action=pushRejectionAction(error);
   setIssue(workbenchError(error,zh));
   if(action) { setPushFailure(action); if(action==='refresh'||action==='review') { setForcePushConfirmation(false); setForcePushBranch(''); } }
 } finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
 };
 useEffect(()=>{
  if(!pushDialog||forcePushConfirmation) return;
  const confirm=(event:globalThis.KeyboardEvent)=>{
   if(event.key!=='Enter'||event.repeat||busy||event.target instanceof Element&&event.target.closest('button,input,textarea,select')) return;
   event.preventDefault(); void pushFromPreview();
  };
  addEventListener('keydown',confirm);
  return()=>removeEventListener('keydown',confirm);
 },[pushDialog,forcePushConfirmation,busy,pushPreview]);
 useEffect(()=>{
  if(!forcePushConfirmation||!pushPreview) return;
  const confirm=(event:globalThis.KeyboardEvent)=>{
   if(event.key!=='Enter'||event.repeat||busy||!(event.target instanceof HTMLInputElement)||event.target.value!==pushPreview.remoteBranch) return;
   event.preventDefault(); void pushFromPreview(true);
  };
  addEventListener('keydown',confirm);
  return()=>removeEventListener('keydown',confirm);
 },[forcePushConfirmation,pushPreview,busy,forcePushBranch]);
 const mergeUpstream = () => {
  const epoch=scopeEpoch.current;
  return run('merge',async()=>{
   const result=await request('git.merge',{...params,upstream:true,operationId:operationId()});
   if(epoch!==scopeEpoch.current) return;
   const feedback=mergeResultMessage(result,zh);
   if(result.conflicted) setIssue(feedback);
   else setNotice(feedback);
   await git.refresh();
  });
 };
 const loadBranches = async () => { const epoch=scopeEpoch.current; try { const next=await request('git.branches', params); if(epoch===scopeEpoch.current)setBranches(next); } catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error, zh)); } };
 const loadStashes = async () => { const epoch=scopeEpoch.current; try { const result=await request('git.stash.list', params); if(epoch===scopeEpoch.current)setStashes(result.entries); } catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error, zh)); } };
 useEffect(() => { void loadStashes(); }, [scopeKey,status]);
 const showStashFiles = async (entry:GitStashEntry) => {
  if(stashFiles[entry.oid]) { setStashFiles(current => { const next={...current}; delete next[entry.oid]; return next; }); return; }
  const epoch=scopeEpoch.current; setStashLoading(entry.oid);
  try { const result=await request('git.stash.show', {...params,oid:entry.oid}); if(epoch===scopeEpoch.current)setStashFiles(current=>({...current,[entry.oid]:result.files})); }
  catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error,zh)); }
  finally { if(epoch===scopeEpoch.current)setStashLoading(undefined); }
 };
 const interferencePayload = (value:unknown) => {
  const raw=value instanceof Error ? value.message : typeof value==='string' ? value : undefined;
  if(!raw) return stashDropInterference(value);
  for(const marker of ['stash_drop_interfered:','stash_switch_failed:']) {
   const offset=raw.indexOf(marker); if(offset<0) continue;
   try { const parsed=JSON.parse(raw.slice(offset+marker.length).trim()) as {stash?:{interference?:unknown}}; return stashDropInterference(marker==='stash_switch_failed:' ? parsed.stash?.interference : parsed); } catch { return undefined; }
  }
  return undefined;
 };
 const interferenceNotice = (value:unknown):ReactNode|undefined => {
  const interference=interferencePayload(value), summary=stashInterferenceError(interference,zh,false);
  if(!interference||!summary) return undefined;
  const entry=(item:{oid:string;message:string}, suffix?:string) => <span className="wb-interference-entry" title={item.oid}>{item.oid.slice(0,7)} · {item.message}{suffix}</span>;
  return <><span title={interference.oid}>{summary}</span>{interference.restored.length>0&&<span className="wb-interference-list">{text('Restored:', '已恢复：')}{interference.restored.map(item=>entry(item))}</span>}{interference.restoreFailed.length>0&&<span className="wb-interference-list">{text('Could not restore:', '恢复失败：')}{interference.restoreFailed.map(item=>entry(item,` · ${item.error}`))}</span>}</>;
 };
 const stashResultNotice = (result:GitStashApply, entry:GitStashEntry, pop:boolean) => {
  const limitation=text(' Staged changes were restored as unstaged.', ' 已暂存的更改会以未暂存状态恢复。');
  if(!result.applied) return `${text(`The stash (${result.oid}) could not be applied. It was kept, and some files may already have been restored.`, `暂存（${result.oid}）无法应用，已保留；部分文件可能已经恢复。`)}${result.warning ? ` ${workbenchError(result.warning,zh)}` : ''}`;
  if(result.conflicted) { const conflict=stashConflictNotice({oid:result.oid,message:entry.message,zh}); return <>{conflict.before}<span title={conflict.title}>{conflict.label}</span>{conflict.after}</>; }
  return (pop ? result.interference ? text('Stash applied.', '暂存已应用。') : result.dropped ? text('Stash applied and removed.', '暂存已应用并移除。') : text('Stash applied and kept.', '暂存已应用并保留。') : text('Stash applied.', '暂存已应用。')) + limitation;
 };
 const applyStash = async (entry:GitStashEntry, pop:boolean) => {
  const epoch=scopeEpoch.current; setBusy(pop?'stash-pop':'stash-apply'); setIssue(undefined); setNotice(undefined);
  try { const result=await request('git.stash.apply',{...params,oid:entry.oid,pop,operationId:operationId()}); if(epoch===scopeEpoch.current) { setNotice(stashResultNotice(result,entry,pop)); const interference='interference' in result ? interferenceNotice(result.interference) : undefined; if(interference)setCommittedWarning(interference); void loadStashes(); } }
  catch(error) { if(epoch===scopeEpoch.current) { const interference=interferenceNotice(error); setIssue(interference ?? workbenchError(error,zh)); if(interference) void loadStashes(); } }
  finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
 };
 const pushStash = async () => {
  const epoch=scopeEpoch.current; setBusy('stash-push'); setIssue(undefined); setNotice(undefined);
  try { const result=await request('git.stash.push',{...params,...(stashMessage.trim()?{message:stashMessage.trim()}:{}),includeUntracked:stashUntracked,operationId:operationId()}); if(epoch===scopeEpoch.current) { setStashDialog(false); setStashMessage(''); setNotice(text(`Stashed changes (${result.oid}).`, `更改已暂存（${result.oid}）。`)); void loadStashes(); } }
  catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error,zh)); }
  finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
 };
 const openBranches = (anchor:HTMLElement) => { setBranchMenu(anchor); setBranchQuery(''); setCreating(false); setBranchBase('HEAD'); void loadBranches(); };
 const checkout = async (branch:string, create = false, stash = false) => {
  setBranchMenu(undefined);
  const epoch=scopeEpoch.current;
  setBusy('checkout'); setIssue(undefined); setNotice(undefined); setCommittedWarning(undefined);
  try {
   const result=await request('git.checkout', {...params, branch, ...(create ? {create:true,...(branchBase==='HEAD'?{}:{startPoint:branchBase})} : {}), ...(stash?{stash:true}:{}), operationId:operationId()});
   if(epoch===scopeEpoch.current) {
    if(!stash || !result.stash) setNotice(text(`Switched to ${branch}.`, `已切换到 ${branch}。`));
    else if(result.stash.conflicted) { const stashMessage='message' in result.stash&&typeof result.stash.message==='string' ? result.stash.message : undefined, conflict=stashConflictNotice({oid:result.stash.oid,message:stashMessage,branch,zh}); setNotice(<>{conflict.before}<span title={conflict.title}>{conflict.label}</span>{conflict.after}</>); }
    else if(result.stash.applied === false) setNotice(text(`Switched to ${branch}; your changes stay in stash (${result.stash.oid}) because they could not be re-applied.`, `已切换到 ${branch}；由于无法重新应用，你的更改仍保留在暂存中（${result.stash.oid}）。`));
    else setNotice(text(`Switched to ${branch}; your changes were re-applied. Staged changes were restored as unstaged.`, `已切换到 ${branch}；你的更改已重新应用。已暂存的更改会以未暂存状态恢复。`));
    const interference=result.stash ? interferenceNotice(result.stash.interference) : undefined;
    if(interference) setCommittedWarning(interference);
    else if(result.warning) setCommittedWarning(workbenchError(result.warning,zh));
    void loadStashes();
   }
  } catch(error) {
   if(epoch!==scopeEpoch.current)return;
   const raw=error instanceof Error?error.message:String(error);
   const marker=raw.indexOf('checkout_would_overwrite:');
   if(marker>=0) {
    try {
     const paths=JSON.parse(raw.slice(marker+'checkout_would_overwrite:'.length).trim());
     if(Array.isArray(paths)) { setConfirm({kind:'checkout-overwrite',branch,paths:paths.filter((path):path is string=>typeof path==='string')}); return; }
    } catch { /* The mapped error below preserves malformed runtime details. */ }
   }
   const interference=interferenceNotice(error); setIssue(interference ?? workbenchError(error,zh));
   if(interference) void loadStashes();
  } finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
 };
 const confirmAction = async () => {
  if(!confirm) return;
  const current = confirm, epoch=scopeEpoch.current;
  if(current.kind === 'discard') {
   if(!current.fingerprints || !current.indexFingerprints || current.snapshotError) return;
   setConfirm(undefined);
   const dirty = actions.dirtyPaths().filter(path => current.paths.includes(path));
   if(dirty.length) { setIssue(text(`Save or close unsaved editors first: ${dirty.join(', ')}`, `请先保存或关闭未保存的编辑器：${dirty.join('、')}`)); return; }
   setBusy('discard'); setIssue(undefined); setNotice(undefined); setCommittedWarning(undefined);
   try {
    await request('git.discard', {...params, paths:current.paths, expectedFingerprints:current.fingerprints, expectedIndexFingerprints:current.indexFingerprints, operationId:operationId()});
    if(epoch===scopeEpoch.current)setNotice(text('Changes discarded.', '更改已丢弃。'));
   } catch(error) {
    if(epoch===scopeEpoch.current) {
     if(/(?:file_conflict|index_conflict|discard_incomplete)/.test(String(error))) void git.refresh();
     setIssue(workbenchError(error,zh,'discard'));
    }
   } finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
  } else if(current.kind === 'abort-merge') {
   setConfirm(undefined);
   await run('abort-merge',()=>request('git.merge.abort',{...params,operationId:operationId()}),text('Merge aborted.','合并已中止。'));
  } else if(current.kind === 'amend') {
   setConfirm(undefined);
   const ok = await run('commit', () => request('git.commit', {...params, message:message.trim(), amend:true, operationId:operationId()}), text('Last commit amended.', '已修改上次提交。'));
   if(ok) setMessage('');
  } else if(current.kind === 'checkout-overwrite') {
   setConfirm(undefined);
   void checkout(current.branch,false,true);
  } else if(current.kind === 'stash-drop') {
   setBusy('stash-drop'); setIssue(undefined);
   try { await request('git.stash.drop',{...params,oid:current.entry.oid,operationId:operationId()}); if(epoch===scopeEpoch.current) { setConfirm(undefined); setNotice(text('Stash removed.', '暂存已移除。')); void loadStashes(); } }
   catch(error) { if(epoch===scopeEpoch.current) { setConfirm(undefined); const interference=interferenceNotice(error); setIssue(interference ?? workbenchError(error,zh)); if(interference) void loadStashes(); } }
   finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
  } else {
   setBusy('branch'); setIssue(undefined);
   try {
    await request('git.branch.delete', {...params, branch:current.branch, ...(current.force ? {force:true} : {}), operationId:operationId()});
    if(epoch===scopeEpoch.current) { setConfirm(undefined); setNotice(text(`Deleted ${current.branch}.`, `已删除 ${current.branch}。`)); void loadBranches(); }
   } catch(error) {
    if(epoch===scopeEpoch.current) {
     if(!current.force && /branch_not_merged/.test(String(error))) setConfirm({...current, force:true});
     else { setConfirm(undefined); setIssue(workbenchError(error, zh)); }
    }
   } finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
  }
 };

 useEffect(()=>{
  if(!command||consumedCommand.current===command.key)return;
  if(command.scopeKey!==undefined&&command.scopeKey!==scopeKey){consumedCommand.current=command.key;onCommandHandled?.(command.key);return;}
  if(!visible||!status||git.loading||busy)return;
  consumedCommand.current=command.key;
  onCommandHandled?.(command.key);
  if(command.action==='commit')messageRef.current?.focus();
  else if(command.action==='switch-branch'){if(branchButton.current)openBranches(branchButton.current);}
  else if(command.action==='stash')setStashDialog(true);
  else if(command.action==='fetch')void run('fetch',()=>request('git.fetch',{...params,operationId:operationId()}),text('Fetched.','已获取。'));
  else if(command.action==='pull'&&status.upstream)void run('pull',()=>request('git.pull',{...params,operationId:operationId()}),text('Pulled.','已拉取。'));
  else if(command.action==='push'&&status.branch)void openPushPreview();
 },[command,scopeKey,status,git.loading,busy,visible]);

 const tools = <>
  {actions.openHistory && <button type="button" className="icon-btn" title={text('History', '提交历史')} aria-label={text('History', '提交历史')} onClick={() => actions.openHistory?.()}><Icon name="clock"/></button>}
  <button type="button" className="icon-btn" title={text('Stash changes…', '暂存更改…')} aria-label={text('Stash changes…', '暂存更改…')} disabled={!!busy} onClick={() => setStashDialog(true)}><Icon name="archive"/></button>
  <button type="button" className="icon-btn" title={text('Refresh', '刷新')} aria-label={text('Refresh', '刷新')} onClick={() => void git.refresh()}><WbIcon name="refresh"/></button>
 </>;
 const toolbar = toolbarHost ? createPortal(tools, toolbarHost) : null;
 if(git.error && !status) return <div className="wb-scm">{toolbar}<div className="wb-empty-state"><Icon name="branch"/><strong>{text('No Git repository', '没有 Git 仓库')}</strong><p>{git.error}</p><p className="wb-muted">{text('Files, search and editing still work in this folder.', '此文件夹仍可使用文件、搜索和编辑功能。')}</p></div></div>;
 if(!status) return <div className="wb-scm">{toolbar}<p className="wb-summary">{text('Loading…', '正在读取…')}</p></div>;

 const row = (change:GitChange, group:ChangeGroup) => {
  const decoration = decorationFor(change, group);
  const staged = group === 'staged';
  const selectionGroup=group === 'conflicts' ? undefined : group as SelectedCommitGroup;
  const selected=selectionGroup!==undefined&&selection.has(selectedCommitKey(rootKey,selectionGroup,change.path));
  return <div key={`${group}:${change.path}`} className={`wb-change-row tone-${decoration.tone}`} role="listitem" data-change-path={change.path} data-change-group={group}>
   {selectionGroup && <input tabIndex={-1} type="checkbox" className="wb-change-select" aria-keyshortcuts="Control+Space Meta+Space" aria-label={text(`Select ${change.path} in ${group}`, `在${group}中选择 ${change.path}`)} checked={selected} onClick={event=>event.stopPropagation()} onChange={()=>toggleSelection(selectionGroup,change.path)}/>}
   <button type="button" className="wb-change-open" tabIndex={tabRow&&changeFocusKey(tabRow)===changeFocusKey({group,path:change.path})?0:-1} ref={button=>{const key=changeFocusKey({group,path:change.path});if(button)rowButtons.current.set(key,button);else rowButtons.current.delete(key);}} onFocus={()=>{listOwnsFocus.current=true;setFocusedRow(current=>current?.group===group&&current.path===change.path?current:{group,path:change.path});}} aria-keyshortcuts="Enter Shift+Enter Space Delete Control+Space Meta+Space" title={`${change.originalPath ? `${change.originalPath} → ${change.path}` : change.path} · ${text('Open diff (Enter) · Open file (Shift+Enter)','打开差异（Enter）· 打开文件（Shift+Enter）')}`}
    onClick={() => openChange(change, group)}>
    <Icon name="file"/><span className="wb-name">{baseName(change.path)}</span><span className="wb-dir">{parentPath(change.path)}</span>
   </button>
   <span className="wb-row-actions" ref={element=>{element?.querySelectorAll('button').forEach(button=>{button.tabIndex=-1;});}}>
    <button tabIndex={-1} type="button" className="icon-btn" aria-keyshortcuts="Shift+Enter" title={text('Open file (Shift+Enter)', '打开文件（Shift+Enter）')} aria-label={text('Open file', '打开文件')} onClick={() => actions.openFile(change.path)}><Icon name="file"/></button>
    {actions.comments?.attachContext && <ContextSendAction host={actions.comments} item={() => changedFileContext(params, change.path, staged, zh)} sourceRoot={scope.rootPath} zh={zh} label={text('Send diff to agent', '将差异发送给 Agent')} iconOnly testId="source-control-send-diff"/>}
    {(group === 'changes' || group === 'untracked') && <button tabIndex={-1} type="button" className="icon-btn" aria-keyshortcuts="Delete" title={text('Discard changes (Delete)', '丢弃更改（Delete）')} aria-label={text('Discard changes', '丢弃更改')} disabled={!!busy} onClick={() => discard([change])}><WbIcon name="undo"/></button>}
    {staged
     ? <button tabIndex={-1} type="button" className="icon-btn" aria-keyshortcuts="Space" title={text('Unstage (Space)', '取消暂存（Space）')} aria-label={text('Unstage', '取消暂存')} disabled={!!busy} onClick={() => void unstage([change.path])}><WbIcon name="minus"/></button>
     : <button tabIndex={-1} type="button" className="icon-btn" aria-keyshortcuts="Space" title={group === 'conflicts' ? conflictStageReason(conflictStates[change.path],zh) ?? text('Mark resolved (stage) (Space)', '标记已解决（暂存）（Space）') : text('Stage (Space)', '暂存（Space）')} aria-label={group==='conflicts'?text('Mark resolved (stage)','标记已解决（暂存）'):text('Stage', '暂存')} disabled={!!busy || (group==='conflicts' && !!conflictStageReason(conflictStates[change.path],zh))} onClick={() => void stage([change.path])}><Icon name="plus"/></button>}
   </span>
   <span className="wb-deco" aria-label={decoration.tone}>{decoration.letter}</span>
  </div>;
 };
 const section = (group:ChangeGroup, title:string, actionsNode:ReactNode) => {
  const items = groups[group];
  if(!items.length) return null;
  const closed = collapsed.has(group);
  const selectionGroup=group === 'conflicts' ? undefined : group as SelectedCommitGroup;
  const selectedCount=selectionGroup?selectedIn(selectionGroup).length:0;
  return <section className="wb-change-group" aria-label={title}>
   <div className="wb-group-head">
    {selectionGroup && <GroupSelectionToggle checked={selectedCount===items.length} mixed={selectedCount>0&&selectedCount<items.length} label={text(`Select all ${title}`, `全选${title}`)} onChange={()=>toggleGroupSelection(selectionGroup)}/>}
    <button type="button" className="wb-group-toggle" aria-expanded={!closed} onClick={() => setCollapsed(current => { const next = new Set(current); if(next.has(group)) next.delete(group); else next.add(group); return next; })}>
     <span className={`wb-chevron${closed ? '' : ' open'}`} aria-hidden="true"><Icon name="chevR"/></span>{title}<span className="wb-count">{items.length}</span>
    </button>
    <span className="wb-row-actions">{actionsNode}</span>
   </div>
   {!closed && <div role="list">{items.map(change => row(change, group))}</div>}
  </section>;
 };
 const nothing = !(status.changes.length);
 const stashAge = (createdAt:number) => {
  const seconds=Math.max(0,Math.floor(Date.now()/1000-createdAt));
  const [amount,unit]=seconds<60?[seconds,text('second','秒')]:seconds<3600?[Math.floor(seconds/60),text('minute','分钟')]:seconds<86400?[Math.floor(seconds/3600),text('hour','小时')]:[Math.floor(seconds/86400),text('day','天')];
  return zh ? `${amount} ${unit}前` : `${amount} ${unit}${amount===1?'':'s'} ago`;
 };
 const selectedForStage=selectedIn('changes').length+selectedIn('untracked').length;
 const commitSelectedActive=selectedStaged.length>0;
 const sortedBranches=sortBranches(branches?.branches ?? []);
 const filteredBranches = sortedBranches.filter(branch => branch.name.toLowerCase().includes(branchQuery.trim().toLowerCase()));
 const branchBases=Array.from(new Set(['HEAD', ...sortedBranches.filter(branch=>!branch.remote).flatMap(branch=>[branch.name,...(branch.upstream?[branch.upstream]:[])])]));
 const localChangePaths=checkoutLocalPaths(status);
 return <div className={`wb-scm${compact ? ' compact' : ''}`}>
  {toolbar}
  {operation && <div className="wb-operation" role="status" data-testid="git-operation-banner">
   <p>{operation.label}</p>
   {status.operation?.kind==='merge' && <div className="wb-operation-actions">
    <button type="button" className="btn" disabled={!!busy} onClick={()=>setConfirm({kind:'abort-merge'})}>{text('Abort merge','中止合并')}</button>
    <button type="button" className="btn btn-primary" disabled={!!busy || !operation.canConclude} onClick={()=>void commit('commit')}>{text('Conclude merge','完成合并')}</button>
   </div>}
  </div>}
  <div className="wb-scm-bar">
   <button ref={branchButton} type="button" className="wb-branch-chip" title={status.upstream ? text(`Switch branch · tracking ${status.upstream}`, `切换分支 · 跟踪 ${status.upstream}`) : text('Switch branch · no upstream yet', '切换分支 · 尚无上游')} onClick={event => openBranches(event.currentTarget)}>
    <Icon name="branch"/><span className="wb-name">{status.branch ?? text('Detached HEAD', '分离的 HEAD')}</span><Icon name="chevron" className="wb-chip-caret"/>
   </button>
   <span className="wb-sync-actions">
    {!toolbarHost && tools}
    <button type="button" className="icon-btn" title={text('Fetch', '获取')} aria-label={text('Fetch', '获取')} disabled={!!busy} onClick={() => void run('fetch', () => request('git.fetch', {...params, operationId:operationId()}), text('Fetched.', '已获取。'))}><WbIcon name="fetch"/></button>
    <button type="button" className="icon-btn wb-count-btn" title={status.upstream ? text(`Pull (fast-forward only) · ${status.behind} behind`, `拉取（仅快进）· 落后 ${status.behind}`) : text('Pull · no upstream yet', '拉取 · 尚无上游')} aria-label={text('Pull', '拉取')} disabled={!!busy || !status.upstream} onClick={() => void run('pull', () => request('git.pull', {...params, operationId:operationId()}), text('Pulled.', '已拉取。'))}><WbIcon name="pull"/>{status.upstream && status.behind > 0 && <span className="wb-btn-count">{status.behind}</span>}</button>
     <button type="button" className="icon-btn wb-count-btn" title={status.upstream ? text(`Push · ${status.ahead} ahead`, `推送 · 领先 ${status.ahead}`) : text('Publish branch', '发布分支')} aria-label={status.upstream ? text('Push', '推送') : text('Publish branch', '发布分支')} disabled={!!busy || !status.branch} onClick={() => void openPushPreview()}><WbIcon name="push"/>{status.upstream && status.ahead > 0 && <span className="wb-btn-count">{status.ahead}</span>}</button>
   </span>
  </div>
  <div className="wb-commit">
   <textarea ref={messageRef} value={message} onChange={event => setMessage(event.target.value)} rows={2} placeholder={text('Message (Ctrl+Enter to commit)', '提交说明（Ctrl+Enter 提交）')} aria-label={text('Commit message', '提交说明')}
    onKeyDown={event => { if(event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if(!busy) void (commitSelectedActive ? commitSelected() : commit('commit')); } }}/>
   <div className="wb-commit-actions">
   <button type="button" className="btn btn-primary wb-commit-main" disabled={!!busy || (commitSelectedActive ? !selectedCommit?.supported : !groups.staged.length)} title={commitSelectedActive&&!selectedCommit?.supported ? `${selectedCommitReason}${selectedCommit?.unsupportedReason ? ` (${selectedCommit.unsupportedReason})` : ''}` : !commitSelectedActive&&!groups.staged.length ? text('Stage changes first', '请先暂存更改') : undefined} onClick={() => void (commitSelectedActive ? commitSelected() : commit('commit'))}>
     {busy === 'commit-selected' ? text('Committing selected…', '正在提交所选文件…') : busy === 'commit' ? text('Committing all…', '正在提交全部…') : commitSelectedActive ? text('Commit selected', '提交所选') : text('Commit all staged', '提交全部暂存')}
    </button>
    <button type="button" className="btn wb-commit-more" aria-label={text('More commit actions', '更多提交操作')} disabled={!!busy} onClick={event => setCommitMenu(event.currentTarget)}><Icon name="chevron"/></button>
   </div>
   {commitSelectedActive&&!selectedCommit?.supported && <p className="wb-selected-summary" title={selectedCommit?.unsupportedReason}>{selectedCommitReason}</p>}
   {(commitSelectedActive||selectedForStage>0) && <p className="wb-selected-summary" aria-live="polite">{commitSelectedActive ? text(`${selectedStaged.length} staged file(s) selected for this commit.`, `已选择 ${selectedStaged.length} 个暂存文件用于此次提交。`) : ''}{commitSelectedActive&&selectedForStage>0?' ':''}{selectedForStage>0 ? text(`${selectedForStage} change(s) selected to stage; they are not included until staged.`, `已选择 ${selectedForStage} 个更改待暂存；暂存前不会包含在提交中。`) : ''}</p>}
  </div>
  {busy && busy !== 'commit' && <p className="wb-summary" aria-live="polite">{text('Working…', '正在执行…')}</p>}
  {issue && <p className="wb-issue" role="alert">{issue}<button type="button" className="icon-btn" aria-label={text('Dismiss', '关闭提示')} onClick={() => setIssue(undefined)}><Icon name="close"/></button></p>}
  {notice && !issue && <p className="wb-notice" aria-live="polite">{notice}</p>}
  {committedWarning && <p className="wb-notice wb-commit-warning" role="status">{committedWarning}</p>}
  <div ref={changesRef} tabIndex={-1} className="wb-changes" onBlur={event=>{listOwnsFocus.current=event.relatedTarget instanceof Element&&event.relatedTarget.matches('.wb-change-open')&&event.currentTarget.contains(event.relatedTarget);}} onContextMenu={onChangeContext} onKeyDown={onChangeKey}>
   {section('conflicts', text('Merge conflicts', '合并冲突'), null)}
   {section('staged', text('Staged changes', '已暂存的更改'), <>
    <button type="button" className="icon-btn" title={text('Unstage selected files (whole file)', '取消暂存所选文件（整个文件）')} aria-label={text('Unstage selected files (whole file)', '取消暂存所选文件（整个文件）')} disabled={!!busy || !selectedStaged.length} onClick={() => void unstageSelected()}><WbIcon name="minus"/></button>
    <button type="button" className="icon-btn" title={text('Unstage all', '全部取消暂存')} aria-label={text('Unstage all', '全部取消暂存')} disabled={!!busy} onClick={() => void unstage(groups.staged.map(change => change.path))}><WbIcon name="minus"/></button>
   </>)}
   {section('changes', text('Changes', '更改'), <>
    <button type="button" className="icon-btn" title={text('Discard all changes', '丢弃全部更改')} aria-label={text('Discard all changes', '丢弃全部更改')} disabled={!!busy} onClick={() => discard(groups.changes)}><WbIcon name="undo"/></button>
    <button type="button" className="icon-btn" title={text('Stage selected files', '暂存所选文件')} aria-label={text('Stage selected files', '暂存所选文件')} disabled={!!busy || !selectedIn('changes').length} onClick={() => void stageSelected('changes')}><Icon name="plus"/></button>
    <button type="button" className="icon-btn" title={text('Stage all changes', '暂存全部更改')} aria-label={text('Stage all changes', '暂存全部更改')} disabled={!!busy} onClick={() => void stage(groups.changes.map(change => change.path))}><Icon name="plus"/></button>
   </>)}
   {section('untracked', text('Untracked', '未跟踪'), <>
    <button type="button" className="icon-btn" title={text('Stage selected files', '暂存所选文件')} aria-label={text('Stage selected files', '暂存所选文件')} disabled={!!busy || !selectedIn('untracked').length} onClick={() => void stageSelected('untracked')}><Icon name="plus"/></button>
    <button type="button" className="icon-btn" title={text('Stage all untracked', '暂存全部未跟踪文件')} aria-label={text('Stage all untracked', '暂存全部未跟踪文件')} disabled={!!busy} onClick={() => void stage(groups.untracked.map(change => change.path))}><Icon name="plus"/></button>
   </>)}
   {!!stashes?.length && <section className="wb-change-group wb-stashes" aria-label={text('Stashes', '暂存')}>
    <div className="wb-group-head"><button type="button" className="wb-group-toggle" aria-expanded={!stashesCollapsed} onClick={()=>setStashesCollapsed(current=>!current)}><span className={`wb-chevron${stashesCollapsed?'':' open'}`} aria-hidden="true"><Icon name="chevR"/></span>{text('Stashes', '暂存')}<span className="wb-count">{stashes.length}</span></button></div>
    {!stashesCollapsed&&<div role="list">{stashes.map(entry=><div key={entry.oid} className="wb-stash-row" role="listitem">
     <div className="wb-stash-summary"><span className="wb-name" title={entry.message}>{entry.message || text('WIP on stash', '暂存中的进行中更改')}</span>{entry.branch&&<span className="wb-stash-branch">{entry.branch}</span>}<span className="wb-time">{stashAge(entry.createdAt)}</span>{entry.untracked&&<span className="wb-stash-untracked">{text('untracked', '未跟踪')}</span>}</div>
     <span className="wb-row-actions"><button type="button" className="icon-btn" aria-label={text(`Show files in ${entry.message}`, `显示 ${entry.message} 中的文件`)} title={text('Show files', '显示文件')} disabled={!!busy||stashLoading===entry.oid} onClick={()=>void showStashFiles(entry)}><Icon name="file"/></button><button type="button" className="icon-btn" aria-label={text(`Apply ${entry.message}`, `应用 ${entry.message}`)} title={text('Apply', '应用')} disabled={!!busy} onClick={()=>void applyStash(entry,false)}><Icon name="check"/></button><button type="button" className="icon-btn" aria-label={text(`Pop ${entry.message}`, `弹出 ${entry.message}`)} title={text('Pop', '弹出')} disabled={!!busy} onClick={()=>void applyStash(entry,true)}><Icon name="export"/></button><button type="button" className="icon-btn" aria-label={text(`Drop ${entry.message}`, `删除 ${entry.message}`)} title={text('Drop', '删除')} disabled={!!busy} onClick={()=>setConfirm({kind:'stash-drop',entry})}><Icon name="trash"/></button></span>
     {stashLoading===entry.oid&&<p className="wb-stash-files wb-summary" role="status">{text('Loading files…', '正在读取文件…')}</p>}
     {stashFiles[entry.oid]&&<div className="wb-stash-files" role="list">{stashFiles[entry.oid].map(file=><div key={`${file.status}:${file.path}`} className="wb-stash-file" role="listitem"><span className="wb-deco">{file.status}</span><span className="wb-name">{file.path}</span>{file.untracked&&<span className="wb-stash-untracked">{text('untracked', '未跟踪')}</span>}</div>)}</div>}
    </div>)}</div>}
   </section>}
   {nothing && <p className="wb-empty">{text('No changes in this worktree.', '此工作树没有更改。')}</p>}
  </div>
  {commitMenu && <CatalogPopover anchor={commitMenu} label={text('Commit actions', '提交操作')} onClose={() => setCommitMenu(undefined)}>
   <button type="button" role="menuitem" className="menu-item" disabled={!groups.staged.length} onClick={() => { setCommitMenu(undefined); void commit('commit'); }}><Icon name="check"/>{text('Commit all staged', '提交全部暂存')}</button>
   <button type="button" role="menuitem" className="menu-item" disabled={!groups.staged.length} onClick={() => { setCommitMenu(undefined); void commit('push'); }}><Icon name="export"/>{status.upstream ? text('Commit & push', '提交并推送') : text('Commit & publish', '提交并发布')}</button>
   <button type="button" role="menuitem" className="menu-item" onClick={() => { setCommitMenu(undefined); void commit('amend'); }}><Icon name="clock"/>{text('Amend last commit…', '修改上次提交…')}</button>
   </CatalogPopover>}
   {pushDialog&&pushPreview&&!forcePushConfirmation&&<SurfaceDialog size="wide" icon="export" className="git-push-preview-dialog" title={text('Push branch','推送分支')} subtitle={pushDestination(pushPreview,zh)} onClose={()=>{if(!busy||busy==='push-preview')setPushDialog(false);}}
    footer={<><button type="button" className="btn" disabled={!!busy} onClick={()=>setPushDialog(false)}>{text('Cancel','取消')}</button><button type="submit" form="git-push-preview-form" className="btn btn-primary" disabled={!!busy}>{busy==='push'?text('Pushing…','正在推送…'):text('Push','推送')}</button></>}>
    <form id="git-push-preview-form" onSubmit={event=>{event.preventDefault();void pushFromPreview();}}>
     {issue&&<p className="surface-error" role="alert">{issue}</p>}
     <div className="git-push-preview-meta"><span>{pushPreview.lastFetchedAt?text(`Remote info from ${relativeTime(pushPreview.lastFetchedAt,zh)}`,`远程信息更新于 ${relativeTime(pushPreview.lastFetchedAt,zh)}`):text('Remote fetch time is unavailable.','远程获取时间不可用。')}</span><button type="button" className="btn btn-sm" disabled={!!busy} onClick={()=>void refreshPushPreview()}>{busy==='push-preview'?text('Refreshing…','正在刷新…'):text('Fetch and refresh','获取并刷新')}</button></div>
     {pushPreview.behind.count>0&&<div className="surface-error" role="status"><span>{text(`The remote has ${pushPreview.behind.count} commit${pushPreview.behind.count===1?'':'s'} you do not have. A normal push may be rejected.`,`远程分支有 ${pushPreview.behind.count} 个你尚未获取的提交，普通推送可能被拒绝。`)}</span><button type="button" className="btn btn-sm" disabled={!!busy} onClick={()=>{setPushDialog(false);void run('pull',()=>request('git.pull',{...params,operationId:operationId()}),text('Pulled.','已拉取。'));}}>{text('Pull','拉取')}</button></div>}
     {pushFailure==='force'&&<div className="surface-error" role="status"><span>{text('The remote rejected the normal push because it has commits you do not have.','远程分支有你尚未获取的提交，因此拒绝了普通推送。')}</span><span><button type="button" className="btn btn-sm" disabled={!!busy} onClick={()=>{setPushDialog(false);void run('pull',()=>request('git.pull',{...params,operationId:operationId()}),text('Pulled.','已拉取。'));}}>{text('Pull','拉取')}</button><button type="button" className="btn btn-danger" disabled={!!busy||!pushPreview.remoteOid} onClick={()=>{setForcePushBranch('');setForcePushConfirmation(true);}}>{text('Force push…','强制推送…')}</button></span></div>}
     {pushFailure==='refresh'&&<div className="surface-error" role="status"><span>{text('The remote changed since this preview. Fetch and review it again.','远程分支自预览后已变化。请获取并重新检查。')}</span><button type="button" className="btn" disabled={!!busy} onClick={()=>void refreshPushPreview()}>{text('Fetch and review again','获取并重新检查')}</button></div>}
     {pushFailure==='review'&&<div className="surface-error" role="status"><span>{text('The push destination changed since this preview. Review it again.','推送目标自预览后已变化。请重新检查。')}</span><button type="button" className="btn" disabled={!!busy} onClick={()=>void openPushPreview(false)}>{text('Review again','重新检查')}</button></div>}
     {pushPreview.diverged&&pushFailure!=='force'&&<div className="git-push-preview-warning" role="status"><span>{text('This branch has diverged from its remote. Force push replaces remote history.','此分支已与远程分叉。强制推送会替换远程历史。')}</span><button type="button" className="btn btn-danger" disabled={!!busy||!pushPreview.remoteOid} onClick={()=>{setForcePushBranch('');setForcePushConfirmation(true);}}>{text('Force push…','强制推送…')}</button></div>}
     <h3>{text(`Commits to push (${pushPreview.ahead.count})`,`要推送的提交（${pushPreview.ahead.count}）`)}</h3>
     {pushPreview.ahead.commits.length?<div className="git-push-preview-list" role="list" tabIndex={0} data-testid="git-push-preview-commits" aria-label={text('Commits to push','要推送的提交')}>{pushPreview.ahead.commits.map(commit=><button type="button" role="listitem" key={commit.hash} data-testid="git-push-preview-commit" className="wb-commit-row" disabled={!actions.openHistory||(!!busy&&busy!=='push-preview')} onClick={()=>{setPushDialog(false);actions.openHistory?.({commit:commit.hash});}}><span className="wb-commit-text"><span className="wb-commit-line"><span className="wb-commit-subject">{commit.subject||text('(no message)','（无说明）')}</span></span><span className="wb-commit-meta">{commit.author} · {relativeTime(commit.committedAt,zh)} · <code>{commit.hash.slice(0,7)}</code></span></span></button>)}</div>:<p className="wb-empty">{text('No commits need to be pushed.','没有需要推送的提交。')}</p>}
    </form>
   </SurfaceDialog>}
   {forcePushConfirmation&&pushPreview&&<SurfaceDialog size="sm" icon="branch" className="git-push-force-dialog" title={text('Force push with lease?','使用租约强制推送？')} subtitle={text(`Force push will replace ${pushPreview.remote}/${pushPreview.remoteBranch}`,`强制推送将替换 ${pushPreview.remote}/${pushPreview.remoteBranch}`)} onClose={()=>{if(!busy)setForcePushConfirmation(false);}}
    footer={<><button type="button" className="btn" disabled={!!busy} onClick={()=>setForcePushConfirmation(false)}>{text('Cancel','取消')}</button><button type="button" className="btn btn-danger" disabled={!!busy||!pushPreview.remoteOid||(requiresForcePushBranchConfirmation(pushPreview)&&forcePushBranch!==pushPreview.remoteBranch)} onClick={()=>void pushFromPreview(true)}>{busy==='force-push'?text('Force pushing…','正在强制推送…'):text('Force push (with lease)','强制推送（带租约）')}</button></>}>
    {issue&&<p className="surface-error" role="alert">{issue}</p>}
    <p>{text('This uses a lease and fails safely if somebody pushed to this branch after the preview.','此操作使用租约；如果有人在预览后推送到该分支，操作会安全失败。')}</p>
    {pushPreview.behind.commits.length>0&&<><p>{text('Remote commits that will be discarded:','将被丢弃的远程提交：')}</p><div className="git-push-preview-list" role="list" tabIndex={0} data-testid="git-push-preview-discarded-commits" aria-label={text('Remote commits to discard','将丢弃的远程提交')}>{pushPreview.behind.commits.map(commit=><div key={commit.hash} role="listitem" className="wb-commit-row"><span className="wb-commit-text"><span className="wb-commit-subject">{commit.subject||text('(no message)','（无说明）')}</span><span className="wb-commit-meta">{commit.author} · {relativeTime(commit.committedAt,zh)} · <code>{commit.hash.slice(0,7)}</code></span></span></div>)}</div></>}
    {requiresForcePushBranchConfirmation(pushPreview)&&<label className="git-push-confirm-label">{text(`Type ${pushPreview.remoteBranch} to confirm this default-branch force push.`,`输入 ${pushPreview.remoteBranch} 以确认对默认分支的强制推送。`)}<input autoFocus value={forcePushBranch} onChange={event=>setForcePushBranch(event.target.value)} aria-label={text(`Type ${pushPreview.remoteBranch} to confirm`,`输入 ${pushPreview.remoteBranch} 以确认`)}/></label>}
   </SurfaceDialog>}
   {branchMenu && <CatalogPopover anchor={branchMenu} align="start" label={text('Branches', '分支')} onClose={() => setBranchMenu(undefined)}>
   <div className="wb-branch-menu">
    <input autoFocus className="wb-branch-filter" value={branchQuery} onChange={event => setBranchQuery(event.target.value)} placeholder={creating ? text('New branch name', '新分支名称') : text('Filter or create a branch', '筛选或新建分支')} aria-label={text('Branch name', '分支名称')}
     onKeyDown={event => { if(event.key === 'Enter' && creating && branchQuery.trim()) { event.preventDefault(); void checkout(branchQuery.trim(), true); } }}/>
    {creating && <label className="wb-branch-base">{text('Base branch', '基准分支')}<select value={branchBase} onChange={event=>setBranchBase(event.target.value)} aria-label={text('Base branch', '基准分支')}>{branchBases.map(base=><option key={base} value={base}>{base==='HEAD'?text('Current HEAD','当前 HEAD'):base}</option>)}</select></label>}
    <button type="button" role="menuitem" className="menu-item" disabled={!!busy} onClick={() => { if(creating && branchQuery.trim()) void checkout(branchQuery.trim(), true); else setCreating(true); }}><Icon name="plus"/>{creating && branchQuery.trim() ? text(`Create "${branchQuery.trim()}" from ${branchBase==='HEAD'?'current HEAD':branchBase}`, `从${branchBase==='HEAD'?'当前 HEAD':branchBase}新建“${branchQuery.trim()}”`) : text('New branch from…', '从…新建分支')}</button>
    {!branches && <p className="wb-summary">{text('Loading branches…', '正在读取分支…')}</p>}
    {branches && !creating && <>
     {(['local', 'remote'] as const).map(kind => {
      const list = filteredBranches.filter(branch => branch.remote === (kind === 'remote'));
      if(!list.length) return null;
      return <div key={kind}>
       <div className="menu-label">{kind === 'local' ? text('Local branches', '本地分支') : text('Remote branches', '远程分支')}</div>
       {list.map(branch => { const state=branchRowState(branch,Boolean(actions.openWorktree)); const worktree=branch.worktreePath; return <div key={`${kind}:${branch.name}`} className="wb-branch-item">
        <button type="button" role="menuitem" className="menu-item" disabled={state==='current'||state==='worktree-unavailable'||state==='worktree-missing'||!!busy} onClick={() => { if(state==='open-worktree'&&worktree) { setBranchMenu(undefined); actions.openWorktree?.(worktree); } else void checkout(branch.name); }} title={(state==='worktree-unavailable'||state==='worktree-missing')&&worktree ? worktree : branch.lastCommit?.subject}>
         <Icon name={branch.current ? 'check' : 'branch'}/><span className="wb-name" title={branch.name}>{branch.name}</span>
         {worktree ? <span className="wb-sync" title={worktree}>{state==='open-worktree' ? text(`in ${worktreeName(worktree)} · Open worktree…`, `在 ${worktreeName(worktree)} 中 · 打开工作树…`) : state==='worktree-missing' ? text(`in ${worktreeName(worktree)} · Worktree folder is missing — run git worktree prune`, `在 ${worktreeName(worktree)} 中 · 工作树文件夹缺失，请运行 git worktree prune`) : text(`in ${worktreeName(worktree)}`, `在 ${worktreeName(worktree)} 中`)}</span> : (branch.ahead || branch.behind) ? <span className="wb-sync">↑{branch.ahead ?? 0} ↓{branch.behind ?? 0}</span> : branch.gone ? <span className="wb-sync muted">{text('gone', '已删除')}</span> : null}
        </button>
        {kind === 'local' && state==='checkout' && <button type="button" className="icon-btn" title={text('Delete branch', '删除分支')} aria-label={text(`Delete ${branch.name}`, `删除 ${branch.name}`)} onClick={() => { setBranchMenu(undefined); setConfirm({kind:'delete-branch', branch:branch.name, force:false}); }}><Icon name="trash"/></button>}
       </div>; })}
      </div>;
     })}
    </>}
   </div>
  </CatalogPopover>}
  {stageGuard.dialog}
  {diverged && <SurfaceDialog size="sm" icon="branch" title={text('Branches have diverged','分支已分叉')} onClose={()=>{if(!busy)setDiverged(undefined);}}
   footer={<><button type="button" className="btn" disabled={!!busy} onClick={()=>setDiverged(undefined)}>{text('Cancel','取消')}</button><button type="button" className="btn btn-primary" disabled={!!busy} onClick={()=>{setDiverged(undefined);void mergeUpstream();}}>{text(`Merge ${diverged.upstream} into ${diverged.branch}`,`将 ${diverged.upstream} 合并到 ${diverged.branch}`)}</button></>}>
   <p>{text(`${diverged.branch} and ${diverged.upstream} have diverged (${diverged.ahead} ahead, ${diverged.behind} behind)`,`${diverged.branch} 与 ${diverged.upstream} 已分叉（领先 ${diverged.ahead}，落后 ${diverged.behind}）`)}</p>
  </SurfaceDialog>}
  {stashDialog && <SurfaceDialog size="sm" icon="archive" title={text('Stash changes', '暂存更改')} subtitle={text('Save your current changes without committing them.', '保存当前更改但不提交。')} onClose={()=>{if(!busy)setStashDialog(false);}}
   footer={<><button type="button" className="btn" disabled={!!busy} onClick={()=>setStashDialog(false)}>{text('Cancel','取消')}</button><button type="button" className="btn btn-primary" disabled={!!busy} onClick={()=>void pushStash()}>{busy==='stash-push'?text('Stashing…','正在暂存…'):text('Stash changes','暂存更改')}</button></>}>
   <div className="wb-stash-dialog"><label>{text('Message (optional)', '说明（可选）')}<input autoFocus maxLength={200} value={stashMessage} onChange={event=>setStashMessage(event.target.value.replace(/[\r\n\t\u0000-\u001f]/g,''))} aria-label={text('Stash message', '暂存说明')}/></label><label className="wb-stash-checkbox"><input type="checkbox" checked={stashUntracked} onChange={event=>setStashUntracked(event.target.checked)}/>{text('Include untracked files', '包括未跟踪文件')}</label></div>
  </SurfaceDialog>}
  {confirm && <SurfaceDialog size="sm" icon={confirm.kind === 'amend' ? 'clock' : confirm.kind === 'checkout-overwrite' ? 'branch' : 'trash'}
   title={confirm.kind === 'abort-merge' ? text('Abort merge?','中止合并？') : confirm.kind === 'discard' ? text('Discard changes?', '丢弃更改？') : confirm.kind === 'amend' ? text('Amend the last commit?', '修改上次提交？') : confirm.kind === 'checkout-overwrite' ? text(`Switching to ${confirm.branch} would overwrite local changes`, `切换到 ${confirm.branch} 会覆盖本地更改`) : confirm.kind === 'stash-drop' ? text('Drop stash?', '删除暂存？') : confirm.force ? text('Force delete unmerged branch?', '强制删除未合并的分支？') : text('Delete branch?', '删除分支？')}
   subtitle={confirm.kind === 'abort-merge' ? undefined : confirm.kind === 'discard' ? confirm.paths.join(', ') : confirm.kind === 'amend' ? confirm.subject : confirm.kind === 'checkout-overwrite' ? undefined : confirm.kind === 'stash-drop' ? confirm.entry.message : confirm.branch}
   onClose={() => { if(!busy) { if(confirm.kind === 'discard') discardEpoch.current++; setConfirm(undefined); } }}
   footer={<>
    <button type="button" className="btn" disabled={!!busy} onClick={() => { if(confirm.kind === 'discard') discardEpoch.current++; setConfirm(undefined); }}>{text('Cancel', '取消')}</button>
    {confirm.kind === 'checkout-overwrite' ? <><button type="button" className="btn" onClick={() => { setConfirm(undefined); requestAnimationFrame(()=>changesRef.current?.focus()); }}>{text('Open Source Control', '打开源代码管理')}</button><button type="button" className="btn btn-primary" onClick={() => void confirmAction()}>{text('Stash and switch', '暂存并切换')}</button></> : <button type="button" className={`btn ${confirm.kind === 'amend' ? 'btn-primary' : 'btn-danger'}`} disabled={!!busy || (confirm.kind === 'discard' && (!confirm.fingerprints || !confirm.indexFingerprints || !!confirm.snapshotError))} onClick={() => void confirmAction()}>
     {confirm.kind === 'abort-merge' ? text('Abort merge','中止合并') : confirm.kind === 'discard' ? text('Discard', '丢弃') : confirm.kind === 'amend' ? text('Amend commit', '修改提交') : confirm.kind === 'stash-drop' ? text('Drop stash', '删除暂存') : confirm.force ? text('Force delete', '强制删除') : text('Delete', '删除')}
    </button>}
   </>}>
   {confirm.kind === 'discard' && (!confirm.fingerprints || !confirm.indexFingerprints || confirm.snapshotError) && <p className="wb-summary" role={confirm.snapshotError ? 'alert' : 'status'}>{confirm.snapshotError ?? text('Checking files before discard…', '正在检查丢弃前的文件…')}</p>}
   {confirm.kind === 'checkout-overwrite' ? <><p>{text("Files Git won't overwrite:", 'Git 不会覆盖的文件：')}</p>{confirm.paths.slice(0,10).map(path=><span key={path} className="wb-path-line">{path}</span>)}{confirm.paths.length>10&&<span className="wb-path-line">{text(`and ${confirm.paths.length-10} more`, `以及另外 ${confirm.paths.length-10} 个`)}</span>}{localChangePaths&&<><p>{text(`Your local changes (${localChangePaths.length})`, `你的本地更改（${localChangePaths.length}）`)}</p>{localChangePaths.slice(0,10).map(path=><span key={path} className="wb-path-line">{path}</span>)}{localChangePaths.length>10&&<span className="wb-path-line">{text(`and ${localChangePaths.length-10} more`, `以及另外 ${localChangePaths.length-10} 个`)}</span>}</>}<p className="wb-hint">{text('Stash and switch includes untracked files. If Git cannot re-apply them, they stay listed in Stashes.', '“暂存并切换”会包括未跟踪文件；如果 Git 无法重新应用它们，它们会保留在暂存列表中。')}</p></> : <p>{confirm.kind === 'abort-merge' ? text('Abort this merge and restore the state before the merge?','中止当前合并并还原合并开始前的状态？') : confirm.kind === 'discard'
    ? text(`Tracked files return to their staged version.${confirm.untracked ? ` ${confirm.untracked} untracked file(s) will be moved to the Recycle Bin.` : ''}`, `已跟踪文件将恢复为暂存区版本。${confirm.untracked ? `${confirm.untracked} 个未跟踪文件将移到回收站。` : ''}`)
     : confirm.kind === 'amend'
     ? text('The staged changes and the new message replace this commit. Do not amend commits that were already pushed and shared.', '已暂存的更改和新的说明会替换此提交。已推送并共享的提交请不要修改。')
     : confirm.kind === 'stash-drop'
     ? text('This removes the saved changes permanently.', '这会永久删除已保存的更改。')
     : confirm.force ? text('This branch has commits that are not merged anywhere. Deleting it may lose them.', '此分支有尚未合并的提交，删除后这些提交可能丢失。') : text('The local branch will be deleted. Remote branches are not affected.', '将删除本地分支，不影响远程分支。')}</p>
   }
  </SurfaceDialog>}
 </div>;
}
