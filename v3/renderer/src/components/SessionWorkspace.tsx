import { Select } from "./ui/Select";
import { useEffect, useRef, useState } from 'react';
import type { FileEntry, GitStatus, PaneLayout, Session, Snapshot, Worktree } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { confirmCloseEditors } from '../dirtyEditors';
import { insertTerminalText } from '../terminalInputTargets';
import { useTranslation } from '../i18n';
import { addSessionTab } from '../presentation';
import { displayPath, sameCanonicalScope } from '../projectScope';
import { addPane, addTabToPane, closePane, paneCount, sessionIdsIn } from '../workspaceLayout';
import { FileWorkspace } from './FileWorkspace';
import { PaneWorkspace } from './PaneWorkspace';
import { AgentIcon, Icon } from './PrototypeIcon';
import { SessionActions } from './SessionActions';
import { SessionConfigDialog } from './SessionConfigDialog';
import { SurfaceDialog } from './SurfaceDialog';
import './session-workspace.css';

const providerName=(id:string)=>({claude:'Claude',codex:'Codex',opencode:'OpenCode',shell:'Shell',kimi:'Kimi',gemini:'Gemini',grok:'Grok',custom:'Custom'}[id]??id);
const working=(s:Session)=>!s.readOnly&&['starting','running','idle','waiting'].includes(s.status);
const tabFor=(s:Session)=>({id:`session-${s.id}`,kind:'session' as const,sessionId:s.id});
const initialFor=(s:Session):PaneLayout=>({kind:'pane',id:`pane-${s.id}`,tabs:[tabFor(s)],activeTabId:tabFor(s).id});

type Props={session:Session;data:Snapshot;theme:'light'|'dark';onBack:()=>void;onSelect:(id:string)=>void;onProject:(id:string,path?:string)=>void;onChanged:()=>void;initialLayout?:PaneLayout;backgroundPresentation?:string;onBackgroundPresented:()=>void;pendingCommands?:string[];onClearCommands?:()=>void};
export function SessionWorkspace({session,data,theme,onBack,onSelect,onProject,onChanged,initialLayout,backgroundPresentation,onBackgroundPresented,pendingCommands=[],onClearCommands}:Props){
 const {locale}=useTranslation(),zh=locale==='zh-CN';
 const project=data.projects.find(p=>p.id===session.projectId),path=session.worktreePath??project?.path;
 const restored=data.workspaces.find(w=>w.projectId===session.projectId&&sameCanonicalScope(w.worktreePath??project?.path,path));
 const [layout,setLayout]=useState<PaneLayout>(initialLayout??restored?.layout??initialFor(session));
 const workspace=paneCount(layout)>1;
 const [view,setView]=useState<'terminal'|'file'|'diff'>('terminal');
 const [fileOpened,setFileOpened]=useState(false),[filePath,setFilePath]=useState<string>(),[fileDirty,setFileDirty]=useState(false);
 const [trees,setTrees]=useState<Worktree[]>([]),[files,setFiles]=useState<FileEntry[]>([]),[git,setGit]=useState<GitStatus>();
 const [inspector,setInspector]=useState(pendingCommands.length>0),[fileQuery,setFileQuery]=useState('');
 const [picker,setPicker]=useState<{mode:'switch'|'add'|'fill';paneId?:string}>(),[query,setQuery]=useState(''),[allProjects,setAllProjects]=useState(false);
 const [commandTarget,setCommandTarget]=useState(session.id),[commandNotice,setCommandNotice]=useState<string>();
 useEffect(()=>{if(pendingCommands.length)setInspector(true);},[pendingCommands]);
 const fillCommand=(command:string)=>{try{insertTerminalText(commandTarget,command);setCommandNotice(zh?'已填入终端，请检查后按回车执行。':'Inserted into the terminal. Review it before pressing Enter.');}catch(error){setIssue(zh?'请先打开目标会话的终端窗格并取得输入控制权。命令只能包含一行。':String(error));}};
 const [configOpen,setConfigOpen]=useState(false);
 const [issue,setIssue]=useState<string>(),[fullscreen,setFullscreen]=useState(false);
 const saving=useRef(Promise.resolve()),saved=useRef({id:restored?.id,revision:restored?.revision??0});
 const currentTree=trees.find(tree=>sameCanonicalScope(tree.path,path));
 const treeSessions=data.sessions.filter(s=>s.projectId===session.projectId&&sameCanonicalScope(s.worktreePath??project?.path,path)&&(!s.archived||s.id===session.id));
 const state=session.readOnly?'ended':session.status==='waiting'?'needs':session.status==='error'?'failed':session.status==='interrupted'?'stalled':working(session)?'running':'ended';
 const stateLabel=zh?({needs:'待处理',failed:'失败',stalled:'已中断',running:'运行中',ended:session.readOnly?'只读历史':'已结束'}[state]):({needs:'Attention',failed:'Failed',stalled:'Interrupted',running:'Running',ended:session.readOnly?'Read-only history':'Ended'}[state]);
 const fail=(error:unknown)=>setIssue(error instanceof Error?error.message:String(error));
 const save=(next:PaneLayout)=>{
  setLayout(next);
  saving.current=saving.current.then(async()=>{
   try{const value=await request('workspace.save',{id:saved.current.id,name:session.title,projectId:session.projectId,worktreePath:path,layout:next,expectedRevision:saved.current.revision,operationId:operationId()});saved.current={id:value.id,revision:value.revision};}
   catch(error){fail(error);}
  });
 };
 useEffect(()=>{
  if(!session.projectId)return;
  let live=true;const scope={projectId:session.projectId,worktreePath:path};
  void request('worktree.list',{projectId:session.projectId}).then(value=>{if(live)setTrees(value);}).catch(fail);
  void request('filesystem.list',{...scope,path:''}).then(value=>{if(live)setFiles(value);}).catch(()=>{});
  void request('git.status',scope).then(value=>{if(live){setGit(value);setFilePath(current=>current??value.changes[0]?.path);}}).catch(()=>{});
  return()=>{live=false;};
 },[session.projectId,path]);
 useEffect(()=>{if(!backgroundPresentation)return;save(addSessionTab(layout,backgroundPresentation));onBackgroundPresented();},[backgroundPresentation]);
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setFullscreen(false);};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[]);
 const change=(direction:-1|1)=>{const index=treeSessions.findIndex(s=>s.id===session.id);const next=treeSessions[(index+direction+treeSessions.length)%treeSessions.length];if(next)onSelect(next.id);};
 const switchView=(next:'terminal'|'file'|'diff')=>{if(next!=='terminal')setFileOpened(true);setView(next);};
 const addSessionPane=(s:Session)=>{save(addPane(layout,tabFor(s)));setPicker(undefined);};
 const fillPane=(s:Session)=>{if(picker?.mode!=='fill'||!picker.paneId)return;save(addTabToPane(layout,picker.paneId,tabFor(s)));setPicker(undefined);};
 const cancelPicker=()=>{if(picker?.mode==='fill'&&picker.paneId){const next=closePane(layout,picker.paneId);if(next)save(next);}setPicker(undefined);};
 const exitSplit=async()=>{if(!await confirmCloseEditors())return;save(initialFor(session));};
 const available=picker&&picker.mode!=='switch'?treeSessions.filter(s=>!sessionIdsIn(layout).includes(s.id)):allProjects?data.sessions.filter(s=>!s.archived):treeSessions;
 const openFile=(next:string)=>{setFilePath(next);switchView('file');};
 const follow=()=>void request('session.update',{sessionId:session.id,followed:!session.followed,operationId:operationId()}).then(onChanged).catch(fail);
 const localFiles=[...new Set([...(git?.changes.map(change=>change.path)??[]),...files.filter(file=>file.kind==='file').map(file=>file.path)])];
 return <section className={`ws session-screen runtime-workspace${fullscreen?' terminal-fullscreen':''}`} aria-label={zh?'终端工作区':'Terminal workspace'}>
  <header className="ws-top">
   <button className="ws-back" onClick={onBack}><Icon name="back"/><span>{zh?'返回工作台':'Back to workbench'}</span></button>
   <button className="btn btn-ghost" onClick={onBack}>{zh?'网格':'Grid'}</button>
   <button className="btn btn-ghost" onClick={()=>change(-1)} disabled={treeSessions.length<2}>{zh?'上一个':'Previous'}</button>
   <button className="btn btn-ghost" onClick={()=>change(1)} disabled={treeSessions.length<2}>{zh?'下一个':'Next'}</button>
   {project&&<button className="ws-chip" onClick={()=>onProject(project.id)}><span className="dot primary"/>{project.name}</button>}
   {project&&<button className="ws-chip branch" title={displayPath(path)} onClick={()=>onProject(project.id,path)}><Icon name="branch"/>{currentTree?.branch??git?.branch??displayPath(path)?.split(/[\\/]/).at(-1)}</button>}
   <div className="top-spacer"/><span className={`chip st-${state}`}>{stateLabel}</span>
   <button className="icon-btn" onClick={()=>setInspector(value=>!value)} aria-pressed={inspector} aria-label={zh?'会话详情面板':'Session details'}><Icon name="panel"/></button>
  </header>
  <div className="ws-body"><div className="ws-center">
   <nav className="ws-tabrow" aria-label={zh?'工作区内容':'Workspace content'}><div className="segctrl">
    <button className={`tab${view==='terminal'?' active':''}`} onClick={()=>switchView('terminal')} aria-pressed={view==='terminal'}><Icon name="terminal"/>{zh?'终端':'Terminal'}</button>
    <button className={`tab${view==='file'?' active':''}`} onClick={()=>switchView('file')} disabled={!project} aria-pressed={view==='file'}><Icon name="file"/>{filePath?.split(/[\\/]/).at(-1)??(zh?'文件':'Files')}{fileDirty?(zh?' · 未保存':' · Unsaved'):''}</button>
    <button className={`tab${view==='diff'?' active':''}`} onClick={()=>switchView('diff')} disabled={!project} aria-pressed={view==='diff'}><Icon name="branch"/>{git?(zh?`${git.changes.length} 个差异`:`${git.changes.length} changes`):(zh?'差异':'Changes')}</button>
   </div></nav>
   <div className="ws-strip">{treeSessions.map(s=><button key={s.id} className={`sess-chip${s.id===session.id?' active':''}${workspace&&sessionIdsIn(layout).includes(s.id)?' tiled':''}`} onClick={()=>onSelect(s.id)}><AgentIcon provider={s.provider}/>{providerName(s.provider)} · {s.title}</button>)}
    {treeSessions.length>1&&(!workspace||paneCount(layout)<4)&&<button className="btn btn-ghost" onClick={()=>{setPicker({mode:'add'});setQuery('');}}><Icon name={workspace?'plus':'split'}/>{zh?(workspace?'添加窗格':'并排查看'):(workspace?'Add pane':'Side by side')}</button>}
    {workspace&&<button className="btn btn-ghost" onClick={()=>void exitSplit()}>{zh?'收起为单窗格':'Collapse to single pane'}</button>}
    <div className="top-spacer"/><button className="btn btn-ghost" onClick={()=>{setPicker({mode:'switch'});setQuery('');}}>{zh?'切换会话':'Switch session'}<Icon name="chevD"/></button>
   </div>
   {issue&&<p className="surface-error" role="alert">{issue}</p>}
   <div className={`ws-content${inspector?' with-drawer':''}`}><div className="ws-pane">
    <div className="workspace-content-host" hidden={view!=='terminal'}>
     <PaneWorkspace layout={layout} sessions={data.sessions} theme={theme} terminalCompatibility={data.settings.terminalCompatibility} onChange={save} onSessionChanged={onChanged} ownerSessionId={session.id} onPickSession={(paneId)=>{setPicker({mode:'fill',paneId});setQuery('');}}/>
    </div>
    {fileOpened&&project&&<div className="workspace-content-host" hidden={view==='terminal'}><FileWorkspace projectId={project.id} worktreePath={path} initialPath={filePath} initialView={view==='diff'?'diff':'file'} view={view==='diff'?'diff':'file'} onViewChange={next=>switchView(next==='diff'?'diff':'file')} onDocumentChange={value=>{setFilePath(value.path);setFileDirty(value.dirty);}} editorId={`session-workspace:${session.id}`} ownerSessionId={session.id}/></div>}
   </div>{inspector&&<aside className="inspector" aria-label={zh?'会话详情面板':'Session details'}><div className="ins-head">{zh?'文件':'Files'}</div><div className="ins-scroll">
    <div className="ins-block"><div className="input-wrap ins-filter"><Icon name="search"/><input placeholder={zh?'筛选关联文件':'Filter related files'} value={fileQuery} onChange={event=>setFileQuery(event.target.value)}/></div>{localFiles.filter(file=>file.toLowerCase().includes(fileQuery.toLowerCase())).map(file=><button className="file-link" key={file} onClick={()=>openFile(file)}><Icon name="file"/>{file}</button>)}{!localFiles.length&&<p>{zh?'此目录没有可显示的文件。':'No files to display in this directory.'}</p>}</div>
    {pendingCommands.length>0&&<div className="ins-block pcol-ctx-sec"><h3>{zh?'待审阅命令':'Commands to review'}</h3><p className="note">{zh?'点击命令填入目标终端；不会自动按回车或替换已有输入。':'Insert a command into the target terminal, then review it before pressing Enter.'}</p><label>{zh?'目标会话':'Target session'}<Select value={commandTarget} onChange={event=>setCommandTarget(event.target.value)}>{data.sessions.filter(candidate=>candidate.mode==='terminal'&&working(candidate)&&(sessionIdsIn(layout).includes(candidate.id)||candidate.id===session.id)).map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</Select></label>{pendingCommands.map((command,index)=><button type="button" className="cmd-opt" key={index} title={zh?'填入终端（不执行）':'Insert into terminal without executing'} onClick={()=>fillCommand(command)}>{command}</button>)}{commandNotice&&<p className="note" role="status">{commandNotice}</p>}<button className="btn-subtle" onClick={onClearCommands}>{zh?'清空待审阅命令':'Clear command list'}</button></div>}
    <div className="ins-block"><h3>{zh?'会话信息':'Session information'}</h3><span className={`chip st-${state}`}>{stateLabel}</span><p>{session.title}</p><p className="mono dim-s">{displayPath(path)}</p><button className="btn" onClick={()=>setConfigOpen(true)}>{zh?'配置':'Configure'}</button></div>
    <div className="ins-block"><h3>{zh?'重点关注':'Following'}</h3><button className="btn" onClick={follow} aria-pressed={session.followed}><Icon name="star"/>{zh?(session.followed?'已关注 · 点击取消':'关注此会话'):(session.followed?'Following · Unfollow':'Follow session')}</button></div>
    <div className="ins-block runtime-session-actions"><SessionActions session={session}/><button className="btn" onClick={()=>setFullscreen(value=>!value)}>{zh?'全屏终端':'Fullscreen terminal'}</button></div>
   </div></aside>}</div>
  </div></div>
  {picker&&<SurfaceDialog title={zh?(picker.mode==='switch'?'切换会话':picker.mode==='add'?'选择并排会话':'选择会话'):(picker.mode==='switch'?'Switch session':picker.mode==='add'?'Choose session for split':'Choose session')} onClose={cancelPicker} size="sm"><div className="switcher"><div className="tools"><div className="input-wrap"><Icon name="search"/><input autoFocus value={query} onChange={event=>setQuery(event.target.value)} placeholder={zh?'搜索会话':'Search sessions'}/></div>{picker.mode==='switch'&&<Select value={allProjects?'all':'tree'} onChange={event=>setAllProjects(event.target.value==='all')}><option value="tree">{zh?'当前工作树':'Current worktree'}</option><option value="all">{zh?'全部项目':'All projects'}</option></Select>}</div><div className="switcher-list">{available.filter(s=>`${s.title} ${s.provider}`.toLowerCase().includes(query.toLowerCase())).map(s=><button className="switcher-row" key={s.id} onClick={()=>{if(picker.mode==='switch'){setPicker(undefined);onSelect(s.id);}else if(picker.mode==='add')addSessionPane(s);else fillPane(s);}}><AgentIcon provider={s.provider}/>{s.title}<small>{providerName(s.provider)}</small></button>)}</div>{!available.length&&<p className="note">{zh?'没有其他可选会话。':'No other sessions are available.'}</p>}</div></SurfaceDialog>}
  {configOpen&&<SessionConfigDialog session={session} onClose={()=>setConfigOpen(false)} onRerun={onSelect}/>}
 </section>;
}
