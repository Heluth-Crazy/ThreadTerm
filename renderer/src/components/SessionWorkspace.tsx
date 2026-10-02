import { Select } from "./ui/Select";
import { useEffect, useRef, useState } from 'react';
import type { ContentRef, Draft, FileReference, GitStatus, PaneLayout, Session, Snapshot, Worktree } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { insertSessionText, insertTerminalText } from '../terminalInputTargets';
import { useTranslation } from '../i18n';
import { addSessionTab } from '../presentation';
import { displayPath, sameCanonicalScope } from '../projectScope';
import { activate, addPane, addTabToPane, closePane, reconcileSessionLayout, sessionIdsIn, sessionOnlyLayout } from '../workspaceLayout';
import { isFileTab, removeWorkspaceTabs, workspaceTabs, type FileTab } from '../workspaceTabs';
import { canSplitPaneArea, fileViewPlacement, visibleSessionLayout } from '../sessionFileViews';
import { PaneWorkspace, type PaneWorkbench } from './PaneWorkspace';
import { WorkbenchSideBar, type WorkbenchCommand, type WorkbenchView } from './WorkbenchSideBar';
import { QuickOpen, invalidateQuickOpen } from './QuickOpen';
import { dirtyPathsInScope } from '../dirtyEditors';
import { formatAgentReference, referencePath } from '../workbench/agentReference';
import { workbenchError } from '../workbench/errors';
import { coveredBy, type WorkbenchActions, type WorkbenchScope } from '../workbench/types';
import { AgentIcon, Icon } from './PrototypeIcon';
import { SessionActions } from './SessionActions';
import { SessionConfigDialog } from './SessionConfigDialog';
import { SurfaceDialog } from './SurfaceDialog';
import './session-workspace.css';

const providerName=(id:string)=>({claude:'Claude',codex:'Codex',opencode:'OpenCode',shell:'Shell',kimi:'Kimi',gemini:'Gemini',grok:'Grok',custom:'Custom'}[id]??id);
const working=(s:Session)=>!s.readOnly&&['starting','running','idle','waiting'].includes(s.status);
const tabFor=(s:Session)=>({id:`session-${s.id}`,kind:'session' as const,sessionId:s.id});
const initialFor=(s:Session):PaneLayout=>({kind:'pane',id:`pane-${s.id}`,tabs:[tabFor(s)],activeTabId:tabFor(s).id});
/** One tab per file with unsaved edits: its file/preview tab, or its diff tab when that is the only view of it. */
const unsavedTabIds=(tabs:readonly ContentRef[],unsaved:(tab:FileTab)=>boolean)=>{
 const chosen=new Map<string,FileTab>();
 for(const tab of tabs){
  if(!isFileTab(tab)||!unsaved(tab))continue;
  const key=`${tab.projectId}\0${tab.worktreePath??''}\0${tab.path}`,current=chosen.get(key);
  if(!current||(current.kind==='diff'&&tab.kind!=='diff'))chosen.set(key,tab);
 }
 return new Set([...chosen.values()].map(tab=>tab.id));
};

type Props={session:Session;data:Snapshot;theme:'light'|'dark';onBack:()=>void;onSelect:(id:string)=>void;onProject:(id:string,path?:string)=>void;onChanged:()=>void;initialLayout?:PaneLayout;backgroundPresentation?:string;onBackgroundPresented:()=>void;pendingCommands?:string[];onClearCommands?:()=>void;navigationKey?:unknown;onActiveSession?:(id:string)=>void};
export function SessionWorkspace({session,data,theme,onBack,onSelect,onProject,onChanged,initialLayout,backgroundPresentation,onBackgroundPresented,pendingCommands=[],onClearCommands,navigationKey,onActiveSession}:Props){
 const {locale}=useTranslation(),zh=locale==='zh-CN';
 const project=data.projects.find(p=>p.id===session.projectId),path=session.worktreePath??project?.path;
 const restored=data.workspaces.find(w=>w.projectId===session.projectId&&sameCanonicalScope(w.worktreePath??project?.path,path));
 // A session opens as just a session (user decision 2026-09-28): restored file/Git/history/review tabs are not
 // shown again; file tabs with unsaved edits come back once draft.list answers (restoreUnsaved). Preset layouts
 // (initialLayout) are an explicit choice and stay as they are.
 const openedFrom=useRef<{source:PaneLayout;stripped:PaneLayout}|undefined>(undefined);
 const [layout,setLayout]=useState<PaneLayout>(()=>{
  if(initialLayout)return initialLayout;
  if(!restored)return initialFor(session);
  const stripped=reconcileSessionLayout(sessionOnlyLayout(restored.layout,()=>false),new Set(data.sessions.map(item=>item.id)),session.id);
  openedFrom.current={source:restored.layout,stripped};
  return stripped;
 });
 const [previewSessionId,setPreviewSessionId]=useState(session.id);
 const latestLayout=useRef(layout);latestLayout.current=layout;
 const [toolbarHost,setToolbarHost]=useState<HTMLDivElement|null>(null),[switcherHost,setSwitcherHost]=useState<HTMLDivElement|null>(null);
 // Split decisions use the space the panes actually get (the side bar and inspector take their own share).
 const paneArea=useRef<HTMLDivElement>(null),wideForSplit=()=>Boolean(paneArea.current&&canSplitPaneArea(paneArea.current.clientWidth));
 const [focusTarget,setFocusTarget]=useState<{paneId:string;tabId:string;key:string}|undefined>(()=>{const target=workspaceTabs(layout).find(item=>item.tab.kind==='session'&&item.tab.sessionId===session.id);return target?{paneId:target.paneId,tabId:target.tab.id,key:'initial'}:undefined;});
 const [fileReveal,setFileReveal]=useState<{tabId:string;line:number;column?:number;key:string}>();
 const fileOpenGeneration=useRef(0),live=useRef(true);
 useEffect(()=>{live.current=true;return()=>{live.current=false;fileOpenGeneration.current++;};},[]);
 const [trees,setTrees]=useState<Worktree[]>([]),[git,setGit]=useState<GitStatus>();
 const [workbenchCommand,setWorkbenchCommand]=useState<WorkbenchCommand>(),[quickOpen,setQuickOpen]=useState(false),[historyFocus,setHistoryFocus]=useState<{tabId:string;commit:string;key:string}>();
 const [inspector,setInspector]=useState(pendingCommands.length>0);
 const [picker,setPicker]=useState<{mode:'switch'|'add'|'fill';paneId?:string}>(),[query,setQuery]=useState(''),[allProjects,setAllProjects]=useState(false);
 const [commandTarget,setCommandTarget]=useState(session.id),[commandNotice,setCommandNotice]=useState<string>();
 useEffect(()=>{if(pendingCommands.length)setInspector(true);},[pendingCommands]);
 const fillCommand=(command:string)=>{try{insertTerminalText(commandTarget,command);setCommandNotice(zh?'已填入终端，请检查后按回车执行。':'Inserted into the terminal. Review it before pressing Enter.');}catch(error){setIssue(zh?'请先打开目标会话的终端窗格并取得输入控制权。命令只能包含一行。':String(error));}};
 const [configOpen,setConfigOpen]=useState(false);
 const [issue,setIssue]=useState<string>(),[fullscreen,setFullscreen]=useState(false);
 const [fileIssue,setFileIssue]=useState<{path:string;message:string}>();
 const saving=useRef(Promise.resolve()),saved=useRef({id:restored?.id,revision:restored?.revision??0});
 const persistedLayout=useRef<PaneLayout|undefined>(undefined);
 const currentTree=trees.find(tree=>sameCanonicalScope(tree.path,path));
 const treeSessions=data.sessions.filter(s=>s.projectId===session.projectId&&sameCanonicalScope(s.worktreePath??project?.path,path)&&(!s.archived||s.id===session.id));
 const state=session.readOnly?'ended':session.status==='waiting'?'needs':session.status==='error'?'failed':session.status==='interrupted'?'stalled':working(session)?'running':'ended';
 const stateLabel=zh?({needs:'待处理',failed:'失败',stalled:'已中断',running:'运行中',ended:session.readOnly?'只读历史':'已结束'}[state]):({needs:'Attention',failed:'Failed',stalled:'Interrupted',running:'Running',ended:session.readOnly?'Read-only history':'Ended'}[state]);
 const fail=(error:unknown)=>setIssue(error instanceof Error?error.message:String(error));
 const save=(next:PaneLayout)=>{
  latestLayout.current=next;
  setLayout(next);
  saving.current=saving.current.then(async()=>{
   try{const value=await request('workspace.save',{id:saved.current.id,name:session.title,projectId:session.projectId,worktreePath:path,layout:next,expectedRevision:saved.current.revision,operationId:operationId()});saved.current={id:value.id,revision:value.revision};persistedLayout.current=next;}
   catch(error){fail(error);}
  });
 };
 /** Bring back file tabs dropped on open that still have unsaved edits (drafts), in their old places when the
  * layout is still the one shown on open, otherwise beside the routed session. Persist the result. */
 const restoreUnsaved=async(source:PaneLayout,stripped:PaneLayout)=>{
  const kept=new Set(workspaceTabs(stripped).map(item=>item.tab.id));
  const dropped=workspaceTabs(source).filter(item=>item.tab.kind!=='session'&&!kept.has(item.tab.id));
  if(!dropped.length)return;
  // Drafts are keyed by the exact scope string the editor used (none for project scope), so ask per scope.
  const scopes=new Map<string,{projectId:string;worktreePath?:string}>();
  for(const {tab} of dropped)if(isFileTab(tab))scopes.set(`${tab.projectId}\0${tab.worktreePath??''}`,{projectId:tab.projectId,...(tab.worktreePath?{worktreePath:tab.worktreePath}:{})});
  const drafts:Draft[]=(await Promise.all([...scopes.values()].map(scope=>request('draft.list',scope).catch(()=>[] as Draft[])))).flat();
  if(!live.current)return;
  const unsaved=unsavedTabIds(dropped.map(item=>item.tab),tab=>drafts.some(draft=>draft.projectId===tab.projectId&&draft.path===tab.path&&(draft.worktreePath||'')===(tab.worktreePath??'')));
  if(latestLayout.current===stripped){
   const next=unsaved.size?reconcileSessionLayout(sessionOnlyLayout(source,tab=>kept.has(tab.id)||unsaved.has(tab.id)),new Set(data.sessions.map(item=>item.id)),session.id):stripped;
   save(next);
   return;
  }
  let next=latestLayout.current;
  const home=workspaceTabs(next).find(item=>item.tab.kind==='session'&&item.tab.sessionId===session.id)?.paneId;
  for(const {tab} of dropped)if(home&&unsaved.has(tab.id)&&!workspaceTabs(next).some(item=>item.tab.id===tab.id))next=addTabToPane(next,home,tab);
  if(next!==latestLayout.current)save(next);
 };
 useEffect(()=>{if(openedFrom.current)void restoreUnsaved(openedFrom.current.source,openedFrom.current.stripped);},[]);
 useEffect(()=>{
  if(!session.projectId)return;
  let live=true;const scope={projectId:session.projectId,worktreePath:path};
  void request('worktree.list',{projectId:session.projectId}).then(value=>{if(live)setTrees(value);}).catch(fail);
  void request('git.status',scope).then(value=>{if(live)setGit(value);}).catch(()=>{});
  return()=>{live=false;};
 },[session.projectId,path]);
 useEffect(()=>{if(!backgroundPresentation)return;save(addSessionTab(latestLayout.current,backgroundPresentation));onBackgroundPresented();},[backgroundPresentation]);
 const previousInitial=useRef(initialLayout);
 useEffect(()=>{if(initialLayout&&initialLayout!==previousInitial.current){fileOpenGeneration.current++;save(initialLayout);setPreviewSessionId(session.id);}previousInitial.current=initialLayout;},[initialLayout]);
 const lastNavigation=useRef(navigationKey);
 useEffect(()=>{
  if(lastNavigation.current===navigationKey)return;lastNavigation.current=navigationKey;
  fileOpenGeneration.current++;
  setPreviewSessionId(session.id);
  // Switching sessions inside an open workspace keeps its tabs and side panel (A/B file previews must come back
  // when returning to A). Only opening the workspace drops restored non-session tabs; see the layout state above.
  const next=reconcileSessionLayout(latestLayout.current,new Set(data.sessions.map(item=>item.id)),session.id);
  if(next!==latestLayout.current)save(next);
  const target=workspaceTabs(next).find(item=>item.tab.kind==='session'&&item.tab.sessionId===session.id);
  if(target)setFocusTarget({paneId:target.paneId,tabId:target.tab.id,key:crypto.randomUUID()});
 },[navigationKey,session.id]);
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setFullscreen(false);};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[]);
 const change=(direction:-1|1)=>{const index=treeSessions.findIndex(s=>s.id===session.id);const next=treeSessions[(index+direction+treeSessions.length)%treeSessions.length];if(next)onSelect(next.id);};
 const addSessionPane=(s:Session)=>{save(addPane(layout,tabFor(s)));setPicker(undefined);};
 const fillPane=(s:Session)=>{if(picker?.mode!=='fill'||!picker.paneId)return;save(addTabToPane(layout,picker.paneId,tabFor(s)));setPicker(undefined);};
 const cancelPicker=()=>{if(picker?.mode==='fill'&&picker.paneId&&!workspaceTabs(latestLayout.current).some(item=>item.paneId===picker.paneId)){const next=closePane(latestLayout.current,picker.paneId);if(next)save(next);}setPicker(undefined);};
 const available=picker&&picker.mode!=='switch'?treeSessions.filter(s=>!sessionIdsIn(layout).includes(s.id)):allProjects?data.sessions.filter(s=>!s.archived):treeSessions;
 const openScopedFile=async(next:{projectId:string;worktreePath?:string;path:string;kind:'file'|'diff'|'preview';assetKind?:'text'|'image';line?:number;column?:number;sourcePaneId?:string;ownerSessionId?:string;staged?:boolean},generation=++fileOpenGeneration.current)=>{
  const ownerSessionId=next.ownerSessionId;
  const opened=workspaceTabs(latestLayout.current);
  const existing=opened.find(item=>item.tab.kind!=='session'&&item.tab.ownerSessionId===ownerSessionId&&item.tab.kind===next.kind&&item.tab.projectId===next.projectId&&sameCanonicalScope(item.tab.worktreePath??project?.path,next.worktreePath??project?.path)&&item.tab.path===next.path&&(next.kind!=='diff'||(item.tab.kind==='diff'&&Boolean(item.tab.staged)===Boolean(next.staged))));
  let target=existing;
  if(!target){
   const placement=fileViewPlacement(latestLayout.current,ownerSessionId,next.sourcePaneId,wideForSplit());
   if(!live.current||generation!==fileOpenGeneration.current)return;
   const tab:ContentRef={id:crypto.randomUUID(),kind:next.kind,projectId:next.projectId,worktreePath:next.worktreePath,path:next.path,assetKind:next.assetKind,ownerSessionId,...(next.kind==='diff'&&next.staged?{staged:true}:{})};
   const updated=placement.split?addPane(latestLayout.current,tab):addTabToPane(latestLayout.current,placement.paneId,tab);
   target=workspaceTabs(updated).find(item=>item.tab.id===tab.id);if(!target)return;
   save(updated);
  }else{
   if(!live.current||generation!==fileOpenGeneration.current)return;
   if(!workspaceTabs(latestLayout.current).some(item=>item.paneId===target!.paneId&&item.tab.id===target!.tab.id))return;
   save(activate(latestLayout.current,target.paneId,target.tab.id));
  }
  if(ownerSessionId)setPreviewSessionId(ownerSessionId);
  const key=crypto.randomUUID();setFocusTarget({paneId:target.paneId,tabId:target.tab.id,key});
  if(next.line||next.column)setFileReveal({tabId:target.tab.id,line:next.line??1,column:next.column,key});
 };
 const openPaneFile=(file:Parameters<typeof openScopedFile>[0])=>void openScopedFile({...file,kind:file.kind==='file'&&(file.assetKind==='image'||/\.(md|png|jpe?g|gif|webp)$/i.test(file.path))?'preview':file.kind}).catch(fail);
 const openReference=async(sessionId:string,reference:FileReference)=>{
  const generation=++fileOpenGeneration.current;setFileIssue(undefined);
  try{
   const resolved=await request('filesystem.resolve',{sessionId,...reference});
   if(!live.current||generation!==fileOpenGeneration.current)return;
   const sourcePaneId=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===sessionId)?.paneId;
   await openScopedFile({...resolved,sourcePaneId,ownerSessionId:sessionId,assetKind:resolved.kind,kind:resolved.kind==='image'||/\.md$/i.test(resolved.path)?'preview':'file'},generation);
  }catch(error){if(live.current&&generation===fileOpenGeneration.current){
   const reason=error instanceof Error?error.message:String(error);
   const known:Record<string,[string,string]>={file_reference_not_found:['文件不存在或已移动。','The file is missing or has moved.'],file_reference_not_file:['这是目录，不是可打开的文件。','This is a directory, not a file.'],file_reference_outside_scope:['文件不在此会话的工作目录范围内。','This file is outside the session workspace.'],file_reference_relative_requires_absolute:['Shell 的当前目录可能已改变，请使用完整路径。','The shell directory may have changed. Use an absolute path.'],file_too_large:['文件太大，暂时无法在应用内打开。','The file is too large to open here.'],image_too_large:['图片太大，暂时无法预览。','The image is too large to preview.']};
   const match=Object.entries(known).find(([code])=>reason.includes(code));
   setFileIssue({path:reference.path,message:match?match[1][zh?0:1]:(zh?'无法打开此文件：':'Unable to open this file: ')+reason});
  }}
 };
 const follow=()=>void request('session.update',{sessionId:session.id,followed:!session.followed,operationId:operationId()}).then(onChanged).catch(fail);
 const previewKind=(file:string,assetKind?:'text'|'image')=>assetKind==='image'||/\.(md|png|jpe?g|gif|webp)$/i.test(file)?'preview' as const:'file' as const;
 // Workbench (side bar, history, review, send-to-agent). Files opened here are ownerless top-level tabs.
 const workbenchScope:WorkbenchScope|undefined=project&&path?{projectId:project.id,worktreePath:path,rootPath:path}:undefined;
 const openWorkbenchTab=(tab:ContentRef,same:(candidate:ContentRef)=>boolean)=>{
  const existing=workspaceTabs(latestLayout.current).find(item=>same(item.tab));
  let target=existing;
  if(!target){
   const placement=fileViewPlacement(latestLayout.current,undefined,undefined,wideForSplit());
   const updated=placement.split?addPane(latestLayout.current,tab):addTabToPane(latestLayout.current,placement.paneId,tab);
   target=workspaceTabs(updated).find(item=>item.tab.id===tab.id);if(!target)return undefined;
   save(updated);
  }else save(activate(latestLayout.current,target.paneId,target.tab.id));
  setFocusTarget({paneId:target.paneId,tabId:target.tab.id,key:crypto.randomUUID()});
  return target.tab.id;
 };
 const openHistory=(target:{projectId:string;worktreePath?:string;path?:string;commit?:string})=>{
  const tabId=openWorkbenchTab({id:crypto.randomUUID(),kind:'history',projectId:target.projectId,...(target.worktreePath?{worktreePath:target.worktreePath}:{}),...(target.path?{path:target.path}:{})},
   candidate=>candidate.kind==='history'&&candidate.projectId===target.projectId&&sameCanonicalScope(candidate.worktreePath??project?.path,target.worktreePath??project?.path)&&(candidate.path??'')===(target.path??''));
  if(tabId&&target.commit)setHistoryFocus({tabId,commit:target.commit,key:crypto.randomUUID()});
 };
 const sendToAgent=(target:{projectId:string;worktreePath?:string;path:string;startLine?:number;endLine?:number})=>{
  const receiver=data.sessions.find(candidate=>candidate.id===previewSessionId);
  if(!receiver||!working(receiver)){setIssue(zh?'请先在此工作区打开一个运行中的 Agent 会话，再发送文件引用。':'Open a running agent session in this workspace to send file references.');return;}
  const fileRoot=target.worktreePath??data.projects.find(candidate=>candidate.id===target.projectId)?.path??'';
  const sessionRoot=receiver.worktreePath??data.projects.find(candidate=>candidate.id===receiver.projectId)?.path;
  const reference=formatAgentReference({path:referencePath(target.path,fileRoot,sessionRoot),startLine:target.startLine,endLine:target.endLine});
  // Show the receiving session first: only a visible Chat composer or terminal accepts input.
  const tab=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===receiver.id);
  if(tab){save(activate(latestLayout.current,tab.paneId,tab.tab.id));setFocusTarget({paneId:tab.paneId,tabId:tab.tab.id,key:crypto.randomUUID()});}
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
   try{insertSessionText(receiver.id,reference);setIssue(undefined);}
   catch(error){const reason=String(error);setIssue(/terminal_command_requires_single_line/.test(reason)?(zh?'引用包含换行，无法插入终端。':'The reference contains a line break and cannot go to a terminal.'):/unavailable/.test(reason)?(zh?'该会话当前不能接收输入（可能是只读历史或尚未取得控制权）。':'That session cannot take input right now (read-only history or no input control).'):workbenchError(error,zh));}
  }));
 };
 const workbenchActions:WorkbenchActions|undefined=workbenchScope&&project?{
  openFile:(file,position)=>void openScopedFile({projectId:project.id,worktreePath:path,path:file,kind:previewKind(file),line:position?.line,column:position?.column}).catch(fail),
  openBeside:file=>void openScopedFile({projectId:project.id,worktreePath:path,path:file,kind:previewKind(file),ownerSessionId:previewSessionId}).catch(fail),
  openDiff:(file,staged)=>void openScopedFile({projectId:project.id,worktreePath:path,path:file,kind:'diff',staged}).catch(fail),
  openHistory:file=>openHistory({projectId:project.id,worktreePath:path,path:file}),
  openReview:target=>void openWorkbenchTab({id:crypto.randomUUID(),kind:'review',projectId:project.id,worktreePath:path,...target},
   candidate=>candidate.kind==='review'&&candidate.sessionId===target.sessionId&&candidate.checkpointId===target.checkpointId&&(candidate.toCheckpointId??'')===(target.toCheckpointId??'')&&candidate.path===target.path),
  sendToAgent:reference=>sendToAgent({projectId:project.id,worktreePath:path,path:reference.path,startLine:reference.startLine,endLine:reference.endLine}),
  dirtyPaths:()=>dirtyPathsInScope({projectId:project.id,projectPath:project.path,worktreePath:path}),
  renamed:(from,to)=>{
   invalidateQuickOpen(workbenchScope);
   // Open tabs follow the rename; their editors reopen the new path (dirty editors were refused earlier).
   const rename=(node:PaneLayout):PaneLayout=>node.kind==='split'?{...node,first:rename(node.first),second:rename(node.second)}:{...node,tabs:node.tabs.map(tab=>tab.kind!=='session'&&tab.kind!=='history'&&tab.projectId===project.id&&sameCanonicalScope(tab.worktreePath??project.path,path)&&coveredBy(tab.path,from)?{...tab,path:to+tab.path.slice(from.length)}:tab)};
   save(rename(latestLayout.current));
  },
  deleted:file=>{
   invalidateQuickOpen(workbenchScope);
   const targets=workspaceTabs(latestLayout.current).filter(item=>item.tab.kind!=='session'&&item.tab.kind!=='history'&&item.tab.projectId===project.id&&sameCanonicalScope(item.tab.worktreePath??project.path,path)&&coveredBy(item.tab.path,file)).map(item=>({paneId:item.paneId,tabId:item.tab.id}));
   if(targets.length)save(removeWorkspaceTabs(latestLayout.current,targets).layout);
  },
 }:undefined;
 const paneWorkbench:PaneWorkbench={
  sendToAgent,openHistory,
  openFile:target=>void openScopedFile({...target,kind:previewKind(target.path)}).catch(fail),
  historyFocus,
 };
 const workspaceSessions=treeSessions.filter(candidate=>sessionIdsIn(layout).includes(candidate.id)||candidate.id===session.id);
 const focusedTab=focusTarget?workspaceTabs(layout).find(item=>item.tab.id===focusTarget.tabId)?.tab:undefined;
 const activeFilePath=focusedTab&&focusedTab.kind!=='session'&&focusedTab.kind!=='history'&&!focusedTab.ownerSessionId?focusedTab.path:undefined;
 // Workbench shortcuts never fire inside a terminal: Ctrl+P/B/L belong to shells and TUIs there.
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{
   if(!(event.ctrlKey||event.metaKey)||event.altKey||(event.target as Element|null)?.closest?.('.xterm'))return;
   const letter=event.key.toLowerCase();
   const view:WorkbenchView|'toggle'|undefined=event.shiftKey?({e:'files',f:'search',g:'scm'} as Record<string,WorkbenchView>)[letter]:letter==='b'?'toggle':undefined;
   if(!event.shiftKey&&letter==='p'){event.preventDefault();setQuickOpen(true);return;}
   if(view){event.preventDefault();setWorkbenchCommand({view,key:crypto.randomUUID()});}
  };
  const palette=(event:Event)=>{const view=(event as CustomEvent<{view:WorkbenchView|'quick-open'}>).detail?.view;if(view==='quick-open')setQuickOpen(true);else if(view)setWorkbenchCommand({view,key:crypto.randomUUID()});};
  addEventListener('keydown',key);addEventListener('threadterm:workbench',palette);
  return()=>{removeEventListener('keydown',key);removeEventListener('threadterm:workbench',palette);};
 },[]);
 // Back goes to this session's branch home page (App.sessionHome); name it, since the label is just "Back".
 const home=project?(currentTree?.branch??git?.branch??project.name):undefined;
 const backTitle=home?(zh?`返回 ${home}`:`Back to ${home}`):(zh?'返回所有终端':'Back to all terminals');
 return <section className={`ws session-screen runtime-workspace${fullscreen?' terminal-fullscreen':''}`} aria-label={zh?'终端工作区':'Terminal workspace'}>
  <header className="ws-top">
   <button className="ws-back" onClick={onBack} title={backTitle} aria-label={backTitle}><Icon name="back"/><span>{zh?'返回':'Back'}</span></button>
   {project&&<button className="ws-chip" onClick={()=>onProject(project.id)}><span className="dot primary"/>{project.name}</button>}
   {project&&<button className="ws-chip branch" title={displayPath(path)} onClick={()=>onProject(project.id,path)}><Icon name="branch"/>{currentTree?.branch??git?.branch??displayPath(path)?.split(/[\\/]/).at(-1)}</button>}
   <div className="top-spacer"/>
   <button className="icon-btn" onClick={()=>setInspector(value=>!value)} aria-pressed={inspector} aria-label={zh?'会话详情面板':'Session details'}><Icon name="panel"/></button>
  </header>
  <div className="ws-body"><div className="ws-center">
   <div className="wb-tabrow"><div className="wb-switcher-host" ref={setSwitcherHost}/><div className="workspace-toolbar-host" ref={setToolbarHost}/></div>
   {issue&&<p className="surface-error" role="alert">{issue}</p>}
   {fileIssue&&<div className="workspace-file-error" role="alert"><span>{fileIssue.message} <code>{fileIssue.path}</code></span><button type="button" className="btn" onClick={()=>void navigator.clipboard.writeText(fileIssue.path).catch(fail)}>{zh?'复制路径':'Copy path'}</button><button type="button" className="icon-btn" aria-label={zh?'关闭提示':'Dismiss notice'} onClick={()=>setFileIssue(undefined)}><Icon name="close"/></button></div>}
   <div className={`ws-content${inspector?' with-drawer':''}`}>{workbenchScope&&workbenchActions&&<WorkbenchSideBar scope={workbenchScope} actions={workbenchActions} sessions={workspaceSessions} activeSessionId={previewSessionId} activePath={activeFilePath} command={workbenchCommand} switcherHost={switcherHost} zh={zh}/>}<div className="ws-pane" ref={paneArea}>
    <div className="workspace-content-host">
     <PaneWorkspace
      layout={layout} sessions={data.sessions} theme={theme}
      terminalCompatibility={data.settings.terminalCompatibility} providers={data.providers}
      onChange={save} onSessionChanged={onChanged} onOpenSession={onSelect} ownerSessionId={previewSessionId}
      onPickSession={(paneId)=>{setPicker({mode:'fill',paneId});setQuery('');}}
      toolbarHost={toolbarHost}
      onEmpty={()=>{void saving.current.then(()=>{if(live.current&&persistedLayout.current===latestLayout.current&&!workspaceTabs(visibleSessionLayout(latestLayout.current,previewSessionId)).length)onBack();});}}
      onActiveSession={id=>{setPreviewSessionId(id);onActiveSession?.(id);}}
      onInteraction={()=>{fileOpenGeneration.current++;}}
      onFileReference={(id,reference)=>void openReference(id,reference)} workbench={paneWorkbench}
      focusTarget={focusTarget} fileReveal={fileReveal} onOpenPath={openPaneFile}
     />
    </div>
   </div>{inspector&&<aside className="inspector" aria-label={zh?'会话详情面板':'Session details'}><div className="ins-head">{zh?'会话详情':'Session details'}</div><div className="ins-scroll">
    {pendingCommands.length>0&&<div className="ins-block pcol-ctx-sec"><h3>{zh?'待审阅命令':'Commands to review'}</h3><p className="note">{zh?'点击命令填入目标终端；不会自动按回车或替换已有输入。':'Insert a command into the target terminal, then review it before pressing Enter.'}</p><label>{zh?'目标会话':'Target session'}<Select value={commandTarget} onChange={event=>setCommandTarget(event.target.value)}>{data.sessions.filter(candidate=>candidate.mode==='terminal'&&working(candidate)&&(sessionIdsIn(layout).includes(candidate.id)||candidate.id===session.id)).map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</Select></label>{pendingCommands.map((command,index)=><button type="button" className="cmd-opt" key={index} title={zh?'填入终端（不执行）':'Insert into terminal without executing'} onClick={()=>fillCommand(command)}>{command}</button>)}{commandNotice&&<p className="note" role="status">{commandNotice}</p>}<button className="btn-subtle" onClick={onClearCommands}>{zh?'清空待审阅命令':'Clear command list'}</button></div>}
    <div className="ins-block"><h3>{zh?'会话信息':'Session information'}</h3><span className={`chip st-${state}`}>{stateLabel}</span><p>{session.title}</p><p className="mono dim-s">{displayPath(path)}</p><button className="btn" onClick={()=>setConfigOpen(true)}>{zh?'配置':'Configure'}</button></div>
    <div className="ins-block"><h3>{zh?'重点关注':'Following'}</h3><button className="btn" onClick={follow} aria-pressed={session.followed}><Icon name="star"/>{zh?(session.followed?'已关注 · 点击取消':'关注此会话'):(session.followed?'Following · Unfollow':'Follow session')}</button></div>
    <div className="ins-block runtime-session-actions"><SessionActions session={session}/><button className="btn" onClick={()=>setFullscreen(value=>!value)}>{zh?'全屏终端':'Fullscreen terminal'}</button></div>
   </div></aside>}</div>
  </div></div>
  {picker&&<SurfaceDialog title={zh?(picker.mode==='switch'?'切换会话':picker.mode==='add'?'选择并排会话':'选择会话'):(picker.mode==='switch'?'Switch session':picker.mode==='add'?'Choose session for split':'Choose session')} onClose={cancelPicker} size="sm"><div className="switcher"><div className="tools"><div className="input-wrap"><Icon name="search"/><input autoFocus value={query} onChange={event=>setQuery(event.target.value)} placeholder={zh?'搜索会话':'Search sessions'}/></div>{picker.mode==='switch'&&<Select value={allProjects?'all':'tree'} onChange={event=>setAllProjects(event.target.value==='all')}><option value="tree">{zh?'当前工作树':'Current worktree'}</option><option value="all">{zh?'全部项目':'All projects'}</option></Select>}</div><div className="switcher-list">{available.filter(s=>`${s.title} ${s.provider}`.toLowerCase().includes(query.toLowerCase())).map(s=><button className="switcher-row" key={s.id} onClick={()=>{if(picker.mode==='switch'){setPicker(undefined);onSelect(s.id);}else if(picker.mode==='add')addSessionPane(s);else fillPane(s);}}><AgentIcon provider={s.provider}/>{s.title}<small>{providerName(s.provider)}</small></button>)}</div>{!available.length&&<p className="note">{zh?'没有其他可选会话。':'No other sessions are available.'}</p>}</div></SurfaceDialog>}
  {configOpen&&<SessionConfigDialog session={session} onClose={()=>setConfigOpen(false)} onRerun={onSelect}/>}
  {quickOpen&&workbenchScope&&workbenchActions&&<QuickOpen scope={workbenchScope} zh={zh} onClose={()=>setQuickOpen(false)} onOpen={(file,position)=>workbenchActions.openFile(file,position)}/>}
 </section>;
}
