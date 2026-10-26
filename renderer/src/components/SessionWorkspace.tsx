import { Select } from "./ui/Select";
import { useEffect, useRef, useState } from 'react';
import type { ContentRef, Draft, FileReference, GitStatus, PaneLayout, PreviewAssociation, PreviewPresentation, Session, Snapshot, Worktree } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { attachChatImages, insertChatText, insertSessionText } from '../terminalInputTargets';
import { useTranslation } from '../i18n';
import { addSessionTab } from '../presentation';
import { displayPath, sameCanonicalScope } from '../projectScope';
import { activate, addPane, addTabToPane, closePane, placeWebTabBesideSession, reconcileSessionLayout, selectWebTabBesideSession, sessionIdsIn, sessionOnlyLayout } from '../workspaceLayout';
import { taskMapRoot } from '../taskMapRoot';
import { focusedWorkspaceTab, isFileTab, isWebTabUrl, removeWorkspaceTabs, workspaceTabs, type FileTab } from '../workspaceTabs';
import { canSplitPaneArea, fileViewPlacement, visibleSessionLayout } from '../sessionFileViews';
import { PaneWorkspace, type PaneWorkbench } from './PaneWorkspace';
import { WorkbenchSideBar, type WorkbenchCommand, type WorkbenchView } from './WorkbenchSideBar';
import { QuickOpen, invalidateQuickOpen } from './QuickOpen';
import { SessionDocuments } from './SessionDocuments';
import { useSessionDocuments } from '../useSessionDocuments';
import { sessionDocumentError } from '../sessionDocuments';
import { dirtyPathsInScope } from '../dirtyEditors';
import { formatAgentReference, referencePath } from '../workbench/agentReference';
import { workbenchError } from '../workbench/errors';
import { coveredBy, type WorkbenchActions, type WorkbenchScope } from '../workbench/types';
import { AgentIcon, Icon } from './PrototypeIcon';
import { SessionActions } from './SessionActions';
import { QuickLaunchMenu, QuickLaunchRunChip } from './QuickLaunch';
import { SessionConfigDialog } from './SessionConfigDialog';
import { SurfaceDialog } from './SurfaceDialog';
import './session-workspace.css';
import type { FileCommentsHost } from '../fileCommentsHost';
import { agentName } from '../agents';
import { attachChatContext } from '../terminalInputTargets';
import type { ContextItem } from '../chatContext';
import { ContextHost } from './ContextHost';
import { ContextSendDialogHost } from './ContextSendAction';
import { retitleGroupTabs } from '../groupNavigation';

const working=(s:Session)=>!s.readOnly&&['starting','running','idle','waiting'].includes(s.status);
const tabFor=(s:Session)=>({id:`session-${s.id}`,kind:'session' as const,sessionId:s.id});
const initialFor=(s:Session):PaneLayout=>({kind:'pane',id:`pane-${s.id}`,tabs:[tabFor(s)],activeTabId:tabFor(s).id});
/** Re-scopes the single Usage tab to a project (or to every project) without adding a second one. */
const withUsageProject=(node:PaneLayout,tabId:string,projectId:string|undefined):PaneLayout=>node.kind==='pane'
 ?{...node,tabs:node.tabs.map((tab):ContentRef=>{
   if(tab.id!==tabId||tab.kind!=='usage')return tab;
   return projectId?{...tab,projectId}:{id:tab.id,kind:'usage'};
  })}
 :{...node,first:withUsageProject(node.first,tabId,projectId),second:withUsageProject(node.second,tabId,projectId)};
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
const visibleRect=(element:Element|undefined)=>{
 if(!element||element.closest('[hidden],[inert]'))return false;
 const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
 return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth;
};
/** Bound to a paint, never a polling loop: acknowledgement needs proof that both sibling surfaces mounted visibly. */
const waitForPreviewMount=(sessionId:string,previewId:string,documentId:string,tabId:string,cancelled:()=>boolean)=>new Promise<boolean>(resolve=>{
 const deadline=performance.now()+2000;
 let frame=0,timer:number|undefined,done=false;
 const finish=(value:boolean)=>{if(done)return;done=true;cancelAnimationFrame(frame);if(timer!==undefined)clearTimeout(timer);resolve(value);};
 const check=()=>{
  if(cancelled())return finish(false);
  const chat=[...document.querySelectorAll(`[data-content-id="session-${sessionId}"]`)].find(visibleRect);
  const preview=[...document.querySelectorAll<HTMLElement>('[data-preview-id]')].find(item=>item.dataset.previewId===previewId&&item.dataset.documentId===documentId&&item.dataset.webTabId===tabId&&visibleRect(item)&&visibleRect(item.querySelector('.tt-browser-view[data-native-ready="true"]')??undefined));
  if(chat&&preview)return finish(true);
  if(performance.now()>=deadline)return finish(false);
  frame=requestAnimationFrame(check);
 };
 timer=window.setTimeout(()=>finish(false),2050);
 frame=requestAnimationFrame(check);
});
const previewOperationKey=(value:Pick<PreviewPresentation,'sessionId'|'attachmentId'|'requestId'|'previewId'|'documentId'>)=>[value.sessionId,value.attachmentId,value.requestId,value.previewId,value.documentId].join('\0');

type Props={session:Session;data:Snapshot;theme:'light'|'dark';onBack:()=>void;onSelect:(id:string)=>void;onProject:(id:string,path?:string)=>void;onChanged:()=>void;backgroundPresentation?:string;onBackgroundPresented:()=>void;navigationKey?:unknown;onActiveSession?:(id:string)=>void;groupToOpen?:{id:string;title:string;members:{sessionId:string}[]};onGroupOpened?:(id:string)=>void;usageToOpen?:{key:string;projectId?:string};onUsageOpened?:(key:string)=>void};
export function SessionWorkspace({session,data,theme,onBack,onSelect,onProject,onChanged,backgroundPresentation,onBackgroundPresented,navigationKey,onActiveSession,groupToOpen,onGroupOpened,usageToOpen,onUsageOpened}:Props){
 const latestData=useRef(data);latestData.current=data;
 const providerName=(id:string)=>agentName(id,data.providers);
 const {locale}=useTranslation(),zh=locale==='zh-CN';
 const project=data.projects.find(p=>p.id===session.projectId),path=session.worktreePath??project?.path;
 const restored=data.workspaces.find(w=>w.projectId===session.projectId&&sameCanonicalScope(w.worktreePath??project?.path,path));
 // A session opens with its sessions and independent browser pages. Restored file/Git/history/review tabs are not
 // shown again; file tabs with unsaved edits come back once draft.list answers (restoreUnsaved). Browser pages are
 // user content with runtime associations outside ContentRef, so pruning them would make navigation silently close
 // manual and agent previews.
 const openedFrom=useRef<{source:PaneLayout;stripped:PaneLayout}|undefined>(undefined);
 const [layout,setLayout]=useState<PaneLayout>(()=>{
  if(!restored)return initialFor(session);
  const stripped=reconcileSessionLayout(sessionOnlyLayout(restored.layout,tab=>tab.kind==='web'||tab.kind==='group'||tab.kind==='roundtable'),new Set(data.sessions.map(item=>item.id)),session.id);
  openedFrom.current={source:restored.layout,stripped};
  return stripped;
 });
 const [previewSessionId,setPreviewSessionId]=useState(session.id);
 const [taskMapFocus,setTaskMapFocus]=useState<{tabId:string;sessionId:string;itemId?:string;key:string}>();
 const latestLayout=useRef(layout);latestLayout.current=layout;
 const previewViewIds=useRef(new Map<string,string>());
 const previewAttachments=useRef(new Map<string,string>());
 const previewAssociations=useRef(new Map<string,PreviewAssociation>());
 const previewAccepted=useRef(new Set<string>());
 const previewNavigation=useRef(new Map<string,{navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number}>());
 const previewCancelled=useRef(new Set<string>());
 const [previewAttachEpoch,setPreviewAttachEpoch]=useState(0);
 const [,setPreviewAssociationRevision]=useState(0);
 const [switcherHost,setSwitcherHost]=useState<HTMLDivElement|null>(null);
 // Split decisions use the space the panes actually get (the side bar and inspector take their own share).
 const paneArea=useRef<HTMLDivElement>(null),wideForSplit=()=>Boolean(paneArea.current&&canSplitPaneArea(paneArea.current.clientWidth));
 const [focusTarget,setFocusTarget]=useState<{paneId:string;tabId:string;key:string}|undefined>(()=>{const target=workspaceTabs(layout).find(item=>item.tab.kind==='session'&&item.tab.sessionId===session.id);return target?{paneId:target.paneId,tabId:target.tab.id,key:'initial'}:undefined;});
 const [fileReveal,setFileReveal]=useState<{tabId:string;line:number;column?:number;key:string}>();
 const fileOpenGeneration=useRef(0),live=useRef(true);
 useEffect(()=>{live.current=true;return()=>{live.current=false;fileOpenGeneration.current++;};},[]);
 const [trees,setTrees]=useState<Worktree[]>([]),[git,setGit]=useState<GitStatus>();
 const [workbenchCommand,setWorkbenchCommand]=useState<WorkbenchCommand>(),[quickOpen,setQuickOpen]=useState(false),[historyFocus,setHistoryFocus]=useState<{tabId:string;commit:string;key:string}>();
 const [inspector,setInspector]=useState(false);
 const [pinPicker,setPinPicker]=useState(false);
 const [picker,setPicker]=useState<{mode:'switch'|'add'|'fill';paneId?:string}>(),[query,setQuery]=useState(''),[allProjects,setAllProjects]=useState(false);
 const [configOpen,setConfigOpen]=useState(false);
 const [navigationOpen,setNavigationOpen]=useState(false);
 const navigationToggle=useRef<HTMLButtonElement>(null);
 const [issue,setIssue]=useState<string>(),[fullscreen,setFullscreen]=useState(false);
 const [commentNotice,setCommentNotice]=useState<string>();
 useEffect(()=>{if(!commentNotice)return;const timer=setTimeout(()=>setCommentNotice(undefined),6000);return()=>clearTimeout(timer);},[commentNotice]);
 const closeNavigation=(restoreFocus=true)=>{setNavigationOpen(false);if(restoreFocus)requestAnimationFrame(()=>navigationToggle.current?.focus());};
 useEffect(()=>{if(!navigationOpen)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();closeNavigation();}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key);},[navigationOpen]);
 useEffect(()=>{const navigation=document.querySelector<HTMLElement>('.app-shell > .sidebar');if(!navigation)return;const previousId=navigation.id;navigation.id='runtime-navigation';return()=>{if(navigation.id==='runtime-navigation')navigation.id=previousId;};},[]);
 useEffect(()=>{if(!navigationOpen)return;const frame=requestAnimationFrame(()=>document.querySelector<HTMLElement>('#runtime-navigation button:not(:disabled), #runtime-navigation [href]')?.focus());return()=>cancelAnimationFrame(frame);},[navigationOpen]);
 useEffect(()=>{const media=matchMedia('(max-width:760px)'),change=()=>{if(!media.matches)setNavigationOpen(false);};change();media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
 const [fileIssue,setFileIssue]=useState<{path:string;message:string}>();
 const saving=useRef(Promise.resolve()),saved=useRef({id:restored?.id,revision:restored?.revision??0});
 const persistedLayout=useRef<PaneLayout|undefined>(undefined);
 const currentTree=trees.find(tree=>sameCanonicalScope(tree.path,path));
 const treeSessions=data.sessions.filter(s=>s.projectId===session.projectId&&sameCanonicalScope(s.worktreePath??project?.path,path)&&(!s.archived||s.id===session.id));
 const hostedChatIds=data.sessions.filter(candidate=>candidate.mode==='chat'&&sessionIdsIn(layout).includes(candidate.id)).map(candidate=>candidate.id);
 const state=session.readOnly?'ended':session.status==='waiting'?'needs':session.status==='error'?'failed':session.status==='interrupted'?'stalled':working(session)?'running':'ended';
 const stateLabel=zh?({needs:'待处理',failed:'失败',stalled:'已中断',running:'运行中',ended:session.readOnly?'只读历史':'已结束'}[state]):({needs:'Attention',failed:'Failed',stalled:'Interrupted',running:'Running',ended:session.readOnly?'Read-only history':'Ended'}[state]);
 const fail=(error:unknown)=>setIssue(error instanceof Error?error.message:String(error));
 const save=(next:PaneLayout)=>{
  latestLayout.current=next;
  setLayout(next);
  const persisted=saving.current.catch(()=>undefined).then(async()=>{
   const value=await request('workspace.save',{id:saved.current.id,name:session.title,projectId:session.projectId,worktreePath:path,layout:next,expectedRevision:saved.current.revision,operationId:operationId()});
   saved.current={id:value.id,revision:value.revision};persistedLayout.current=next;
  });
  saving.current=persisted.catch(error=>{fail(error);});
  return persisted;
 };
 const prepareBrowserShare=async(tabId:string)=>{
  if(!project||!path)throw new Error('Save this tab in a project workspace before sharing.');
  const contains=()=>workspaceTabs(latestLayout.current).some(item=>item.tab.kind==='web'&&item.tab.id===tabId);
  if(!contains())throw new Error('The browser tab is no longer in this workspace.');
  await saving.current;
  if(!saved.current.id||persistedLayout.current!==latestLayout.current)await save(latestLayout.current);
  await saving.current;
  if(!live.current||!contains()||!saved.current.id||persistedLayout.current!==latestLayout.current)throw new Error('The current browser workspace could not be saved.');
  return {id:saved.current.id,revision:saved.current.revision};
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
   const next=unsaved.size?reconcileSessionLayout(sessionOnlyLayout(source,tab=>tab.kind==='web'||tab.kind==='group'||tab.kind==='roundtable'||kept.has(tab.id)||unsaved.has(tab.id)),new Set(data.sessions.map(item=>item.id)),session.id):stripped;
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
 /** A desktop attachment is an explicit, per-view lease.  It is never retried by a timer or used to replay a
  * previous request; reconnect/navigation receives a fresh attachment for subsequent preview.present events. */
 useEffect(()=>{
  let active=true;
  const attached:string[]=[];
  for(const sessionId of hostedChatIds){
   let viewId=previewViewIds.current.get(sessionId);
   if(!viewId){viewId=crypto.randomUUID();previewViewIds.current.set(sessionId,viewId);}
   void request('preview.attach',{sessionId,viewId,workspaceId:saved.current.id}).then(result=>{
    if(!active)return void request('preview.detach',{sessionId,attachmentId:result.attachmentId}).catch(()=>undefined);
    previewAttachments.current.set(sessionId,result.attachmentId);attached.push(sessionId);
    for(const association of result.associations)if(association.tabId)previewAssociations.current.set(association.tabId,association);
    setPreviewAssociationRevision(value=>value+1);
   }).catch(error=>{if(active&&!String(error).includes('target_in_use'))fail(error);});
  }
  return()=>{
   active=false;
   for(const sessionId of attached){const attachmentId=previewAttachments.current.get(sessionId);previewAttachments.current.delete(sessionId);if(attachmentId)void request('preview.detach',{sessionId,attachmentId}).catch(()=>undefined);}
  };
 },[hostedChatIds.join('|'),previewAttachEpoch]);
 useEffect(()=>subscribeEvents(event=>{if(event.event==='runtime.transport'&&(event.data as {state?:string}|undefined)?.state==='reconnected')setPreviewAttachEpoch(value=>value+1);}),[]);
 useEffect(()=>subscribeEvents(event=>{
  if((event.event==='preview.cancel'||event.event==='preview.present')&&event.data&&typeof event.data==='object'){
   const cancellation=event.data as Partial<PreviewPresentation>;
   if(event.event==='preview.cancel'&&typeof cancellation.requestId==='string'&&typeof cancellation.sessionId==='string'&&typeof cancellation.attachmentId==='string'&&typeof cancellation.previewId==='string'&&typeof cancellation.documentId==='string'&&cancellation.attachmentId===previewAttachments.current.get(cancellation.sessionId)){previewCancelled.current.add(previewOperationKey(cancellation as PreviewPresentation));return;}
  }
  if(event.event!=='preview.present'||!event.data||typeof event.data!=='object')return;
  const presentation=event.data as Partial<PreviewPresentation>;
  if(typeof presentation.sessionId!=='string'||typeof presentation.attachmentId!=='string'||presentation.attachmentId!==previewAttachments.current.get(presentation.sessionId)
   ||presentation.viewId!==previewViewIds.current.get(presentation.sessionId)||typeof presentation.requestId!=='string'||typeof presentation.previewId!=='string'
   ||typeof presentation.documentId!=='string'||typeof presentation.url!=='string')return;
  const attachmentId=presentation.attachmentId;
  const acknowledge=async()=>{
   const operationKey=previewOperationKey(presentation as PreviewPresentation);
   let current:PreviewAssociation;
   let prepared=false;
   const existing=[...previewAssociations.current.values()].find(item=>item.previewId===presentation.previewId);
   const existingTab=existing?.tabId?workspaceTabs(latestLayout.current).find(item=>item.tab.id===existing.tabId):undefined;
   try{
    current=await request('preview.prepare',{sessionId:presentation.sessionId!,attachmentId,requestId:presentation.requestId!,previewId:presentation.previewId!,documentId:presentation.documentId!});
    if(previewCancelled.current.has(operationKey)||current.state!=='accepted'||current.url!==presentation.url)return;
    prepared=true;
    let tabId=existingTab?.tab.id;
    if(tabId){
     const selected=selectWebTabBesideSession(latestLayout.current,presentation.sessionId!,tabId);
     if(selected!==latestLayout.current)await save(selected);
    }else{
     const tab:Extract<ContentRef,{kind:'web'}>={id:crypto.randomUUID(),kind:'web',url:presentation.url!};
     const placed=placeWebTabBesideSession(latestLayout.current,presentation.sessionId!,tab);
     if(placed.status==='layout_unavailable')throw Object.assign(new Error('No browser pane can be created without exceeding the four-pane limit.'),{code:'layout_unavailable',retryable:false});
     tabId=tab.id;
     if(!tabId)throw new Error('The browser tab could not be placed.');
     await save(placed.layout);
    }
    if(!live.current)return;
    const association:PreviewAssociation={...current,tabId,workspaceId:saved.current.id};
    previewAssociations.current.set(tabId,association);setPreviewAssociationRevision(value=>value+1);
    const mounted=await waitForPreviewMount(association.sessionId,association.previewId,association.documentId,tabId,()=>previewCancelled.current.has(operationKey)||previewAttachments.current.get(association.sessionId)!==attachmentId);
    if(previewCancelled.current.has(operationKey))return;
    if(!mounted)throw new Error('The saved page tab did not mount beside its owning Chat before acknowledgement.');
    const acknowledged=await request('preview.ack',{sessionId:association.sessionId,attachmentId,requestId:association.requestId,previewId:association.previewId,documentId:association.documentId,state:'presented',tabId,workspaceId:saved.current.id,workspaceRevision:saved.current.revision});
    if(acknowledged.state!=='presented')throw new Error('The runtime did not accept the saved preview presentation.');
    association.sequence=acknowledged.sequence;association.navigation=acknowledged.navigation;
    previewAccepted.current.add(tabId);flushRuntimePreviewNavigation(tabId);
   }catch(error){
    // prepare rejects revoked/replaced operations.  They were never accepted,
    // so acknowledgement would race the runtime's cancellation state.
    if(!prepared||previewCancelled.current.has(operationKey))return;
    const detail={code:typeof error==='object'&&error&&'code' in error?String((error as {code:unknown}).code):'presentation_failed',message:error instanceof Error?error.message:String(error),retryable:typeof error==='object'&&error&&'retryable' in error?Boolean((error as {retryable:unknown}).retryable):false};
    void request('preview.ack',{sessionId:presentation.sessionId!,attachmentId,requestId:presentation.requestId!,previewId:presentation.previewId!,documentId:presentation.documentId!,state:'failed',error:detail}).catch(()=>undefined);
    if(live.current)fail(detail.message);
   }
  };
  void acknowledge();
 }),[session.id]);
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
 const openReference=async(sessionId:string,reference:FileReference,independent=false)=>{
  const generation=++fileOpenGeneration.current;setFileIssue(undefined);
  try{
   const resolved=await request('filesystem.resolve',{sessionId,...reference});
   if(!live.current||generation!==fileOpenGeneration.current)return;
   const sourcePaneId=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===sessionId)?.paneId;
   await openScopedFile({...resolved,sourcePaneId,...(independent?{}:{ownerSessionId:sessionId}),assetKind:resolved.kind,kind:resolved.kind==='image'||/\.md$/i.test(resolved.path)?'preview':'file'},generation);
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
 const documentsSession=data.sessions.find(candidate=>candidate.id===previewSessionId)??session;
 const documentsRoot=documentsSession.worktreePath??data.projects.find(candidate=>candidate.id===documentsSession.projectId)?.path;
 const documents=useSessionDocuments(documentsSession.id,zh);
 const canPin=documentsSession.projectId===project?.id&&sameCanonicalScope(documentsRoot,path);
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
 const openGroupTab=(group:NonNullable<Props['groupToOpen']>)=>{
  const existing=workspaceTabs(latestLayout.current).find(item=>(item.tab.kind==='group'&&item.tab.groupId===group.id)||(item.tab.kind==='roundtable'&&item.tab.roundtableId===group.id));
  if(existing){save(activate(latestLayout.current,existing.paneId,existing.tab.id));setFocusTarget({paneId:existing.paneId,tabId:existing.tab.id,key:crypto.randomUUID()});return;}
  const paneId=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===session.id)?.paneId??focusedWorkspaceTab(latestLayout.current)?.paneId;
  if(!paneId)return;
  const tab:ContentRef={id:crypto.randomUUID(),kind:'group',groupId:group.id,title:group.title};
  save(addTabToPane(latestLayout.current,paneId,tab));
  setFocusTarget({paneId,tabId:tab.id,key:crypto.randomUUID()});
 };
 useEffect(()=>{
  if(!groupToOpen||groupToOpen.members[0]?.sessionId!==session.id)return;
  openGroupTab(groupToOpen);
  onGroupOpened?.(groupToOpen.id);
 },[groupToOpen,session.id]);
 // One Usage page per window: reuse the open tab, otherwise add it beside the session, and re-scope it on request.
 const openUsageTab=(projectId?:string)=>{
  const existing=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='usage');
  if(existing){
   const current=existing.tab.kind==='usage'?existing.tab.projectId:undefined;
   const layout=current===projectId?latestLayout.current:withUsageProject(latestLayout.current,existing.tab.id,projectId);
   save(activate(layout,existing.paneId,existing.tab.id));
   setFocusTarget({paneId:existing.paneId,tabId:existing.tab.id,key:crypto.randomUUID()});
   return;
  }
  const paneId=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===session.id)?.paneId??focusedWorkspaceTab(latestLayout.current)?.paneId;
  if(!paneId)return;
  const tab:ContentRef={id:crypto.randomUUID(),kind:'usage',...(projectId?{projectId}:{})};
  save(addTabToPane(latestLayout.current,paneId,tab));
  setFocusTarget({paneId,tabId:tab.id,key:crypto.randomUUID()});
 };
 useEffect(()=>{
  if(!usageToOpen)return;
  openUsageTab(usageToOpen.projectId);
  onUsageOpened?.(usageToOpen.key);
 },[usageToOpen]);
 const openTaskMap=(sessionId:string,itemId?:string)=>{
  const root=taskMapRoot(sessionId,data.sessions);
  const tabId=openWorkbenchTab({id:crypto.randomUUID(),kind:'map',sessionId:root},candidate=>candidate.kind==='map'&&candidate.sessionId===root);
  if(tabId&&(root!==sessionId||itemId!==undefined))setTaskMapFocus({tabId,sessionId,itemId,key:crypto.randomUUID()});
 };
 const openHistory=(target:{projectId:string;worktreePath?:string;path?:string;commit?:string})=>{
  const tabId=openWorkbenchTab({id:crypto.randomUUID(),kind:'history',projectId:target.projectId,...(target.worktreePath?{worktreePath:target.worktreePath}:{}),...(target.path?{path:target.path}:{})},
   candidate=>candidate.kind==='history'&&candidate.projectId===target.projectId&&sameCanonicalScope(candidate.worktreePath??project?.path,target.worktreePath??project?.path)&&(candidate.path??'')===(target.path??''));
  if(tabId&&target.commit)setHistoryFocus({tabId,commit:target.commit,key:crypto.randomUUID()});
 };
 const sendToAgent=(target:{projectId:string;worktreePath?:string;path:string;startLine?:number;endLine?:number;sessionId?:string})=>{
  const receiver=data.sessions.find(candidate=>candidate.id===(target.sessionId??previewSessionId));
  if(!receiver||!working(receiver)){setIssue(zh?'请先在此工作区打开一个运行中的 Agent 会话，再发送文件引用。':'Open a running agent session in this workspace to send file references.');return;}
  const fileRoot=target.worktreePath??data.projects.find(candidate=>candidate.id===target.projectId)?.path??'';
  const sessionRoot=receiver.worktreePath??data.projects.find(candidate=>candidate.id===receiver.projectId)?.path;
  const reference=formatAgentReference({path:referencePath(target.path,fileRoot,sessionRoot),startLine:target.startLine,endLine:target.endLine});
  if(receiver.mode==='chat'){
   void insertIntoSession(receiver.id,'',undefined,{kind:'file',id:crypto.randomUUID(),path:referencePath(target.path,fileRoot,sessionRoot),startLine:target.startLine,endLine:target.endLine}).then(()=>setIssue(undefined)).catch(error=>setIssue(String(error)));
   return;
  }
  // Show the receiving session first: only a visible Chat composer or terminal accepts input.
  const tab=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===receiver.id);
  if(tab){save(activate(latestLayout.current,tab.paneId,tab.tab.id));setFocusTarget({paneId:tab.paneId,tabId:tab.tab.id,key:crypto.randomUUID()});}
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
   try{insertSessionText(receiver.id,reference);setIssue(undefined);}
   catch(error){const reason=String(error);setIssue(/terminal_command_requires_single_line/.test(reason)?(zh?'引用包含换行，无法插入终端。':'The reference contains a line break and cannot go to a terminal.'):/unavailable/.test(reason)?(zh?'该会话当前不能接收输入（可能是只读历史或尚未取得控制权）。':'That session cannot take input right now (read-only history or no input control).'):workbenchError(error,zh));}
  }));
 };
 // File comments (fileCommentsHost.ts): any working Chat session of this folder or open in this workspace can receive
 // them; the current session is the default. Unlike sendToAgent the text is multi-line and the outcome goes back to the
 // caller, which keeps its comments when nothing was inserted. Only a Chat message box takes several lines.
 const groupCommentMembers=data.sessions.filter(candidate=>candidate.group&&candidate.mode==='chat'&&sameCanonicalScope(candidate.worktreePath??data.projects.find(project=>project.id===candidate.projectId)?.path,path));
 const commentReceivers=[...treeSessions,...groupCommentMembers,...data.sessions.filter(candidate=>sessionIdsIn(layout).includes(candidate.id))]
  .filter((candidate,index,list)=>candidate.mode==='chat'&&working(candidate)&&list.findIndex(other=>other.id===candidate.id)===index)
  .sort((left,right)=>Number(right.id===previewSessionId)-Number(left.id===previewSessionId));
 const [groupTitles,setGroupTitles]=useState<Record<string,string>>({});
 useEffect(()=>{
  const projectIds=[...new Set(commentReceivers.map(candidate=>candidate.projectId).filter((id):id is string=>Boolean(id)))];
  let cancelled=false;
  void Promise.all(projectIds.map(projectId=>request('group.list',{projectId}).catch(()=>[]))).then(groups=>{
   if(!cancelled)setGroupTitles(Object.fromEntries(groups.flat().map(group=>[group.id,group.title])));
  });
  return()=>{cancelled=true;};
 },[data.sessions,session.projectId]);
 const insertIntoSession=(sessionId:string,text:string,images?:string[],context?:ContextItem)=>new Promise<void|number>((resolve,reject)=>{
  const receiver=data.sessions.find(candidate=>candidate.id===sessionId);
  if(!receiver||!working(receiver)||receiver.mode!=='chat'){reject(new Error(zh?'该会话已结束或不是聊天会话，无法接收审查意见。可以先复制。':'That session has ended or is not a Chat, so it cannot take the comments. Copy them instead.'));return;}
  // Open the receiver beside the current session when it is not in the workspace yet, then show it.
  let tab=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===receiver.id);
  if(!tab){
   const current=workspaceTabs(latestLayout.current).find(item=>item.tab.kind==='session'&&item.tab.sessionId===previewSessionId)??workspaceTabs(latestLayout.current)[0];
   const updated=current?addTabToPane(latestLayout.current,current.paneId,tabFor(receiver)):addPane(latestLayout.current,tabFor(receiver));
   save(updated);
   tab=workspaceTabs(updated).find(item=>item.tab.kind==='session'&&item.tab.sessionId===receiver.id);
   if(!tab){reject(new Error(zh?'无法在此工作区打开该会话。':'That session could not be opened in this workspace.'));return;}
  }
  save(activate(latestLayout.current,tab.paneId,tab.tab.id));setFocusTarget({paneId:tab.paneId,tabId:tab.tab.id,key:crypto.randomUUID()});
  // A freshly opened Chat registers its message box only after it connected: try for up to 10 s.
   const until=Date.now()+10_000;
   const attempt=()=>{
    try{
     const current=latestData.current.sessions.find(candidate=>candidate.id===sessionId);
     if(!current||current.readOnly||!working(current)||current.mode!=='chat')throw new Error(zh?'该会话已结束或不可再接收审查意见。评论已保留。':'That session has ended or can no longer receive review comments. The comments were kept.');
     if(context){if(!attachChatContext(current.id,context))throw new Error(zh?'上下文未能加入草稿。':'Context could not be added to the draft.');resolve();}
     else{insertChatText(current.id,text);resolve(images?.length?attachChatImages(current.id,images):undefined);}
   }
   catch(error){
    const reason=String(error);
    if(/chat_view_unavailable/.test(reason)&&Date.now()<until){setTimeout(attempt,150);return;}
    reject(new Error(/unavailable/.test(reason)?(zh?'该会话当前不能接收输入（可能是只读历史或尚未取得控制权）。':'That session cannot take input right now (read-only history or no input control).'):workbenchError(error,zh)));
   }
  };
  requestAnimationFrame(()=>requestAnimationFrame(attempt));
 });
 const projectRootOf=(projectId:string)=>data.projects.find(candidate=>candidate.id===projectId)?.path;
 const commentsHost:FileCommentsHost={
  projectRoot:projectRootOf,
  receivers:commentReceivers.map(candidate=>({id:candidate.id,title:candidate.group&&groupTitles[candidate.group.id]?`@${candidate.group.handle} · ${groupTitles[candidate.group.id]}`:candidate.title,provider:candidate.provider,root:candidate.worktreePath??projectRootOf(candidate.projectId??'')??''})),
  defaultReceiverId:commentReceivers.some(candidate=>candidate.id===previewSessionId)?previewSessionId:undefined,
  insert:insertIntoSession,notice:setCommentNotice,
  attachContext:async(sessionId,item)=>{await insertIntoSession(sessionId,'',undefined,item);},
 };
 const workbenchActions:WorkbenchActions|undefined=workbenchScope&&project?{
  comments:commentsHost,
  sessionDocuments:canPin?documents:undefined,
  openFile:(file,position)=>void openScopedFile({projectId:project.id,worktreePath:path,path:file,kind:previewKind(file),line:position?.line,column:position?.column}).catch(fail),
  openSession:onSelect,
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
   const rename=(node:PaneLayout):PaneLayout=>node.kind==='split'?{...node,first:rename(node.first),second:rename(node.second)}:{...node,tabs:node.tabs.map(tab=>tab.kind!=='session'&&tab.kind!=='history'&&tab.kind!=='web'&&tab.kind!=='map'&&tab.kind!=='group'&&tab.kind!=='roundtable'&&tab.kind!=='usage'&&tab.projectId===project.id&&sameCanonicalScope(tab.worktreePath??project.path,path)&&coveredBy(tab.path,from)?{...tab,path:to+tab.path.slice(from.length)}:tab)};
   save(rename(latestLayout.current));
  },
  deleted:file=>{
   invalidateQuickOpen(workbenchScope);
   const targets=workspaceTabs(latestLayout.current).filter(item=>item.tab.kind!=='session'&&item.tab.kind!=='history'&&item.tab.kind!=='group'&&item.tab.kind!=='roundtable'&&item.tab.kind!=='usage'&&item.tab.projectId===project.id&&sameCanonicalScope(item.tab.worktreePath??project.path,path)&&coveredBy(item.tab.path,file)).map(item=>({paneId:item.paneId,tabId:item.tab.id}));
   if(targets.length)save(removeWorkspaceTabs(latestLayout.current,targets).layout);
  },
 }:undefined;
 const paneWorkbench:PaneWorkbench={
  openTaskMap,taskMapFocus,
  openSessionReview:target=>{
   const source=data.sessions.find(candidate=>candidate.id===target.sessionId),sourceProject=data.projects.find(candidate=>candidate.id===source?.projectId);
   if(!source||!sourceProject)return;
   openWorkbenchTab({id:crypto.randomUUID(),kind:'review',projectId:sourceProject.id,worktreePath:source.worktreePath??sourceProject.path,...target},
    candidate=>candidate.kind==='review'&&candidate.sessionId===target.sessionId&&candidate.checkpointId===target.checkpointId&&(candidate.toCheckpointId??'')===(target.toCheckpointId??'')&&candidate.path===target.path);
  },
  openSessionFile:target=>{
   const source=data.sessions.find(candidate=>candidate.id===target.sessionId),sourceProject=data.projects.find(candidate=>candidate.id===source?.projectId);
   if(!source||!sourceProject)return;
   void openScopedFile({projectId:sourceProject.id,worktreePath:source.worktreePath??sourceProject.path,path:target.path,kind:previewKind(target.path)}).catch(fail);
  },
  openGroupFile:target=>void openReference(target.sessionId,{path:target.path},true),
  updateGroupTitle:(id,title)=>{
   const next=retitleGroupTabs(latestLayout.current,id,title);
   if(next!==latestLayout.current)save(next);
  },
  sessionDocuments:canPin&&project&&documentsRoot?{...documents,projectId:project.id,rootPath:documentsRoot,projectRoot:project.path}:undefined,
  sendToAgent,openHistory,comments:commentsHost,commentScope:project&&path?{projectId:project.id,root:path}:undefined,
  // Like review/history tabs: an independent tab placed beside the sessions, one per address.
  openWeb:url=>{if(isWebTabUrl(url))openWorkbenchTab({id:crypto.randomUUID(),kind:'web',url},candidate=>candidate.kind==='web'&&candidate.url===url);},
  openFile:target=>void openScopedFile({...target,kind:previewKind(target.path)}).catch(fail),
  historyFocus,
 };
 const closeRuntimePreview=(tabId:string)=>{
  const association=previewAssociations.current.get(tabId);
  if(!association)return;
  const attachmentId=previewAttachments.current.get(association.sessionId);
  if(!attachmentId){setIssue('The page closed, but its preview connection is no longer available.');return;}
  void saving.current.then(()=>{
   if(persistedLayout.current!==latestLayout.current)throw new Error('The page tab could not be saved as closed.');
   return request('preview.close',{sessionId:association.sessionId,attachmentId,previewId:association.previewId});
  }).then(()=>{previewAssociations.current.delete(tabId);setPreviewAssociationRevision(value=>value+1);}).catch(fail);
 };
 const observeRuntimePreview=(tabId:string,observation:{navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number})=>{
  previewNavigation.current.set(tabId,observation);
  flushRuntimePreviewNavigation(tabId);
 };
 const flushRuntimePreviewNavigation=(tabId:string)=>{
  const association=previewAssociations.current.get(tabId),attachmentId=association&&previewAttachments.current.get(association.sessionId);
  const observation=previewNavigation.current.get(tabId);
  if(!association||!attachmentId||!observation||!previewAccepted.current.has(tabId))return;
  previewNavigation.current.delete(tabId);
  const sequence=association.sequence+1;
  association.sequence=sequence;association.navigation=observation.navigation;setPreviewAssociationRevision(value=>value+1);
  void request('preview.observe',{sessionId:association.sessionId,attachmentId,requestId:association.requestId,previewId:association.previewId,documentId:association.documentId,sequence,navigation:observation.navigation,...(observation.url?{url:observation.url}:{}),...(observation.title?{title:observation.title}:{}),...(observation.documentGeneration!==undefined?{documentGeneration:observation.documentGeneration}:{}),...(observation.navigation==='failed'?{error:{code:'iframe_navigation_failed',message:'The page failed to navigate.',retryable:false}}:{})}).then(result=>{association.sequence=result.sequence;association.navigation=result.navigation;if(observation.documentGeneration!==undefined)association.documentGeneration=observation.documentGeneration;if(observation.url)association.observedUrl=observation.url;if(observation.title)association.observedTitle=observation.title;setPreviewAssociationRevision(value=>value+1);}).catch(fail);
 };
 const pageCommentProvenance=new Map([...previewAssociations.current.entries()].map(([tabId,association])=>{const owner=data.sessions.find(candidate=>candidate.id===association.sessionId);return [tabId,{previewId:association.previewId,sessionId:association.sessionId,sessionTitle:owner?.title,providerId:owner?.provider,requestId:association.requestId,documentId:association.documentId,tabId,workspaceId:association.workspaceId,...(association.documentGeneration!==undefined?{navigation:association.documentGeneration}:{}),sequence:association.sequence}];}));
 const previewLabels=new Map([...previewAssociations.current.entries()].map(([tabId,association])=>[tabId,{title:association.title,observedTitle:association.observedTitle,sessionId:association.sessionId}]));
 const workspaceSessions=treeSessions.filter(candidate=>sessionIdsIn(layout).includes(candidate.id)||candidate.id===session.id);
 const focusedTab=focusTarget?workspaceTabs(layout).find(item=>item.tab.id===focusTarget.tabId)?.tab:undefined;
 const activeFilePath=focusedTab&&focusedTab.kind!=='session'&&focusedTab.kind!=='history'&&focusedTab.kind!=='usage'&&!focusedTab.ownerSessionId?focusedTab.path:undefined;
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
 return <section className={`ws session-screen runtime-workspace${fullscreen?' terminal-fullscreen':''}`} data-navigation-open={navigationOpen||undefined} aria-label={zh?'终端工作区':'Terminal workspace'}>
  {navigationOpen&&<button type="button" className="runtime-nav-scrim" aria-label={zh?'关闭导航':'Close navigation'} onClick={()=>closeNavigation()}/>}
  <header className="ws-top">
   <button className="ws-back" onClick={onBack} title={backTitle} aria-label={backTitle}><Icon name="back"/><span>{zh?'返回':'Back'}</span></button>
   <button ref={navigationToggle} type="button" className="runtime-nav-toggle icon-btn" aria-label={zh?'打开导航':'Open navigation'} aria-expanded={navigationOpen} aria-controls="runtime-navigation" onClick={()=>navigationOpen?closeNavigation(false):setNavigationOpen(true)}><Icon name="panel"/></button>
   {project&&<button className="ws-chip" title={project.name} onClick={()=>onProject(project.id)}><span className="dot primary"/><span className="ws-chip-label">{project.name}</span></button>}
   {project&&<button className="ws-chip branch" title={displayPath(path)} onClick={()=>onProject(project.id,path)}><Icon name="branch"/><span className="ws-chip-label">{currentTree?.branch??git?.branch??displayPath(path)?.split(/[\\/]/).at(-1)}</span></button>}
   {project&&path&&<QuickLaunchMenu key={`${project.id}:${path}`} projectId={project.id} root={path} data={data} onOpenSession={onSelect} onOpenPreview={paneWorkbench.openWeb}/>}
   {session.run&&<QuickLaunchRunChip session={session} onOpenPreview={paneWorkbench.openWeb}/>}
   <div className="top-spacer"/>
   <button className="icon-btn" onClick={()=>setInspector(value=>!value)} aria-pressed={inspector} aria-label={zh?'会话详情面板':'Session details'}><Icon name="panel"/></button>
  </header>
  <div className="ws-body"><div className="ws-center">
   {issue&&<p className="surface-error" role="alert">{issue}</p>}
   {commentNotice&&<div className="ws-notice-anchor"><p role="status">{commentNotice}</p></div>}
   {fileIssue&&<div className="workspace-file-error" role="alert"><span>{fileIssue.message} <code>{fileIssue.path}</code></span><button type="button" className="btn" onClick={()=>void navigator.clipboard.writeText(fileIssue.path).catch(fail)}>{zh?'复制路径':'Copy path'}</button><button type="button" className="icon-btn" aria-label={zh?'关闭提示':'Dismiss notice'} onClick={()=>setFileIssue(undefined)}><Icon name="close"/></button></div>}
   <div className={`ws-content${inspector?' with-drawer':''}`}>{workbenchScope&&workbenchActions&&<WorkbenchSideBar scope={workbenchScope} actions={workbenchActions} sessions={workspaceSessions} activeSessionId={previewSessionId} activePath={activeFilePath} command={workbenchCommand} switcherHost={switcherHost} zh={zh}/>}<div className="ws-pane" ref={paneArea}>
    <div className="workspace-content-host">
     <ContextHost.Provider value={commentsHost}><PaneWorkspace
      layout={layout} sessions={data.sessions} data={data} theme={theme}
      terminalCompatibility={data.settings.terminalCompatibility} providers={data.providers}
      delegationEnabled={data.settings['chatTools.delegation'] !== false} sessionInfoEnabled={data.settings['chatTools.sessionInfo'] !== false}
      onChange={save} onSessionChanged={onChanged} onOpenSession={onSelect} ownerSessionId={previewSessionId}
      prepareBrowserShare={prepareBrowserShare}
      onPickSession={(paneId)=>{setPicker({mode:'fill',paneId});setQuery('');}}
      onSwitcherHost={setSwitcherHost}
      onEmpty={()=>{void saving.current.then(()=>{if(live.current&&persistedLayout.current===latestLayout.current&&!workspaceTabs(visibleSessionLayout(latestLayout.current,previewSessionId)).length)onBack();});}}
      onActiveSession={id=>{setPreviewSessionId(id);onActiveSession?.(id);}}
      onInteraction={()=>{fileOpenGeneration.current++;}}
      onFileReference={(id,reference)=>void openReference(id,reference)} workbench={paneWorkbench}
      focusTarget={focusTarget} fileReveal={fileReveal} onOpenPath={openPaneFile} projectPath={project?.path} onWebClosed={closeRuntimePreview} onWebNavigation={observeRuntimePreview} previewProvenance={pageCommentProvenance} previewLabels={previewLabels}
     /></ContextHost.Provider><ContextSendDialogHost/>
    </div>
   </div>{inspector&&<div className="inspector-slot"><aside className="inspector" aria-label={zh?'会话详情面板':'Session details'}><div className="ins-head"><span>{zh?'会话详情':'Session details'}</span><button type="button" className="icon-btn icon-btn-sm" aria-label={zh?'关闭会话详情':'Close session details'} onClick={()=>setInspector(false)}><Icon name="close"/></button></div><div className="ins-scroll">
    <div className="ins-block"><h3>{zh?'会话信息':'Session information'}</h3><span className={`chip st-${state}`}>{stateLabel}</span><p>{session.title}</p><p className="mono dim-s">{displayPath(path)}</p><button className="btn" onClick={()=>setConfigOpen(true)}>{zh?'配置':'Configure'}</button>{session.mode==='chat'&&<button type="button" className="btn" onClick={()=>openTaskMap(session.id)}>{zh?'任务图':'Task map'}</button>}</div>
    {canPin&&project&&<SessionDocuments key={documentsSession.id} sessionId={documentsSession.id} zh={zh} state={documents} onPick={()=>setPinPicker(true)} openFile={file=>void openScopedFile({projectId:project.id,worktreePath:path,path:file,kind:'file'}).catch(fail)}/>}
    <div className="ins-block"><h3>{zh?'重点关注':'Following'}</h3><button className="btn" onClick={follow} aria-pressed={session.followed}><Icon name="star"/>{zh?(session.followed?'已关注 · 点击取消':'关注此会话'):(session.followed?'Following · Unfollow':'Follow session')}</button></div>
    <div className="ins-block runtime-session-actions"><SessionActions session={session}/></div><div className="ins-block session-fullscreen-row"><button className="btn" title={zh?'隐藏工作区界面，按 Esc 退出':'Hide workspace chrome; press Esc to leave'} onClick={()=>setFullscreen(value=>!value)}>{session.mode==='chat'?(zh?'全屏':'Fullscreen'):(zh?'全屏终端':'Fullscreen terminal')}</button></div>
   </div></aside></div>}</div>
  </div></div>
  {picker&&<SurfaceDialog title={zh?(picker.mode==='switch'?'切换会话':picker.mode==='add'?'选择并排会话':'选择会话'):(picker.mode==='switch'?'Switch session':picker.mode==='add'?'Choose session for split':'Choose session')} onClose={cancelPicker} size="sm"><div className="switcher"><div className="tools"><div className="input-wrap"><Icon name="search"/><input type="search" autoFocus value={query} onChange={event=>setQuery(event.target.value)} placeholder={zh?'搜索会话':'Search sessions'}/></div>{picker.mode==='switch'&&<Select value={allProjects?'all':'tree'} onChange={event=>setAllProjects(event.target.value==='all')}><option value="tree">{zh?'当前工作树':'Current worktree'}</option><option value="all">{zh?'全部项目':'All projects'}</option></Select>}</div><div className="switcher-list">{available.filter(s=>`${s.title} ${s.provider}`.toLowerCase().includes(query.toLowerCase())).map(s=><button className="switcher-row" key={s.id} onClick={()=>{if(picker.mode==='switch'){setPicker(undefined);onSelect(s.id);}else if(picker.mode==='add')addSessionPane(s);else fillPane(s);}}><AgentIcon provider={s.provider}/>{s.title}<small>{providerName(s.provider)}</small></button>)}</div>{!available.length&&<p className="note">{zh?'没有其他可选会话。':'No other sessions are available.'}</p>}</div></SurfaceDialog>}
  {configOpen&&<SessionConfigDialog session={session} data={data} onClose={()=>setConfigOpen(false)} onRerun={onSelect}/>}
  {quickOpen&&workbenchScope&&workbenchActions&&<QuickOpen scope={workbenchScope} zh={zh} onClose={()=>setQuickOpen(false)} onOpen={(file,position)=>workbenchActions.openFile(file,position)}/>}
  {pinPicker&&canPin&&workbenchScope&&<QuickOpen mode="pick" scope={workbenchScope} zh={zh} onClose={()=>setPinPicker(false)} onOpen={file=>{void documents.pin(file).catch(error=>setIssue(sessionDocumentError(error,zh)));}}/>}
 </section>;
}
