import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CatalogVisibility, ProjectCatalogItem, Session, Worktree } from '@threadterm/protocol';
import { openDirectory, operationId, request } from '../bridge';
import { hasDirtyEditorsInScope } from '../dirtyEditors';
import { useTranslation } from '../i18n';
import { displayPath, sameCanonicalScope } from '../projectScope';
import { Icon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import './catalog-active-delete-dialog.css';

type Kind=CatalogVisibility['kind'];
export type CatalogTarget={kind:Kind;id:string;name:string;path:string;projectId:string;worktreeId?:string};
type Props={target:CatalogTarget;projects:ProjectCatalogItem[];trees:Worktree[];sessions:Session[];visibility:CatalogVisibility[];onChanged:()=>void;onHidden:()=>void;onWorktree?:(id:string,path?:string)=>void;onNewSession?:(id?:string,path?:string)=>void};
type Dialog='rename'|'archive'|'remove'|'remove-active'|'discover';
type DeleteNotice='scope-changed'|'stop-failed';

const isActiveSession=(session:Session)=>!session.readOnly&&['starting','running','idle','waiting'].includes(session.status);
const sessionsInCatalogScope=(target:CatalogTarget,sessions:Session[],projectPath?:string)=>sessions.filter(session=>target.kind==='session'?session.id===target.id:session.projectId===target.projectId&&(target.kind==='project'||sameCanonicalScope(session.worktreePath??projectPath,target.path)));

export async function restoreCatalogTarget(target:CatalogTarget,visibility:CatalogVisibility[],session?:Session){
  const entry=visibility.find(row=>row.kind===target.kind&&row.id===target.id);
  await request('catalog.visibility.update',{kind:target.kind,id:target.id,visibility:'active',expectedRevision:entry?.revision??session?.organizationRevision??0,operationId:operationId()});
}

export function CatalogActions({target,projects,trees,sessions,visibility,onChanged,onHidden,onWorktree,onNewSession}:Props){
  const {locale}=useTranslation(),zh=locale==='zh-CN',text=(en:string,cn:string)=>zh?cn:en;
  const [anchor,setAnchor]=useState<HTMLElement>(),[dialog,setDialog]=useState<Dialog>(),[sessionsToEnd,setSessionsToEnd]=useState<Session[]>(),[deleteNotice,setDeleteNotice]=useState<DeleteNotice>();
  const [name,setName]=useState(target.name),[issue,setIssue]=useState<string>(),[busy,setBusy]=useState(false),locked=useRef(false);
  const project=projects.find(row=>row.id===target.projectId),session=target.kind==='session'?sessions.find(row=>row.id===target.id):undefined;
  const entry=visibility.find(row=>row.kind===target.kind&&row.id===target.id);
  const archived=entry?.visibility==='archived'||Boolean(session?.archived);
  const scopedSessions=sessionsInCatalogScope(target,sessions,project?.path),activeSessions=scopedSessions.filter(isActiveSession),deleteActiveSessions=sessionsToEnd??activeSessions;
  const close=()=>setAnchor(undefined);
  const run=async(action:()=>Promise<void>)=>{if(locked.current)return;locked.current=true;setBusy(true);setIssue(undefined);try{await action();}catch(error){setIssue(error instanceof Error?error.message:String(error));}finally{locked.current=false;setBusy(false);}};
  const updateProject=async(patch:{name?:string;pinned?:boolean;sortOrder?:number})=>{if(!project)return;await request('project.update',{id:project.id,...patch,expectedRevision:project.revision,operationId:operationId()});onChanged();};
  const move=async(direction:-1|1)=>{
    if(!project)return;
    const group=projects.filter(row=>row.pinned===project.pinned&&!visibility.some(entry=>entry.kind==='project'&&entry.id===row.id&&entry.visibility!=='active'));
    const index=group.findIndex(row=>row.id===project.id),next=index+direction;if(next<0||next>=group.length)return;
    [group[index],group[next]]=[group[next],group[index]];
    for(const [order,row]of group.entries())if(row.sortOrder!==order)await request('project.update',{id:row.id,sortOrder:order,expectedRevision:row.revision,operationId:operationId()});
    onChanged();close();
  };
  const ensureNoDirtyEditors=()=>{
    if(hasDirtyEditorsInScope({projectId:target.projectId,projectPath:project?.path,worktreePath:target.kind==='worktree'?target.path:undefined,sessionId:target.kind==='session'?target.id:undefined}))throw new Error(text('Save or close the edited files in this scope before archiving or deleting.','请先保存或关闭此范围内的文件修改，再进行归档或删除。'));
  };
  const changeVisibility=async(next:CatalogVisibility['visibility'],latest:{visibility:CatalogVisibility[];sessions:Session[]}={visibility,sessions})=>{
    const latestSession=target.kind==='session'?latest.sessions.find(row=>row.id===target.id):undefined;
    const latestEntry=latest.visibility.find(row=>row.kind===target.kind&&row.id===target.id);
    if(next==='active')await restoreCatalogTarget(target,latest.visibility,latestSession);
    else{
      if(sessionsInCatalogScope(target,latest.sessions,project?.path).some(isActiveSession))throw new Error(text('End active sessions in this scope before archiving or deleting.','请先结束此范围内的活动会话，再进行归档或删除。'));
      ensureNoDirtyEditors();
      await request('catalog.visibility.update',{kind:target.kind,id:target.id,visibility:next,expectedRevision:latestEntry?.revision??latestSession?.organizationRevision??0,operationId:operationId()});
      onHidden();
    }
    onChanged();close();setDialog(undefined);
  };
  const endSessionsAndDelete=async()=>{
    ensureNoDirtyEditors();
    setDeleteNotice(undefined);
    const current=await request('runtime.snapshot',{}),active=sessionsInCatalogScope(target,current.sessions,project?.path).filter(isActiveSession),confirmed=sessionsToEnd??[];
    if(active.some(session=>!confirmed.some(confirmedSession=>confirmedSession.id===session.id))){setSessionsToEnd(active);setDeleteNotice('scope-changed');return;}
    try{for(const activeSession of active.filter(session=>confirmed.some(confirmedSession=>confirmedSession.id===session.id)))await request('session.stop',{sessionId:activeSession.id,operationId:operationId()});}
    catch(error){setDeleteNotice('stop-failed');throw error;}
    const [latestVisibility,latestSnapshot]=await Promise.all([request('catalog.visibility.list',{}),request('runtime.snapshot',{})]);
    const remaining=sessionsInCatalogScope(target,latestSnapshot.sessions,project?.path).filter(isActiveSession);
    if(remaining.length){setSessionsToEnd(remaining);setDeleteNotice('scope-changed');return;}
    await changeVisibility('removed',{visibility:latestVisibility,sessions:latestSnapshot.sessions});
  };
  const beginDelete=()=>{
    close();setIssue(undefined);setDeleteNotice(undefined);setName(target.name);setSessionsToEnd(activeSessions);setDialog(activeSessions.length?'remove-active':'remove');
  };
  const deleteCatalogRecord=async()=>{
    const current=await request('runtime.snapshot',{}),active=sessionsInCatalogScope(target,current.sessions,project?.path).filter(isActiveSession);
    if(active.length){setSessionsToEnd(active);setDeleteNotice(undefined);setDialog('remove-active');return;}
    const latestVisibility=await request('catalog.visibility.list',{});
    await changeVisibility('removed',{visibility:latestVisibility,sessions:current.sessions});
  };
  const begin=(next:Dialog)=>{close();setIssue(undefined);setDeleteNotice(undefined);setName(target.name);setSessionsToEnd(undefined);setDialog(next);};
  const rename=async()=>{if(!name.trim())return;if(target.kind==='project')await updateProject({name:name.trim()});else await request('session.update',{sessionId:target.id,title:name.trim(),operationId:operationId()});setDialog(undefined);onChanged();};
  const organize=async(patch:{pinned?:boolean;bookmarked?:boolean})=>{if(!session)return;await request('session.organize',{sessionId:session.id,...patch,expectedRevision:session.organizationRevision??0,operationId:operationId()});onChanged();close();};
  const item=(label:string,icon:string,action:()=>void,danger=false,disabled=false)=><button type="button" role="menuitem" className={`menu-item${danger?' danger':''}`} disabled={busy||disabled} onClick={action}><Icon name={icon}/>{label}</button>;
  const archivedTargets:CatalogTarget[]=target.kind==='project'?trees.filter(tree=>visibility.some(row=>row.kind==='worktree'&&row.id===tree.id&&row.visibility==='archived')).map(tree=>({kind:'worktree',id:tree.id,name:tree.branch??text('Local directory','本地目录'),path:tree.path,projectId:tree.projectId,worktreeId:tree.id})):target.kind==='worktree'?sessions.filter(row=>row.projectId===target.projectId&&sameCanonicalScope(row.worktreePath??project?.path,target.path)&&(row.archived||visibility.some(entry=>entry.kind==='session'&&entry.id===row.id&&entry.visibility==='archived'))).map(row=>({...target,kind:'session',id:row.id,name:row.title})):[];
  return <>
    <button type="button" className="icon-btn row-more" aria-label={`${target.name} ${text('Manage','管理')}`} aria-expanded={Boolean(anchor)} onClick={event=>setAnchor(anchor?undefined:event.currentTarget)}><Icon name="more"/></button>
    {anchor&&<CatalogPopover anchor={anchor} onClose={close} label={target.name}>
      <div className="menu-label">{target.name}</div>
      {item(text('Copy directory path','复制目录路径'),'file',()=>void run(async()=>{await navigator.clipboard.writeText(displayPath(target.path));close();}))}
      {item(text('Open directory','查看目录'),'folder',()=>void run(async()=>{await openDirectory(target.projectId,target.worktreeId);close();}))}
      {target.kind!=='session'&&item(text('Refresh directory status','刷新目录状态'),'refresh',()=>{onChanged();close();})}
      {target.kind==='project'&&project&&<>
        {item(text('Discover existing worktrees','发现已有分支工作树'),'branch',()=>begin('discover'))}
        {item(text('Rename project','重命名项目'),'file',()=>begin('rename'))}
        {item(project.pinned?text('Unpin','取消置顶'):text('Pin project','置顶项目'),'star',()=>void run(async()=>{await updateProject({pinned:!project.pinned});close();}))}
        {item(text('Move up','向上移动'),'chevD',()=>void run(()=>move(-1)))}
        {item(text('Move down','向下移动'),'chevD',()=>void run(()=>move(1)))}
      </>}
      {session&&item(session.pinned?text('Unpin from quick switch','取消固定快捷选择'):text('Pin to quick switch','固定到快捷选择'),'star',()=>void run(()=>organize({pinned:!session.pinned})))}
      <div className="menu-sep"/>
      {archived?item(text('Restore','恢复'),'archive',()=>void run(()=>changeVisibility('active'))):item(text('Archive','归档'),'archive',()=>begin('archive'))}
      {item(text('Delete','删除'),'trash',beginDelete,true)}
      {target.kind!=='session'&&<><div className="menu-sep"/><div className="menu-label">{target.kind==='project'?text('Archived branches','归档的分支'):text('Archived sessions','归档的会话')}</div>{archivedTargets.length?archivedTargets.map(row=><button type="button" role="menuitem" className="menu-item" disabled={busy} key={row.id} onClick={()=>void run(async()=>{await restoreCatalogTarget(row,visibility,sessions.find(session=>session.id===row.id));onChanged();close();})}><Icon name={row.kind==='session'?'terminal':'branch'}/><span className="grow">{row.name}</span><span className="dim">{text('Restore','恢复')}</span></button>):<div className="menu-note">{text('No archived items','暂无归档内容')}</div>}</>}
      <div className="menu-sep"/>
      {target.kind!=='session'&&onNewSession&&item(text('New terminal','新建终端'),'plus',()=>{close();onNewSession(target.projectId,target.path);})}
      {session&&<>
        {item(session.followed?text('Unfollow','取消关注'):text('Follow','关注'),'star',()=>void run(async()=>{await request('session.update',{sessionId:session.id,followed:!session.followed,operationId:operationId()});onChanged();close();}))}
        {item(session.bookmarked?text('Remove bookmark','移除书签'):text('Bookmark','添加书签'),'bookmark',()=>void run(()=>organize({bookmarked:!session.bookmarked})))}
        {item(text('Rename session','重命名会话'),'file',()=>begin('rename'))}
      </>}
      <div className="menu-note">{text('Local catalogue only; files and Agent CLI history are retained.','仅本应用归档，不影响磁盘或 Agent CLI')}</div>
      {issue&&<p className="surface-error" role="alert">{issue}</p>}
    </CatalogPopover>}
    {dialog==='rename'&&<SurfaceDialog title={target.kind==='project'?text('Rename project','重命名项目'):text('Rename session','重命名会话')} subtitle={text('Update the display name in ThreadTerm.','更新 ThreadTerm 中的显示名称。')} onClose={()=>{if(!busy)setDialog(undefined);}} size="sm" footer={<><button className="btn" disabled={busy} onClick={()=>setDialog(undefined)}>{text('Cancel','取消')}</button><button className="btn btn-primary" disabled={busy||!name.trim()} onClick={()=>void run(rename)}>{text('Save','保存')}</button></>}><div className="field"><label>{text('Display name','显示名称')}<input autoFocus maxLength={60} value={name} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void run(rename);}}/></label></div>{issue&&<p className="surface-error" role="alert">{issue}</p>}</SurfaceDialog>}
    {(dialog==='archive'||dialog==='remove'||dialog==='remove-active')&&<SurfaceDialog title={dialog==='archive'?text('Archive in ThreadTerm','在 ThreadTerm 中归档'):dialog==='remove-active'?text('End sessions before deleting','会话需要结束后才可删除'):text('Delete catalogue entry','删除目录记录')} subtitle={target.name} icon={dialog==='archive'?'archive':'trash'} className={dialog==='remove-active'?'catalog-active-delete-dialog':''} onClose={()=>{if(!busy)setDialog(undefined);}} size="sm" footer={<><button className="btn" disabled={busy} onClick={()=>setDialog(undefined)}>{text('Cancel','取消')}</button><button className={`btn ${dialog==='archive'?'btn-primary':'btn-danger'}`} disabled={busy} onClick={()=>void run(dialog==='remove-active'?endSessionsAndDelete:dialog==='archive'?()=>changeVisibility('archived'):deleteCatalogRecord)}>{dialog==='archive'?text('Confirm archive','确认归档'):dialog==='remove-active'?(busy?text('Ending sessions…','正在结束…'):text('End and delete','结束并删除')):text('Confirm delete','确认删除')}</button></>}><p className="dlg-text">{dialog==='archive'?text('Hide this entry from the catalogue. Restore it from its parent menu.','从目录中隐藏此记录，可以从上级菜单恢复。'):dialog==='remove-active'?text(`${deleteActiveSessions.length} active session${deleteActiveSessions.length===1?'':'s'} in this scope will be ended before this catalogue entry is removed.`, `此范围内有 ${deleteActiveSessions.length} 个活动会话。结束后会删除该目录记录。`):text('Remove this entry from the ThreadTerm catalogue.','从 ThreadTerm 目录中删除此记录。')}</p>{dialog==='remove-active'&&<p className="note">{text(`Sessions to end: ${deleteActiveSessions.map(row=>row.title).join(', ')}`,`需要结束：${deleteActiveSessions.map(row=>row.title).join('、')}`)}</p>}<p className="note">{dialog==='archive'?text('Files and Agent CLI history are retained. End active sessions in this scope before proceeding.','磁盘文件和 Agent CLI 历史会保留。此范围仍有活动会话时，请先结束会话。'):text('Files and Agent CLI history are retained. Only this catalogue record is removed.','磁盘文件和 Agent CLI 历史会保留；仅删除本应用中的目录记录。')}</p>{deleteNotice==='scope-changed'&&<p className="catalog-active-delete-notice" role="status">{text('The active sessions in this scope changed. Review the updated list, then choose End and delete again.','此范围内的活动会话已变化。请查看更新后的列表，然后再次选择结束并删除。')}</p>}{issue&&<div className="surface-error" role="alert">{dialog==='remove-active'&&<strong>{deleteNotice==='stop-failed'?text('Unable to end every listed session. Review the reason below, then retry.','未能结束列表中的全部会话。请查看以下原因后重试。'):text('The catalogue entry was not deleted.','目录记录尚未删除。')}</strong>}<span>{issue.includes('end_active_sessions')?text('End active sessions in this scope before changing its catalogue visibility.','请先结束此范围内的活动会话，再进行归档或删除。'):issue}</span></div>}</SurfaceDialog>}
    {dialog==='discover'&&<SurfaceDialog title={text('Discover existing worktrees','发现已有分支工作树')} subtitle={displayPath(target.path)} icon="branch" size="wide" onClose={()=>setDialog(undefined)} footer={<button className="btn" onClick={()=>setDialog(undefined)}>{text('Cancel','取消')}</button>}><div className="catalog-discovery">{trees.map(tree=><button type="button" className="menu-item" key={tree.id} onClick={()=>{setDialog(undefined);onWorktree?.(tree.projectId,tree.path);}}><Icon name="branch"/><span>{tree.branch??text('Local directory','本地目录')}<small>{displayPath(tree.path)}</small></span>{tree.missing&&<span className="dim">{text('Missing','目录缺失')}</span>}</button>)}</div></SurfaceDialog>}
  </>;
}

export function CatalogPopover({anchor,onClose,label,children}:{anchor:HTMLElement;onClose:()=>void;label:string;children:ReactNode}){
  const panel=useRef<HTMLDivElement>(null),callback=useRef(onClose);callback.current=onClose;
  const [position,setPosition]=useState<{left:number;top:number}>();
  const mounted=position!==undefined;
  useLayoutEffect(()=>{
    const place=()=>{
      const box=anchor.getBoundingClientRect(),height=panel.current?.offsetHeight??0;
      const next={left:Math.max(8,Math.min(innerWidth-288,box.right+6)),top:Math.max(8,Math.min(innerHeight-height-8,box.top))};
      setPosition(current=>current&&current.left===next.left&&current.top===next.top?current:next);
    };
    place();
    if(!mounted)return;
    if(!panel.current?.contains(document.activeElement))panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    addEventListener('resize',place);
    return()=>removeEventListener('resize',place);
  },[anchor,mounted]);
  useEffect(()=>{
    const pointer=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!anchor.contains(event.target as Node))callback.current();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();callback.current();}if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}};
    addEventListener('pointerdown',pointer);addEventListener('keydown',key,true);
    return()=>{removeEventListener('pointerdown',pointer);removeEventListener('keydown',key,true);if(anchor.isConnected)anchor.focus();};
  },[anchor]);
  return position&&createPortal(<div ref={panel} className="popover catalogue-popover" role="menu" aria-label={label} style={position}>{children}</div>,document.body);
}
