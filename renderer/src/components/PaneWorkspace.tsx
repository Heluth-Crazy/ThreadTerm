import { type CSSProperties, type DragEvent as ReactDragEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from 'react-dom';
import type { ContentRef, FileReference, PaneLayout, PreviewAssociation, ProviderCapability, Session, Snapshot } from "@threadterm/protocol";
import { confirmCloseEditors } from "../dirtyEditors";
import { useTranslation } from "../i18n";
import {
  splitPane,
  addTabToPane,
  activate,
  reorderTab,
  resizeSplit,
  paneCount,
  paneIdsIn,
} from "../workspaceLayout";
import { browserCommand, openExternal, openWindow, operationId, request } from "../bridge";
import { TerminalSurface } from "./TerminalSurface";
import { ChatView } from "./ChatView";
import { FileWorkspace } from "./FileWorkspace";
import { GitHistoryView } from "./GitHistoryView";
import { ReviewDiffView } from "./ReviewDiffView";
import { WebPreview } from "./WebPreview";
import { sanitizeBrowserTitle } from '../browserTypes';
import { BROWSER_NEW_TAB_URL, updateBrowserTab } from '../browserNewTab';
import type { BrowserShareWorkspace } from '../browserTypes';
import { AgentIcon, Icon } from "./PrototypeIcon";
import { ImportedHistoryView } from "./ImportedHistoryView";
import { CatalogPopover } from './CatalogActions';
import { WorkspaceTabBar } from './WorkspaceTabBar';
import { SessionSurfaceContext, SurfaceActions } from './SessionSurfaceContext';
import { contentTitle, focusedWorkspaceTab, isFileTab, isWebTabUrl, tabCloseTargets, workspaceTabs, type WorkspaceTabTarget } from '../workspaceTabs';
import { paneGeometry, paneRectStyle, PANE_GAP, PANE_DIVIDER_SIZE } from '../paneGeometry';
import { fileSelectionKey, visibleSessionLayout, workspaceNavigationLayout, workspaceNavigationTarget, withSessionCompanions, removeClosedViews } from '../sessionFileViews';
import "./workspace-parity.css";
import { FILE_DRAG_TYPE, readFileDrag } from "../fileDrag";
import type { FileCommentsHost } from "../fileCommentsHost";
import type { PageCommentProvenance } from '../reviewComments';
import { absolutePath, type WorkbenchActions } from '../workbench/types';
import { sameCanonicalScope } from '../projectScope';
import { sessionDiffActions } from '../sessionDiffActions';
import { presentedSession } from '../resumedSession';
import { openForkInPane } from '../chatFork';
import { isDocumentPinned, sessionDocumentError } from '../sessionDocuments';
import { fileTabMenuItems } from '../contextMenuSurfaceItems';
import { showContextMenu } from './ContextMenu';

const TaskMapView = lazy(() => import('./TaskMapView'));
const GroupChatView = lazy(async () => ({ default: (await import('./GroupChatView')).GroupChatView }));
const UsagePage = lazy(async () => ({ default: (await import('./UsagePage')).UsagePage }));

type Props = {
  layout: PaneLayout;
  sessions: Session[];
  /** Only the Usage tab needs the snapshot (provider and project names); other panes read live RPCs. */
  data?: Snapshot;
  theme: "light" | "dark";
  terminalCompatibility: unknown;
  providers?: ProviderCapability[];
  onChange: (next: PaneLayout) => void;
  onSessionChanged?: () => void;
  onOpenSession?: (sessionId: string) => void;
  ownerSessionId?: string;
  onPickSession?: (paneId: string) => void;
  toolbarHost?:HTMLElement|null;
  onEmpty?:()=>void;
  onActiveSession?:(sessionId:string)=>void;
  onInteraction?:()=>void;
  onFileReference?:(sessionId:string,reference:FileReference)=>void;
  focusTarget?:WorkspaceTabTarget & {key:string};
  fileReveal?:{tabId:string;line:number;column?:number;key:string};
  onOpenPath?:(file:{projectId:string;worktreePath?:string;path:string;kind:'file'|'diff'|'preview';assetKind?:'text'|'image';ownerSessionId?:string})=>void;
  /** Project root for a session without its own worktree; scopes the Chat Open-diff action. */
  projectPath?:string;
  onWebClosed?:(tabId:string)=>void;
  prepareBrowserShare?:(tabId:string)=>Promise<BrowserShareWorkspace>;
  onWebNavigation?:(tabId:string,observation:{navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number})=>void;
  previewProvenance?:ReadonlyMap<string,PageCommentProvenance>;
  previewLabels?:ReadonlyMap<string,Pick<PreviewAssociation,'title'|'observedTitle'|'sessionId'>>;
  /** Chat composer `@` groups the session supports; both default on (Extensions → Chat tools). */
  delegationEnabled?:boolean;
  sessionInfoEnabled?:boolean;
  workbench?:PaneWorkbench;
};
/** Host callbacks for workbench content inside panes; absent → panes behave as before. */
export type PaneWorkbench = {
  openTaskMap?:(sessionId:string,itemId?:string)=>void;
  taskMapFocus?:{tabId:string;sessionId:string;itemId?:string;key:string};
  openSessionReview?:(target:{sessionId:string;checkpointId:string;toCheckpointId?:string;path:string})=>void;
  openSessionFile?:(target:{sessionId:string;path:string})=>void;
  /** Resolves a Group output in a member workspace, then opens it as an independent file tab. */
  openGroupFile?:(target:{sessionId:string;path:string})=>void;
  /** Persist a Group's renamed title in every matching Group or legacy Roundtable tab. */
  updateGroupTitle?:(id:string,title:string)=>void;
  /** `sessionId` picks the receiving session (a file dropped on its pane); otherwise the workspace's current one. */
  sendToAgent?:(target:{projectId:string;worktreePath?:string;path:string;startLine?:number;endLine?:number;sessionId?:string})=>void;
  openHistory?:(target:{projectId:string;worktreePath?:string;path?:string;commit?:string})=>void;
  openFile?:(target:{projectId:string;worktreePath?:string;path:string})=>void;
  /** Opens an http(s) page as an independent tab (terminal link bar → Open in preview). */
  openWeb?:(url:string)=>void;
  /** Comments on any file view, added to a chosen session's message box (fileCommentsHost.ts). */
  comments?:FileCommentsHost;
  commentScope?:{projectId:string;root:string};
  /** One-shot request to select a commit in a history tab (blame click). */
  historyFocus?:{tabId:string;commit:string;key:string};
  /** Documents for the active session, limited to this session's project/worktree root. */
  sessionDocuments?:{projectId:string;rootPath:string;projectRoot?:string} & NonNullable<WorkbenchActions['sessionDocuments']>;
};
export function PaneWorkspace({ layout, sessions, data, onChange, theme, terminalCompatibility, providers = [], onSessionChanged, onOpenSession, ownerSessionId, onPickSession,toolbarHost,onEmpty,onActiveSession,onInteraction,onFileReference,focusTarget,fileReveal,onOpenPath,projectPath,onWebClosed,onWebNavigation,prepareBrowserShare,previewProvenance,previewLabels,delegationEnabled,sessionInfoEnabled,workbench }: Props) {
  const zh=useTranslation().locale==='zh-CN';
  const [selectedPaneId, setSelectedPaneId] = useState<string|undefined>(focusTarget?.paneId);
  const [paneHost,setPaneHost]=useState<HTMLDivElement|null>(null),[stackHorizontal,setStackHorizontal]=useState(false);
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string>();
  const knownWebTabs=useRef<Set<string>|undefined>(undefined);
  const [resumedSessions, setResumedSessions] = useState<Map<string,Session>>(() => new Map());
  const viewSessions = resumedSessions.size ? [...sessions.map(session => presentedSession(session, resumedSessions.get(session.id))), ...Array.from(resumedSessions.values()).filter(session => session.forkedFrom && !sessions.some(current => current.id === session.id))] : sessions;
  useEffect(() => {
    setResumedSessions(current => {
      let next: Map<string,Session> | undefined;
      for (const [id, resumed] of current) {
        const canonical = sessions.find(session => session.id === id);
        if ((!canonical && !resumed.forkedFrom) || (canonical && presentedSession(canonical,resumed) === canonical)) {
          next ??= new Map(current); next.delete(id);
        }
      }
      return next ?? current;
    });
  }, [sessions]);
  const [primaryHost,setPrimaryHost]=useState<HTMLDivElement|null>(null),[menuHost,setMenuHost]=useState<HTMLDivElement|null>(null);
  const [menuAnchor,setMenuAnchor]=useState<HTMLElement>(),[closing,setClosing]=useState(false),[closeIssue,setCloseIssue]=useState<string>();
  // Actions are portaled into the host, so they are not React children of it.
  // Close on a microtask after the click: the action runs, then the menu stops covering the surface.
  useEffect(() => {
    if (!menuHost) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !menuHost.contains(target) || !target.closest('button')) return;
      queueMicrotask(() => setMenuAnchor(undefined));
    };
    menuHost.addEventListener('click', close);
    return () => menuHost.removeEventListener('click', close);
  }, [menuHost]);
  const closingRef=useRef(false),latest=useRef(layout);latest.current=layout;
  const fileSelections=useRef(new Map<string,string>());
  const visibleLayout=visibleSessionLayout(layout,ownerSessionId,fileSelections.current);
  const withoutWeb=(node:PaneLayout):PaneLayout=>node.kind==='pane'?{...node,tabs:node.tabs.filter(tab=>tab.kind!=='web'),activeTabId:node.tabs.some(tab=>tab.kind!=='web'&&tab.id===node.activeTabId)?node.activeTabId:null}:{...node,first:withoutWeb(node.first),second:withoutWeb(node.second)};
  // Browser pages are navigated from their own pane strip; this is display-only.
  const navigationLayout=withoutWeb(workspaceNavigationLayout(layout));
  const latestVisible=useRef(visibleLayout);latestVisible.current=visibleLayout;
  useEffect(()=>{for(const item of workspaceTabs(visibleLayout))if(item.active&&item.tab.kind!=='session'&&ownerSessionId&&item.tab.ownerSessionId===ownerSessionId)fileSelections.current.set(fileSelectionKey(ownerSessionId,item.paneId),item.tab.id);},[visibleLayout,ownerSessionId]);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!paneHost)return;const update=()=>setStackHorizontal(paneHost.clientWidth<=680);update();const observer=new ResizeObserver(update);observer.observe(paneHost);return()=>observer.disconnect();},[paneHost]);
  const focused=focusedWorkspaceTab(visibleLayout,selectedPaneId);
  const focusPaneId=selectedPaneId&&paneIdsIn(visibleLayout).includes(selectedPaneId)?selectedPaneId:focused?.paneId;
  const latestFocus=useRef(focusPaneId);latestFocus.current=focusPaneId;
  const activeSession=focused?.tab.kind==='session'?focused.tab.sessionId:undefined;
  const activeSessionKnown=Boolean(activeSession&&sessions.some(session=>session.id===activeSession));
  const activeCallback=useRef(onActiveSession);activeCallback.current=onActiveSession;
  useEffect(()=>{if(activeSession)activeCallback.current?.(activeSession);},[activeSession,activeSessionKnown]);
  useEffect(()=>{if(focusTarget){setSelectedPaneId(focusTarget.paneId);setFullscreenPaneId(current=>current&&current!==focusTarget.paneId?undefined:current);}},[focusTarget]);
  const commit=(next:PaneLayout)=>{latest.current=next;onChange(next);};
  useEffect(()=>{const current=new Set(workspaceTabs(layout).filter(item=>item.tab.kind==='web').map(item=>item.tab.id));if(knownWebTabs.current)for(const id of knownWebTabs.current)if(!current.has(id))void browserCommand({type:'close',tabId:id}).catch(()=>undefined);knownWebTabs.current=current;},[layout]);
  const openFork=(paneId:string,child:Session)=>{
    if(!mounted.current)return;
    const next=openForkInPane(latest.current,paneId,child.id);
    if(next===latest.current)return;
    setResumedSessions(current=>new Map(current).set(child.id,child));
    setSelectedPaneId(paneId);commit(next);onInteraction?.();onSessionChanged?.();
  };
  const activation=useRef(0);
  const activateTab=async(target:WorkspaceTabTarget)=>{
   onInteraction?.();
   const generation=++activation.current;
   const before=workspaceTabs(latest.current);
   if(!before.some(item=>item.paneId===target.paneId&&item.tab.id===target.tabId))return;
   try{
    if(!mounted.current||generation!==activation.current||!workspaceTabs(latest.current).some(item=>item.paneId===target.paneId&&item.tab.id===target.tabId))return;
    setSelectedPaneId(target.paneId);setFullscreenPaneId(current=>current&&current!==target.paneId?undefined:current);
    commit(activate(latest.current,target.paneId,target.tabId));
   }catch(error){if(mounted.current)setCloseIssue(error instanceof Error?error.message:String(error));}
  };
  const closeTabs=async(target:WorkspaceTabTarget,mode:'current'|'others'|'all',companion=false,onlyKind?:ContentRef['kind'])=>{
   onInteraction?.();
   if(closingRef.current)return;closingRef.current=true;setClosing(true);setCloseIssue(undefined);
   activation.current++;
   const requested=tabCloseTargets(companion?latestVisible.current:workspaceNavigationLayout(latest.current),target,mode).filter(candidate=>!onlyKind||workspaceTabs(latest.current).find(item=>item.paneId===candidate.paneId&&item.tab.id===candidate.tabId)?.tab.kind===onlyKind);
   const targets=withSessionCompanions(latest.current,requested);
   const editors=workspaceTabs(latest.current).filter(item=>item.tab.kind!=='session'&&targets.some(t=>t.paneId===item.paneId&&t.tabId===item.tab.id)).map(item=>editorId(item.paneId,item.tab));
   try{
    if(!await confirmCloseEditors(editors)||!mounted.current)return;
    const next=removeClosedViews(latest.current,targets,latestFocus.current);
    if(next.blocked){setCloseIssue(zh?'确认期间打开了新的关联文件，请重新关闭。':'A new related file opened during confirmation. Please close again.');return;}
    const closedWebTabs=workspaceTabs(latest.current).filter(item=>item.tab.kind==='web'&&targets.some(target=>target.paneId===item.paneId&&target.tabId===item.tab.id));
    commit(next.layout);for(const item of closedWebTabs)onWebClosed?.(item.tab.id);setSelectedPaneId(next.focusedPaneId);
    if(!workspaceTabs(visibleSessionLayout(next.layout,ownerSessionId,fileSelections.current)).length)onEmpty?.();
   }catch(error){if(mounted.current)setCloseIssue(error instanceof Error?error.message:String(error));}
   finally{closingRef.current=false;if(mounted.current)setClosing(false);}
  };
  const closeWorkspacePane=async(paneId:string)=>{
   onInteraction?.();
   if(closingRef.current)return;closingRef.current=true;setClosing(true);setCloseIssue(undefined);activation.current++;
   const captured=workspaceTabs(latestVisible.current).filter(item=>item.paneId===paneId);
   const targets=withSessionCompanions(latest.current,captured.map(item=>({paneId,tabId:item.tab.id})));
   const editors=workspaceTabs(latest.current).filter(item=>item.tab.kind!=='session'&&targets.some(target=>target.paneId===item.paneId&&target.tabId===item.tab.id)).map(item=>editorId(item.paneId,item.tab));
   try{
    if(!await confirmCloseEditors(editors)||!mounted.current)return;
    // A tab opened while the confirmation was visible must not disappear.
    if(workspaceTabs(latestVisible.current).some(item=>item.paneId===paneId&&!captured.some(old=>old.tab.id===item.tab.id)))return;
    const next=removeClosedViews(latest.current,targets,latestFocus.current,paneId);
    if(next.blocked){setCloseIssue(zh?'确认期间打开了新的关联文件，请重新关闭。':'A new related file opened during confirmation. Please close again.');return;}
    const closedWebTabs=workspaceTabs(latest.current).filter(item=>item.tab.kind==='web'&&targets.some(target=>target.paneId===item.paneId&&target.tabId===item.tab.id));
    commit(next.layout);for(const item of closedWebTabs)onWebClosed?.(item.tab.id);setSelectedPaneId(next.focusedPaneId);
    if(!workspaceTabs(visibleSessionLayout(next.layout,ownerSessionId,fileSelections.current)).length)onEmpty?.();
   }catch(error){if(mounted.current)setCloseIssue(error instanceof Error?error.message:String(error));}
   finally{closingRef.current=false;if(mounted.current)setClosing(false);}
  };
  useEffect(() => {
    if (!fullscreenPaneId) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreenPaneId(undefined);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [fullscreenPaneId]);
  useEffect(() => {
    const ids = paneIdsIn(visibleLayout);
    if (fullscreenPaneId && !ids.includes(fullscreenPaneId)) setFullscreenPaneId(undefined);
    if (selectedPaneId && !ids.includes(selectedPaneId)) setSelectedPaneId(undefined);
  }, [visibleLayout, fullscreenPaneId, selectedPaneId]);
  const geometry = paneGeometry(visibleLayout,{stackHorizontal});
  // Keep leaf surfaces at one stable React ancestry. Nesting the Pane inside
  // Split unmounts it whenever a split is inserted/collapsed, even with a key.
  const panes = paneGeometry(layout,{stackHorizontal}).panes.map(({node}) => {
    const visible=geometry.panes.find(pane=>pane.node.id===node.id);
    return (
      <Pane
        key={node.id}
        node={node}
        visibleNode={visible?.node}
        style={fullscreenPaneId === node.id || !visible ? undefined : paneRectStyle(visible.rect)}
        sessions={viewSessions}
        data={data}
        theme={theme}
        terminalCompatibility={terminalCompatibility}
        onChange={commit}
        layout={layout}
        selected={Boolean(visible)&&focusPaneId === node.id}
        fullscreen={fullscreenPaneId === node.id}
        browserVisible={!fullscreenPaneId||fullscreenPaneId===node.id}
        onFocus={() => {activation.current++;onInteraction?.();setSelectedPaneId(node.id);}}
        onToggleFullscreen={() => setFullscreenPaneId(current => current === node.id ? undefined : node.id)}
        onSplit={(paneId) => {onInteraction?.();setSelectedPaneId(paneId);}}
        onClosePane={()=>void closeWorkspacePane(node.id)}
        onPickSession={onPickSession}
        onSessionChanged={onSessionChanged}
        onOpenSession={onOpenSession}
        onFork={child=>openFork(node.id,child)}
        providers={providers}
        closing={closing}
        onActivateTab={target=>void activateTab(target)}
        onCloseFile={target=>void closeTabs(target,'current',true)}
        onCloseTab={target=>void closeTabs(target,'current')}
        onCloseTabs={(target,mode)=>void closeTabs(target,mode,false,'web')}
        onResumed={(session) => { setResumedSessions(current => new Map(current).set(session.id,session)); onSessionChanged?.(); }}
        primaryHost={primaryHost} menuHost={menuHost} onFileReference={onFileReference} fileReveal={fileReveal} onOpenPath={onOpenPath} projectPath={projectPath} onWebNavigation={onWebNavigation} prepareBrowserShare={prepareBrowserShare} previewProvenance={previewProvenance} previewLabels={previewLabels} delegationEnabled={delegationEnabled} sessionInfoEnabled={sessionInfoEnabled} workbench={workbench}
      />
    );});
  const companionFiles=workspaceTabs(visibleLayout).filter(item=>item.tab.kind!=='session'&&item.tab.ownerSessionId===ownerSessionId&&Boolean(ownerSessionId));
  const toolbar=<WorkspaceTabBar layout={navigationLayout} sessions={viewSessions} active={focused?.tab.kind==='web'?undefined:workspaceNavigationTarget(layout,focused)} busy={closing}
   onActivate={target=>void activateTab(target)}
   onClose={(target,mode)=>void closeTabs(target,mode)} onReorder={(paneId,from,to)=>{const visible=workspaceTabs(withoutWeb(workspaceNavigationLayout(latest.current))).filter(item=>item.paneId===paneId);const all=workspaceTabs(latest.current).filter(item=>item.paneId===paneId);const source=all.findIndex(item=>item.tab.id===visible[from]?.tab.id),destination=all.findIndex(item=>item.tab.id===visible[to]?.tab.id);if(source>=0&&destination>=0)commit(reorderTab(latest.current,paneId,source,destination));}}
   fileMenuItems={item=>{const documents=workbench?.sessionDocuments;const matchingDocuments=documents&&item.projectId===documents.projectId&&sameCanonicalScope(item.worktreePath??documents.projectRoot,documents.rootPath)?documents:undefined;const root=item.worktreePath??matchingDocuments?.projectRoot;const pinned=Boolean(matchingDocuments&&isDocumentPinned(matchingDocuments.documents,item.path));const plansLabel=matchingDocuments?(zh?(pinned?'从计划与文档中移除':'添加到计划与文档'):(pinned?'Remove from Plans & docs':'Add to Plans & docs')):undefined;return fileTabMenuItems({zh,canSend:Boolean(workbench?.sendToAgent),plansLabel,canCopy:Boolean(root)}).map(menu=>({...menu,disabled:menu.id==='workspace-tab-plans-docs'&&Boolean(matchingDocuments?.loading||matchingDocuments?.error),reason:menu.id==='workspace-tab-plans-docs'&&matchingDocuments?.error?sessionDocumentError(matchingDocuments.error,zh):menu.id==='workspace-tab-plans-docs'&&matchingDocuments?.loading?(zh?'正在加载计划与文档。':'Plans & docs are loading.'):undefined,onSelect:menu.id==='workspace-tab-send-file'?()=>workbench?.sendToAgent?.({projectId:item.projectId,worktreePath:item.worktreePath,path:item.path}):menu.id==='workspace-tab-plans-docs'?()=>matchingDocuments?.toggle(item.path):menu.id==='workspace-tab-copy-path'?()=>{if(root)return navigator.clipboard.writeText(absolutePath(root,item.path));}:undefined,testId:menu.id}));}}>
   <div className="workspace-primary-actions" ref={setPrimaryHost}/>
   {companionFiles.length>0&&<button type="button" className="icon-btn" aria-label={zh?'会话文件':'Open session files'} title={zh?'会话文件':'Open session files'} aria-pressed={Boolean(focused&&focused.tab.kind!=='session'&&focused.tab.ownerSessionId===ownerSessionId)} onClick={()=>{
    const target=companionFiles.find(item=>item.tab.id===fileSelections.current.get(fileSelectionKey(ownerSessionId,item.paneId)))??companionFiles[0];
    void activateTab({paneId:target.paneId,tabId:target.tab.id});
   }}><Icon name="file"/></button>}
   <button type="button" className="icon-btn" aria-label={zh?'打开会话':'Open session'} title={zh?'打开会话':'Open session'} onClick={()=>onPickSession?.(focusPaneId??paneIdsIn(layout)[0])}><Icon name="plus"/></button>
   <button type="button" className="icon-btn" aria-label={zh?'工作区操作':'Workspace actions'} title={zh?'工作区操作':'Workspace actions'} aria-expanded={Boolean(menuAnchor)} onClick={event=>{const anchor=event.currentTarget;setMenuAnchor(current=>current?undefined:anchor);}}><Icon name="more"/></button>
   {menuAnchor&&<CatalogPopover anchor={menuAnchor} label={zh?'工作区操作':'Workspace actions'} onClose={()=>setMenuAnchor(undefined)}><div className="workspace-action-menu" ref={setMenuHost}/></CatalogPopover>}
  </WorkspaceTabBar>;
  return (
    <section className={`pane-workspace ws-content ${fullscreenPaneId ? "pane-focused" : ""}`} aria-label="Workspace panes">
      {toolbarHost?createPortal(toolbar,toolbarHost):toolbar}
      {closeIssue&&<p className="surface-error" role="alert">{closeIssue}</p>}
      <div className="pane-grid" ref={setPaneHost} style={{'--pane-gap':`${PANE_GAP}px`,'--pane-divider-size':`${PANE_DIVIDER_SIZE}px`} as CSSProperties}>
        {geometry.splits.map(({node,rect})=><Split key={node.id} node={node} direction={stackHorizontal&&node.direction==='horizontal'?'vertical':node.direction} root={layout} style={paneRectStyle(rect)} onChange={commit}/>)}
        {panes}
      </div>
    </section>
  );
}
function Split({
  node,
  direction,
  root,
  style,
  onChange,
}: {
  node: Extract<PaneLayout, { kind: "split" }>;
  direction: "horizontal"|"vertical";
  root: PaneLayout;
  style: CSSProperties;
  onChange: (next: PaneLayout) => void;
}) {
  const grabOffset = useRef<number | null>(null);
  const drag = (event: React.PointerEvent) => {
    const container = event.currentTarget.parentElement;
    if (!container || grabOffset.current === null) return;
    const box = container.getBoundingClientRect();
    const divider = event.currentTarget.getBoundingClientRect();
    const vertical = direction === "vertical";
    const gap = Number.parseFloat(getComputedStyle(container)[vertical ? "rowGap" : "columnGap"]) || 0;
    const dividerSize = vertical ? divider.height : divider.width;
    const available = (vertical ? box.height : box.width) - 2 * gap - dividerSize;
    if (available <= 0) return;
    const position = vertical ? event.clientY - box.top : event.clientX - box.left;
    const ratio = (position - grabOffset.current - gap - dividerSize / 2) / available;
    onChange(resizeSplit(root, node.id, ratio));
  };
  return (
    <div
      className={`pane-split ${direction}`}
      data-split-id={node.id}
      style={style}
    >
      <div className="pane-split-child" style={{ flex: `${node.ratio} 1 0px` }} />
      <div
        className="pane-divider"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const divider = event.currentTarget.getBoundingClientRect();
          grabOffset.current = direction === "vertical"
            ? event.clientY - divider.top - divider.height / 2
            : event.clientX - divider.left - divider.width / 2;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) =>
          event.currentTarget.hasPointerCapture(event.pointerId) && drag(event)
        }
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          grabOffset.current = null;
        }}
        onPointerCancel={() => { grabOffset.current = null; }}
        onLostPointerCapture={() => { grabOffset.current = null; }}
      />
      <div className="pane-split-child" style={{ flex: `${1 - node.ratio} 1 0px` }} />
    </div>
  );
}
function editorId(paneId: string, tab: ContentRef) {
  return `workspace:${paneId}:${tab.id}`;
}
function Pane({
  node,
  visibleNode,
  style,
  sessions,
  data,
  theme,
  terminalCompatibility,
  onChange,
  layout,
  selected,
  fullscreen,
  browserVisible,
  onFocus,
  onToggleFullscreen,
  onSplit,
  onClosePane,
  onPickSession,
  onSessionChanged,
  onOpenSession,
  onFork,
  providers,
  onResumed,
  closing,onActivateTab,onCloseFile,onCloseTab,onCloseTabs,
  primaryHost,menuHost,onFileReference,fileReveal,onOpenPath,projectPath,onWebNavigation,prepareBrowserShare,previewProvenance,previewLabels,delegationEnabled,sessionInfoEnabled,workbench,
}: {
  node: Extract<PaneLayout, { kind: "pane" }>;
  visibleNode?: Extract<PaneLayout, { kind: "pane" }>;
  style?: CSSProperties;
  sessions: Session[];
  data?: Snapshot;
  theme: "light" | "dark";
  terminalCompatibility: unknown;
  onChange: (next: PaneLayout) => void;
  layout: PaneLayout;
  selected: boolean;
  fullscreen: boolean;
  browserVisible:boolean;
  onFocus: () => void;
  onToggleFullscreen: () => void;
  onSplit: (paneId: string) => void;
  onClosePane:()=>void;
  onPickSession?: (paneId: string) => void;
  onSessionChanged?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onFork: (session: Session) => void;
  providers: ProviderCapability[];
  onResumed: (session: Session) => void;
  closing:boolean;
  onActivateTab:(target:WorkspaceTabTarget)=>void;
  onCloseFile:(target:WorkspaceTabTarget)=>void;
  onCloseTab:(target:WorkspaceTabTarget)=>void;
  onCloseTabs:(target:WorkspaceTabTarget,mode:'current'|'others'|'all')=>void;
  primaryHost:HTMLElement|null;menuHost:HTMLElement|null;
  onFileReference?:(sessionId:string,reference:FileReference)=>void;
  fileReveal?:{tabId:string;line:number;column?:number;key:string};
  onOpenPath?:(file:{projectId:string;worktreePath?:string;path:string;kind:'file'|'diff'|'preview';assetKind?:'text'|'image';ownerSessionId?:string})=>void;
  projectPath?:string;
  prepareBrowserShare?:(tabId:string)=>Promise<BrowserShareWorkspace>;
  onWebNavigation?:(tabId:string,observation:{navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number})=>void;
  previewProvenance?:ReadonlyMap<string,PageCommentProvenance>;
  previewLabels?:ReadonlyMap<string,Pick<PreviewAssociation,'title'|'observedTitle'|'sessionId'>>;
  delegationEnabled?:boolean;
  sessionInfoEnabled?:boolean;
  workbench?:PaneWorkbench;
}) {
  const {locale}=useTranslation();const zh=locale==="zh-CN";
  const browserLayout=useRef(layout);browserLayout.current=layout;
  const changeBrowserLayout=(update:(current:PaneLayout)=>PaneLayout)=>{const before=browserLayout.current,next=update(before);if(next!==before){browserLayout.current=next;onChange(next);}};
  const tab =
    visibleNode?.tabs.find((item) => item.id === visibleNode.activeTabId) ?? visibleNode?.tabs[0];
  const visited=useRef(new Set<string>());
  if(tab)visited.current.add(tab.id);
  for(const id of visited.current)if(!node.tabs.some(item=>item.id===id))visited.current.delete(id);
  const [issue, setIssue] = useState<string>();
  const [browserTitles,setBrowserTitles]=useState<Map<string,string>>(()=>new Map());
  const [browserIcons,setBrowserIcons]=useState<Map<string,{favicon?:string;loading:boolean}>>(()=>new Map());
  const [newBrowserTab,setNewBrowserTab]=useState<string>();
  useEffect(()=>{setBrowserIcons(current=>{const ids=new Set(node.tabs.map(item=>item.id));return [...current.keys()].some(id=>!ids.has(id))?new Map([...current].filter(([id])=>ids.has(id))):current;});},[node.tabs]);
  const browserStrip=useRef<HTMLDivElement>(null),hasBrowserTabs=node.tabs.some(item=>item.kind==='web');
  const revealBrowserTab=(element?:Element|null)=>(element??browserStrip.current?.querySelector('.browser-page-tab.active'))?.scrollIntoView({inline:'nearest',block:'nearest',behavior:'instant'});
  useEffect(()=>{if(visibleNode&&browserVisible)revealBrowserTab();},[tab?.id,node.tabs.length,Boolean(visibleNode),browserVisible]);
  useEffect(()=>{
    const strip=browserStrip.current;if(!strip)return;
    const wheel=(event:WheelEvent)=>{if(event.ctrlKey||event.metaKey||!event.deltaY||Math.abs(event.deltaX)>Math.abs(event.deltaY)||strip.scrollWidth<=strip.clientWidth)return;event.preventDefault();strip.scrollLeft+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?strip.clientWidth:1);};
    strip.addEventListener('wheel',wheel,{passive:false});return()=>strip.removeEventListener('wheel',wheel);
  },[hasBrowserTabs]);
  const [fileDropTarget, setFileDropTarget] = useState<string>();
  const session =
    tab?.kind === "session"
      ? sessions.find((item) => item.id === tab.sessionId)
      : undefined;
  const paneLimit = paneCount(layout) >= 4;
  const lastPane = paneCount(layout) === 1;
  const openWeb=(url:string)=>{void browserCommand({type:'preferences'}).then(preferences=>{
    if(preferences&&'linkTarget' in preferences&&preferences.linkTarget==='system')return openExternal(url);
    return workbench?.openWeb?.(url);
  }).catch(error=>setIssue(error instanceof Error?error.message:String(error)));};
  const persistWebNavigation=(item:Extract<ContentRef,{kind:'web'}>,observation:{navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number;favicon?:string;loading?:boolean})=>{
    setBrowserIcons(current=>{const before=current.get(item.id),next={favicon:observation.favicon,loading:Boolean(observation.loading)};return before?.favicon===next.favicon&&before?.loading===next.loading?current:new Map(current).set(item.id,next);});
    if(observation.navigation==='load_observed'){
      const title=sanitizeBrowserTitle(observation.title??'');
      setBrowserTitles(current=>current.get(item.id)===title?current:new Map(current).set(item.id,title));
      if(observation.url&&isWebTabUrl(observation.url))changeBrowserLayout(current=>updateBrowserTab(current,item.id,observation.url!,title));
    }
    onWebNavigation?.(item.id,observation);
  };
  const addBrowserPopup=(opener:Extract<ContentRef,{kind:'web'}>,popup:{openerId:string;tabId:string;url:string})=>{
    if(popup.openerId!==opener.id)return;
    const insert=(current:PaneLayout):PaneLayout=>current.kind==='pane'?(current.id!==node.id||current.tabs.some(tab=>tab.id===popup.tabId)?current:{...current,tabs:[...current.tabs.slice(0,current.tabs.findIndex(tab=>tab.id===opener.id)+1),{id:popup.tabId,kind:'web',url:popup.url},...current.tabs.slice(current.tabs.findIndex(tab=>tab.id===opener.id)+1)]}):{...current,first:insert(current.first),second:insert(current.second)};
    changeBrowserLayout(current=>activate(insert(current),node.id,popup.tabId));
  };
  const addBrowserTab=()=>{
    const id=crypto.randomUUID();
    setNewBrowserTab(id);
    changeBrowserLayout(current=>addTabToPane(current,node.id,{id,kind:'web',url:BROWSER_NEW_TAB_URL}));
    onFocus();
  };
  const split = (direction: "horizontal" | "vertical") => {
    const paneId = crypto.randomUUID();
    onChange(splitPane(layout, node.id, direction, paneId));
    onSplit(paneId);
  };
  const empty = node.tabs.length === 0 ? (
    <div className="pane-empty">
      <Icon name="plus" />
      <strong>{zh?"空窗格":"Empty pane"}</strong>
      <p className="note">{zh?"为此窗格选择一个会话；取消选择将移除该窗格。":"Pick a session for this pane; cancelling removes it."}</p>
      <button className="btn btn-primary" onClick={() => onPickSession?.(node.id)}>{zh?"选择会话":"Choose session"}</button>
    </div>
  ) : null;
  const content = node.tabs.filter(item=>visited.current.has(item.id)).map(item=>{
    const active=Boolean(visibleNode)&&item.id===tab?.id;
    const itemSession=item.kind==='session'?sessions.find(candidate=>candidate.id===item.sessionId):undefined;
    return <SessionSurfaceContext.Provider key={item.id} value={{primaryHost,menuHost,focused:selected&&active,openFile:itemSession&&onFileReference?reference=>onFileReference(itemSession.id,reference):undefined,...sessionDiffActions(itemSession,projectPath,onOpenPath),openWeb:workbench?.openWeb?openWeb:undefined,openFork:onFork,openTaskMap:itemSession?.mode==='chat'?workbench?.openTaskMap:undefined}}>
    <div className={`pane-tab-surface${fileDropTarget===item.id?" file-drop-target":""}`} data-content-id={item.id} {...(item.kind==='web'?{id:`browser-panel-${node.id}-${item.id}`,role:'tabpanel','aria-labelledby':`browser-tab-${node.id}-${item.id}`}:{})} hidden={!active} inert={!active}
     {...(itemSession&&!itemSession.readOnly&&workbench?.sendToAgent&&["starting","running","idle","waiting"].includes(itemSession.status)?{
      // An Explorer file dropped here inserts the same reference as "Send to agent", into this session.
      "data-drop-label":zh?"松开以插入文件引用（不会发送）":"Drop to insert the file reference (not sent)",
      onDragOver:(event:ReactDragEvent<HTMLDivElement>)=>{if(!event.dataTransfer.types.includes(FILE_DRAG_TYPE))return;event.preventDefault();event.dataTransfer.dropEffect="copy";if(fileDropTarget!==item.id)setFileDropTarget(item.id);},
      onDragLeave:(event:ReactDragEvent<HTMLDivElement>)=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFileDropTarget(undefined);},
      onDrop:(event:ReactDragEvent<HTMLDivElement>)=>{if(!event.dataTransfer.types.includes(FILE_DRAG_TYPE))return;event.preventDefault();setFileDropTarget(undefined);const file=readFileDrag(event.dataTransfer.getData(FILE_DRAG_TYPE));if(file)workbench.sendToAgent?.({...file,sessionId:itemSession.id});},
     }:{})}>
    {itemSession?.readOnly ? (
    <ImportedHistoryView session={itemSession} onResumed={onResumed} onOpenSession={onOpenSession}/>
  ) : itemSession ? (
    itemSession.mode === "terminal" ? (
      <TerminalSurface sessionId={itemSession.id} provider={itemSession.provider} session={itemSession} theme={theme} terminalCompatibility={terminalCompatibility} resumeCapture={providers.find((candidate) => candidate.id === itemSession.provider)?.terminalResumeCapture} onChanged={onSessionChanged} onOpenSession={onOpenSession} />
    ) : (
      <ChatView session={itemSession} sessions={sessions} delegates={sessions.filter(candidate => candidate.delegation?.parentSessionId === itemSession.id)} delegatedBy={itemSession.delegation ? sessions.find(candidate => candidate.id === itemSession.delegation?.parentSessionId) : undefined} onOpenSession={onOpenSession} delegationEnabled={delegationEnabled} sessionInfoEnabled={sessionInfoEnabled} />
    )
  ) : item.kind === "map" ? (
    <Suspense fallback={<p className="note" role="status">{zh?'正在加载任务图…':'Loading task map…'}</p>}><TaskMapView sessionId={item.sessionId} sessions={sessions} visible={active&&browserVisible} zh={zh}
      focus={workbench?.taskMapFocus?.tabId===item.id?workbench.taskMapFocus:undefined} onOpenSession={onOpenSession}
      onOpenReview={workbench?.openSessionReview} onOpenFile={workbench?.openSessionFile} onClose={()=>onCloseTab({paneId:node.id,tabId:item.id})}/></Suspense>
  ) : item.kind === "usage" ? (
    <Suspense fallback={<p className="note" role="status">{zh?'正在加载用量…':'Loading usage…'}</p>}><UsagePage initialProjectId={item.projectId} data={data} onOpenSession={onOpenSession}/></Suspense>
  ) : item.kind === "group" || item.kind === "roundtable" ? (
    <Suspense fallback={<p className="note" role="status">{zh?'正在加载群聊…':'Loading group chat…'}</p>}><GroupChatView id={item.kind==='group'?item.groupId:item.roundtableId} providers={providers} sessions={sessions} visible={active&&browserVisible} onOpenSession={id=>onOpenSession?.(id)} onOpenFile={path=>{const groupId=item.kind==='group'?item.groupId:item.roundtableId;const sessionId=sessions.find(candidate=>candidate.group?.id===groupId)?.id;if(sessionId)workbench?.openGroupFile?.({sessionId,path});}} onOpenUrl={url=>workbench?.openWeb?.(url)} onChanged={onSessionChanged??(()=>undefined)} onTitleChanged={workbench?.updateGroupTitle}/></Suspense>
  ) : item.kind === "history" ? (
    <GitHistoryView projectId={item.projectId} worktreePath={item.worktreePath} path={item.path} zh={zh}
      focusCommit={workbench?.historyFocus?.tabId===item.id?workbench.historyFocus.commit:undefined}
      onOpenFile={workbench?.openFile?path=>workbench.openFile?.({projectId:item.projectId,worktreePath:item.worktreePath,path}):undefined}
      comments={workbench?.comments}/>
  ) : item.kind === "review" ? (
    <ReviewDiffView projectId={item.projectId} worktreePath={item.worktreePath} path={item.path} sessionId={item.sessionId}
      checkpointId={item.checkpointId} toCheckpointId={item.toCheckpointId} editorId={editorId(node.id, item)} zh={zh}
      onOpenFile={workbench?.openFile?path=>workbench.openFile?.({projectId:item.projectId,worktreePath:item.worktreePath,path}):undefined}
      comments={workbench?.comments}/>
  ) : item.kind === "web" ? (
    <WebPreview prepareBrowserShare={prepareBrowserShare} tabId={item.id} url={item.url} visible={active&&browserVisible} zh={zh} commentScope={workbench?.commentScope} commentsHost={workbench?.comments} commentProvenance={previewProvenance?.get(item.id)} onNavigation={observation=>persistWebNavigation(item,observation)} onPopup={popup=>addBrowserPopup(item,popup)} onNewTab={addBrowserTab} addressFocus={newBrowserTab===item.id?item.id:undefined}/>
  ) : isFileTab(item) ? (
    <FileWorkspace
      projectId={item.projectId}
      worktreePath={item.worktreePath}
      comments={workbench?.comments}
      initialStaged={item.kind === "diff" ? item.staged : undefined}
      onSendToAgent={workbench?.sendToAgent?lines=>workbench.sendToAgent?.({projectId:item.projectId,worktreePath:item.worktreePath,...lines}):undefined}
      onOpenHistory={workbench?.openHistory?target=>workbench.openHistory?.({projectId:item.projectId,worktreePath:item.worktreePath,...target}):undefined}
      initialPath={item.path}
      initialView={item.kind}
      assetKind={item.assetKind}
      editorId={editorId(node.id, item)}
      ownerSessionId={item.ownerSessionId}
      sessionDocuments={workbench?.sessionDocuments && item.projectId === workbench.sessionDocuments.projectId && sameCanonicalScope(item.worktreePath ?? workbench.sessionDocuments.projectRoot, workbench.sessionDocuments.rootPath) ? workbench.sessionDocuments : undefined}
      previewNavigation={item.ownerSessionId?{
        activeId:item.id,
        files:workspaceTabs(layout).flatMap(candidate=>isFileTab(candidate.tab)&&candidate.tab.ownerSessionId===item.ownerSessionId?[{id:candidate.tab.id,path:candidate.tab.path,kind:candidate.tab.kind}]:[]),
        onSelect:id=>{const target=workspaceTabs(layout).find(candidate=>candidate.tab.id===id&&candidate.tab.kind!=='session'&&candidate.tab.ownerSessionId===item.ownerSessionId);if(target)onActivateTab({paneId:target.paneId,tabId:id});},
        onClose:()=>onCloseFile({paneId:node.id,tabId:item.id}),closing:closing||!active,
      }:undefined}
      reveal={fileReveal?.tabId===item.id?fileReveal:undefined}
      embedded
      onOpenPath={onOpenPath?(path,kind)=>onOpenPath({projectId:item.projectId,worktreePath:item.worktreePath,path,kind,assetKind:path===item.path?item.assetKind:undefined,ownerSessionId:item.ownerSessionId}):undefined}
    />
  ) : null}
    </div></SessionSurfaceContext.Provider>;
  });
  const tabLabel = (item: ContentRef) => item.kind === "session"
    ? sessions.find(candidate => candidate.id === item.sessionId)?.title ?? (zh?"终端":"Terminal")
    : item.kind==='map'?`${zh?'任务图':'Task map'} · ${sessions.find(candidate=>candidate.id===item.sessionId)?.title??item.sessionId}`:contentTitle(item, zh).label;
  const browserTabs=node.tabs.filter((item):item is Extract<ContentRef,{kind:'web'}>=>item.kind==='web');
  const browserLabel=(item:Extract<ContentRef,{kind:'web'}>)=>{
   if(item.url===BROWSER_NEW_TAB_URL)return zh?'新标签页':'New tab';
   const runtime=previewLabels?.get(item.id), title=browserTitles.get(item.id)??item.title??runtime?.observedTitle??runtime?.title;
   if(title)return title;
   try{const parsed=new URL(item.url);return `${parsed.host}${parsed.pathname==='/'?'':parsed.pathname}${parsed.search}`;}catch{return item.url;}
  };
  const browserTitle=(item:Extract<ContentRef,{kind:'web'}>)=>{
   if(item.url===BROWSER_NEW_TAB_URL)return zh?'新标签页':'New tab';
   const runtime=previewLabels?.get(item.id), owner=runtime?.sessionId?sessions.find(candidate=>candidate.id===runtime.sessionId):undefined;
   return `${item.url}${owner?` — ${owner.title} (${owner.provider})`:''}`;
  };
  const browserKeys=(event:React.KeyboardEvent<HTMLButtonElement>)=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();const tabs=Array.from(event.currentTarget.closest('[role=tablist]')!.querySelectorAll<HTMLButtonElement>('[role=tab]'));
   const index=tabs.indexOf(event.currentTarget),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
   tabs[next]?.focus();tabs[next]?.click();
  };
  const browserMenu=(item:Extract<ContentRef,{kind:'web'}>,event:React.MouseEvent<HTMLElement>)=>{
   event.preventDefault();const target={paneId:node.id,tabId:item.id};
   showContextMenu({x:event.clientX,y:event.clientY,restoreFocus:event.currentTarget,items:(['current','others','all'] as const).map(mode=>({id:`browser-tab-close-${mode}`,label:zh?({current:'关闭当前页面',others:'关闭其他页面',all:'关闭所有页面'}[mode]):({current:'Close page',others:'Close other pages',all:'Close all pages'}[mode]),disabled:mode==='others'&&browserTabs.length<2,onSelect:()=>onCloseTabs(target,mode)}))});
  };
  return (
    <SessionSurfaceContext.Provider value={{primaryHost,menuHost,focused:selected,openFile:session&&onFileReference?reference=>onFileReference(session.id,reference):undefined,...sessionDiffActions(session,projectPath,onOpenPath),openWeb:workbench?.openWeb?openWeb:undefined}}>
    <section data-pane-id={node.id} hidden={!visibleNode} inert={!visibleNode} style={style} className={`workspace-pane ws-pane ${fullscreen ? "fullscreen" : ""}${selected ? " selected" : ""}`} onPointerDown={event=>{if(event.currentTarget.contains(event.target as Node))onFocus();}}>
       {session&&tab&&<div className="pane-identity"><AgentIcon provider={session.provider}/><span title={tabLabel(tab)}>{tabLabel(tab)}</span></div>}
       {browserTabs.length>0&&<div className="browser-page-tabs" ref={browserStrip} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&!event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='t'){event.preventDefault();event.stopPropagation();addBrowserTab();}}} role="tablist" aria-label={zh?'浏览器页面':'Browser pages'}>{browserTabs.map(item=>{const label=browserLabel(item),title=browserTitle(item),active=item.id===tab?.id,provider=previewLabels?.get(item.id)?.sessionId?sessions.find(candidate=>candidate.id===previewLabels.get(item.id)?.sessionId)?.provider:undefined;return <div className={`browser-page-tab${active?' active':''}`} key={item.id} onContextMenu={event=>browserMenu(item,event)}><button type="button" id={`browser-tab-${node.id}-${item.id}`} role="tab" aria-selected={active} aria-controls={`browser-panel-${node.id}-${item.id}`} tabIndex={active?0:-1} title={title} aria-label={title} onKeyDown={browserKeys} onClick={event=>{onActivateTab({paneId:node.id,tabId:item.id});revealBrowserTab(event.currentTarget.closest('.browser-page-tab'));}}>{browserIcons.get(item.id)?.loading?<span className="browser-page-loading" aria-hidden="true"/>:browserIcons.get(item.id)?.favicon?<img className="browser-page-favicon" src={browserIcons.get(item.id)!.favicon} width={16} height={16} alt="" aria-hidden="true" onError={event=>{const failed=event.currentTarget.getAttribute('src');setBrowserIcons(current=>{const icon=current.get(item.id);return icon?.favicon===failed?new Map(current).set(item.id,{loading:icon.loading}):current;});}}/>:<Icon name="globe"/>}<span className="browser-page-tab-title">{label}</span>{provider&&<small>{provider}</small>}</button><button type="button" className="browser-page-tab-close" aria-label={zh?`关闭页面 ${label}`:`Close page ${label}`} title={zh?'关闭页面':'Close page'} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onCloseTab({paneId:node.id,tabId:item.id});}}><Icon name="close"/></button></div>;})}<span className="browser-page-new-tab-slot"><button type="button" className="browser-page-new-tab" aria-label={zh?'新标签页':'New tab'} title={zh?'新标签页':'New tab'} onClick={addBrowserTab}><Icon name="plus"/></button></span></div>}
      <SurfaceActions slot="menu">
        <button type="button" className="menu-item" onClick={onToggleFullscreen}><Icon name="panel"/>{fullscreen?(zh?'退出窗格全屏':'Restore pane'):(zh?'全屏窗格':'Fullscreen pane')}</button>
        <button type="button" className="menu-item" disabled={paneLimit} title={paneLimit?(zh?'最多 4 个窗格':'Up to 4 panes'):undefined} onClick={()=>split('horizontal')}><Icon name="split"/>{zh?'左右拆分':'Split right'}</button>
        <button type="button" className="menu-item" disabled={paneLimit} onClick={()=>split('vertical')}><Icon name="split" style={{transform:'rotate(90deg)'}}/>{zh?'上下拆分':'Split down'}</button>
        {session && !session.readOnly && (
          <button type="button" className="menu-item" onClick={() => void openWindow({ sessionId: session.id }).catch((error) => setIssue(error instanceof Error ? error.message : String(error)))}>
            <Icon name="popout" />{zh?'弹出为浮窗':'Open floating window'}
          </button>
        )}
        {session?.mode==='chat' && !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status) && (
          <button className="menu-item danger"
            onClick={() =>
              void request("session.stop", {
                sessionId: session.id,
                operationId: operationId(),
              }).then(() => onSessionChanged?.()).catch((error) =>
                setIssue(
                  error instanceof Error
                    ? error.message
                    : (zh?"无法结束会话，当前视图已保留。":"Unable to end session; this view remains open."),
                ),
              )
            }
          >
            {zh?"结束会话进程":"End session process"}
          </button>
        )}
        <button
          className="menu-item"
          disabled={lastPane}
          aria-label={zh?"关闭窗格":"Close pane"}
          title={lastPane ? (zh?"至少保留一个窗格":"Keep at least one pane") : (zh?"关闭窗格":"Close pane")}
          onClick={onClosePane}
        ><Icon name="close" />{zh?'关闭窗格':'Close pane'}</button>
      </SurfaceActions>
      {issue && <p className="surface-error">{issue}</p>}
      <div className="pane-body">{empty}{content}</div>
    </section>
    </SessionSurfaceContext.Provider>
  );
}
