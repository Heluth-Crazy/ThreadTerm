import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GitStatus, Session } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { Icon } from './PrototypeIcon';
import { ExplorerView } from './ExplorerView';
import { SearchView } from './SearchView';
import { SourceControlView } from './SourceControlView';
import { AgentChangesView } from './AgentChangesView';
import { workbenchError } from '../workbench/errors';
import { FILES_CHANGED_EVENT, scopeParams, type GitState, type WorkbenchActions, type WorkbenchScope } from '../workbench/types';
import { createRefreshQueue, type RefreshQueue } from '../workbench/refreshQueue';
import { eventTouchesWorktree } from '../workbench/refreshTriggers';
import '../workbench/workbench.css';
import './panel-headers.css';

export type WorkbenchView = 'files'|'search'|'scm'|'changes';
export type WorkbenchCommand = { view:WorkbenchView|'toggle'; key:string };
// Only the last view and the width are remembered. The panel starts closed whenever the workspace opens: a session
// opens as just a session, and the panel appears only when a view is chosen (user decision 2026-09-28).
type Stored = { view:WorkbenchView; width:number };
const STORAGE_KEY = 'threadterm.workbench.sidebar';
const MIN_WIDTH = 220, MAX_WIDTH = 520;

function readStored():Stored {
 try {
  const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Stored>;
  return {
   view:['files', 'search', 'scm', 'changes'].includes(String(value.view)) ? value.view as WorkbenchView : 'files',
   width:Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(value.width) || 280)),
  };
 } catch { return {view:'files', width:280}; }
}

/** Shared Git status for the side bar, refreshed only when this worktree can have changed: this app's own Git
 * and file actions, an agent turn or terminal run finishing in the scope, window focus, the panel becoming visible
 * and the explicit Refresh button. There is no timer, so an open panel costs nothing while nothing happens; bursts
 * coalesce into one request with at most one waiting behind it. */
export function useGitStatus(scope:Pick<WorkbenchScope,'projectId'|'worktreePath'>, active:boolean, zh:boolean, sessionIds:readonly string[] = []):GitState {
 const [status, setStatus] = useState<GitStatus>();
 const [error, setError] = useState<string>();
 const [loading, setLoading] = useState(false);
 const scopeKey = `${scope.projectId}\0${scope.worktreePath ?? ''}`;
 const key = useRef(scopeKey); key.current = scopeKey;
 // Sessions of this worktree: their turns and terminal runs are the only hint that an agent changed files.
 const sessions = useRef(new Set(sessionIds)); sessions.current = new Set(sessionIds);
 const queue = useRef<RefreshQueue|undefined>(undefined);
 const load = useCallback(() => {
  const requested = scopeKey;
  setLoading(true);
  return request('git.status', scopeParams(scope))
   .then(value => { if(key.current === requested) { setStatus(value); setError(undefined); } })
   .catch(failure => { if(key.current === requested) { setStatus(undefined); setError(workbenchError(failure, zh)); } })
   .finally(() => { if(key.current === requested) setLoading(false); });
 }, [scopeKey, zh]);
 const loadRef = useRef(load); loadRef.current = load;
 const refresh = useCallback(() => queue.current ? queue.current.request() : loadRef.current(), []);
 // A closed panel still reads once per scope (badge); an open one reads through its queue below, so a new scope
 // never costs two `git.status` calls.
 useEffect(() => { setStatus(undefined); setError(undefined); if(!active) void load(); }, [scopeKey]);
 useEffect(() => {
  if(!active) return;
  const requests = createRefreshQueue(() => loadRef.current());
  queue.current = requests;
  const trigger = () => { void requests.request(); };
  const shown = () => { if(document.visibilityState === 'visible') trigger(); };
  const unsubscribe = subscribeEvents(event => { if(eventTouchesWorktree(event, {projectId:scope.projectId, worktreePath:scope.worktreePath}, sessions.current)) trigger(); });
  addEventListener('focus', trigger); addEventListener('visibilitychange', shown); addEventListener(FILES_CHANGED_EVENT, trigger);
  // Opening the panel is itself an invalidation: the status may have drifted while it was closed.
  trigger();
  return () => {
   requests.stop(); if(queue.current === requests) queue.current = undefined;
   unsubscribe(); removeEventListener('focus', trigger); removeEventListener('visibilitychange', shown); removeEventListener(FILES_CHANGED_EVENT, trigger);
  };
 }, [active, scope.projectId, scope.worktreePath]);
 return {status, error, loading, refresh};
}

/**
 * View switcher + panel. The switcher is portalled to the start of the session tab bar row and the
 * panel renders in place, as a card in the same row as the panes (same top, bottom and radius).
 */
export function WorkbenchSideBar({scope, actions, sessions, activeSessionId, activePath, command, switcherHost, zh}:{
 scope:WorkbenchScope; actions:WorkbenchActions; sessions:Session[]; activeSessionId?:string; activePath?:string; command?:WorkbenchCommand; switcherHost?:HTMLElement|null; zh:boolean;
}) {
 const [stored, setStored] = useState(readStored);
 const [open, setOpen] = useState(false);
 const [visited, setVisited] = useState<Set<WorkbenchView>>(() => new Set([stored.view]));
 const [focusKey, setFocusKey] = useState<string>();
 const [actionsHost, setActionsHost] = useState<HTMLDivElement|null>(null);
 const git = useGitStatus(scope, open, zh, sessions.filter(session => session.projectId === scope.projectId && (session.worktreePath ?? '') === (scope.worktreePath ?? '')).map(session => session.id));
 const text = (en:string, cn:string) => zh ? cn : en;
 const update = (patch:Partial<Stored>) => setStored(current => {
  const next = {...current, ...patch};
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage full or disabled: keep in memory */ }
  return next;
 });
 const select = (view:WorkbenchView, focus = false) => {
  setVisited(current => current.has(view) ? current : new Set([...current, view]));
  // Clicking the active view collapses the panel, as in VS Code/Cursor.
  if(!focus && open && stored.view === view) setOpen(false);
  else { update({view}); setOpen(true); }
  if(focus) setFocusKey(crypto.randomUUID());
 };
 useEffect(() => {
  if(!command) return;
  if(command.view === 'toggle') setOpen(value => !value);
  else select(command.view, true);
 }, [command?.key]);
 const resize = (event:ReactPointerEvent<HTMLDivElement>) => {
  event.preventDefault();
  const start = event.clientX, width = stored.width, target = event.currentTarget;
  target.setPointerCapture(event.pointerId);
  const move = (next:PointerEvent) => update({width:Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + next.clientX - start))});
  const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
 };
 const changeCount = git.status?.changes.length ?? 0;
 const views:{id:WorkbenchView;icon:string;label:string;shortcut:string;badge?:number}[] = [
  {id:'files', icon:'file', label:text('Files', '文件'), shortcut:'Ctrl+Shift+E'},
  {id:'search', icon:'search', label:text('Search', '搜索'), shortcut:'Ctrl+Shift+F'},
  {id:'scm', icon:'branch', label:text('Source Control', '源代码管理'), shortcut:'Ctrl+Shift+G', badge:changeCount || undefined},
  {id:'changes', icon:'spark', label:text('Agent changes', 'Agent 改动'), shortcut:''},
 ];
 const current = views.find(view => view.id === stored.view)!;
 const switcher = <nav className="wb-switcher" aria-label={text('Workbench views', '侧栏视图')}>
  {views.map(view => <button key={view.id} type="button" className={`wb-switch-btn${open && stored.view === view.id ? ' active' : ''}`}
   aria-pressed={open && stored.view === view.id} aria-label={view.label}
   title={`${view.label}${view.shortcut ? ` (${view.shortcut})` : ''}${open && stored.view === view.id ? text(' · click to hide the side bar (Ctrl+B)', ' · 再次点击隐藏侧栏（Ctrl+B）') : ''}`}
   onClick={() => select(view.id)}>
   <Icon name={view.icon}/>{view.badge ? <span className="wb-switch-badge">{view.badge > 99 ? '99+' : view.badge}</span> : null}
  </button>)}
 </nav>;
 return <>
  {switcherHost ? createPortal(switcher, switcherHost) : switcher}
  {open && <aside className="wb-sidebar" style={{width:stored.width}} aria-label={text('Workbench', '工作台侧栏')}>
   <section className="wb-panel" aria-label={current.label}>
    <header className="wb-panel-head"><strong>{current.label}</strong><div className="wb-panel-actions" ref={setActionsHost}/>
     <button type="button" className="icon-btn wb-panel-close" title={text('Close side bar (Ctrl+B)', '关闭侧栏（Ctrl+B）')} aria-label={text('Close side bar', '关闭侧栏')} onClick={() => setOpen(false)}><Icon name="close"/></button></header>
    <div className="wb-panel-body">
     {visited.has('files') && <div className="wb-view" hidden={stored.view !== 'files'}><ExplorerView scope={scope} actions={actions} git={git} zh={zh} activePath={activePath} focusKey={stored.view === 'files' ? focusKey : undefined} toolbarHost={stored.view === 'files' ? actionsHost : undefined}/></div>}
     {visited.has('search') && <div className="wb-view" hidden={stored.view !== 'search'}><SearchView scope={scope} actions={actions} zh={zh} focusKey={stored.view === 'search' ? focusKey : undefined}/></div>}
     {visited.has('scm') && <div className="wb-view" hidden={stored.view !== 'scm'}><SourceControlView scope={scope} actions={actions} git={git} zh={zh} toolbarHost={stored.view === 'scm' ? actionsHost : undefined}/></div>}
     {visited.has('changes') && <div className="wb-view" hidden={stored.view !== 'changes'}><AgentChangesView sessions={sessions} activeSessionId={activeSessionId} actions={actions} zh={zh} visible={stored.view === 'changes'} toolbarHost={stored.view === 'changes' ? actionsHost : undefined}/></div>}
    </div>
   </section>
   <div className="wb-resize" role="separator" aria-orientation="vertical" aria-label={text('Resize side bar', '调整侧栏宽度')} aria-valuenow={stored.width} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} tabIndex={0} onPointerDown={resize}
    onKeyDown={event => { if(event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); update({width:Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stored.width + (event.key === 'ArrowLeft' ? -16 : 16)))}); } }}/>
  </aside>}
 </>;
}
