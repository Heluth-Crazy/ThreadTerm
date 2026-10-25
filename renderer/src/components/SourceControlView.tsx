import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WbIcon } from '../workbench/icons';
import type { GitBranches, GitChange, GitSelectedCommitResult } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { Icon } from './PrototypeIcon';
import { CatalogPopover } from './CatalogActions';
import { SurfaceDialog } from './SurfaceDialog';
import { changeGroups, decorationFor, type ChangeGroup } from '../workbench/gitDecorations';
import { workbenchError } from '../workbench/errors';
import { absolutePath, baseName, parentPath, scopeParams, type GitState, type WorkbenchActions, type WorkbenchScope } from '../workbench/types';
import { ContextSendAction, sendContextToAgent } from './ContextSendAction';
import { changedFileContext } from './GitContextActions';
import { showContextMenu } from './ContextMenu';
import { sourceControlMenuItems } from '../contextMenuSurfaceItems';
import { clearSelectedChanges, selectedChanges, selectedCommitKey, setGroupSelection, toggleSelectedChange, type SelectedCommitGroup } from '../workbench/selectedCommitSelection';

type Confirm =
 | {kind:'discard';paths:string[];untracked:number}
 | {kind:'amend';subject:string}
 | {kind:'delete-branch';branch:string;force:boolean};
function GroupSelectionToggle({checked,mixed,label,onChange}:{checked:boolean;mixed:boolean;label:string;onChange:()=>void}) {
 const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(input.current)input.current.indeterminate=mixed;},[mixed]);
 return <input ref={input} type="checkbox" className="wb-change-select" aria-label={label} checked={checked} onChange={onChange}/>;
}

export function SourceControlView({scope, actions, git, zh, compact = false, toolbarHost}:{scope:WorkbenchScope;actions:WorkbenchActions;git:GitState;zh:boolean;compact?:boolean;toolbarHost?:HTMLElement|null}) {
 const [message, setMessage] = useState('');
 const [busy, setBusy] = useState<string>();
 const [issue, setIssue] = useState<string>();
 const [notice, setNotice] = useState<string>();
 const [committedWarning, setCommittedWarning] = useState<string>();
 const [collapsed, setCollapsed] = useState<Set<ChangeGroup>>(new Set());
 const [confirm, setConfirm] = useState<Confirm>();
 const [commitMenu, setCommitMenu] = useState<HTMLElement>();
 const [branchMenu, setBranchMenu] = useState<HTMLElement>();
 const [branches, setBranches] = useState<GitBranches>();
 const [branchQuery, setBranchQuery] = useState('');
 const [creating, setCreating] = useState(false);
 const [selection, setSelection] = useState<Set<string>>(() => new Set());
 const messageRef = useRef<HTMLTextAreaElement>(null);
 const scopeEpoch=useRef(0);
 const renderedScope=useRef(`${scope.projectId}\u0000${scope.worktreePath ?? ''}\u0000${scope.rootPath}`);
 const text = (en:string, cn:string) => zh ? cn : en;
 const params = scopeParams(scope);
 const status = git.status;
 const rootKey=scope.rootPath;
 const scopeKey=`${scope.projectId}\u0000${scope.worktreePath ?? ''}\u0000${scope.rootPath}`;
 if(renderedScope.current!==scopeKey) { renderedScope.current=scopeKey; scopeEpoch.current++; }
 const selectedCommit=status?.selectedCommit;
 const groups = useMemo(() => {
  const value:Record<ChangeGroup,GitChange[]> = {conflicts:[], staged:[], changes:[], untracked:[]};
  for(const change of status?.changes ?? []) for(const group of changeGroups(change)) value[group].push(change);
  return value;
 }, [status]);
 const selectedIn = (group:SelectedCommitGroup) => selectedChanges(selection, rootKey, group, groups[group]);
 const selectedStaged=selectedIn('staged');
 const toggleSelection = (group:SelectedCommitGroup, path:string) => setSelection(current => toggleSelectedChange(current,rootKey,group,path));
 const toggleGroupSelection = (group:SelectedCommitGroup) => {
  const items=groups[group], all=items.length>0&&items.every(change=>selection.has(selectedCommitKey(rootKey,group,change.path)));
  setSelection(current=>setGroupSelection(current,rootKey,group,items,!all));
 };
 useEffect(() => { setBusy(undefined); setIssue(undefined); setNotice(undefined); setCommittedWarning(undefined); setConfirm(undefined); setCommitMenu(undefined); setBranchMenu(undefined); setBranches(undefined); setBranchQuery(''); setCreating(false); }, [scope.projectId, scope.worktreePath, scope.rootPath]);
 // Success notices are transient; errors stay until dismissed.
 useEffect(() => { if(!notice) return; const timer = setTimeout(() => setNotice(undefined), 4000); return () => clearTimeout(timer); }, [notice]);

 const run = async (label:string, action:() => Promise<unknown>, done?:string) => {
  const epoch=scopeEpoch.current; let succeeded=false;
  setBusy(label); setIssue(undefined); setNotice(undefined); setCommittedWarning(undefined);
  try { await action(); succeeded=true; if(epoch===scopeEpoch.current&&done)setNotice(done); }
  catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error, zh)); }
  // The shared Git status refreshes from the runtime's scoped `state.changed` for this operation, so
  // a successful action costs exactly one `git.status`; this panel never polls and never doubles it.
  finally { if(epoch===scopeEpoch.current)setBusy(undefined); }
  return succeeded&&epoch===scopeEpoch.current;
 };
 const stage = (paths:string[]) => run('stage', () => request('git.stage', {...params, paths, operationId:operationId()}));
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
  await runSelected('stage-selected',()=>request('git.stage',{...params,paths:selected.map(change=>change.path),operationId:operationId()}),[[group,selected]],text('Selected files staged.','已暂存所选文件。'));
 };
 const unstageSelected = async () => {
  const selected=selectedStaged; if(!selected.length)return;
  await runSelected('unstage-selected',()=>request('git.unstage',{...params,paths:selected.map(change=>change.path),operationId:operationId()}),[['staged',selected]],text('Selected files unstaged.','已取消暂存所选文件。'));
 };
 const discard = (changes:GitChange[]) => setConfirm({kind:'discard', paths:changes.map(change => change.path), untracked:changes.filter(change => change.untracked).length});
 const openChange = (change:GitChange, group:ChangeGroup) => group === 'conflicts' ? actions.openFile(change.path) : actions.openDiff(change.path, group === 'staged');
 const changeMenu = (change:GitChange, group:ChangeGroup, event:{clientX:number;clientY:number;currentTarget:HTMLElement}) => {
  const staged = group === 'staged';
  showContextMenu({x:event.clientX, y:event.clientY, restoreFocus:event.currentTarget, items:sourceControlMenuItems({zh, staged, conflict:group === 'conflicts', discardable:group === 'changes' || group === 'untracked', busy:Boolean(busy), canSend:Boolean(actions.comments?.attachContext)}).map(item => ({...item, testId:item.id, onSelect:item.id === 'source-control-send-diff' ? async () => actions.comments?.attachContext && sendContextToAgent({host:actions.comments, context:await changedFileContext(params, change.path, staged, zh), zh, sourceRoot:scope.rootPath}) : item.id === 'source-control-unstage' ? () => void unstage([change.path]) : item.id === 'source-control-stage' ? () => void stage([change.path]) : item.id === 'source-control-open-changes' ? () => openChange(change, group) : item.id === 'source-control-copy-path' ? () => navigator.clipboard.writeText(absolutePath(scope.rootPath, change.path)) : item.id === 'source-control-discard' ? () => discard([change]) : undefined}))});
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
  if(event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-change-path][data-change-group]');
  if(!element || !event.currentTarget.contains(element)) return;
  const group = element.dataset.changeGroup as ChangeGroup, change = groups[group]?.find(candidate => candidate.path === element.dataset.changePath);
  if(!change) return;
  event.preventDefault(); const rect = element.getBoundingClientRect();
  changeMenu(change, group, {clientX:rect.left + Math.min(16, rect.width / 2), clientY:rect.top + Math.min(16, rect.height / 2), currentTarget:element});
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
  if(mode === 'push') await push();
 };
 const commitSelected = async () => {
  const trimmed=message.trim();
  if(!trimmed) { messageRef.current?.focus(); setIssue(text('Write a commit message first.', '请先填写提交说明。')); return; }
  if(!selectedStaged.length) return;
  if(!selectedCommit?.supported) { setIssue(selectedCommit?.unsupportedReason ?? text('Restart the ThreadTerm runtime to enable selected commits.', '请重启 ThreadTerm 运行时以启用选择性提交。')); return; }
  const selected=[...selectedStaged];
  const result=await runSelected<GitSelectedCommitResult>('commit-selected',()=>request('git.commit.selected',{...params,message:trimmed,selected:selected.map(change=>({path:change.path,indexStatus:change.indexStatus,...(change.originalPath?{originalPath:change.originalPath}:{})})),expectedHead:selectedCommit.head,expectedIndexFingerprint:selectedCommit.indexFingerprint,operationId:operationId()}),[['staged',selected]],text('Selected staged files committed.','已提交所选暂存文件。'));
  if(!result) return;
  setMessage('');
  if(result.postCommitError||result.cleanupError) setCommittedWarning([result.postCommitError&&text(`Committed, but the post-commit hook reported: ${result.postCommitError}`, `已提交，但提交后钩子报告：${result.postCommitError}`),result.cleanupError&&text('Committed, but cleanup after publication reported an error.', '已提交，但发布后的清理报告错误。')].filter(Boolean).join(' '));
 };
 const push = () => run('push', () => request('git.push', {...params, ...(status?.upstream ? {} : {setUpstream:true}), operationId:operationId()}), status?.upstream ? text('Pushed.', '已推送。') : text('Branch published.', '分支已发布。'));
 const loadBranches = async () => { const epoch=scopeEpoch.current; try { const next=await request('git.branches', params); if(epoch===scopeEpoch.current)setBranches(next); } catch(error) { if(epoch===scopeEpoch.current)setIssue(workbenchError(error, zh)); } };
 const openBranches = (anchor:HTMLElement) => { setBranchMenu(anchor); setBranchQuery(''); setCreating(false); void loadBranches(); };
 const checkout = async (branch:string, create = false) => {
  setBranchMenu(undefined);
  await run('checkout', () => request('git.checkout', {...params, branch, ...(create ? {create:true} : {}), operationId:operationId()}), text(`Switched to ${branch}.`, `已切换到 ${branch}。`));
 };
 const confirmAction = async () => {
  if(!confirm) return;
  const current = confirm, epoch=scopeEpoch.current;
  if(current.kind === 'discard') {
   setConfirm(undefined);
   const dirty = actions.dirtyPaths().filter(path => current.paths.includes(path));
   if(dirty.length) { setIssue(text(`Save or close unsaved editors first: ${dirty.join(', ')}`, `请先保存或关闭未保存的编辑器：${dirty.join('、')}`)); return; }
   await run('discard', () => request('git.discard', {...params, paths:current.paths, operationId:operationId()}), text('Changes discarded.', '更改已丢弃。'));
  } else if(current.kind === 'amend') {
   setConfirm(undefined);
   const ok = await run('commit', () => request('git.commit', {...params, message:message.trim(), amend:true, operationId:operationId()}), text('Last commit amended.', '已修改上次提交。'));
   if(ok) setMessage('');
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

 const tools = <>
  {actions.openHistory && <button type="button" className="icon-btn" title={text('History', '提交历史')} aria-label={text('History', '提交历史')} onClick={() => actions.openHistory?.()}><Icon name="clock"/></button>}
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
   {selectionGroup && <input type="checkbox" className="wb-change-select" aria-label={text(`Select ${change.path} in ${group}`, `在${group}中选择 ${change.path}`)} checked={selected} onClick={event=>event.stopPropagation()} onChange={()=>toggleSelection(selectionGroup,change.path)}/>}
   <button type="button" className="wb-change-open" title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
    onClick={() => openChange(change, group)}>
    <Icon name="file"/><span className="wb-name">{baseName(change.path)}</span><span className="wb-dir">{parentPath(change.path)}</span>
   </button>
   <span className="wb-row-actions">
    <button type="button" className="icon-btn" title={text('Open file', '打开文件')} aria-label={text('Open file', '打开文件')} onClick={() => actions.openFile(change.path)}><Icon name="file"/></button>
    {actions.comments?.attachContext && <ContextSendAction host={actions.comments} item={() => changedFileContext(params, change.path, staged, zh)} sourceRoot={scope.rootPath} zh={zh} label={text('Send diff to agent', '将差异发送给 Agent')} iconOnly testId="source-control-send-diff"/>}
    {(group === 'changes' || group === 'untracked') && <button type="button" className="icon-btn" title={text('Discard changes', '丢弃更改')} aria-label={text('Discard changes', '丢弃更改')} disabled={!!busy} onClick={() => discard([change])}><WbIcon name="undo"/></button>}
    {staged
     ? <button type="button" className="icon-btn" title={text('Unstage', '取消暂存')} aria-label={text('Unstage', '取消暂存')} disabled={!!busy} onClick={() => void unstage([change.path])}><WbIcon name="minus"/></button>
     : <button type="button" className="icon-btn" title={group === 'conflicts' ? text('Mark resolved (stage)', '标记已解决（暂存）') : text('Stage', '暂存')} aria-label={text('Stage', '暂存')} disabled={!!busy} onClick={() => void stage([change.path])}><Icon name="plus"/></button>}
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
    <button type="button" className="wb-group-toggle" aria-expanded={!closed} onClick={() => setCollapsed(current => { const next = new Set(current); if(next.has(group)) next.delete(group); else next.add(group); return next; })}>
     <span className={`wb-chevron${closed ? '' : ' open'}`} aria-hidden="true"><Icon name="chevR"/></span>{title}<span className="wb-count">{items.length}</span>
    </button>
    {selectionGroup && <GroupSelectionToggle checked={selectedCount===items.length} mixed={selectedCount>0&&selectedCount<items.length} label={text(`Select all ${title}`, `全选${title}`)} onChange={()=>toggleGroupSelection(selectionGroup)}/>}<span className="wb-row-actions">{actionsNode}</span>
   </div>
   {!closed && <div role="list">{items.map(change => row(change, group))}</div>}
  </section>;
 };
 const nothing = !(status.changes.length);
 const selectedForStage=selectedIn('changes').length+selectedIn('untracked').length;
 const commitSelectedActive=selectedStaged.length>0;
 const filteredBranches = (branches?.branches ?? []).filter(branch => branch.name.toLowerCase().includes(branchQuery.trim().toLowerCase()));
 return <div className={`wb-scm${compact ? ' compact' : ''}`}>
  {toolbar}
  <div className="wb-scm-bar">
   <button type="button" className="wb-branch-chip" title={status.upstream ? text(`Switch branch · tracking ${status.upstream}`, `切换分支 · 跟踪 ${status.upstream}`) : text('Switch branch · no upstream yet', '切换分支 · 尚无上游')} onClick={event => openBranches(event.currentTarget)}>
    <Icon name="branch"/><span className="wb-name">{status.branch ?? text('Detached HEAD', '分离的 HEAD')}</span><Icon name="chevron" className="wb-chip-caret"/>
   </button>
   <span className="wb-sync-actions">
    {!toolbarHost && tools}
    <button type="button" className="icon-btn" title={text('Fetch', '获取')} aria-label={text('Fetch', '获取')} disabled={!!busy} onClick={() => void run('fetch', () => request('git.fetch', {...params, operationId:operationId()}), text('Fetched.', '已获取。'))}><WbIcon name="fetch"/></button>
    <button type="button" className="icon-btn wb-count-btn" title={status.upstream ? text(`Pull (fast-forward only) · ${status.behind} behind`, `拉取（仅快进）· 落后 ${status.behind}`) : text('Pull · no upstream yet', '拉取 · 尚无上游')} aria-label={text('Pull', '拉取')} disabled={!!busy || !status.upstream} onClick={() => void run('pull', () => request('git.pull', {...params, operationId:operationId()}), text('Pulled.', '已拉取。'))}><WbIcon name="pull"/>{status.upstream && status.behind > 0 && <span className="wb-btn-count">{status.behind}</span>}</button>
    <button type="button" className="icon-btn wb-count-btn" title={status.upstream ? text(`Push · ${status.ahead} ahead`, `推送 · 领先 ${status.ahead}`) : text('Publish branch', '发布分支')} aria-label={status.upstream ? text('Push', '推送') : text('Publish branch', '发布分支')} disabled={!!busy || !status.branch} onClick={() => void push()}><WbIcon name="push"/>{status.upstream && status.ahead > 0 && <span className="wb-btn-count">{status.ahead}</span>}</button>
   </span>
  </div>
  <div className="wb-commit">
   <textarea ref={messageRef} value={message} onChange={event => setMessage(event.target.value)} rows={2} placeholder={text('Message (Ctrl+Enter to commit)', '提交说明（Ctrl+Enter 提交）')} aria-label={text('Commit message', '提交说明')}
    onKeyDown={event => { if(event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if(!busy) void (commitSelectedActive ? commitSelected() : commit('commit')); } }}/>
   <div className="wb-commit-actions">
   <button type="button" className="btn btn-primary wb-commit-main" disabled={!!busy || (commitSelectedActive ? !selectedCommit?.supported : !groups.staged.length)} title={commitSelectedActive&&!selectedCommit?.supported ? selectedCommit?.unsupportedReason ?? text('Restart the ThreadTerm runtime to enable selected commits.', '请重启 ThreadTerm 运行时以启用选择性提交。') : !commitSelectedActive&&!groups.staged.length ? text('Stage changes first', '请先暂存更改') : undefined} onClick={() => void (commitSelectedActive ? commitSelected() : commit('commit'))}>
     {busy === 'commit-selected' ? text('Committing selected…', '正在提交所选文件…') : busy === 'commit' ? text('Committing all…', '正在提交全部…') : commitSelectedActive ? text('Commit selected', '提交所选') : text('Commit all staged', '提交全部暂存')}
    </button>
    <button type="button" className="btn wb-commit-more" aria-label={text('More commit actions', '更多提交操作')} disabled={!!busy} onClick={event => setCommitMenu(event.currentTarget)}><Icon name="chevron"/></button>
   </div>
   {(commitSelectedActive||selectedForStage>0) && <p className="wb-selected-summary" aria-live="polite">{commitSelectedActive ? text(`${selectedStaged.length} staged file(s) selected for this commit.`, `已选择 ${selectedStaged.length} 个暂存文件用于此次提交。`) : ''}{commitSelectedActive&&selectedForStage>0?' ':''}{selectedForStage>0 ? text(`${selectedForStage} change(s) selected to stage; they are not included until staged.`, `已选择 ${selectedForStage} 个更改待暂存；暂存前不会包含在提交中。`) : ''}</p>}
  </div>
  {busy && busy !== 'commit' && <p className="wb-summary" aria-live="polite">{text('Working…', '正在执行…')}</p>}
  {issue && <p className="wb-issue" role="alert">{issue}<button type="button" className="icon-btn" aria-label={text('Dismiss', '关闭提示')} onClick={() => setIssue(undefined)}><Icon name="close"/></button></p>}
  {notice && !issue && <p className="wb-notice" aria-live="polite">{notice}</p>}
  {committedWarning && <p className="wb-notice wb-commit-warning" role="status">{committedWarning}</p>}
  <div className="wb-changes" onContextMenu={onChangeContext} onKeyDown={onChangeKey}>
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
   {nothing && <p className="wb-empty">{text('No changes in this worktree.', '此工作树没有更改。')}</p>}
  </div>
  {commitMenu && <CatalogPopover anchor={commitMenu} label={text('Commit actions', '提交操作')} onClose={() => setCommitMenu(undefined)}>
   <button type="button" role="menuitem" className="menu-item" disabled={!groups.staged.length} onClick={() => { setCommitMenu(undefined); void commit('commit'); }}><Icon name="check"/>{text('Commit all staged', '提交全部暂存')}</button>
   <button type="button" role="menuitem" className="menu-item" disabled={!groups.staged.length} onClick={() => { setCommitMenu(undefined); void commit('push'); }}><Icon name="export"/>{status.upstream ? text('Commit & push', '提交并推送') : text('Commit & publish', '提交并发布')}</button>
   <button type="button" role="menuitem" className="menu-item" onClick={() => { setCommitMenu(undefined); void commit('amend'); }}><Icon name="clock"/>{text('Amend last commit…', '修改上次提交…')}</button>
  </CatalogPopover>}
  {branchMenu && <CatalogPopover anchor={branchMenu} label={text('Branches', '分支')} onClose={() => setBranchMenu(undefined)}>
   <div className="wb-branch-menu">
    <input autoFocus className="wb-branch-filter" value={branchQuery} onChange={event => setBranchQuery(event.target.value)} placeholder={creating ? text('New branch name', '新分支名称') : text('Filter or create a branch', '筛选或新建分支')} aria-label={text('Branch name', '分支名称')}
     onKeyDown={event => { if(event.key === 'Enter' && creating && branchQuery.trim()) { event.preventDefault(); void checkout(branchQuery.trim(), true); } }}/>
    <button type="button" role="menuitem" className="menu-item" disabled={!!busy} onClick={() => { if(creating && branchQuery.trim()) void checkout(branchQuery.trim(), true); else setCreating(true); }}><Icon name="plus"/>{creating && branchQuery.trim() ? text(`Create "${branchQuery.trim()}" from current`, `从当前位置新建“${branchQuery.trim()}”`) : text('Create new branch…', '新建分支…')}</button>
    {!branches && <p className="wb-summary">{text('Loading branches…', '正在读取分支…')}</p>}
    {branches && !creating && <>
     {(['local', 'remote'] as const).map(kind => {
      const list = filteredBranches.filter(branch => branch.remote === (kind === 'remote'));
      if(!list.length) return null;
      return <div key={kind}>
       <div className="menu-label">{kind === 'local' ? text('Local branches', '本地分支') : text('Remote branches', '远程分支')}</div>
       {list.map(branch => <div key={`${kind}:${branch.name}`} className="wb-branch-item">
        <button type="button" role="menuitem" className="menu-item" disabled={branch.current || !!busy} onClick={() => void checkout(branch.name)} title={branch.lastCommit?.subject}>
         <Icon name={branch.current ? 'check' : 'branch'}/><span className="wb-name">{branch.name}</span>
         {(branch.ahead || branch.behind) ? <span className="wb-sync">↑{branch.ahead ?? 0} ↓{branch.behind ?? 0}</span> : branch.gone ? <span className="wb-sync muted">{text('gone', '已删除')}</span> : null}
        </button>
        {kind === 'local' && !branch.current && <button type="button" className="icon-btn" title={text('Delete branch', '删除分支')} aria-label={text(`Delete ${branch.name}`, `删除 ${branch.name}`)} onClick={() => { setBranchMenu(undefined); setConfirm({kind:'delete-branch', branch:branch.name, force:false}); }}><Icon name="trash"/></button>}
       </div>)}
      </div>;
     })}
    </>}
   </div>
  </CatalogPopover>}
  {confirm && <SurfaceDialog size="sm" icon={confirm.kind === 'amend' ? 'clock' : 'trash'}
   title={confirm.kind === 'discard' ? text('Discard changes?', '丢弃更改？') : confirm.kind === 'amend' ? text('Amend the last commit?', '修改上次提交？') : confirm.force ? text('Force delete unmerged branch?', '强制删除未合并的分支？') : text('Delete branch?', '删除分支？')}
   subtitle={confirm.kind === 'discard' ? confirm.paths.join(', ') : confirm.kind === 'amend' ? confirm.subject : confirm.branch}
   onClose={() => { if(!busy) setConfirm(undefined); }}
   footer={<>
    <button type="button" className="btn" disabled={!!busy} onClick={() => setConfirm(undefined)}>{text('Cancel', '取消')}</button>
    <button type="button" className={`btn ${confirm.kind === 'amend' ? 'btn-primary' : 'btn-danger'}`} disabled={!!busy} onClick={() => void confirmAction()}>
     {confirm.kind === 'discard' ? text('Discard', '丢弃') : confirm.kind === 'amend' ? text('Amend commit', '修改提交') : confirm.force ? text('Force delete', '强制删除') : text('Delete', '删除')}
    </button>
   </>}>
   <p>{confirm.kind === 'discard'
    ? text(`Tracked files return to their staged version.${confirm.untracked ? ` ${confirm.untracked} untracked file(s) will be moved to the Recycle Bin.` : ''}`, `已跟踪文件将恢复为暂存区版本。${confirm.untracked ? `${confirm.untracked} 个未跟踪文件将移到回收站。` : ''}`)
    : confirm.kind === 'amend'
     ? text('The staged changes and the new message replace this commit. Do not amend commits that were already pushed and shared.', '已暂存的更改和新的说明会替换此提交。已推送并共享的提交请不要修改。')
     : confirm.force ? text('This branch has commits that are not merged anywhere. Deleting it may lose them.', '此分支有尚未合并的提交，删除后这些提交可能丢失。') : text('The local branch will be deleted. Remote branches are not affected.', '将删除本地分支，不影响远程分支。')}</p>
  </SurfaceDialog>}
 </div>;
}
