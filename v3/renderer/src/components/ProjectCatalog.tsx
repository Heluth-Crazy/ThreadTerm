import { useEffect, useRef, useState } from "react";
import type { CatalogVisibility, ProjectCatalogItem, Session, Worktree } from "@threadterm/protocol";
import { request, subscribeEvents } from "../bridge";
import { displayPath, sameCanonicalScope } from "../projectScope";
import { useTranslation } from "../i18n";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { CatalogActions, CatalogPopover, restoreCatalogTarget, type CatalogTarget } from "./CatalogActions";
import "./project-catalog.css";

type Props={selectedProjectId?:string;selectedWorktreePath?:string;selectedSessionId?:string;onAll:()=>void;onProject:(id:string)=>void;onWorktree?:(id:string,path?:string)=>void;sessions?:Session[];visibility?:CatalogVisibility[];onChanged?:()=>void;onSession?:(id:string)=>void;onNewSession?:(id?:string,path?:string)=>void;onScopeChange?:(id?:string)=>void;onAddProject?:()=>void};
const stateClass=(session:Session)=>session.readOnly?"ended":session.status==="waiting"?"needs":session.status==="error"?"failed":session.status==="interrupted"?"stalled":session.status==="exited"?"ended":"running";
const treeState=(tree:Worktree,sessions:Session[])=>{
  if(tree.missing)return "stalled";
  const rank:Record<string,number>={ended:0,stalled:1,running:2,failed:3,needs:4};
  return sessions.map(stateClass).reduce((best,state)=>rank[state]>rank[best]?state:best,"ended");
};

export function ProjectCatalog({selectedProjectId,selectedWorktreePath,selectedSessionId,onAll,onProject,onWorktree,sessions=[],visibility=[],onChanged,onSession,onNewSession,onScopeChange,onAddProject}:Props){
  const {locale}=useTranslation(),zh=locale==="zh-CN",label=(en:string,cn:string)=>zh?cn:en;
  const [items,setItems]=useState<ProjectCatalogItem[]>([]),[trees,setTrees]=useState<Record<string,Worktree[]>>({});
  const [issue,setIssue]=useState<string>(),[collapsed,setCollapsed]=useState<Record<string,boolean>>({}),[showAll,setShowAll]=useState<Record<string,boolean>>({});
  const [scopeProjectId,setScopeProjectId]=useState<string>(),[menuAnchor,setMenuAnchor]=useState<HTMLElement>(),generation=useRef(0);
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
  useEffect(()=>{void reload();const unsubscribe=subscribeEvents(event=>{const kind=(event.data as {kind?:unknown}|null)?.kind;if(event.event==="state.changed"&&["project","project.catalog","worktree","catalog.visibility"].includes(String(kind)))void reload();});return()=>{generation.current++;unsubscribe();};},[]);
  const changed=()=>{void reload();onChanged?.();};
  const hide=(target:CatalogTarget)=>{
    if(target.kind==="project"&&selectedProjectId===target.id||target.kind==="worktree"&&selectedProjectId===target.projectId&&sameCanonicalScope(target.path,selectedWorktreePath)||target.kind==="session"&&selectedSessionId===target.id)onAll();
    if(target.kind==="project"&&scopeProjectId===target.id){setScopeProjectId(undefined);onScopeChange?.();}
  };
  const actions=(target:CatalogTarget)=><CatalogActions target={target} projects={items} trees={trees[target.projectId]??[]} sessions={sessions} visibility={visibility} onChanged={changed} onHidden={()=>hide(target)} onWorktree={onWorktree} onNewSession={onNewSession}/>;
  const projectTarget=(item:ProjectCatalogItem):CatalogTarget=>({kind:"project",id:item.id,name:item.name,path:item.path,projectId:item.id});
  const closeMenu=()=>setMenuAnchor(undefined);
  const selectScope=(id?:string)=>{setScopeProjectId(id);closeMenu();onScopeChange?.(id);};
  const scopeName=items.find(item=>item.id===scopeProjectId)?.name??label("all projects","全部项目");
  const scoped=items.filter(item=>visibilityOf("project",item.id)==="active"&&(!scopeProjectId||scopeProjectId===item.id));
  return <section className="project-catalog" aria-label={label("Project catalog","项目目录")}>
    <div className="catalog-head"><button type="button" className="side-label side-scope" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} aria-label={label("Project scope","项目范围")} title={scopeName} onClick={event=>setMenuAnchor(menuAnchor?undefined:event.currentTarget)}><span className="grow">{label("Projects","项目")} · {scopeName}</span><Icon name="more"/></button></div>
    <div className="side-tree">{scoped.map(item=>{
      const projectSessions=sessions.filter(session=>session.projectId===item.id&&!session.archived&&visibilityOf("session",session.id)==="active");
      const actualTrees=trees[item.id]??[];
      const ordered=actualTrees.filter(tree=>visibilityOf("worktree",tree.id)==="active");
      const plainDirectorySessions=!item.git.available&&actualTrees.length===0?projectSessions:[];
      const current=ordered.find(tree=>sameCanonicalScope(tree.path,selectedWorktreePath));
      const listed=showAll[item.id]||current&&ordered.indexOf(current)>=8?ordered:ordered.slice(0,8);
      const waiting=projectSessions.filter(session=>session.status==="waiting"&&(plainDirectorySessions.includes(session)||ordered.some(tree=>sameCanonicalScope(tree.path,session.worktreePath??item.path)))).length;
      return <div className="proj-group" key={item.id}><div className={"proj-row-wrap"+(selectedProjectId===item.id&&!selectedWorktreePath?" active":"")}>
        <button type="button" className={"proj-disclosure"+(collapsed[item.id]?"":" open")} aria-expanded={!collapsed[item.id]} aria-label={label(collapsed[item.id]?"Expand":"Collapse",collapsed[item.id]?"展开":"收起")+" "+item.name} onClick={()=>setCollapsed(value=>({...value,[item.id]:!value[item.id]}))}><Icon name="chevron" className="chev"/></button>
        <button type="button" className="proj-row" title={displayPath(item.path)} onClick={()=>onProject(item.id)}><Icon name="folder"/><span className="grow">{item.name}</span>{item.pinned&&<span className="follow-star">★</span>}{collapsed[item.id]&&waiting>0&&<span className="badge amber">{waiting}</span>}</button>{actions(projectTarget(item))}
      </div>{!collapsed[item.id]&&<div className="tree-list">{listed.map(tree=>{
        const treeSessions=projectSessions.filter(session=>sameCanonicalScope(session.worktreePath??item.path,tree.path));
        const selected=selectedProjectId===item.id&&Boolean(selectedWorktreePath)&&sameCanonicalScope(tree.path,selectedWorktreePath);
        const treeTarget:CatalogTarget={kind:"worktree",id:tree.id,name:tree.branch??label("Local directory","本地目录"),path:tree.path,projectId:item.id,worktreeId:tree.id};
        return <div className="catalog-tree-group" key={tree.id}><div className={"tree-row-wrap"+(selected?" current":"")}><button type="button" className={"tree-row"+(selected?" active":"")} title={displayPath(tree.path)} onClick={()=>onWorktree?.(item.id,tree.path)}><span className="bico"><Icon name="branch"/><i className={"bico-dot st-"+treeState(tree,treeSessions)}/></span><span className="branch">{treeTarget.name}</span>{treeSessions.length>0&&<span className="badge">{treeSessions.length}</span>}</button>{actions(treeTarget)}</div>
          {treeSessions.map(session=><div className="sess-row-wrap" key={session.id}><button type="button" className={"sess-row"+(session.id===selectedSessionId?" active":"")} title={session.title+" · "+session.status} onClick={()=>onSession?.(session.id)}><span className="bico"><AgentIcon provider={session.provider}/><i className={"bico-dot st-"+stateClass(session)}/></span><span className="grow">{session.title}</span>{session.followed&&<span className="follow-star" aria-label={label("Followed","已关注")}>★</span>}</button>{actions({...treeTarget,kind:"session",id:session.id,name:session.title})}</div>)}
        </div>;
      })}{plainDirectorySessions.map(session=>{const sessionTarget:CatalogTarget={kind:"session",id:session.id,name:session.title,path:session.worktreePath??item.path,projectId:item.id};return <div className="sess-row-wrap" key={session.id}><button type="button" className={"sess-row"+(session.id===selectedSessionId?" active":"")} title={session.title+" · "+session.status} onClick={()=>onSession?.(session.id)}><span className="bico"><AgentIcon provider={session.provider}/><i className={"bico-dot st-"+stateClass(session)}/></span><span className="grow">{session.title}</span>{session.followed&&<span className="follow-star" aria-label={label("Followed","已关注")}>★</span>}</button>{actions(sessionTarget)}</div>;})}{ordered.length>8&&<button type="button" className="btn-subtle catalog-more-trees" onClick={()=>setShowAll(value=>({...value,[item.id]:!value[item.id]}))}>{showAll[item.id]?label("Collapse more worktrees","收起更多工作目录"):label("Show "+(ordered.length-8)+" more worktrees","显示其余 "+(ordered.length-8)+" 个工作目录")}</button>}</div>}</div>;
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
