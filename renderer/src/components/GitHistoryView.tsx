import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { GitCommitDetail, GitCommitInfo, GitHistoryPlan, GitHistoryMutationResult, GitStatus, GitTextPair, Worktree } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { Icon } from './PrototypeIcon';
import { MergeEditor, type MergeSelection } from './MergeEditor';
import { relativeTime } from './CodeEditor';
import { workbenchError } from '../workbench/errors';
import { baseName, parentPath } from '../workbench/types';
import { commitGraph, refBadge, type GraphRow } from '../workbench/gitGraph';
import type { FileCommentsHost } from '../fileCommentsHost';
import { sameCommentVersion, type CommentScope } from '../reviewComments';
import { CommentForm, PendingComments, useFileComments } from './FileComments';
import '../workbench/workbench.css';
import { ContextSendAction, sendContextToAgent } from './ContextSendAction';
import type { ContextItem } from '../chatContext';
import { showContextMenu } from './ContextMenu';
import { historyCommitMenuItems, historyVersionMenuItems } from '../contextMenuSurfaceItems';
import { isKeyboardEditableTarget } from '../workbench/scmKeyboard';
import { defaultGitHistoryRovingCommit, resolveGitHistoryTarget } from '../workbench/gitHistorySelection';
import { SurfaceDialog } from './SurfaceDialog';
import { historyActionSelection, resetDialogPreview, resetUndoMatchesBranch } from '../workbench/gitHistoryActions';
import { NewWorktree } from './ProjectOverview';

const PAGE = 100;
const SCOPE_KEY = 'threadterm.workbench.historyScope';
const ROW = 44, LANE = 14, MAX_LANES = 12;
const laneX = (column:number) => 9 + Math.min(column, MAX_LANES - 1) * LANE;
type HistoryDialog = {kind:'branch'|'worktree'|'cherry-pick'|'revert'|'reset';commit:GitCommitInfo;plan:GitHistoryPlan};
type ResetReceipt = {previousHead:string;head:string;symbolicHead:string;operation:string};

/** One row's slice of the commit graph; rows are a fixed height so the slices join into continuous lines. */
function GraphCell({row, width, head}:{row:GraphRow;width:number;head:boolean}) {
 const mid = ROW / 2;
 const curve = (from:number, to:number, y1:number, y2:number) => {
  const x1 = laneX(from), x2 = laneX(to), bend = (y1 + y2) / 2;
  return from === to ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${bend} ${x2} ${bend} ${x2} ${y2}`;
 };
 return <svg className="wb-graph" width={laneX(Math.min(width, MAX_LANES) - 1) + 9} height={ROW} aria-hidden="true">
  {row.edges.map((edge, index) => <path key={index} className={`lane-${edge.color % 8}`} d={edge.half === 'top' ? curve(edge.from, edge.to, 0, mid) : curve(edge.from, edge.to, mid, ROW)}/>)}
  <circle className={`wb-graph-node lane-${row.color % 8}${head ? ' head' : ''}`} cx={laneX(row.node)} cy={mid} r={head ? 5 : 4}/>
 </svg>;
}

export function GitHistoryView({projectId, worktreePath, path, focusCommit, zh, onOpenFile, comments:commentsHost}:{projectId:string;worktreePath?:string;path?:string;focusCommit?:string;zh:boolean;onOpenFile?:(path:string)=>void;comments?:FileCommentsHost}) {
 const scope = {projectId, ...(worktreePath ? {worktreePath} : {})};
 const root = commentsHost ? worktreePath ?? commentsHost.projectRoot(projectId) : undefined;
 const commentScope:CommentScope|undefined = root ? {projectId, root} : undefined;
 const comments = useFileComments(commentScope);
 const [commits, setCommits] = useState<GitCommitInfo[]>([]);
 const [hasMore, setHasMore] = useState(false);
 const [selected, setSelected] = useState<string>();
 const [explicitTarget, setExplicitTarget] = useState(focusCommit);
 const [detail, setDetail] = useState<GitCommitDetail>();
 const [detailSelection, setDetailSelection] = useState<string>();
 const [file, setFile] = useState<{path:string;originalPath?:string}>();
 const [pair, setPair] = useState<GitTextPair>();
 const [pairCommit, setPairCommit] = useState<string>();
 const [selection, setSelection] = useState<MergeSelection>();
 const [draft, setDraft] = useState<MergeSelection>();
 const [issue, setIssue] = useState<string>();
 const [loading, setLoading] = useState(false);
 // Repository history is drawn as a graph of the current branch or of every branch; file history is a plain list.
 const [allBranches, setAllBranches] = useState(() => { try { return localStorage.getItem(SCOPE_KEY) === 'all'; } catch { return false; } });
 const [remoteBranches, setRemoteBranches] = useState<ReadonlySet<string>>(new Set());
 const [notice, setNotice] = useState<string>();
 const [dialog,setDialog]=useState<HistoryDialog>();
 const [actionBusy,setActionBusy]=useState(false);
 const [branchName,setBranchName]=useState('');
 const [branchBase,setBranchBase]=useState('');
 const [mainline,setMainline]=useState(1);
 const [resetMode,setResetMode]=useState<'soft'|'mixed'>('mixed');
 const [resetReceipt,setResetReceipt]=useState<ResetReceipt>();
 const [projectPath,setProjectPath]=useState<string>();
 const [gitStatus,setGitStatus]=useState<GitStatus>();
 const [actionPlan,setActionPlan]=useState<GitHistoryPlan>();
 const scopeKey=`${projectId}\0${worktreePath??''}\0${path??''}`;
 const scopeIdentity=useRef(scopeKey);scopeIdentity.current=scopeKey;
 const mounted=useRef(true),busyAction=useRef(false);
 const isCurrent=()=>mounted.current&&scopeIdentity.current===scopeKey;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const generation = useRef(0), fileGeneration = useRef(0), pageGeneration = useRef(0), explicitTargetRef = useRef(focusCommit), focusCommitPropRef = useRef(focusCommit), focusRow = useRef<string|undefined>(undefined), focusedCommit = useRef<string|undefined>(undefined), listFocused = useRef(false);
 if(focusCommitPropRef.current!==focusCommit) { focusCommitPropRef.current=focusCommit; explicitTargetRef.current=focusCommit; }
 const commitRows = useRef(new Map<string,HTMLButtonElement>());
 const all = !path && allBranches;
 const graph = useMemo(() => path ? undefined : commitGraph(commits), [commits, path]);
 const selectedCommit = explicitTarget ?? selected;
 const selectedRow = explicitTarget ? resolveGitHistoryTarget(explicitTarget, commits.map(commit=>commit.hash), detail&&detailSelection?{target:detailSelection,hash:detail.commit.hash}:undefined) : selected;
 const selectCommit = (hash:string) => { explicitTargetRef.current=undefined; setExplicitTarget(undefined); setSelected(hash); };
 const text = (en:string, cn:string) => zh ? cn : en;
 const copy = (value:string) => void navigator.clipboard.writeText(value).catch(error => setIssue(workbenchError(error, zh)));
 const actionItems=(plan:GitHistoryPlan|undefined,status=gitStatus)=>historyCommitMenuItems({zh,canSend:Boolean(commentsHost?.attachContext),includeActions:true,ready:Boolean(plan)&&Boolean(status),branch:plan?.branch,detached:plan?.detached,isAncestor:plan?.isAncestor,operation:Boolean(status?.operation),busy:actionBusy});
 const openAction = async (kind:HistoryDialog['kind'], value:GitCommitInfo) => {
  if(busyAction.current)return;
  setIssue(undefined);
  try {
   const [plan,status]=await Promise.all([request('git.history.plan',{...scope,hash:value.hash}),request('git.status',scope)]);
   if(!isCurrent())return;
   setGitStatus(status);
   const id=kind==='branch'?'history-new-branch':kind==='worktree'?'history-new-worktree':kind==='cherry-pick'?'history-cherry-pick':kind==='revert'?'history-revert':'history-reset';
   if(actionItems(plan,status).find(item=>item.id===id)?.disabled)return;
   if(kind==='cherry-pick') { await cherryPick(value,plan); return; }
   setBranchName('');setBranchBase(plan.hash);setMainline(1);setResetMode('mixed');setDialog({kind,commit:value,plan});
  } catch(error) { if(isCurrent())setIssue(workbenchError(error,zh)); }
 };
 const commitMenu = async (value:GitCommitInfo, event:{clientX:number;clientY:number;currentTarget:HTMLElement}) => {
  let plan:GitHistoryPlan|undefined,status=gitStatus;
  try { [plan,status]=await Promise.all([request('git.history.plan',{...scope,hash:value.hash}),request('git.status',scope)]); }
  catch(error) { if(isCurrent())setIssue(workbenchError(error,zh)); }
  if(!isCurrent()||!event.currentTarget.isConnected)return;
  if(status)setGitStatus(status);
  const kindById={'history-new-branch':'branch','history-new-worktree':'worktree','history-cherry-pick':'cherry-pick','history-revert':'revert','history-reset':'reset'} as const;
  showContextMenu({x:event.clientX,y:event.clientY,restoreFocus:event.currentTarget,items:actionItems(plan,status).map(item=>({...item,testId:item.id,onSelect:item.id==='history-send-to-agent'?()=>commentsHost?.attachContext&&sendContextToAgent({host:commentsHost,context:{kind:'commit',id:crypto.randomUUID(),sha:value.hash,subject:value.subject} satisfies ContextItem,zh}):item.id==='history-copy-commit-hash'?()=>copy(value.hash):item.id in kindById?()=>void openAction(kindById[item.id as keyof typeof kindById],value):undefined}))});
 };
 const fileDiffMenu = (event:{clientX:number;clientY:number;currentTarget:HTMLElement}, selectedLines:MergeSelection|undefined = selection, hasSelection=Boolean(selectedLines?.text), copySelection?:()=>Promise<void>) => {const commentReason=!commentScope || !version ? text('Comments are unavailable for this file version.', '此文件版本无法评论。') : !selectedLines ? text('Select lines on either side first.', '请先在任一侧选中行。') : draft ? text('Finish the current comment first.', '请先完成当前评论。') : undefined;showContextMenu({x:event.clientX, y:event.clientY, restoreFocus:event.currentTarget, items:historyVersionMenuItems({zh,startLine:selectedLines?.startLine,endLine:selectedLines?.endLine,canComment:Boolean(commentScope && version && selectedLines && !draft),commentReason,hasText:hasSelection,path:file?.path}).map(item => ({...item,testId:item.id,onSelect:item.id === 'history-comment-lines' ? () => selectedLines && setDraft(selectedLines) : item.id === 'history-copy-selection' ? () => copySelection ? copySelection() : selectedLines && copy(selectedLines.text) : item.id === 'history-copy-path' ? () => file && copy(file.path) : undefined}))});};
 const onCommitContext = (event:MouseEvent<HTMLDivElement>) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-commit-hash]');
  if(!element || !event.currentTarget.contains(element)) return;
  const value = commits.find(candidate => candidate.hash === element.dataset.commitHash);
  if(!value) return;
  event.preventDefault(); selectCommit(value.hash); commitMenu(value, {clientX:event.clientX, clientY:event.clientY, currentTarget:element});
 };
 const onCommitKey = (event:KeyboardEvent<HTMLDivElement>) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-commit-hash]');
  if(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
   if(!element || !event.currentTarget.contains(element)) return;
   const value = commits.find(candidate => candidate.hash === element.dataset.commitHash);
   if(!value) return;
   event.preventDefault(); const rect = element.getBoundingClientRect(); selectCommit(value.hash);
   commitMenu(value, {clientX:rect.left + Math.min(16, rect.width / 2), clientY:rect.top + Math.min(16, rect.height / 2), currentTarget:element});
   return;
  }
  if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey) return;
  // A present or future history filter hands ArrowDown to the first result; other editable controls keep their native keys.
  if(event.key==='ArrowDown'&&event.target instanceof Element&&event.target.closest('input')&&commits[0]) { const first=commits[0];event.preventDefault();focusRow.current=first.hash;if(first.hash===selectedCommit) {focusRow.current=undefined;commitRows.current.get(first.hash)?.focus();} else selectCommit(first.hash);return; }
  if(isKeyboardEditableTarget(event.target)||!['ArrowUp','ArrowDown','Home','End','Enter'].includes(event.key)) return;
  if(!element || !event.currentTarget.contains(element)) return;
  const index=commits.findIndex(candidate=>candidate.hash===element.dataset.commitHash);
  const next=event.key==='Home'?commits[0]:event.key==='End'?commits.at(-1):event.key==='ArrowUp'?commits[Math.max(0,index-1)]:event.key==='ArrowDown'?commits[Math.min(commits.length-1,index+1)]:commits[index];
  if(!next) return;
  event.preventDefault();focusRow.current=next.hash;
  if(next.hash===selectedCommit) { focusRow.current=undefined;commitRows.current.get(next.hash)?.focus(); }
  else selectCommit(next.hash);
 };
 useEffect(()=>{
  const hash=focusRow.current??(listFocused.current?focusedCommit.current:undefined);if(!hash||hash!==selectedRow) return;
  const row=commitRows.current.get(hash);if(!row) return;
  focusRow.current=undefined;row.focus();
 },[selectedRow,commits]);
 const loadPage = async (skip:number,preserveSelection=false) => {
  if(!isCurrent())return;
  const ticket = skip ? pageGeneration.current : ++pageGeneration.current;
  setLoading(true);
  const params = {...scope, ...(path ? {path} : {}), skip, limit:PAGE};
  const restart = text('Restart ThreadTerm to show all branches; showing the current branch.', '重启 ThreadTerm 后才能显示所有分支；当前显示的是当前分支。');
  try {
   let value;
   // An older app rejects the `all` field and an older runtime ignores it (no `scope`): fall back to HEAD and say so.
   try { value = await request('git.log', all ? {...params, all:true} : params); }
   catch(error) { if(!all) throw error; value = await request('git.log', params); value = {...value, scope:undefined}; }
   if(!isCurrent()||ticket !== pageGeneration.current) return;
   if(all&&value.scope!=='all')setNotice(restart);
   setCommits(current => skip ? [...current, ...value.commits] : value.commits);
   setHasMore(value.hasMore);
   if(!skip && !preserveSelection && value.commits[0]) setSelected(current => defaultGitHistoryRovingCommit(current, explicitTargetRef.current, value.commits.map(commit => commit.hash)));
  } catch(error) { if(isCurrent())setIssue(workbenchError(error, zh)); }
  finally { if(isCurrent())setLoading(false); }
 };
 const refreshAt = async (hash:string, message:string) => {
  await loadPage(0);if(!isCurrent())return;
  explicitTargetRef.current=hash;setExplicitTarget(hash);setSelected(hash);setNotice(message);
 };
 const finishHistoryAction = async (result:GitHistoryMutationResult,message:string) => {
  if(!isCurrent())return;
  const hash=historyActionSelection(result,explicitTargetRef.current);
  if(hash)setSelected(hash);
  setNotice(message);
  await loadPage(0,true);
 };
 const cherryPick = async (_value:GitCommitInfo, plan:GitHistoryPlan) => {
  if(busyAction.current||plan.detached||plan.isAncestor)return;
  busyAction.current=true;setActionBusy(true);setIssue(undefined);
  try {
   const result=await request('git.cherryPick',{...scope,hash:plan.hash,operationId:operationId()});
   await finishHistoryAction(result,result.conflicted?text('Cherry-pick has conflicts. Resolve them in Source Control, then continue.','拣选发生冲突。请在源代码管理中解决后继续。'):text('Cherry-pick completed.','拣选已完成。'));
  }catch(error){if(isCurrent()){setIssue(workbenchError(error,zh));}}
  finally{if(isCurrent()){busyAction.current=false;setActionBusy(false);}}
 };
 const submitDialog = async () => {
  if(!dialog||busyAction.current)return;
  busyAction.current=true;setActionBusy(true);setIssue(undefined);
  try {
   if(dialog.kind==='branch') {
    if(!branchName.trim())return;
    const before=await request('git.status',scope);if(!isCurrent())return;if(before.operation)throw new Error(`operation_in_progress: ${before.operation.kind}`);
    await request('git.checkout',{...scope,branch:branchName.trim(),create:true,startPoint:branchBase.trim(),operationId:operationId()});if(!isCurrent())return;setDialog(undefined);const status=await request('git.status',scope),head=status.selectedCommit?.head;await refreshAt(head&&head.kind!=='unborn'?head.oid:dialog.plan.hash,text(`Created and switched to ${branchName.trim()}.`,`已创建并切换到 ${branchName.trim()}。`));
   } else if(dialog.kind==='revert') {
    const result=await request('git.revert',{...scope,hash:dialog.plan.hash,...(dialog.plan.parents.length>1?{mainline}:{}),operationId:operationId()});if(!isCurrent())return;setDialog(undefined);
     await finishHistoryAction(result,result.conflicted?text('Revert has conflicts. Resolve them in Source Control, then continue.','还原发生冲突。请在源代码管理中解决后继续。'):text('Revert completed.','还原已完成。'));
   } else if(dialog.kind==='reset') {
    const resetOperation=operationId(),receipt=await request('git.reset',{...scope,hash:dialog.plan.hash,mode:resetMode,expectedHead:dialog.plan.head,operationId:resetOperation});if(!isCurrent())return;setDialog(undefined);setResetReceipt({previousHead:receipt.previousHead,head:receipt.head,symbolicHead:receipt.symbolicHead,operation:resetOperation});await refreshAt(receipt.head,text('Branch reset.','分支已重置。'));
   }
  }catch(error){if(isCurrent())setIssue(workbenchError(error,zh));}finally{if(isCurrent()){busyAction.current=false;setActionBusy(false);}}
 };
 const undoReset = async () => {
  if(!resetReceipt||busyAction.current||!resetUndoMatchesBranch(resetReceipt.symbolicHead,gitStatus?.branch))return;
  busyAction.current=true;setActionBusy(true);setIssue(undefined);
  try{const receipt=await request('git.reset',{...scope,hash:resetReceipt.previousHead,mode:'soft',expectedHead:resetReceipt.head,undoOf:resetReceipt.operation,operationId:operationId()});if(!isCurrent())return;setResetReceipt(undefined);await refreshAt(receipt.head,text('Reset undone.','已撤销重置。'));}
  catch(error){if(isCurrent())setIssue(workbenchError(error,zh));}finally{if(isCurrent()){busyAction.current=false;setActionBusy(false);}}
 };
 useEffect(() => { explicitTargetRef.current=focusCommit; setExplicitTarget(focusCommit); setCommits([]); setSelected(undefined); setDetail(undefined); void loadPage(0); }, [projectId, worktreePath, path, all]);
 useEffect(() => { let live=true; void request('worktree.list',{projectId}).then((trees:Worktree[])=>{if(live)setProjectPath(trees.find(tree=>tree.isMain)?.path ?? worktreePath);}).catch(()=>{if(live)setProjectPath(worktreePath);}); return()=>{live=false;}; },[projectId,worktreePath]);
 useEffect(()=>{
  let live=true,requestNumber=0;
  const refresh=async(changed=false)=>{
   const ticket=++requestNumber;
   try{const status=await request('git.status',scope);if(!live||!isCurrent()||ticket!==requestNumber)return;
    setGitStatus(status);
    if(changed){await loadPage(0,true);if(!live||!isCurrent()||ticket!==requestNumber)return;}
   }catch(error){if(live&&isCurrent())setIssue(workbenchError(error,zh));}
  };
  void refresh();
  const off=subscribeEvents(event=>{const data=event.data as {kind?:unknown;projectId?:unknown;worktreePath?:unknown}|null;if(event.event==='state.changed'&&data?.kind==='git'&&data.projectId===projectId&&(data.worktreePath??undefined)===worktreePath)void refresh(true);});
  return()=>{live=false;off();};
 },[scopeKey,all,zh]);
 useEffect(()=>{setDialog(undefined);setResetReceipt(undefined);setGitStatus(undefined);setActionPlan(undefined);setActionBusy(false);setIssue(undefined);busyAction.current=false;},[scopeKey]);
 useEffect(()=>{if(resetReceipt&&gitStatus&&!resetUndoMatchesBranch(resetReceipt.symbolicHead,gitStatus.branch))setResetReceipt(undefined);},[resetReceipt,gitStatus?.branch]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(undefined),4000);return()=>clearTimeout(timer);},[notice]);
 useEffect(() => {
  if(path) return;
  let live = true;
  void request('git.branches', scope).then(value => { if(live) setRemoteBranches(new Set(value.branches.filter(branch => branch.remote).map(branch => branch.name))); }).catch(() => {});
  return () => { live = false; };
 }, [projectId, worktreePath, path]);
 const chooseScope = (next:boolean) => { setAllBranches(next); try { localStorage.setItem(SCOPE_KEY, next ? 'all' : 'head'); } catch { /* keep in memory */ } };
 useEffect(() => { explicitTargetRef.current=focusCommit; setExplicitTarget(focusCommit); setSelected(current => focusCommit ? undefined : current ?? commits[0]?.hash); }, [focusCommit]);
 useEffect(() => {
  if(!selectedCommit) return;
  const ticket = ++generation.current;
  setDetail(undefined); setDetailSelection(undefined); setPair(undefined); setPairCommit(undefined); setFile(undefined);
  void request('git.commit.show', {...scope, commit:selectedCommit}).then(value => {
   if(ticket !== generation.current) return;
   setDetail(value); setDetailSelection(selectedCommit);
   // File history opens the followed file directly; otherwise the first changed file.
   const initial = (path && value.files.find(candidate => candidate.path === path)) || value.files[0];
   if(initial) setFile({path:initial.path, originalPath:initial.originalPath});
  }).catch(error => { if(ticket === generation.current) setIssue(workbenchError(error, zh)); });
 }, [selectedCommit, projectId, worktreePath]);
 const info = detail?.commit;
 const headSnapshot=gitStatus?.selectedCommit?.head;
 const statusHead=headSnapshot&&headSnapshot.kind!=='unborn'?headSnapshot.oid:undefined;
 useEffect(()=>{setActionPlan(undefined);if(!info)return;let live=true;void request('git.history.plan',{...scope,hash:info.hash}).then(plan=>{if(live&&isCurrent())setActionPlan(plan);}).catch(error=>{if(live&&isCurrent())setIssue(workbenchError(error,zh));});return()=>{live=false;};},[info?.hash,statusHead,gitStatus?.branch,gitStatus?.operation?.kind,scopeKey]);
 const headerItems=actionItems(actionPlan).slice(0,5);
 const headerKinds=['branch','worktree','cherry-pick','revert','reset'] as const;
 const resetPreview=dialog?.kind==='reset'?resetDialogPreview(dialog.plan.reset):undefined;
 // The diff loads from the selected row as before; comments wait for the full hash (a blame click may select a short
 // one), so a comment always names the same commit.
 const commit = detailSelection === selectedCommit ? info?.hash : undefined;
 useEffect(() => {
  if(!selectedCommit || !file) return;
  const ticket = ++fileGeneration.current;
  setPair(undefined); setPairCommit(undefined);
  void request('git.commit.diff', {...scope, commit:selectedCommit, path:file.path, ...(file.originalPath ? {originalPath:file.originalPath} : {})})
   .then(value => { if(ticket === fileGeneration.current) { setPair(value); setPairCommit(selectedCommit); } })
   .catch(error => { if(ticket === fileGeneration.current) setIssue(workbenchError(error, zh)); });
 }, [selectedCommit, file?.path]);
 useEffect(() => { setSelection(undefined); setDraft(undefined); }, [selectedCommit, file?.path, commentScope?.projectId, commentScope?.root]);
 const version = pair && !pair.binary && commit && pairCommit === selectedCommit ? {kind:'commit' as const, commit} : undefined;
 const marks = useMemo(() => !version || !pair ? [] : comments.filter(comment => comment.path === pair.path && sameCommentVersion(comment.version, version))
  .map(({side, startLine, endLine}) => ({side, startLine, endLine})), [comments, pair, version?.commit]);
 return <section className={`wb-history${graph ? ' graph' : ''}`} aria-label={path ? text(`History of ${path}`, `${path} 的历史`) : text('Git history', 'Git 历史')}>
  <div className="wb-history-list" role="listbox" aria-label={text('Commits', '提交')} onFocus={() => { listFocused.current=true; }} onBlur={event => { if(!event.currentTarget.contains(event.relatedTarget)) listFocused.current=false; }} onContextMenu={onCommitContext} onKeyDown={onCommitKey}>
   <header className="wb-history-title"><Icon name="clock"/><strong>{path ? baseName(path) : text('History', '提交历史')}</strong>{path && <span className="wb-dir" title={path}>{parentPath(path)}</span>}
    {!path && <div className="seg wb-history-scope" role="radiogroup" aria-label={text('History scope', '历史范围')}>
     <button type="button" role="radio" aria-checked={!allBranches} className={`seg-btn${allBranches ? '' : ' active'}`} onClick={() => chooseScope(false)}>{text('Current branch', '当前分支')}</button>
     <button type="button" role="radio" aria-checked={allBranches} className={`seg-btn${allBranches ? ' active' : ''}`} onClick={() => chooseScope(true)}>{text('All branches', '所有分支')}</button>
    </div>}</header>
   {notice && <p className="wb-notice" role="status">{notice}</p>}
   {issue && <p className="wb-issue" role="alert">{issue}<button type="button" className="icon-btn" aria-label={text('Dismiss', '关闭提示')} onClick={() => setIssue(undefined)}><Icon name="close"/></button></p>}
   {commits.map((commit, index) => <button type="button" role="option" aria-selected={commit.hash === selectedRow} tabIndex={commit.hash === selectedRow ? 0 : -1} ref={element => { if(element) commitRows.current.set(commit.hash,element); else commitRows.current.delete(commit.hash); }} key={commit.hash} data-commit-hash={commit.hash} onFocus={() => { focusedCommit.current=commit.hash; }}
    className={`wb-commit-row${commit.hash === selectedRow ? ' selected' : ''}`} onClick={() => selectCommit(commit.hash)}>
    {graph ? <GraphCell row={graph.rows[index]} width={graph.width} head={commit.refs.some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> '))}/>
     : <span className={`wb-lane${commit.parents.length > 1 ? ' merge' : ''}`} aria-hidden="true"/>}
    <span className="wb-commit-text">
     <span className="wb-commit-line"><span className="wb-commit-subject">{commit.subject || text('(no message)', '（无说明）')}</span>
      {commit.refs.map(ref => { const badge = refBadge(ref, remoteBranches); return <span key={ref} className={`wb-ref ${badge.kind}`} title={ref}>{badge.label}</span>; })}</span>
     <span className="wb-commit-meta">{commit.authorName} · {relativeTime(commit.authoredAt, zh)} · <code>{commit.hash.slice(0, 7)}</code></span>
    </span>
   </button>)}
   {!commits.length && !loading && !issue && <p className="wb-empty">{text('No commits yet.', '还没有提交。')}</p>}
   {hasMore && <button type="button" className="btn btn-sm wb-more" disabled={loading} onClick={() => void loadPage(commits.length)}>{loading ? text('Loading…', '正在读取…') : text('Load more', '加载更多')}</button>}
  </div>
  <div className="wb-history-detail">
   {info ? <>
    <header className="wb-commit-head">
     <strong>{info.subject}</strong>
     <span className="wb-commit-meta">{info.authorName} &lt;{info.authorEmail}&gt; · {new Date(info.authoredAt).toLocaleString()} · <code title={info.hash}>{info.hash.slice(0, 10)}</code>
      <button type="button" className="icon-btn" title={text('Copy commit hash', '复制提交哈希')} aria-label={text('Copy commit hash', '复制提交哈希')} onClick={() => copy(info.hash)}><Icon name="export"/></button></span>
     <span className="wb-operation-actions">{headerItems.map((item,index)=><button key={item.id} type="button" className="btn btn-sm" disabled={item.disabled} title={item.reason} onClick={()=>void openAction(headerKinds[index],info)}>{item.label}</button>)}</span>
     {commentsHost?.attachContext && <ContextSendAction host={commentsHost} item={{kind:'commit', id:crypto.randomUUID(), sha:info.hash, subject:info.subject} satisfies ContextItem} zh={zh} label={text('Send to agent', '发送给 Agent')} testId="history-send-to-agent"/>}
     {detail?.body && <pre className="wb-commit-body">{detail.body}</pre>}
    </header>
    <div className="wb-commit-files" role="list">
     {detail?.files.map(candidate => <button type="button" role="listitem" key={candidate.path} className={`wb-change-row tone-${candidate.status === 'A' ? 'added' : candidate.status === 'D' ? 'deleted' : candidate.status === 'R' ? 'renamed' : 'modified'}${file?.path === candidate.path ? ' selected' : ''}`}
      title={candidate.originalPath ? `${candidate.originalPath} → ${candidate.path}` : candidate.path} onClick={() => setFile({path:candidate.path, originalPath:candidate.originalPath})}>
      <Icon name="file"/><span className="wb-name">{baseName(candidate.path)}</span><span className="wb-dir">{parentPath(candidate.path)}</span><span className="wb-deco">{candidate.status}</span>
     </button>)}
     {detail && !detail.files.length && <p className="wb-empty">{text('No file changes in this folder.', '此目录中没有文件更改。')}</p>}
    </div>
    <div className="wb-history-diff">
     {file && <div className="file-bar"><span className="path" title={file.path}>{file.path}</span><span className="grow"/>{commentScope && version && <button type="button" className="btn btn-sm" disabled={!selection || Boolean(draft)} title={selection ? text('Comment on the selected lines', '评论选中的行') : text('Select lines (or put the cursor on a line) on either side first', '请先在任一侧选中行（或将光标放在某行）')} onClick={() => selection && setDraft(selection)}>{text('Comment', '评论')}</button>}{onOpenFile && <button type="button" className="btn btn-sm" onClick={() => onOpenFile(file.path)}>{text('Open current file', '打开当前文件')}</button>}</div>}
     {commentScope && version && pair && draft && <CommentForm scope={commentScope} path={pair.path} version={version} selection={draft} zh={zh} onCancel={() => setDraft(undefined)} onAdded={() => setDraft(undefined)}/>}
     {commentScope && commentsHost && <PendingComments scope={commentScope} host={commentsHost} comments={comments} zh={zh}/>}
     {pair?.binary ? <p className="tt-editor-state">{text('Binary file — no text diff.', '二进制文件，无法显示文本对比。')}</p>
      : pair ? <MergeEditor path={pair.path} oldText={pair.oldText} newText={pair.newText} readOnly onChange={() => {}} onSave={() => {}} onSelection={commentScope ? setSelection : undefined} onContextMenu={({x,y,selection,hasSelection,target,copy}) => fileDiffMenu({clientX:x, clientY:y, currentTarget:target}, selection, hasSelection, copy)} marks={commentScope ? marks : undefined}/>
      : file ? <p className="tt-editor-state">{text('Loading diff…', '正在读取对比…')}</p> : null}
    </div>
  </> : <p className="tt-editor-state">{selectedCommit ? text('Loading commit…', '正在读取提交…') : text('Select a commit.', '选择一个提交。')}</p>}
  </div>
  {resetReceipt&&resetUndoMatchesBranch(resetReceipt.symbolicHead,gitStatus?.branch)&&<p className="wb-notice" role="status">{text('The branch was reset.','分支已重置。')} <button type="button" className="btn btn-sm" disabled={actionBusy} onClick={()=>void undoReset()}>{text('Undo reset','撤销重置')}</button></p>}
  {dialog&&dialog.kind!=='worktree'&&<SurfaceDialog size="wide" icon="branch" title={dialog.kind==='branch'?text('New branch from here','从此处新建分支'):dialog.kind==='cherry-pick'?text('Cherry-pick commit','拣选提交'):dialog.kind==='revert'?text('Revert commit','还原提交'):text('Reset branch to here','将分支重置到此处')} subtitle={`${dialog.commit.hash.slice(0,7)} · ${dialog.commit.subject}`} onClose={()=>{if(!actionBusy)setDialog(undefined);}} footer={<><button type="button" className="btn" disabled={actionBusy} onClick={()=>setDialog(undefined)}>{text('Cancel','取消')}</button><button type="button" className={dialog.kind==='reset'?'btn btn-danger':'btn btn-primary'} disabled={actionBusy||Boolean(gitStatus?.operation)||(dialog.kind==='branch'&&(!branchName.trim()||!branchBase.trim()))} onClick={()=>void submitDialog()}>{actionBusy?text('Working…','正在执行…'):dialog.kind==='branch'?text('Create branch','创建分支'):dialog.kind==='revert'?text('Revert commit','还原提交'):dialog.kind==='reset'?text('Reset branch','重置分支'):text('Cherry-pick','拣选')}</button></>}>
   {dialog.kind==='branch'&&<><label className="field">{text('Branch name','分支名')}<input autoFocus value={branchName} onKeyDown={event=>{if(event.key==='Enter'&&branchName.trim()&&branchBase.trim())void submitDialog();}} onChange={event=>setBranchName(event.target.value)} aria-label={text('Branch name','分支名')} placeholder="feature/my-change"/></label><label className="field">{text('Base','基准')}<input value={branchBase} onChange={event=>setBranchBase(event.target.value)} aria-label={text('Base','基准')}/></label></>}
   {dialog.kind==='revert'&&<>{dialog.plan.parents.length>1?<label className="field">{text('Mainline parent','主线父提交')}<select value={mainline} onChange={event=>setMainline(Number(event.target.value))}>{dialog.plan.parents.map((parent,index)=><option key={parent.hash} value={index+1}>{text(`Parent ${index+1}: ${parent.subject}`,`父提交 ${index+1}：${parent.subject}`)}</option>)}</select></label>:<p>{text('Create a new commit that reverses this commit.','创建一个新提交来还原此提交。')}</p>}</>}
   {dialog.kind==='reset'&&<><p>{text('Choose how to keep the changes after moving the branch.','选择移动分支后保留更改的方式。')}</p><label><input type="radio" name="reset-mode" checked={resetMode==='soft'} onChange={()=>setResetMode('soft')}/>{text('Soft — keep changes staged','软重置 — 保留暂存的更改')}</label><label><input type="radio" name="reset-mode" checked={resetMode==='mixed'} onChange={()=>setResetMode('mixed')}/>{text('Mixed — keep changes unstaged','混合重置 — 保留未暂存的更改')}</label><p>{text('Commits leaving the branch:','将离开分支的提交：')}</p><div role="list" className="git-push-preview-list">{resetPreview?.commits.map(commit=><div key={commit.hash} role="listitem">{commit.hash.slice(0,7)} · {commit.subject}</div>)}{Boolean(resetPreview?.remaining)&&<div>{text(`and ${resetPreview!.remaining} more`,`以及另外 ${resetPreview!.remaining} 个`)}</div>}</div>{resetPreview?.pushed&&<p className="surface-error" role="alert">{text('Some of these commits are already pushed. The next push will need a force push.','其中一些提交已推送。下次推送将需要强制推送。')}</p>}</>}
  </SurfaceDialog>}
  {dialog?.kind==='worktree'&&projectPath&&<NewWorktree projectId={projectId} projectPath={projectPath} initialBase={dialog.plan.hash} onClose={()=>setDialog(undefined)} onCreated={()=>{if(isCurrent()){setDialog(undefined);setNotice(text('Worktree created.','工作树已创建。'));}}}/>}
 </section>;
}
