import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, Fragment, useContext } from "react";
import type { NativeSubagentSummary, CatalogVisibility, ProjectCatalogItem, ProviderCapability, Session, Worktree } from "@threadterm/protocol";
import { useMachineExpand, useMachines, useMachineTree } from '../machines';
import { machineTreeKey } from '../machineTypes';
import { request, subscribeEvents } from "../bridge";
import { projectCatalogStore } from '../projectCatalogStore';
import { displayPath, sameCanonicalScope } from "../projectScope";
import { useTranslation } from "../i18n";
import { NativeSubagentsContext } from '../nativeSubagents';
import { subagentTitle } from '../subagentActivity';
import { AgentTile, Icon, SessionIcon } from "./PrototypeIcon";
import { CatalogActions, CatalogPopover, restoreCatalogTarget, type CatalogTarget } from "./CatalogActions";
import "./project-catalog.css";
import "./mac-sidebar.css";
import { sessionState, sessionStateLabel } from "../sessionState";
import { isTerminalAttentionSession, sessionActivity, sessionActivityLabel } from "../sessionActivity";
import { isCodeReviewSession } from "../codeReview";
import { delegationQuiet, delegationQuietLabel, delegationStateLabel, nestedDelegateIds } from "../delegation";
import { QuietMinutes } from "./QuietMinutes";
import { boundedExpandedParents, EXPANDED_DELEGATES_KEY, foldedDelegateRows, readExpandedParents, type DelegateCatalogRow } from "../delegateFold";
import { DelegateGroupActions } from "./DelegateGroupActions";
import { catalogGroups, groupCatalogLabel, groupCatalogState, groupCatalogStatusClass, groupMemberIds, groupMemberLabel } from "../groupCatalog";
import { openGroup } from "../groupNavigation";
import { WbIcon } from "../workbench/icons";
import {
  activeDelegateParents,
  branchOrder,
  CATALOG_VIEW_KEY,
  projectShapeKnown,
  foldExpanded,
  foldedSummaryLabel,
  foldSummary,
  foldableBranches,
  needsYou,
  orderBranchSessions,
  orderBranches,
  orderRecentCandidates,
  recentRows,
  readCatalogView,
  selectedAncestors,
  setCatalogFold,
  splitBranchSessions,
  uniqueWorktrees,
  worktreeLabel,
  writeCatalogView,
  type CatalogFoldKind,
  type CatalogView,
  type FoldSummary,
} from "../catalogTidy";
import { updateCatalogFolds, useCatalogFolds } from "../catalogFolds";
import "./group-catalog.css";

type Props={selectedProjectId?:string;selectedWorktreePath?:string;selectedSessionId?:string;onAll:()=>void;onProject:(id:string)=>void;onWorktree?:(id:string,path?:string)=>void;sessions?:Session[];visibility?:CatalogVisibility[];onChanged?:()=>void;onSession?:(id:string)=>void;onNewSession?:(id?:string,path?:string)=>void;onScopeChange?:(id?:string)=>void;onAddProject?:()=>void;providers?:ProviderCapability[]};
const stateClass=(session:Session)=>session.readOnly?"ended":session.status==="waiting"?"needs":session.status==="error"?"failed":session.status==="interrupted"?"stalled":session.status==="exited"?"ended":"running";
const attentionStateClass=(session:Session)=>{
  if(isTerminalAttentionSession(session))return stateClass(session);
  const activity=sessionActivity(session);
  return activity==="awaiting_approval"||activity==="awaiting_input"?"needs":activity==="running"||activity==="awaiting_parent"?"running":"ended";
};
const treeState=(tree:Worktree,sessions:Session[])=>{
  if(tree.missing)return "stalled";
  const rank:Record<string,number>={ended:0,stalled:1,running:2,failed:3,needs:4};
  return sessions.map(attentionStateClass).reduce((best,state)=>rank[state]>rank[best]?state:best,"ended");
};
const activityStates=new Set(['running','awaiting_approval','awaiting_parent','awaiting_input','idle','unknown']);
/** How long the tree waits for every open project's shape before it draws what it has (see `layoutKnown`). */
const CATALOG_LAYOUT_WAIT_MS=2500;
/** Catalog stores whose tree this window has drawn: a remount draws at once and never waits again. */
const drawnCatalogs=new WeakSet<object>();
/**
 * Marks a session another agent started through ThreadTerm delegation with what its row does not
 * already show: a branch icon for a worktree delegate (branch in the tooltip), and the word
 * "delegate" only when it is not nested under its parent. The row title keeps the space.
 */
function DelegateChip({session,nested,zh}:{session:Session;nested:boolean;zh:boolean}){
  const delegation=session.delegation;
  if(!delegation)return null;
  // R6: a quiet delegate reads how long it has been silent, in the warning colour.
  const quiet=delegationQuiet(session),quietLabel=quiet?delegationQuietLabel(quiet.since,(en,cn)=>zh?cn:en):undefined;
  if(nested&&!delegation.branch&&!quiet)return null;
  const title=(zh?"由代理委派 · ":"Delegated by an agent · ")+(quietLabel??delegationStateLabel(delegation.state,zh))+(delegation.branch?" · "+delegation.branch:"");
  return <span className={"delegate-chip st-"+delegation.state+(quiet?" is-quiet":"")} title={title} aria-label={title}>{delegation.branch&&<Icon name="branch"/>}{quiet?<QuietMinutes since={quiet.since} copy={(en,cn)=>zh?cn:en}/>:!nested&&(zh?"委派":"delegate")}</span>;
}
const isActivity=(value:unknown):value is NonNullable<Session['activity']>=>Boolean(value)&&typeof value==='object'&&activityStates.has((value as {state?:unknown}).state as string)&&Number.isSafeInteger((value as {revision?:unknown}).revision)&&Number((value as {revision:number}).revision)>=0&&((value as {turnId?:unknown}).turnId===undefined||typeof (value as {turnId?:unknown}).turnId==='string')&&((value as {reason?:unknown}).reason===undefined||typeof (value as {reason?:unknown}).reason==='string');

/** Branch names shed their prefix (`feature/`) before the leaf, which is what tells branches apart. */
function BranchName({name}:{name:string}){
  const cut=name.lastIndexOf("/")+1;
  if(cut<=0||cut>=name.length)return <span className="branch">{name}</span>;
  return <span className="branch branch-split"><span className="branch-prefix">{name.slice(0,cut)}</span><span className="branch-leaf">{name.slice(cut)}</span></span>;
}

/** R1: the trailing summary of a folded project, branch or parent. */
function FoldMark({summary,zh}:{summary:FoldSummary|undefined;zh:boolean}){
  if(!summary)return null;
  const text=foldedSummaryLabel(summary,zh);
  if(summary.kind==="needs")return <span className="badge amber" aria-label={text} title={text}>{summary.count}</span>;
  if(summary.kind==="running")return <i className="fold-spin" role="status" aria-label={text} title={text}/>;
  return <span className="badge" aria-label={text} title={text}>{summary.count}</span>;
}

type SessionGroup={parent:Extract<DelegateCatalogRow,{kind:'session'}>;children:DelegateCatalogRow[]};
/** The rows between one top-level session and the next belong to it (delegates and their finished fold). */
function groupDelegateRows(rows:DelegateCatalogRow[]):SessionGroup[]{
  const groups:SessionGroup[]=[];
  for(const row of rows){
    if(row.kind==='session'&&!row.nested)groups.push({parent:row,children:[]});
    else if(groups.length)groups[groups.length-1].children.push(row);
  }
  return groups;
}
function descendantSessions<T extends {id:string;delegation?:{parentSessionId:string}}>(parentId:string,sessions:readonly T[]):T[]{
  const found:T[]=[],seen=new Set<string>([parentId]);
  let frontier=[parentId];
  while(frontier.length&&found.length<200){
    const next:string[]=[];
    for(const id of frontier)for(const session of sessions)if(session.delegation?.parentSessionId===id&&!seen.has(session.id)){seen.add(session.id);found.push(session);next.push(session.id);}
    frontier=next;
  }
  return found;
}

export function ProjectCatalog({selectedProjectId,selectedWorktreePath,selectedSessionId,onAll,onProject,onWorktree,sessions:sessionSnapshot,visibility=[],onChanged,onSession,onNewSession,onScopeChange,onAddProject,providers}:Props){
  const nativeSubagents = useContext(NativeSubagentsContext);
  const machine=useMachines(),machineTree=useMachineTree(),sharedTree=machine.enabled&&machine.machines.length>1;
  const folds=useCatalogFolds(),setFolds=updateCatalogFolds;
  const [view,setView]=useState<CatalogView>(()=>{try{return readCatalogView(localStorage.getItem(CATALOG_VIEW_KEY));}catch{return 'tree';}});
  const expandMachine=useMachineExpand();
  // The tree is drawn once its folds are known: the machine list decides whether this window shares one tree with
  // other computers, whose folds then come from the main process. Drawing defaults first made rows open, close and
  // open again on startup (11-19).
  const foldsKnown=machine.loaded!==false&&(!sharedTree||machineTree.loaded!==false);
  // R9: the selected chat's project, branch and parents read as open while its reveal is not saved yet (see the
  // effect below), so the first frame already shows it unfolded.
  const revealing=(kind:CatalogFoldKind,id:string)=>Boolean(pendingReveal&&(kind==='project'?pendingReveal.projectId===id:kind==='branch'?pendingReveal.branch===id:kind==='parent'&&pendingReveal.parents.includes(id)));
  const expanded=(kind:CatalogFoldKind,id:string)=>revealing(kind,id)||foldExpanded(folds,kind,id);
  const setFold=(kind:CatalogFoldKind,id:string,open:boolean)=>setFolds(current=>setCatalogFold(current,kind,id,open));
  const setManyFolds=(kind:CatalogFoldKind,ids:readonly string[],open:boolean)=>setFolds(current=>ids.reduce((next,id)=>setCatalogFold(next,kind,id,open),current));
  // With several computers the main process keeps this tree's folds in memory only: a fold it has not seen this run
  // falls back to the one saved here, so a restart does not open everything first.
  const projectOpen=(id:string)=>revealing('project',id)||(sharedTree?machineTree.expanded[machineTreeKey(machine.currentId,'project',id)]??foldExpanded(folds,'project',id):foldExpanded(folds,'project',id));
  const branchOpen=(path:string)=>revealing('branch',path)||(sharedTree?machineTree.expanded[machineTreeKey(machine.currentId,'branch',path)]??foldExpanded(folds,'branch',path):foldExpanded(folds,'branch',path));
  const machineExpandMany=(projectIds:readonly string[],paths:readonly string[],open:boolean)=>{
    for(const id of projectIds)void expandMachine(machineTreeKey(machine.currentId,'project',id),open);
    for(const path of paths)void expandMachine(machineTreeKey(machine.currentId,'branch',path),open);
    setFolds(current=>[...projectIds.map(id=>['project',id] as const),...paths.map(path=>['branch',path] as const)].reduce((next,[kind,id])=>setCatalogFold(next,kind,id,open),current));
  };
  const sessions=sessionSnapshot??[];
  const {locale}=useTranslation(),zh=locale==="zh-CN",label=(en:string,cn:string)=>zh?cn:en;
  const store=useMemo(()=>projectCatalogStore(machine.currentId,request),[machine.currentId]);
  const {items,trees,groups,answered,loaded,loading,issue:loadIssue}=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const [actionIssue,setIssue]=useState<string>(),issue=actionIssue??loadIssue;
  const [scopeProjectId,setScopeProjectId]=useState<string>(),[menuAnchor,setMenuAnchor]=useState<HTMLElement>(),[activities,setActivities]=useState<Record<string,NonNullable<Session['activity']>>>({}),[frozenOrder,setFrozenOrder]=useState<ReadonlyMap<string,number>>(),activityEpoch=useRef<string|undefined>(undefined);
  const rootRef=useRef<HTMLElement>(null);
  const catalogSessions=useMemo(()=>sessions.filter(session=>!isCodeReviewSession(session)).map(session=>{const snapshotActivity=session.activity,override=activities[session.id];return !override||snapshotActivity&&snapshotActivity.revision>=override.revision?session:{...session,activity:override};}),[sessions,activities]);
  const [expandedDelegates,setExpandedDelegates]=useState<string[]>(()=>{try{return readExpandedParents(localStorage.getItem(EXPANDED_DELEGATES_KEY));}catch{return [];}});
  const [revealedId,setRevealedId]=useState<string>();
  /** R9: what has to be open to show the selected chat; undefined until its project's branch list is known. */
  const revealTarget=useMemo(()=>{
    if(!selectedSessionId)return undefined;
    const session=catalogSessions.find(row=>row.id===selectedSessionId);
    if(!session)return undefined;
    const parents=[...selectedAncestors(catalogSessions,session.id)];
    if(!session.projectId)return {id:session.id,projectId:undefined,branch:undefined,parents};
    const project=items.find(item=>item.id===session.projectId),projectTrees=trees[session.projectId];
    if(!project||!projectTrees)return undefined;
    const tree=projectTrees.find(row=>sameCanonicalScope(row.path,session.worktreePath??project.path));
    return {id:session.id,projectId:session.projectId,branch:tree?.path,parents};
  },[selectedSessionId,catalogSessions,items,trees]);
  const pendingReveal=foldsKnown&&revealTarget&&revealedId!==revealTarget.id?revealTarget:undefined;
  useEffect(()=>{try{localStorage.setItem(CATALOG_VIEW_KEY,writeCatalogView(view));}catch{/* The choice still holds for this window. */}},[view]);
  useEffect(()=>{
    if(!sessionSnapshot)return;
    const next=boundedExpandedParents(expandedDelegates,new Set(sessions.map(session=>session.id)));
    if(next.length!==expandedDelegates.length)setExpandedDelegates(next);
    try{localStorage.setItem(EXPANDED_DELEGATES_KEY,JSON.stringify(next));}catch{/* Folding still works when storage is unavailable. */}
  },[sessionSnapshot,expandedDelegates]);
  const renderNativeSubagent = (agent: NativeSubagentSummary) => {
    const title = subagentTitle(agent, label);
    const state = delegationStateLabel(agent.status, zh);
    return <div className="sess-row-wrap is-delegate" key={agent.key} data-subagent-key={agent.key}>
      <div className="sess-row" title={title + " · " + state}>
        <span className="bico"><AgentTile provider={agent.provider} size={16} /></span>
        <span className="grow">{title}</span>
        <span className={`delegate-chip st-${agent.status}`}>{state}</span>
      </div>
    </div>;
  };
  const renderRunningSubagents = (row: Extract<DelegateCatalogRow, {kind:'session'}>) => row.nativeRunning && <>
    <div className="sess-row-wrap is-delegate"><div className="sess-row delegate-fold-row">
      <span className="grow">{label(`${row.activeCount} active`, `${row.activeCount} 个进行中`)}</span>
    </div></div>
    {row.nativeRunning.map(renderNativeSubagent)}
  </>;
  const renderDelegateFold = (row: Extract<DelegateCatalogRow, {kind:'fold'}>) => <Fragment key={`fold:${row.parentId}`}>
    <div className="sess-row-wrap is-delegate">
      <button type="button" className="sess-row delegate-fold-row" data-parent-id={row.parentId} aria-expanded={row.expanded}
        onClick={() => setExpandedDelegates(current => row.expanded ? current.filter(id => id !== row.parentId) : boundedExpandedParents([...current, row.parentId]))}>
        <span className="bico" aria-hidden="true" />
        <span className="grow">{label(`${row.count} finished`, `${row.count} 个已结束`)}</span>
      </button>
      {row.sessionIds.length > 0 && <DelegateGroupActions parentTitle={catalogSessions.find(session => session.id === row.parentId)?.title ?? ""}
        sessionIds={row.sessionIds} sessions={catalogSessions} onChanged={changed} onMenuOpenChange={onCatalogMenuOpenChange} />}
    </div>
    {row.expanded && row.nativeFinished?.map(renderNativeSubagent)}
  </Fragment>;
  const visibilityOf=(kind:CatalogVisibility["kind"],id:string)=>visibility.find(row=>row.kind===kind&&row.id===id)?.visibility??"active";
  const reload=store.reload;
  useEffect(()=>{const deactivate=store.activate();const unsubscribe=subscribeEvents(event=>{const data=event.data as {kind?:unknown;sessionId?:unknown;activity?:unknown;state?:unknown}|null,kind=data?.kind,sessionId=data?.sessionId,activity=data?.activity;if(event.event==="session.activity"&&typeof sessionId==="string"&&isActivity(activity)){if(activityEpoch.current&&activityEpoch.current!==event.epoch)setActivities({});activityEpoch.current=event.epoch;setActivities(current=>current[sessionId]?.revision!==undefined&&current[sessionId].revision>activity.revision?current:{...current,[sessionId]:activity});}if(event.event==="runtime.transport"&&['reconnected','disconnected','incompatible'].includes(String(data?.state))){activityEpoch.current=undefined;setActivities({});store.transport(data?.state);}if(event.event==="state.changed"&&String(kind)==="group")store.reloadGroups();else if(event.event==="state.changed"&&["project","project.catalog","worktree","catalog.visibility"].includes(String(kind)))void reload();});return()=>{deactivate();unsubscribe();};},[store]);
  useEffect(()=>{const active=new Set(sessions.map(session=>session.id));setActivities(current=>{const next=Object.fromEntries(Object.entries(current).filter(([id])=>active.has(id)));return Object.keys(next).length===Object.keys(current).length?current:next;});},[sessions]);
  const changed=()=>{setIssue(undefined);void reload();onChanged?.();};
  const hide=(target:CatalogTarget)=>{
    if(target.kind==="project"&&selectedProjectId===target.id||target.kind==="worktree"&&selectedProjectId===target.projectId&&sameCanonicalScope(target.path,selectedWorktreePath)||target.kind==="session"&&selectedSessionId===target.id)onAll();
    if(target.kind==="project"&&scopeProjectId===target.id){setScopeProjectId(undefined);onScopeChange?.();}
  };
  const onCatalogMenuOpenChange=useCallback((open:boolean)=>setFrozenOrder(current=>open?current??branchOrder(catalogSessions):undefined),[catalogSessions]);
  // Project and branch rows fold on click; ＋ beside ⋯ starts a session there in one click.
  const newIn=(projectId:string,path:string|undefined,name:string)=>onNewSession&&<button type="button" className="icon-btn tree-new" aria-label={label(`New terminal in ${name}`,`在 ${name} 中新建终端`)} title={label("New terminal","新建终端")} onClick={()=>onNewSession(projectId,path)}><Icon name="plus"/></button>;
  const actions=(target:CatalogTarget)=><CatalogActions target={target} projects={items} trees={trees[target.projectId]??[]} sessions={catalogSessions} providers={providers} visibility={visibility} onChanged={changed} onHidden={()=>hide(target)} onWorktree={(id,path)=>path===undefined?onProject(id):onWorktree?.(id,path)} onNewSession={onNewSession} onMenuOpenChange={onCatalogMenuOpenChange}/>;
  const projectTarget=(item:ProjectCatalogItem):CatalogTarget=>({kind:"project",id:item.id,name:item.name,path:item.path,projectId:item.id});
  const closeMenu=()=>setMenuAnchor(undefined);
  const selectScope=(id?:string)=>{setScopeProjectId(id);closeMenu();onScopeChange?.(id);};
  const scopeName=items.find(item=>item.id===scopeProjectId)?.name??label("all projects","全部项目");
  const scoped=items.filter(item=>visibilityOf("project",item.id)==="active"&&(!scopeProjectId||scopeProjectId===item.id));
  // 11-19 (second report): on a cold start the runtime lists the projects before Git has read them (a repository not
  // read yet comes as "not a repository") and before their branch lists and groups. Drawing every partial answer
  // listed a project's chats flat, then nothing, then as its branch tree: open, closed, open again. A project's rows
  // are drawn once their shape is known, and the tree waits for every open project, at most CATALOG_LAYOUT_WAIT_MS
  // after the list; once drawn it is never hidden again.
  const shapeKnown=(item:ProjectCatalogItem)=>projectShapeKnown(item,(kind,id)=>answered[`${kind}:${id}`]===true);
  const layoutKnown=foldsKnown&&loaded&&scoped.every(item=>!projectOpen(item.id)||shapeKnown(item));
  const [layoutDrawn,setLayoutDrawn]=useState(()=>drawnCatalogs.has(store));
  const layoutWaiting=foldsKnown&&loaded&&!layoutDrawn&&!layoutKnown;
  useEffect(()=>{if(layoutKnown&&!layoutDrawn){drawnCatalogs.add(store);setLayoutDrawn(true);}},[layoutKnown,layoutDrawn,store]);
  useEffect(()=>{
    if(!layoutWaiting)return;
    const timer=setTimeout(()=>{drawnCatalogs.add(store);setLayoutDrawn(true);},CATALOG_LAYOUT_WAIT_MS);
    return()=>clearTimeout(timer);
  },[layoutWaiting,store]);
  const showTree=foldsKnown&&(layoutDrawn||layoutKnown);
  const renderGroups=(groupsToRender:ReturnType<typeof catalogGroups>)=>groupsToRender.map(({group,members})=>{
    const state=groupCatalogState(group.members,catalogSessions),stateLabel=groupCatalogLabel(group.members,zh,catalogSessions);
    return <div className="group-catalog-group" key={group.id}><button type="button" className="sess-row group-row" data-group-id={group.id} title={`${group.title} · ${stateLabel}`} onClick={()=>openGroup(group)}><span className="bico"><WbIcon name="users"/></span><span className="grow">{group.title}</span><span className={`group-state ${groupCatalogStatusClass(state)}`}>{stateLabel}</span></button><div className="group-members">{members.map(session=>{const activity=sessionActivity(session),activityLabel=sessionActivityLabel(activity,zh),member=group.members.find(value=>value.sessionId===session.id),memberLabel=member?groupMemberLabel(member.handle):session.title;return <div className="sess-row-wrap group-member" data-session-id={session.id} data-activity={activity}><button type="button" className={`sess-row${session.id===selectedSessionId?" active":""}`} data-session-id={session.id} data-activity={activity} title={session.title+" · "+activityLabel} onClick={()=>onSession?.(session.id)}><span className={`bico session-activity-${activity}`} aria-label={activityLabel} title={activityLabel}><span className="session-agent-icon"><SessionIcon session={session}/>{activity==="running"&&<i className="session-attention-ring"/>}</span><i className={`bico-dot st-${attentionStateClass(session)}`}/></span><span className="grow">{memberLabel}</span></button></div>;})}</div></div>;
  });

  /* R9: when the selected session changes, unfold its project, branch and parents, then scroll to it. The rows read
     as open from the first frame (`revealing`); this effect then saves the folds once. The branch list loads after
     the first render, so the reveal waits for it: marking it done before left the branch folded for good. */
  useEffect(()=>{
    if(!pendingReveal)return;
    const {id,projectId,branch,parents}=pendingReveal;
    setRevealedId(id);
    setFolds(current=>{
      let next=current;
      if(projectId)next=setCatalogFold(next,'project',projectId,true);
      if(branch)next=setCatalogFold(next,'branch',branch,true);
      for(const parent of parents)next=setCatalogFold(next,'parent',parent,true);
      return next;
    });
    if(sharedTree&&projectId){void expandMachine(machineTreeKey(machine.currentId,'project',projectId),true);if(branch)void expandMachine(machineTreeKey(machine.currentId,'branch',branch),true);}
  },[pendingReveal,sharedTree,machine.currentId,expandMachine]);
  useEffect(()=>{
    if(!selectedSessionId)return;
    let frame=0,tries=0;
    const find=()=>Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-session-id]')??[]).find(node=>node.dataset.sessionId===selectedSessionId);
    const tick=()=>{const node=find();if(node)node.scrollIntoView({block:'nearest'});else if(tries++<12)frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(frame);
  },[selectedSessionId,view]);

  const openSessionTarget=(item:ProjectCatalogItem,session:Session):CatalogTarget=>({kind:"session",id:session.id,name:session.title,path:session.worktreePath??item.path,projectId:item.id});
  const parentIdsOf=(rows:readonly DelegateCatalogRow[])=>groupDelegateRows(rows as DelegateCatalogRow[]).filter(group=>group.children.length>0).map(group=>group.parent.session.id);
  const summaryOf=(sessionsToSummarise:readonly Session[],nativeParent?:string):FoldSummary|undefined=>{
    const base=foldSummary(sessionsToSummarise);
    if(base?.kind==='needs')return base;
    if(nativeParent&&(nativeSubagents?.[nativeParent]??[]).some(agent=>agent.status==='running'))return {kind:'running'};
    return base;
  };

  const renderSessionRow=(row:Extract<DelegateCatalogRow,{kind:'session'}>,treeTarget:CatalogTarget,options:{hasChildren?:boolean;childCount?:number;open?:boolean;summary?:FoldSummary;onToggleChildren?:(event:React.MouseEvent)=>void}={})=>{
    const session=row.session,activity=sessionActivity(session),quiet=delegationQuiet(session);
    const activityLabel=quiet?delegationQuietLabel(quiet.since,label):isTerminalAttentionSession(session)?sessionStateLabel(sessionState(session),zh,session.readOnly,Boolean(session.released)):sessionActivityLabel(activity,zh);
    const needsAttention=activity==="awaiting_approval"||activity==="awaiting_input";
    const ended=isTerminalAttentionSession(session);
    const hasChildren=Boolean(options.hasChildren);
    // A parent's delegates fold from the tag at the row's end, never over its agent icon. Folded, the tag carries
    // what the delegates are doing: amber when one needs you, a spinner while one runs.
    const count=options.childCount??0,summary=options.open?undefined:options.summary;
    const kidState=summary?.kind==="needs"?" is-needs":summary?.kind==="running"?" is-running":"";
    const kidLabel=label(`${count} delegated agents`,`${count} 个子智能体`)+(summary?" · "+foldedSummaryLabel(summary,zh):"");
    return <Fragment key={session.id}>
      <div className={"sess-row-wrap"+(row.nested?" is-delegate":"")+(hasChildren?" has-children":"")+(ended?" is-ended":"")} data-session-id={session.id} data-activity={activity}>
        {needsAttention&&<i className="session-attention-bar" aria-hidden="true"/>}
        <button type="button" className={"sess-row"+(session.id===selectedSessionId?" active":"")} data-session-id={session.id} data-activity={activity} title={session.title+" · "+activityLabel} onClick={()=>onSession?.(session.id)}><span className={`bico session-activity-${activity}`} aria-label={activityLabel} title={activityLabel}><span className="session-agent-icon"><SessionIcon session={session}/>{activity==="running"&&<i className="session-attention-ring"/>}</span>{needsAttention&&<Icon name="bell" className="session-attention-icon" aria-hidden="true"/>}<i className={"bico-dot st-"+attentionStateClass(session)}/></span><span className="grow">{session.title}</span><DelegateChip session={session} nested={row.nested} zh={zh}/>{session.followed&&<span className="follow-star" aria-label={label("Followed","已关注")}>★</span>}</button>
        {hasChildren&&<button type="button" className={"kid-pill"+(options.open?" open":"")+kidState} aria-expanded={Boolean(options.open)} aria-label={kidLabel+" · "+session.title} title={(options.open?label("Hide delegated agents","收起子智能体"):label("Show delegated agents","展开子智能体"))+" · "+kidLabel} onClick={options.onToggleChildren}>{summary?.kind==="running"?<i className="fold-spin" aria-hidden="true"/>:<Icon name="nest"/>}<span className="kid-count">{count}</span></button>}
        {actions({...treeTarget,kind:"session",id:session.id,name:session.title})}</div>
      {options.open!==false&&renderRunningSubagents(row)}
    </Fragment>;
  };

  const renderRows=(rows:DelegateCatalogRow[],treeTarget:CatalogTarget,allSessions:readonly Session[],parentIds:readonly string[],onToggleParent:(session:Session,event:React.MouseEvent)=>void)=>{
    const groups=groupDelegateRows(rows);
    return groups.map(group=>{
      const parentId=group.parent.session.id,hasChildren=group.children.length>0,open=expanded('parent',parentId);
      const children=descendantSessions(parentId,allSessions);
      return <Fragment key={parentId}>
        {renderSessionRow(group.parent,treeTarget,{hasChildren,childCount:children.filter(child=>child.delegation?.parentSessionId===parentId).length||children.length,open,summary:hasChildren?summaryOf(children,parentId):undefined,onToggleChildren:event=>onToggleParent(group.parent.session,event)})}
        {hasChildren&&open&&group.children.map(row=>row.kind==='fold'?renderDelegateFold(row):renderSessionRow(row,treeTarget))}
      </Fragment>;
    });
  };

  const renderBranch=(item:ProjectCatalogItem,tree:Worktree,context:{projectSessions:Session[];allSessions:Session[];projectGroups:ReturnType<typeof catalogGroups>;memberIds:Set<string>;siblings:Worktree[];inOther?:boolean})=>{
    const {projectSessions,allSessions,projectGroups,memberIds,siblings}=context;
    const branchName=worktreeLabel(tree,item.path,label("Local directory","本地目录"));
    const target:CatalogTarget={kind:"worktree",id:tree.id,name:branchName,path:tree.path,projectId:item.id,worktreeId:tree.id};
    const treeAllSessions=projectSessions.filter(session=>sameCanonicalScope(session.worktreePath??item.path,tree.path));
    const treeSessions=treeAllSessions.filter(session=>!memberIds.has(session.id));
    const nested=nestedDelegateIds(allSessions);
    const topLevel=treeSessions.filter(session=>!nested.has(session.id));
    const ordered=orderBranchSessions(topLevel,frozenOrder);
    const pinnedParents=new Set([...activeDelegateParents(allSessions,nativeSubagents),...selectedAncestors(allSessions,selectedSessionId)]);
    const {shown,older}=splitBranchSessions(ordered,{selectedId:selectedSessionId,activeDelegateParents:pinnedParents});
    const olderOpen=expanded('older',tree.path);
    const visible=olderOpen?ordered:shown;
    const rows=foldedDelegateRows(visible,allSessions,selectedSessionId,expandedDelegates,undefined,nativeSubagents);
    const parentIds=parentIdsOf(rows);
    const treeGroups=projectGroups.filter(value=>sameCanonicalScope(value.group.worktreePath??item.path,tree.path));
    const selected=selectedProjectId===item.id&&Boolean(selectedWorktreePath)&&sameCanonicalScope(tree.path,selectedWorktreePath);
    const holdsSelection=selected&&treeAllSessions.some(session=>session.id===selectedSessionId);
    const open=branchOpen(tree.path);
    const toggleBranch=(event:React.MouseEvent)=>{
      const next=!open;
      if(event.altKey){
        const paths=siblings.map(value=>value.path);
        if(sharedTree)machineExpandMany([],paths,next);else setManyFolds('branch',paths,next);
        return;
      }
      if(sharedTree)void expandMachine(machineTreeKey(machine.currentId,'branch',tree.path),next);setFold('branch',tree.path,next);
    };
    const toggleParent=(session:Session,event:React.MouseEvent)=>{
      const next=!expanded('parent',session.id);
      if(event.altKey)setManyFolds('parent',parentIds,next);else setFold('parent',session.id,next);
    };
    // The row is the fold switch. A branch with nothing under it has nothing to fold, so it opens its page instead.
    const empty=treeAllSessions.length===0&&treeGroups.length===0;
    return <div className={"catalog-tree-group"+(context.inOther?" in-other":"")} key={tree.id}><div className={"tree-row-wrap"+(selected?" current":"")+(tree.missing?" gone":"")}>
      <button type="button" className={"tree-row"+(selected&&!holdsSelection?" active":"")+(holdsSelection?" contains-active":"")+(tree.missing?" gone":"")} aria-expanded={empty?undefined:open} title={`${branchName}\n${displayPath(tree.path)}`} onClick={event=>empty?onWorktree?.(item.id,tree.path):toggleBranch(event)}><span className="bico"><Icon name="branch"/><i className={"bico-dot st-"+treeState(tree,treeAllSessions)}/></span><BranchName name={branchName}/>{tree.missing&&<span className="row-tag">{label("Deleted","已删除")}</span>}{!open&&<FoldMark summary={summaryOf(treeAllSessions)} zh={zh}/>}</button>{newIn(item.id,tree.path,branchName)}{actions(target)}
    </div>
      {open&&<>
        {renderGroups(treeGroups)}
        {renderRows(rows,target,allSessions,parentIds,toggleParent)}
        {older.length>0&&<button type="button" className="catalog-fold-row older-fold-row" aria-expanded={olderOpen} onClick={()=>setFold('older',tree.path,!olderOpen)}><span className="grow">{olderOpen?label("Hide older sessions","收起较早的会话"):label(`${older.length} older sessions`,`更早的 ${older.length} 个会话`)}</span></button>}
      </>}
    </div>;
  };

  const headerLabel=view==="recent"?label("Recent","最近"):scopeProjectId?`${label("Projects","项目")} · ${scopeName}`:label("Projects","项目");
  const allProjectIds=scoped.map(item=>item.id);
  const allTreePaths=scoped.flatMap(item=>(trees[item.id]??[]).filter(tree=>visibilityOf('worktree',tree.id)==='active').map(tree=>tree.path));
  const allParentIds=catalogSessions.filter(session=>session.delegation).map(session=>session.delegation!.parentSessionId);
  const allOlderIds=[...allTreePaths,...allProjectIds];
  const applyFoldMenu=(action:'collapse'|'current'|'expand')=>{
    closeMenu();
    // Collapse all / Expand all act on projects, branches and parents. The older-sessions and other-branches folds
    // keep their state: opening them all would bring back the clutter they exist to hide.
    if(action==='collapse'||action==='expand'){
      const open=action==='expand';
      if(sharedTree)machineExpandMany(allProjectIds,allTreePaths,open);
      setFolds(current=>[
        ...(sharedTree?[]:[...allProjectIds.map(id=>['project',id] as const),...allTreePaths.map(path=>['branch',path] as const)]),...allParentIds.map(id=>['parent',id] as const),
      ].reduce((next,[kind,id])=>setCatalogFold(next,kind,id,open),current));
      return;
    }
    // Only the current project, branch and parent chain stays unfolded.
    const session=selectedSessionId?catalogSessions.find(row=>row.id===selectedSessionId):undefined;
    const projectId=selectedProjectId??session?.projectId;
    const project=projectId?items.find(row=>row.id===projectId):undefined;
    const tree=projectId?(trees[projectId]??[]).find(row=>sameCanonicalScope(row.path,session?.worktreePath??project?.path)):undefined;
    const branchPath=tree?.path??selectedWorktreePath;
    const parents=selectedAncestors(catalogSessions,selectedSessionId);
    if(sharedTree){
      machineExpandMany(allProjectIds,allTreePaths,false);
      if(projectId)void expandMachine(machineTreeKey(machine.currentId,'project',projectId),true);
      if(branchPath)void expandMachine(machineTreeKey(machine.currentId,'branch',branchPath),true);
    }
    setFolds(current=>[
      ...allProjectIds.map(id=>['project',id] as const),...allTreePaths.map(path=>['branch',path] as const),...allParentIds.map(id=>['parent',id] as const),
      ...allOlderIds.map(id=>['older',id] as const),...allProjectIds.map(id=>['other',id] as const),
    ].reduce((next,[kind,id])=>setCatalogFold(next,kind,id,false),current));
    setFolds(current=>[...(projectId?[['project',projectId] as const]:[]),...(branchPath?[['branch',branchPath] as const]:[]),...[...parents].map(id=>['parent',id] as const)]
      .reduce((next,[kind,id])=>setCatalogFold(next,kind,id,true),current));
  };

  const renderProject=(item:ProjectCatalogItem)=>{
    const projectSessions=catalogSessions.filter(session=>session.projectId===item.id&&!session.archived&&visibilityOf("session",session.id)==="active");
    const projectGroups=catalogGroups(groups[item.id]??[],projectSessions),memberIds=groupMemberIds(projectGroups.map(value=>value.group));
    const visibleProjectSessions=projectSessions.filter(session=>!memberIds.has(session.id));
    const actualTrees=uniqueWorktrees((trees[item.id]??[]).filter(tree=>visibilityOf("worktree",tree.id)==="active"));
    const plainDirectorySessions=!item.git.available&&(trees[item.id]??[]).length===0?visibleProjectSessions:[];
    const sessionsOf=(tree:Worktree)=>projectSessions.filter(session=>sameCanonicalScope(session.worktreePath??item.path,tree.path));
    const nameOf=(tree:Worktree)=>worktreeLabel(tree,item.path,label("Local directory","本地目录"));
    const ordered=orderBranches(actualTrees,sessionsOf,nameOf);
    const isCurrent=(tree:Worktree)=>Boolean(selectedProjectId===item.id&&selectedWorktreePath&&sameCanonicalScope(tree.path,selectedWorktreePath))
      ||projectSessions.some(session=>session.id===selectedSessionId&&sameCanonicalScope(session.worktreePath??item.path,tree.path));
    const {listed,other}=foldableBranches(ordered,sessionsOf,{isCurrent});
    const otherOpen=expanded('other',item.id);
    const open=projectOpen(item.id);
    const siblings=[...listed,...(otherOpen?other:[])];
    const toggleProject=(event:React.MouseEvent)=>{
      const next=!open;
      if(event.altKey){
        if(sharedTree)machineExpandMany(allProjectIds,[],next);else setManyFolds('project',allProjectIds,next);
        return;
      }
      if(sharedTree)void expandMachine(machineTreeKey(machine.currentId,'project',item.id),next);setFold('project',item.id,next);
    };
    const plainTarget:CatalogTarget={kind:"worktree",id:`plain:${item.id}`,name:item.name,path:item.path,projectId:item.id};
    const plainNested=nestedDelegateIds(plainDirectorySessions);
    const plainOrdered=orderBranchSessions(plainDirectorySessions.filter(session=>!plainNested.has(session.id)),frozenOrder);
    const plainPinned=new Set([...activeDelegateParents(plainDirectorySessions,nativeSubagents),...selectedAncestors(plainDirectorySessions,selectedSessionId)]);
    const plainSplit=splitBranchSessions(plainOrdered,{selectedId:selectedSessionId,activeDelegateParents:plainPinned});
    const plainOlderOpen=expanded('older',item.id);
    const plainRows=plainDirectorySessions.length?foldedDelegateRows(plainOlderOpen?plainOrdered:plainSplit.shown,plainDirectorySessions,selectedSessionId,expandedDelegates,undefined,nativeSubagents):[];
    const plainParentIds=parentIdsOf(plainRows);
    const togglePlainParent=(session:Session,event:React.MouseEvent)=>{
      const next=!expanded('parent',session.id);
      if(event.altKey)setManyFolds('parent',plainParentIds,next);else setFold('parent',session.id,next);
    };
    // The row is the fold switch, like a source list's group; the folder opens and closes with it. The project page
    // is in the row's ⋯ menu, and ＋ starts a session here.
    return <div className="proj-group" key={item.id}><div className={"proj-row-wrap"+(selectedProjectId===item.id&&!selectedWorktreePath?" active":"")}>
      <button type="button" className="proj-row" aria-expanded={open} title={displayPath(item.path)} onClick={toggleProject}><Icon name={open?"folderOpen":"folder"}/><span className="grow">{item.name}</span>{item.pinned&&<span className="follow-star">★</span>}{!open&&<FoldMark summary={summaryOf(projectSessions)} zh={zh}/>}</button>{newIn(item.id,undefined,item.name)}{actions(projectTarget(item))}
    </div>{open&&shapeKnown(item)&&<div className="tree-list">
      {listed.map(tree=>renderBranch(item,tree,{projectSessions,allSessions:visibleProjectSessions,projectGroups,memberIds,siblings}))}
      {other.length>0&&<>
        <button type="button" className="catalog-fold-row other-fold-row" aria-expanded={otherOpen} onClick={()=>setFold('other',item.id,!otherOpen)}><span className="grow">{otherOpen?label("Hide other branches","收起其他分支"):label(`${other.length} other branches`,`其他 ${other.length} 个分支`)}</span></button>
        {otherOpen&&other.map(tree=>renderBranch(item,tree,{projectSessions,allSessions:visibleProjectSessions,projectGroups,memberIds,siblings,inOther:true}))}
      </>}
      {!ordered.length&&renderGroups(projectGroups)}
      {plainRows.length>0&&renderRows(plainRows,plainTarget,plainDirectorySessions,plainParentIds,togglePlainParent)}
      {plainSplit.older.length>0&&<button type="button" className="catalog-fold-row older-fold-row" aria-expanded={plainOlderOpen} onClick={()=>setFold('older',item.id,!plainOlderOpen)}><span className="grow">{plainOlderOpen?label("Hide older sessions","收起较早的会话"):label(`${plainSplit.older.length} older sessions`,`更早的 ${plainSplit.older.length} 个会话`)}</span></button>}
    </div>}</div>;
  };

  const renderRecent=()=>{
    const now=Date.now();
    const candidates=orderRecentCandidates(catalogSessions.flatMap(session=>{
      const item=session.projectId?items.find(row=>row.id===session.projectId):undefined;
      if(!item||visibilityOf('project',item.id)!=='active'||visibilityOf('session',session.id)!=='active'||session.archived)return [];
      if(scopeProjectId&&scopeProjectId!==item.id)return [];
      const tree=(trees[item.id]??[]).find(row=>sameCanonicalScope(row.path,session.worktreePath??item.path));
      const where=tree?`${item.name} · ${worktreeLabel(tree,item.path,label("Local directory","本地目录"))}`:item.name;
      return [{session,where}];
    }));
    const rows=recentRows(candidates,{now,zh});
    return <div className="side-tree catalog-recent-list">
      {rows.map(row=>{
        if(row.kind==='day')return <div className="catalog-recent-day" key={`day:${row.day}`}>{row.label}</div>;
        const session=row.session,item=items.find(value=>value.id===session.projectId);
        if(!item)return null;
        const activity=sessionActivity(session),ended=isTerminalAttentionSession(session),waiting=needsYou(session),target=openSessionTarget(item,session);
        return <div className={"sess-row-wrap catalog-recent-row-wrap"+(ended?" is-ended":"")} key={session.id} data-session-id={session.id} data-activity={activity}>
          <button type="button" className={"sess-row catalog-recent-row"+(session.id===selectedSessionId?" active":"")} data-session-id={session.id} data-activity={activity} title={session.title+" · "+row.where} onClick={()=>onSession?.(session.id)}>
            <span className={`bico session-activity-${activity}`}><span className="session-agent-icon"><SessionIcon session={session}/>{activity==="running"&&<i className="session-attention-ring"/>}</span></span>
            <span className="catalog-recent-two"><span className="catalog-recent-title">{session.title}</span><span className="catalog-recent-where">{row.where}</span></span>
            {waiting?<i className="bico-dot st-needs" aria-label={label("Needs you","需要你")}/>:<span className="catalog-recent-when">{row.when}</span>}
          </button>{actions(target)}
        </div>;
      })}
      <button type="button" className="catalog-fold-row catalog-recent-all" onClick={onAll}><span className="grow">{label("All sessions are in All terminals","全部会话在「所有终端」")}</span></button>
    </div>;
  };

  return <section className="project-catalog" aria-label={label("Project catalog","项目目录")} ref={rootRef}>
    <div className="catalog-head">
      <span className="catalog-head-label" title={headerLabel}>{headerLabel}</span>
      <div className="catalog-view-seg" role="group" aria-label={label("Catalog view","目录视图")}>
        <button type="button" className={view==="tree"?"on":""} data-view="tree" aria-pressed={view==="tree"} onClick={()=>setView('tree')}>{label("Projects","项目")}</button>
        <button type="button" className={view==="recent"?"on":""} data-view="recent" aria-pressed={view==="recent"} onClick={()=>setView('recent')}>{label("Recent","最近")}</button>
      </div>
      <button type="button" className="side-label side-scope" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} aria-label={label("Project scope","项目范围")} title={scopeName} onClick={event=>setMenuAnchor(menuAnchor?undefined:event.currentTarget)}><Icon name="more"/></button>
    </div>
    {view==="recent"?renderRecent():<div className="side-tree">{showTree&&scoped.map(renderProject)}</div>}
    {(loading&&!items.length||view==="tree"&&!showTree&&items.length>0)&&!issue&&<p className="side-empty" role="status">{label("Loading projects…","正在加载项目…")}</p>}
    {loaded&&!loading&&!items.length&&!issue&&<p className="side-empty">{label("No projects yet. Add a directory to get started.","还没有项目，请先添加目录。")}</p>}{issue&&<p className="side-empty" role="alert" title={issue}>{actionIssue??(items.length?label("Some project details did not load. Retrying…","部分项目信息没有加载出来，正在重试…"):label("Projects did not load yet. Retrying…","项目列表还没有加载出来，正在重试…"))} <button type="button" className="btn btn-sm" onClick={()=>{setIssue(undefined);void reload();}}>{label("Try again","重试")}</button></p>}
    {menuAnchor&&<CatalogPopover anchor={menuAnchor} onClose={closeMenu} label={label("Project scope","项目范围")}>
      {onAddProject&&<button type="button" role="menuitem" className="menu-item" onClick={()=>{closeMenu();onAddProject();}}><Icon name="plus"/>{label("Add project","添加项目")}</button>}
      {onAddProject&&<div className="menu-sep"/>}
      <button type="button" role="menuitem" className="menu-item" onClick={()=>selectScope()}><Icon name="folder"/>{label("All projects","全部项目")}</button>
      {items.filter(item=>visibilityOf("project",item.id)==="active").map(item=><button type="button" role="menuitem" className="menu-item" key={item.id} onClick={()=>selectScope(item.id)}><Icon name="folder"/>{item.name}</button>)}
      <div className="menu-sep"/>
      <button type="button" role="menuitem" className="menu-item" onClick={()=>applyFoldMenu('collapse')}><Icon name="chevD"/>{label("Collapse all","全部收起")}</button>
      <button type="button" role="menuitem" className="menu-item" onClick={()=>applyFoldMenu('current')}><Icon name="chevD"/>{label("Expand current only","只展开当前")}</button>
      <button type="button" role="menuitem" className="menu-item" onClick={()=>applyFoldMenu('expand')}><Icon name="chevD"/>{label("Expand all","全部展开")}</button>
      <div className="menu-sep"/><div className="menu-label">{label("Archived projects","归档的项目")}</div>
      {items.filter(item=>visibilityOf("project",item.id)==="archived").map(item=><button type="button" role="menuitem" className="menu-item" key={item.id} onClick={()=>void restoreCatalogTarget(projectTarget(item),visibility).then(()=>{changed();closeMenu();}).catch(error=>setIssue(String(error)))}><Icon name="archive"/><span className="grow">{item.name}</span><span className="dim">{label("Restore","恢复")}</span></button>)}
      {!items.some(item=>visibilityOf("project",item.id)==="archived")&&<div className="menu-note">{label("No archived projects","暂无归档项目")}</div>}
    </CatalogPopover>}
  </section>;
}
