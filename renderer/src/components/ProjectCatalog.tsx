import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogVisibility, ProjectCatalogItem, Session, Worktree } from "@threadterm/protocol";
import { request, subscribeEvents } from "../bridge";
import { displayPath, sameCanonicalScope } from "../projectScope";
import { useTranslation } from "../i18n";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { CatalogActions, CatalogPopover, restoreCatalogTarget, type CatalogTarget } from "./CatalogActions";
import "./project-catalog.css";
import { sessionState, sessionStateLabel } from "../sessionState";
import { activityOrder, isTerminalAttentionSession, sessionActivity, sessionActivityLabel, sortSessionsByActivity } from "../sessionActivity";
import { delegationStateLabel, nestedDelegateIds, withDelegates } from "../delegation";

type Props={selectedProjectId?:string;selectedWorktreePath?:string;selectedSessionId?:string;onAll:()=>void;onProject:(id:string)=>void;onWorktree?:(id:string,path?:string)=>void;sessions?:Session[];visibility?:CatalogVisibility[];onChanged?:()=>void;onSession?:(id:string)=>void;onNewSession?:(id?:string,path?:string)=>void;onScopeChange?:(id?:string)=>void;onAddProject?:()=>void};
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
  if(!delegation||(nested&&!delegation.branch))return null;
  const title=(zh?"由代理委派 · ":"Delegated by an agent · ")+delegationStateLabel(delegation.state,zh)+(delegation.branch?" · "+delegation.branch:"");
  return <span className={"delegate-chip st-"+delegation.state} title={title} aria-label={title}>{delegation.branch&&<Icon name="branch"/>}{!nested&&(zh?"委派":"delegate")}</span>;
}
const isActivity=(value:unknown):value is NonNullable<Session['activity']>=>Boolean(value)&&typeof value==='object'&&activityStates.has((value as {state?:unknown}).state as string)&&Number.isSafeInteger((value as {revision?:unknown}).revision)&&Number((value as {revision:number}).revision)>=0&&((value as {turnId?:unknown}).turnId===undefined||typeof (value as {turnId?:unknown}).turnId==='string')&&((value as {reason?:unknown}).reason===undefined||typeof (value as {reason?:unknown}).reason==='string');

/** Branch names shed their prefix (`feature/`) before the leaf, which is what tells branches apart. */
function BranchName({name}:{name:string}){
  const cut=name.lastIndexOf("/")+1;
  if(cut<=0||cut>=name.length)return <span className="branch">{name}</span>;
  return <span className="branch branch-split"><span className="branch-prefix">{name.slice(0,cut)}</span><span className="branch-leaf">{name.slice(cut)}</span></span>;
}

export function ProjectCatalog({selectedProjectId,selectedWorktreePath,selectedSessionId,onAll,onProject,onWorktree,sessions=[],visibility=[],onChanged,onSession,onNewSession,onScopeChange,onAddProject}:Props){
  const {locale}=useTranslation(),zh=locale==="zh-CN",label=(en:string,cn:string)=>zh?cn:en;
  const [items,setItems]=useState<ProjectCatalogItem[]>([]),[trees,setTrees]=useState<Record<string,Worktree[]>>({});
  const [issue,setIssue]=useState<string>(),[collapsed,setCollapsed]=useState<Record<string,boolean>>({}),[showAll,setShowAll]=useState<Record<string,boolean>>({});
  const [scopeProjectId,setScopeProjectId]=useState<string>(),[menuAnchor,setMenuAnchor]=useState<HTMLElement>(),[activities,setActivities]=useState<Record<string,NonNullable<Session['activity']>>>({}),[frozenOrder,setFrozenOrder]=useState<ReadonlyMap<string,number>>(),generation=useRef(0),activityEpoch=useRef<string|undefined>(undefined);
  const catalogSessions=useMemo(()=>sessions.map(session=>{const snapshotActivity=session.activity,override=activities[session.id];return !override||snapshotActivity&&snapshotActivity.revision>=override.revision?session:{...session,activity:override};}),[sessions,activities]);
  const visibilityOf=(kind:CatalogVisibility["kind"],id:string)=>visibility.find(row=>row.kind===kind&&row.id===id)?.visibility??"active";
  const reload=async()=>{
    const current=++generation.current;
    try{
      const next=await request("project.catalog.list",{});
      const pairs=await Promise.all(next.map(async item=>[item.id,await request("worktree.list",{projectId:item.id})] as const));
      if(current!==generation.current)return;
      setItems([...next].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||a.sortOrder-b.sortOrder));
      setTrees(Object.fromEntries(pairs));setIssue(undefined);
    }catch(error){if(current===generation.current)setIssue(error instanceof Error?error.message:String(error));}
  };
  useEffect(()=>{void reload();const unsubscribe=subscribeEvents(event=>{const data=event.data as {kind?:unknown;sessionId?:unknown;activity?:unknown;state?:unknown}|null,kind=data?.kind,sessionId=data?.sessionId,activity=data?.activity;if(event.event==="session.activity"&&typeof sessionId==="string"&&isActivity(activity)){if(activityEpoch.current&&activityEpoch.current!==event.epoch)setActivities({});activityEpoch.current=event.epoch;setActivities(current=>current[sessionId]?.revision!==undefined&&current[sessionId].revision>activity.revision?current:{...current,[sessionId]:activity});}if(event.event==="runtime.transport"&&['reconnected','disconnected','incompatible'].includes(String(data?.state))){activityEpoch.current=undefined;setActivities({});}if(event.event==="state.changed"&&["project","project.catalog","worktree","catalog.visibility"].includes(String(kind)))void reload();});return()=>{generation.current++;unsubscribe();};},[]);
  useEffect(()=>{const active=new Set(sessions.map(session=>session.id));setActivities(current=>{const next=Object.fromEntries(Object.entries(current).filter(([id])=>active.has(id)));return Object.keys(next).length===Object.keys(current).length?current:next;});},[sessions]);
  const changed=()=>{void reload();onChanged?.();};
  const hide=(target:CatalogTarget)=>{
    if(target.kind==="project"&&selectedProjectId===target.id||target.kind==="worktree"&&selectedProjectId===target.projectId&&sameCanonicalScope(target.path,selectedWorktreePath)||target.kind==="session"&&selectedSessionId===target.id)onAll();
    if(target.kind==="project"&&scopeProjectId===target.id){setScopeProjectId(undefined);onScopeChange?.();}
  };
  const onCatalogMenuOpenChange=useCallback((open:boolean)=>setFrozenOrder(current=>open?current??activityOrder(catalogSessions):undefined),[catalogSessions]);
  const actions=(target:CatalogTarget)=><CatalogActions target={target} projects={items} trees={trees[target.projectId]??[]} sessions={catalogSessions} visibility={visibility} onChanged={changed} onHidden={()=>hide(target)} onWorktree={onWorktree} onNewSession={onNewSession} onMenuOpenChange={onCatalogMenuOpenChange}/>;
  const projectTarget=(item:ProjectCatalogItem):CatalogTarget=>({kind:"project",id:item.id,name:item.name,path:item.path,projectId:item.id});
  const closeMenu=()=>setMenuAnchor(undefined);
  const selectScope=(id?:string)=>{setScopeProjectId(id);closeMenu();onScopeChange?.(id);};
  const scopeName=items.find(item=>item.id===scopeProjectId)?.name??label("all projects","全部项目");
  const scoped=items.filter(item=>visibilityOf("project",item.id)==="active"&&(!scopeProjectId||scopeProjectId===item.id));
  return <section className="project-catalog" aria-label={label("Project catalog","项目目录")}>
    <div className="catalog-head"><button type="button" className="side-label side-scope" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} aria-label={label("Project scope","项目范围")} title={scopeName} onClick={event=>setMenuAnchor(menuAnchor?undefined:event.currentTarget)}><span className="grow">{label("Projects","项目")} · {scopeName}</span><Icon name="more"/></button></div>
    <div className="side-tree">{scoped.map(item=>{
      const projectSessions=catalogSessions.filter(session=>session.projectId===item.id&&!session.archived&&visibilityOf("session",session.id)==="active");
      const nestedIds=nestedDelegateIds(projectSessions);
      const actualTrees=trees[item.id]??[];
      const ordered=actualTrees.filter(tree=>visibilityOf("worktree",tree.id)==="active");
      const plainDirectorySessions=!item.git.available&&actualTrees.length===0?projectSessions:[];
      const current=ordered.find(tree=>sameCanonicalScope(tree.path,selectedWorktreePath));
      const listed=showAll[item.id]||current&&ordered.indexOf(current)>=8?ordered:ordered.slice(0,8);
      const waiting=projectSessions.filter(session=>(sessionActivity(session)==="awaiting_approval"||sessionActivity(session)==="awaiting_input")&&(plainDirectorySessions.includes(session)||ordered.some(tree=>sameCanonicalScope(tree.path,session.worktreePath??item.path)))).length;
      return <div className="proj-group" key={item.id}><div className={"proj-row-wrap"+(selectedProjectId===item.id&&!selectedWorktreePath?" active":"")}>
        <button type="button" className={"proj-disclosure"+(collapsed[item.id]?"":" open")} aria-expanded={!collapsed[item.id]} aria-label={label(collapsed[item.id]?"Expand":"Collapse",collapsed[item.id]?"展开":"收起")+" "+item.name} onClick={()=>setCollapsed(value=>({...value,[item.id]:!value[item.id]}))}><Icon name="chevron" className="chev"/></button>
        <button type="button" className="proj-row" title={displayPath(item.path)} onClick={()=>onProject(item.id)}><Icon name="folder"/><span className="grow">{item.name}</span>{item.pinned&&<span className="follow-star">★</span>}{collapsed[item.id]&&waiting>0&&<span className="badge amber">{waiting}</span>}</button>{actions(projectTarget(item))}
      </div>{!collapsed[item.id]&&<div className="tree-list">{listed.map(tree=>{
        const treeSessions=sortSessionsByActivity(projectSessions.filter(session=>sameCanonicalScope(session.worktreePath??item.path,tree.path)),frozenOrder);
        const selected=selectedProjectId===item.id&&Boolean(selectedWorktreePath)&&sameCanonicalScope(tree.path,selectedWorktreePath);
        const treeTarget:CatalogTarget={kind:"worktree",id:tree.id,name:tree.branch??label("Local directory","本地目录"),path:tree.path,projectId:item.id,worktreeId:tree.id};
        // One filled row: a selected session owns the highlight; its branch only reads as current (brighter text).
        const holdsSelection=selected&&treeSessions.some(session=>session.id===selectedSessionId);
        return <div className="catalog-tree-group" key={tree.id}><div className={"tree-row-wrap"+(selected?" current":"")}><button type="button" className={"tree-row"+(selected&&!holdsSelection?" active":"")+(holdsSelection?" contains-active":"")} title={`${treeTarget.name}
${displayPath(tree.path)}`} onClick={()=>onWorktree?.(item.id,tree.path)}><span className="bico"><Icon name="branch"/><i className={"bico-dot st-"+treeState(tree,treeSessions)}/></span><BranchName name={treeTarget.name}/>{treeSessions.length>0&&<span className="badge">{treeSessions.length}</span>}</button>{actions(treeTarget)}</div>
          {withDelegates(treeSessions,projectSessions).map(session=>{const activity=sessionActivity(session),activityLabel=isTerminalAttentionSession(session)?sessionStateLabel(sessionState(session),zh,session.readOnly):sessionActivityLabel(activity,zh),needsAttention=activity==="awaiting_approval"||activity==="awaiting_input";return <div className={"sess-row-wrap"+(nestedIds.has(session.id)?" is-delegate":"")} data-session-id={session.id} data-activity={activity} key={session.id}>{needsAttention&&<i className="session-attention-bar" aria-hidden="true"/>}<button type="button" className={"sess-row"+(session.id===selectedSessionId?" active":"")} data-session-id={session.id} data-activity={activity} title={session.title+" · "+activityLabel} onClick={()=>onSession?.(session.id)}><span className={`bico session-activity-${activity}`} aria-label={activityLabel} title={activityLabel}><span className="session-agent-icon"><AgentIcon provider={session.provider}/>{activity==="running"&&<i className="session-attention-ring"/>}</span>{needsAttention&&<Icon name="bell" className="session-attention-icon" aria-hidden="true"/>}<i className={"bico-dot st-"+attentionStateClass(session)}/></span><span className="grow">{session.title}</span><DelegateChip session={session} nested={nestedIds.has(session.id)} zh={zh}/>{session.followed&&<span className="follow-star" aria-label={label("Followed","已关注")}>★</span>}</button>{actions({...treeTarget,kind:"session",id:session.id,name:session.title})}</div>})}
        </div>;
      })}{withDelegates(sortSessionsByActivity(plainDirectorySessions,frozenOrder),projectSessions).map(session=>{const sessionTarget:CatalogTarget={kind:"session",id:session.id,name:session.title,path:session.worktreePath??item.path,projectId:item.id},activity=sessionActivity(session),activityLabel=isTerminalAttentionSession(session)?sessionStateLabel(sessionState(session),zh,session.readOnly):sessionActivityLabel(activity,zh),needsAttention=activity==="awaiting_approval"||activity==="awaiting_input";return <div className={"sess-row-wrap"+(nestedIds.has(session.id)?" is-delegate":"")} data-session-id={session.id} data-activity={activity} key={session.id}>{needsAttention&&<i className="session-attention-bar" aria-hidden="true"/>}<button type="button" className={"sess-row"+(session.id===selectedSessionId?" active":"")} data-session-id={session.id} data-activity={activity} title={session.title+" · "+activityLabel} onClick={()=>onSession?.(session.id)}><span className={`bico session-activity-${activity}`} aria-label={activityLabel} title={activityLabel}><span className="session-agent-icon"><AgentIcon provider={session.provider}/>{activity==="running"&&<i className="session-attention-ring"/>}</span>{needsAttention&&<Icon name="bell" className="session-attention-icon" aria-hidden="true"/>}<i className={"bico-dot st-"+attentionStateClass(session)}/></span><span className="grow">{session.title}</span><DelegateChip session={session} nested={nestedIds.has(session.id)} zh={zh}/>{session.followed&&<span className="follow-star" aria-label={label("Followed","已关注")}>★</span>}</button>{actions(sessionTarget)}</div>;})}{ordered.length>8&&<button type="button" className="btn-subtle catalog-more-trees" onClick={()=>setShowAll(value=>({...value,[item.id]:!value[item.id]}))}>{showAll[item.id]?label("Collapse more worktrees","收起更多工作目录"):label("Show "+(ordered.length-8)+" more worktrees","显示其余 "+(ordered.length-8)+" 个工作目录")}</button>}</div>}</div>;
    })}</div>
    {!items.length&&!issue&&<p className="side-empty">{label("No projects yet. Add a directory to get started.","还没有项目，请先添加目录。")}</p>}{issue&&<p className="side-empty" role="alert">{issue}</p>}
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
