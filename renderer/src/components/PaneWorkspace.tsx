import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from 'react-dom';
import type { ContentRef, FileReference, PaneLayout, ProviderCapability, Session } from "@threadterm/protocol";
import { confirmCloseEditors } from "../dirtyEditors";
import { useTranslation } from "../i18n";
import {
  splitPane,
  activate,
  reorderTab,
  resizeSplit,
  paneCount,
  paneIdsIn,
} from "../workspaceLayout";
import { openWindow, operationId, request } from "../bridge";
import { TerminalSurface } from "./TerminalSurface";
import { ChatView } from "./ChatView";
import { FileWorkspace } from "./FileWorkspace";
import { GitHistoryView } from "./GitHistoryView";
import { ReviewDiffView } from "./ReviewDiffView";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { ImportedHistoryView } from "./ImportedHistoryView";
import { CatalogPopover } from './CatalogActions';
import { WorkspaceTabBar } from './WorkspaceTabBar';
import { SessionSurfaceContext, SurfaceActions } from './SessionSurfaceContext';
import { contentTitle, focusedWorkspaceTab, isFileTab, tabCloseTargets, workspaceTabs, type WorkspaceTabTarget } from '../workspaceTabs';
import { paneGeometry, paneRectStyle, PANE_GAP, PANE_DIVIDER_SIZE } from '../paneGeometry';
import { fileSelectionKey, visibleSessionLayout, workspaceNavigationLayout, workspaceNavigationTarget, withSessionCompanions, removeClosedViews } from '../sessionFileViews';
import "./workspace-parity.css";

type Props = {
  layout: PaneLayout;
  sessions: Session[];
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
  workbench?:PaneWorkbench;
};
/** Host callbacks for workbench content inside panes; absent → panes behave as before. */
export type PaneWorkbench = {
  sendToAgent?:(target:{projectId:string;worktreePath?:string;path:string;startLine?:number;endLine?:number})=>void;
  openHistory?:(target:{projectId:string;worktreePath?:string;path?:string;commit?:string})=>void;
  openFile?:(target:{projectId:string;worktreePath?:string;path:string})=>void;
  /** One-shot request to select a commit in a history tab (blame click). */
  historyFocus?:{tabId:string;commit:string;key:string};
};
export function PaneWorkspace({ layout, sessions, onChange, theme, terminalCompatibility, providers = [], onSessionChanged, onOpenSession, ownerSessionId, onPickSession,toolbarHost,onEmpty,onActiveSession,onInteraction,onFileReference,focusTarget,fileReveal,onOpenPath,workbench }: Props) {
  const zh=useTranslation().locale==='zh-CN';
  const [selectedPaneId, setSelectedPaneId] = useState<string|undefined>(focusTarget?.paneId);
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string>();
  const [resumedSessionIds, setResumedSessionIds] = useState<Set<string>>(() => new Set());
  const [primaryHost,setPrimaryHost]=useState<HTMLDivElement|null>(null),[menuHost,setMenuHost]=useState<HTMLDivElement|null>(null);
  const [menuAnchor,setMenuAnchor]=useState<HTMLElement>(),[closing,setClosing]=useState(false),[closeIssue,setCloseIssue]=useState<string>();
  const closingRef=useRef(false),latest=useRef(layout);latest.current=layout;
  const fileSelections=useRef(new Map<string,string>());
  const visibleLayout=visibleSessionLayout(layout,ownerSessionId,fileSelections.current);
  const navigationLayout=workspaceNavigationLayout(layout);
  const latestVisible=useRef(visibleLayout);latestVisible.current=visibleLayout;
  useEffect(()=>{for(const item of workspaceTabs(visibleLayout))if(item.active&&item.tab.kind!=='session'&&ownerSessionId&&item.tab.ownerSessionId===ownerSessionId)fileSelections.current.set(fileSelectionKey(ownerSessionId,item.paneId),item.tab.id);},[visibleLayout,ownerSessionId]);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const focused=focusedWorkspaceTab(visibleLayout,selectedPaneId);
  const focusPaneId=selectedPaneId&&paneIdsIn(visibleLayout).includes(selectedPaneId)?selectedPaneId:focused?.paneId;
  const latestFocus=useRef(focusPaneId);latestFocus.current=focusPaneId;
  const activeSession=focused?.tab.kind==='session'?focused.tab.sessionId:undefined;
  const activeCallback=useRef(onActiveSession);activeCallback.current=onActiveSession;
  useEffect(()=>{if(activeSession)activeCallback.current?.(activeSession);},[activeSession]);
  useEffect(()=>{if(focusTarget){setSelectedPaneId(focusTarget.paneId);setFullscreenPaneId(current=>current&&current!==focusTarget.paneId?undefined:current);}},[focusTarget]);
  const commit=(next:PaneLayout)=>{latest.current=next;onChange(next);};
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
  const closeTabs=async(target:WorkspaceTabTarget,mode:'current'|'others'|'all',companion=false)=>{
   onInteraction?.();
   if(closingRef.current)return;closingRef.current=true;setClosing(true);setCloseIssue(undefined);
   activation.current++;
   const targets=withSessionCompanions(latest.current,tabCloseTargets(companion?latestVisible.current:workspaceNavigationLayout(latest.current),target,mode));
   const editors=workspaceTabs(latest.current).filter(item=>item.tab.kind!=='session'&&targets.some(t=>t.paneId===item.paneId&&t.tabId===item.tab.id)).map(item=>editorId(item.paneId,item.tab));
   try{
    if(!await confirmCloseEditors(editors)||!mounted.current)return;
    const next=removeClosedViews(latest.current,targets,latestFocus.current);
    if(next.blocked){setCloseIssue(zh?'确认期间打开了新的关联文件，请重新关闭。':'A new related file opened during confirmation. Please close again.');return;}
    commit(next.layout);setSelectedPaneId(next.focusedPaneId);
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
    commit(next.layout);setSelectedPaneId(next.focusedPaneId);
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
  const geometry = paneGeometry(visibleLayout);
  // Keep leaf surfaces at one stable React ancestry. Nesting the Pane inside
  // Split unmounts it whenever a split is inserted/collapsed, even with a key.
  const panes = paneGeometry(layout).panes.map(({node}) => {
    const visible=geometry.panes.find(pane=>pane.node.id===node.id);
    return (
      <Pane
        key={node.id}
        node={node}
        visibleNode={visible?.node}
        style={fullscreenPaneId === node.id || !visible ? undefined : paneRectStyle(visible.rect)}
        sessions={sessions}
        theme={theme}
        terminalCompatibility={terminalCompatibility}
        onChange={commit}
        layout={layout}
        selected={Boolean(visible)&&focusPaneId === node.id}
        fullscreen={fullscreenPaneId === node.id}
        onFocus={() => {activation.current++;onInteraction?.();setSelectedPaneId(node.id);}}
        onToggleFullscreen={() => setFullscreenPaneId(current => current === node.id ? undefined : node.id)}
        onSplit={(paneId) => {onInteraction?.();setSelectedPaneId(paneId);}}
        onClosePane={()=>void closeWorkspacePane(node.id)}
        onPickSession={onPickSession}
        onSessionChanged={onSessionChanged}
        onOpenSession={onOpenSession}
        providers={providers}
        closing={closing}
        onActivateTab={target=>void activateTab(target)}
        onCloseFile={target=>void closeTabs(target,'current',true)}
        resumedSessionIds={resumedSessionIds}
        onResumed={(sessionId) => setResumedSessionIds(current => new Set(current).add(sessionId))}
        primaryHost={primaryHost} menuHost={menuHost} onFileReference={onFileReference} fileReveal={fileReveal} onOpenPath={onOpenPath} workbench={workbench}
      />
    );});
  const companionFiles=workspaceTabs(visibleLayout).filter(item=>item.tab.kind!=='session'&&item.tab.ownerSessionId===ownerSessionId&&Boolean(ownerSessionId));
  const toolbar=<WorkspaceTabBar layout={navigationLayout} sessions={sessions} active={workspaceNavigationTarget(layout,focused)} busy={closing}
   onActivate={target=>void activateTab(target)}
   onClose={(target,mode)=>void closeTabs(target,mode)} onReorder={(paneId,from,to)=>{const visible=workspaceTabs(workspaceNavigationLayout(latest.current)).filter(item=>item.paneId===paneId);const all=workspaceTabs(latest.current).filter(item=>item.paneId===paneId);const source=all.findIndex(item=>item.tab.id===visible[from]?.tab.id),destination=all.findIndex(item=>item.tab.id===visible[to]?.tab.id);if(source>=0&&destination>=0)commit(reorderTab(latest.current,paneId,source,destination));}}>
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
      <div className="pane-grid" style={{'--pane-gap':`${PANE_GAP}px`,'--pane-divider-size':`${PANE_DIVIDER_SIZE}px`} as CSSProperties}>
        {geometry.splits.map(({node,rect})=><Split key={node.id} node={node} root={layout} style={paneRectStyle(rect)} onChange={commit}/>)}
        {panes}
      </div>
    </section>
  );
}
function Split({
  node,
  root,
  style,
  onChange,
}: {
  node: Extract<PaneLayout, { kind: "split" }>;
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
    const vertical = node.direction === "vertical";
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
      className={`pane-split ${node.direction}`}
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
          grabOffset.current = node.direction === "vertical"
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
  theme,
  terminalCompatibility,
  onChange,
  layout,
  selected,
  fullscreen,
  onFocus,
  onToggleFullscreen,
  onSplit,
  onClosePane,
  onPickSession,
  onSessionChanged,
  onOpenSession,
  providers,
  resumedSessionIds,
  onResumed,
  closing,onActivateTab,onCloseFile,
  primaryHost,menuHost,onFileReference,fileReveal,onOpenPath,workbench,
}: {
  node: Extract<PaneLayout, { kind: "pane" }>;
  visibleNode?: Extract<PaneLayout, { kind: "pane" }>;
  style?: CSSProperties;
  sessions: Session[];
  theme: "light" | "dark";
  terminalCompatibility: unknown;
  onChange: (next: PaneLayout) => void;
  layout: PaneLayout;
  selected: boolean;
  fullscreen: boolean;
  onFocus: () => void;
  onToggleFullscreen: () => void;
  onSplit: (paneId: string) => void;
  onClosePane:()=>void;
  onPickSession?: (paneId: string) => void;
  onSessionChanged?: () => void;
  onOpenSession?: (sessionId: string) => void;
  providers: ProviderCapability[];
  resumedSessionIds: Set<string>;
  onResumed: (sessionId: string) => void;
  closing:boolean;
  onActivateTab:(target:WorkspaceTabTarget)=>void;
  onCloseFile:(target:WorkspaceTabTarget)=>void;
  primaryHost:HTMLElement|null;menuHost:HTMLElement|null;
  onFileReference?:(sessionId:string,reference:FileReference)=>void;
  fileReveal?:{tabId:string;line:number;column?:number;key:string};
  onOpenPath?:(file:{projectId:string;worktreePath?:string;path:string;kind:'file'|'diff'|'preview';assetKind?:'text'|'image';ownerSessionId?:string})=>void;
  workbench?:PaneWorkbench;
}) {
  const {locale}=useTranslation();const zh=locale==="zh-CN";
  const tab =
    visibleNode?.tabs.find((item) => item.id === visibleNode.activeTabId) ?? visibleNode?.tabs[0];
  const visited=useRef(new Set<string>());
  if(tab)visited.current.add(tab.id);
  for(const id of visited.current)if(!node.tabs.some(item=>item.id===id))visited.current.delete(id);
  const [issue, setIssue] = useState<string>();
  const session =
    tab?.kind === "session"
      ? sessions.find((item) => item.id === tab.sessionId)
      : undefined;
  const paneLimit = paneCount(layout) >= 4;
  const lastPane = paneCount(layout) === 1;
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
    return <SessionSurfaceContext.Provider key={item.id} value={{primaryHost,menuHost,focused:selected&&active,openFile:itemSession&&onFileReference?reference=>onFileReference(itemSession.id,reference):undefined}}>
    <div className="pane-tab-surface" data-content-id={item.id} hidden={!active} inert={!active}>
    {itemSession?.readOnly && !resumedSessionIds.has(itemSession.id) ? (
    <ImportedHistoryView session={itemSession} onResumed={() => onResumed(itemSession.id)} />
  ) : itemSession ? (
    itemSession.mode === "terminal" ? (
      <TerminalSurface sessionId={itemSession.id} provider={itemSession.provider} session={itemSession} theme={theme} terminalCompatibility={terminalCompatibility} resumeCapture={providers.find((candidate) => candidate.id === itemSession.provider)?.terminalResumeCapture} onChanged={onSessionChanged} onOpenSession={onOpenSession} />
    ) : (
      <ChatView session={itemSession} delegates={sessions.filter(candidate => candidate.delegation?.parentSessionId === itemSession.id)} delegatedBy={itemSession.delegation ? sessions.find(candidate => candidate.id === itemSession.delegation?.parentSessionId) : undefined} onOpenSession={onOpenSession} />
    )
  ) : item.kind === "history" ? (
    <GitHistoryView projectId={item.projectId} worktreePath={item.worktreePath} path={item.path} zh={zh}
      focusCommit={workbench?.historyFocus?.tabId===item.id?workbench.historyFocus.commit:undefined}
      onOpenFile={workbench?.openFile?path=>workbench.openFile?.({projectId:item.projectId,worktreePath:item.worktreePath,path}):undefined}/>
  ) : item.kind === "review" ? (
    <ReviewDiffView projectId={item.projectId} worktreePath={item.worktreePath} path={item.path} sessionId={item.sessionId}
      checkpointId={item.checkpointId} toCheckpointId={item.toCheckpointId} editorId={editorId(node.id, item)} zh={zh}
      onOpenFile={workbench?.openFile?path=>workbench.openFile?.({projectId:item.projectId,worktreePath:item.worktreePath,path}):undefined}/>
  ) : isFileTab(item) ? (
    <FileWorkspace
      projectId={item.projectId}
      worktreePath={item.worktreePath}
      initialStaged={item.kind === "diff" ? item.staged : undefined}
      onSendToAgent={workbench?.sendToAgent?lines=>workbench.sendToAgent?.({projectId:item.projectId,worktreePath:item.worktreePath,...lines}):undefined}
      onOpenHistory={workbench?.openHistory?target=>workbench.openHistory?.({projectId:item.projectId,worktreePath:item.worktreePath,...target}):undefined}
      initialPath={item.path}
      initialView={item.kind}
      assetKind={item.assetKind}
      editorId={editorId(node.id, item)}
      ownerSessionId={item.ownerSessionId}
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
    : contentTitle(item, zh).label;
  return (
    <SessionSurfaceContext.Provider value={{primaryHost,menuHost,focused:selected,openFile:session&&onFileReference?reference=>onFileReference(session.id,reference):undefined}}>
    <section data-pane-id={node.id} hidden={!visibleNode} inert={!visibleNode} style={style} className={`workspace-pane ws-pane ${fullscreen ? "fullscreen" : ""}${selected ? " selected" : ""}`} onPointerDown={event=>{if(event.currentTarget.contains(event.target as Node))onFocus();}}>
      {!lastPane&&session&&tab&&<div className="pane-identity"><AgentIcon provider={session.provider}/><span>{tabLabel(tab)}</span></div>}
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
