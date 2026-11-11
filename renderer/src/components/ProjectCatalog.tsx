import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CatalogVisibility, ProjectCatalogItem, ProviderCapability, Session, Worktree } from "@threadterm/protocol";
import { machineBridge, useMachines, useMachineTree } from '../machines';
import { machineTreeKey } from '../machineTypes';
import { request, subscribeEvents } from "../bridge";
import { projectCatalogStore } from '../projectCatalogStore';
import { displayPath, sameCanonicalScope } from "../projectScope";
import { useTranslation } from "../i18n";
import { Icon, SessionIcon } from "./PrototypeIcon";
import { CatalogActions, CatalogPopover, restoreCatalogTarget, type CatalogTarget } from "./CatalogActions";
import "./project-catalog.css";
import { sessionState, sessionStateLabel } from "../sessionState";
import { activityOrder, isTerminalAttentionSession, sessionActivity, sessionActivityLabel, sortSessionsByActivity } from "../sessionActivity";
import { isCodeReviewSession } from "../codeReview";
import {
  delegationQuiet,
  delegationQuietLabel,
  delegationStateLabel,
} from "../delegation";
import { QuietMinutes } from "./QuietMinutes";
import { boundedExpandedParents, EXPANDED_DELEGATES_KEY, foldedDelegateRows, readExpandedParents, type DelegateCatalogRow } from "../delegateFold";
import { catalogGroups, groupCatalogLabel, groupCatalogState, groupCatalogStatusClass, groupMemberIds, groupMemberLabel } from "../groupCatalog";
import { openGroup } from "../groupNavigation";
import { WbIcon } from "../workbench/icons";
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

export function ProjectCatalog({selectedProjectId,selectedWorktreePath,selectedSessionId,onAll,onProject,onWorktree,sessions:sessionSnapshot,visibility=[],onChanged,onSession,onNewSession,onScopeChange,onAddProject,providers}:Props){
  const machine=useMachines(),machineTree=useMachineTree(),sharedTree=machine.enabled&&machine.machines.length>1;
  const isCollapsed=(id:string)=>sharedTree?machineTree.expanded[machineTreeKey(machine.currentId,'project',id)]===false:collapsed[id];
  const toggleProject=(id:string)=>{if(sharedTree)void machineBridge()?.machineExpand(machineTreeKey(machine.currentId,'project',id),Boolean(isCollapsed(id)));else setCollapsed(value=>({...value,[id]:!value[id]}));};
  const branchExpanded=(path:string)=>!sharedTree||machineTree.expanded[machineTreeKey(machine.currentId,'branch',path)]!==false;
  const sessions=sessionSnapshot??[];
  const {locale}=useTranslation(),zh=locale==="zh-CN",label=(en:string,cn:string)=>zh?cn:en;
  const store=useMemo(()=>projectCatalogStore(machine.currentId,request),[machine.currentId]);
  const {items,trees,groups,loaded,loading,issue:loadIssue}=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const [actionIssue,setIssue]=useState<string>(),issue=actionIssue??loadIssue;
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({}),[showAll,setShowAll]=useState<Record<string,boolean>>({});
  const [scopeProjectId,setScopeProjectId]=useState<string>(),[menuAnchor,setMenuAnchor]=useState<HTMLElement>(),[activities,setActivities]=useState<Record<string,NonNullable<Session['activity']>>>({}),[frozenOrder,setFrozenOrder]=useState<ReadonlyMap<string,number>>(),activityEpoch=useRef<string|undefined>(undefined);
  const catalogSessions=useMemo(()=>sessions.filter(session=>!isCodeReviewSession(session)).map(session=>{const snapshotActivity=session.activity,override=activities[session.id];return !override||snapshotActivity&&snapshotActivity.revision>=override.revision?session:{...session,activity:override};}),[sessions,activities]);
  const [expandedDelegates,setExpandedDelegates]=useState<string[]>(()=>{try{return readExpandedParents(localStorage.getItem(EXPANDED_DELEGATES_KEY));}catch{return [];}});
  useEffect(()=>{
    if(!sessionSnapshot)return;
    const next=boundedExpandedParents(expandedDelegates,new Set(sessions.map(session=>session.id)));
    if(next.length!==expandedDelegates.length)setExpandedDelegates(next);
    try{localStorage.setItem(EXPANDED_DELEGATES_KEY,JSON.stringify(next));}catch{/* Folding still works when storage is unavailable. */}
  },[sessionSnapshot,expandedDelegates]);
  const renderDelegateFold=(row:Extract<DelegateCatalogRow,{kind:'fold'}>)=><div className="sess-row-wrap is-delegate" key={`fold:${row.parentId}`}><button type="button" className="sess-row delegate-fold-row" data-parent-id={row.parentId} aria-expanded={row.expanded} onClick={()=>setExpandedDelegates(current=>row.expanded?current.filter(id=>id!==row.parentId):boundedExpandedParents([...current,row.parentId]))}><span className="bico"><Icon name="chevron" className="chev"/></span><span className="grow">{label(`${row.count} finished`,`${row.count} 个已结束`)}</span></button></div>;
  const visibilityOf=(kind:CatalogVisibility["kind"],id:string)=>visibility.find(row=>row.kind===kind&&row.id===id)?.visibility??"active";
  const reload=store.reload;
  useEffect(()=>{const deactivate=store.activate();const unsubscribe=subscribeEvents(event=>{const data=event.data as {kind?:unknown;sessionId?:unknown;activity?:unknown;state?:unknown}|null,kind=data?.kind,sessionId=data?.sessionId,activity=data?.activity;if(event.event==="session.activity"&&typeof sessionId==="string"&&isActivity(activity)){if(activityEpoch.current&&activityEpoch.current!==event.epoch)setActivities({});activityEpoch.current=event.epoch;setActivities(current=>current[sessionId]?.revision!==undefined&&current[sessionId].revision>activity.revision?current:{...current,[sessionId]:activity});}if(event.event==="runtime.transport"&&['reconnected','disconnected','incompatible'].includes(String(data?.state))){activityEpoch.current=undefined;setActivities({});store.transport(data?.state);}if(event.event==="state.changed"&&String(kind)==="group")store.reloadGroups();else if(event.event==="state.changed"&&["project","project.catalog","worktree","catalog.visibility"].includes(String(kind)))void reload();});return()=>{deactivate();unsubscribe();};},[store]);
  useEffect(()=>{const active=new Set(sessions.map(session=>session.id));setActivities(current=>{const next=Object.fromEntries(Object.entries(current).filter(([id])=>active.has(id)));return Object.keys(next).length===Object.keys(current).length?current:next;});},[sessions]);
  const changed=()=>{setIssue(undefined);void reload();onChanged?.();};
  const hide=(target:CatalogTarget)=>{
    if(target.kind==="project"&&selectedProjectId===target.id||target.kind==="worktree"&&selectedProjectId===target.projectId&&sameCanonicalScope(target.path,selectedWorktreePath)||target.kind==="session"&&selectedSessionId===target.id)onAll();
    if(target.kind==="project"&&scopeProjectId===target.id){setScopeProjectId(undefined);onScopeChange?.();}
  };
  const onCatalogMenuOpenChange=useCallback((open:boolean)=>setFrozenOrder(current=>open?current??activityOrder(catalogSessions):undefined),[catalogSessions]);
  const actions=(target:CatalogTarget)=><CatalogActions target={target} projects={items} trees={trees[target.projectId]??[]} sessions={catalogSessions} providers={providers} visibility={visibility} onChanged={changed} onHidden={()=>hide(target)} onWorktree={onWorktree} onNewSession={onNewSession} onMenuOpenChange={onCatalogMenuOpenChange}/>;
  const projectTarget=(item:ProjectCatalogItem):CatalogTarget=>({kind:"project",id:item.id,name:item.name,path:item.path,projectId:item.id});
  const closeMenu=()=>setMenuAnchor(undefined);
  const selectScope=(id?:string)=>{setScopeProjectId(id);closeMenu();onScopeChange?.(id);};
  const scopeName=items.find(item=>item.id===scopeProjectId)?.name??label("all projects","全部项目");
  const scoped=items.filter(item=>visibilityOf("project",item.id)==="active"&&(!scopeProjectId||scopeProjectId===item.id));
  const renderGroups=(groupsToRender:ReturnType<typeof catalogGroups>)=>groupsToRender.map(({group,members})=>{
    const state=groupCatalogState(group.members,catalogSessions),stateLabel=groupCatalogLabel(group.members,zh,catalogSessions);
    return <div className="group-catalog-group" key={group.id}><button type="button" className="sess-row group-row" data-group-id={group.id} title={`${group.title} · ${stateLabel}`} onClick={()=>openGroup(group)}><span className="bico"><WbIcon name="users"/></span><span className="grow">{group.title}</span><span className={`group-state ${groupCatalogStatusClass(state)}`}>{stateLabel}</span></button><div className="group-members">{members.map(session=>{const activity=sessionActivity(session),activityLabel=sessionActivityLabel(activity,zh),member=group.members.find(value=>value.sessionId===session.id),memberLabel=member?groupMemberLabel(member.handle):session.title;return <div className="sess-row-wrap group-member" data-session-id={session.id} data-activity={activity} key={session.id}><button type="button" className={`sess-row${session.id===selectedSessionId?" active":""}`} data-session-id={session.id} data-activity={activity} title={session.title+" · "+activityLabel} onClick={()=>onSession?.(session.id)}><span className={`bico session-activity-${activity}`} aria-label={activityLabel} title={activityLabel}><span className="session-agent-icon"><SessionIcon session={session}/>{activity==="running"&&<i className="session-attention-ring"/>}</span><i className={`bico-dot st-${attentionStateClass(session)}`}/></span><span className="grow">{memberLabel}</span></button></div>;})}</div></div>;
  });
  return <section className="project-catalog" aria-label={label("Project catalog","项目目录")}>
    <div className="catalog-head"><button type="button" className="side-label side-scope" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} aria-label={label("Project scope","项目范围")} title={scopeName} onClick={event=>setMenuAnchor(menuAnchor?undefined:event.currentTarget)}><span className="grow">{label("Projects","项目")} · {scopeName}</span><Icon name="more"/></button></div>
    <div className="side-tree">{scoped.map(item=>{
      const projectSessions=catalogSessions.filter(session=>session.projectId===item.id&&!session.archived&&visibilityOf("session",session.id)==="active");
      const projectGroups=catalogGroups(groups[item.id]??[],projectSessions),memberIds=groupMemberIds(projectGroups.map(value=>value.group));
      const visibleProjectSessions=projectSessions.filter(session=>!memberIds.has(session.id));
      const actualTrees=trees[item.id]??[];
      const ordered=actualTrees.filter(tree=>visibilityOf("worktree",tree.id)==="active");
      const plainDirectorySessions=!item.git.available&&actualTrees.length===0?visibleProjectSessions:[];
      const current=ordered.find(tree=>sameCanonicalScope(tree.path,selectedWorktreePath));
      const listed=showAll[item.id]||current&&ordered.indexOf(current)>=8?ordered:ordered.slice(0,8);
      const waiting=projectSessions.filter(session=>(sessionActivity(session)==="awaiting_approval"||sessionActivity(session)==="awaiting_input")&&((!item.git.available&&actualTrees.length===0)||ordered.some(tree=>sameCanonicalScope(tree.path,session.worktreePath??item.path)))).length;
      return <div className="proj-group" key={item.id}><div className={"proj-row-wrap"+(selectedProjectId===item.id&&!selectedWorktreePath?" active":"")}>
        <button type="button" className={"proj-disclosure"+(isCollapsed(item.id)?"":" open")} aria-expanded={!isCollapsed(item.id)} aria-label={label(isCollapsed(item.id)?"Expand":"Collapse",isCollapsed(item.id)?"展开":"收起")+" "+item.name} onClick={()=>toggleProject(item.id)}><Icon name="chevron" className="chev"/></button>
        <button type="button" className="proj-row" title={displayPath(item.path)} onClick={()=>onProject(item.id)}><Icon name="folder"/><span className="grow">{item.name}</span>{item.pinned&&<span className="follow-star">★</span>}{isCollapsed(item.id)&&waiting>0&&<span className="badge amber">{waiting}</span>}</button>{actions(projectTarget(item))}
      </div>{!isCollapsed(item.id)&&<div className="tree-list">{listed.map(tree=>{
        const treeAllSessions=sortSessionsByActivity(projectSessions.filter(session=>sameCanonicalScope(session.worktreePath??item.path,tree.path)),frozenOrder);
        const treeSessions=treeAllSessions.filter(session=>!memberIds.has(session.id));
        const treeGroups=projectGroups.filter(value=>sameCanonicalScope(value.group.worktreePath??item.path,tree.path));
        const selected=selectedProjectId===item.id&&Boolean(selectedWorktreePath)&&sameCanonicalScope(tree.path,selectedWorktreePath);
        const treeTarget:CatalogTarget={kind:"worktree",id:tree.id,name:tree.branch??label("Local directory","本地目录"),path:tree.path,projectId:item.id,worktreeId:tree.id};
        // One filled row: a selected session owns the highlight; its branch only reads as current (brighter text).
        const holdsSelection=selected&&treeAllSessions.some(session=>session.id===selectedSessionId);
        return <div className="catalog-tree-group" key={tree.id}><div className={"tree-row-wrap"+(selected?" current":"")}>{sharedTree&&<button type="button" className={"proj-disclosure"+(branchExpanded(tree.path)?" open":"")} aria-expanded={branchExpanded(tree.path)} aria-label={label("Toggle branch","展开或收起分支")+" "+treeTarget.name} onClick={()=>void machineBridge()?.machineExpand(machineTreeKey(machine.currentId,'branch',tree.path),!branchExpanded(tree.path))}><Icon name="chevron" className="chev"/></button>}<button type="button" className={"tree-row"+(selected&&!holdsSelection?" active":"")+(holdsSelection?" contains-active":"")} title={`${treeTarget.name}
${displayPath(tree.path)}`} onClick={()=>onWorktree?.(item.id,tree.path)}><span className="bico"><Icon name="branch"/><i className={"bico-dot st-"+treeState(tree,treeAllSessions)}/></span><BranchName name={treeTarget.name}/>{treeAllSessions.length>0&&<span className="badge">{treeAllSessions.length}</span>}</button>{actions(treeTarget)}</div>
          {branchExpanded(tree.path)&&<>{renderGroups(treeGroups)}{foldedDelegateRows(treeSessions,visibleProjectSessions,selectedSessionId,expandedDelegates).map(row=>{if(row.kind==="fold")return renderDelegateFold(row);const session=row.session,activity=sessionActivity(session),quiet=delegationQuiet(session),activityLabel=quiet?delegationQuietLabel(quiet.since,label):isTerminalAttentionSession(session)?sessionStateLabel(sessionState(session),zh,session.readOnly,Boolean(session.released)):sessionActivityLabel(activity,zh),needsAttention=activity==="awaiting_approval"||activity==="awaiting_input";return <div className={"sess-row-wrap"+(row.nested?" is-delegate":"")} data-session-id={session.id} data-activity={activity} key={session.id}>{needsAttention&&<i className="session-attention-bar" aria-hidden="true"/>}<button type="button" className={"sess-row"+(session.id===selectedSessionId?" active":"")} data-session-id={session.id} data-activity={activity} title={session.title+" · "+activityLabel} onClick={()=>onSession?.(session.id)}><span className={`bico session-activity-${activity}`} aria-label={activityLabel} title={activityLabel}><span className="session-agent-icon"><SessionIcon session={session}/>{activity==="running"&&<i className="session-attention-ring"/>}</span>{needsAttention&&<Icon name="bell" className="session-attention-icon" aria-hidden="true"/>}<i className={"bico-dot st-"+attentionStateClass(session)}/></span><span className="grow">{session.title}</span><DelegateChip session={session} nested={row.nested} zh={zh}/>{session.followed&&<span className="follow-star" aria-label={label("Followed","已关注")}>★</span>}</button>{actions({...treeTarget,kind:"session",id:session.id,name:session.title})}</div>})}
        </>}</div>;
      })}{!ordered.length&&renderGroups(projectGroups)}{foldedDelegateRows(sortSessionsByActivity(plainDirectorySessions,frozenOrder),visibleProjectSessions,selectedSessionId,expandedDelegates).map(row=>{if(row.kind==="fold")return renderDelegateFold(row);const session=row.session,sessionTarget:CatalogTarget={kind:"session",id:session.id,name:session.title,path:session.worktreePath??item.path,projectId:item.id},activity=sessionActivity(session),quiet=delegationQuiet(session),activityLabel=quiet?delegationQuietLabel(quiet.since,label):isTerminalAttentionSession(session)?sessionStateLabel(sessionState(session),zh,session.readOnly,Boolean(session.released)):sessionActivityLabel(activity,zh),needsAttention=activity==="awaiting_approval"||activity==="awaiting_input";return <div className={"sess-row-wrap"+(row.nested?" is-delegate":"")} data-session-id={session.id} data-activity={activity} key={session.id}>{needsAttention&&<i className="session-attention-bar" aria-hidden="true"/>}<button type="button" className={"sess-row"+(session.id===selectedSessionId?" active":"")} data-session-id={session.id} data-activity={activity} title={session.title+" · "+activityLabel} onClick={()=>onSession?.(session.id)}><span className={`bico session-activity-${activity}`} aria-label={activityLabel} title={activityLabel}><span className="session-agent-icon"><SessionIcon session={session}/>{activity==="running"&&<i className="session-attention-ring"/>}</span>{needsAttention&&<Icon name="bell" className="session-attention-icon" aria-hidden="true"/>}<i className={"bico-dot st-"+attentionStateClass(session)}/></span><span className="grow">{session.title}</span><DelegateChip session={session} nested={row.nested} zh={zh}/>{session.followed&&<span className="follow-star" aria-label={label("Followed","已关注")}>★</span>}</button>{actions(sessionTarget)}</div>;})}{ordered.length>8&&<button type="button" className="btn btn-sm catalog-more-trees" onClick={()=>setShowAll(value=>({...value,[item.id]:!value[item.id]}))}>{showAll[item.id]?label("Collapse more worktrees","收起更多工作目录"):label("Show "+(ordered.length-8)+" more worktrees","显示其余 "+(ordered.length-8)+" 个工作目录")}</button>}</div>}</div>;
    })}</div>
    {loading&&!items.length&&!issue&&<p className="side-empty" role="status">{label("Loading projects…","正在加载项目…")}</p>}
    {loaded&&!loading&&!items.length&&!issue&&<p className="side-empty">{label("No projects yet. Add a directory to get started.","还没有项目，请先添加目录。")}</p>}{issue&&<p className="side-empty" role="alert">{issue} <button type="button" className="btn btn-sm" onClick={()=>{setIssue(undefined);void reload();}}>{label("Try again","重试")}</button></p>}
    {menuAnchor&&<CatalogPopover anchor={menuAnchor} onClose={closeMenu} label={label("Project scope","项目范围")}>
      {onAddProject&&<button type="button" role="menuitem" className="menu-item" onClick={()=>{closeMenu();onAddProject();}}><Icon name="plus"/>{label("Add project","添加项目")}</button>}
      {onAddProject&&<div className="menu-sep"/>}
      <button type="button" role="menuitem" className="menu-item" onClick={()=>selectScope()}><Icon name="folder"/>{label("All projects","全部项目")}</button>
      {items.filter(item=>visibilityOf("project",item.id)==="active").map(item=><button type="button" role="menuitem" className="menu-item" key={item.id} onClick={()=>selectScope(item.id)}><Icon name="folder"/>{item.name}</button>)}
      <div className="menu-sep"/><div className="menu-label">{label("Archived projects","归档的项目")}</div>
      {items.filter(item=>visibilityOf("project",item.id)==="archived").map(item=><button type="button" role="menuitem" className="menu-item" key={item.id} onClick={()=>void restoreCatalogTarget(projectTarget(item),visibility).then(()=>{changed();closeMenu();}).catch(error=>setIssue(String(error)))}><Icon name="archive"/><span className="grow">{item.name}</span><span className="dim">{label("Restore","恢复")}</span></button>)}
      {!items.some(item=>visibilityOf("project",item.id)==="archived")&&<div className="menu-note">{label("No archived projects","暂无归档项目")}</div>}
    </CatalogPopover>}
  </section>;
}
