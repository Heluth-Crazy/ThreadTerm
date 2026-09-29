import type { PaneLayout, Session, Snapshot } from '@threadterm/protocol';
import { canonicalScopePath } from './projectScope';
import { removeWorkspaceTabs, workspaceTabs, type WorkspaceTab, type WorkspaceTabTarget } from './workspaceTabs';
import { closePane, paneCount, paneIdsIn } from './workspaceLayout';

export function fileSelectionKey(owner: string | undefined, paneId: string): string {
  return JSON.stringify([owner, paneId]);
}

export function visibleSessionLayout(layout: PaneLayout, owner: string | undefined, selections: ReadonlyMap<string, string> = new Map()): PaneLayout {
  if (!owner) return layout;
  function visit(node: PaneLayout): PaneLayout | undefined {
    if (node.kind === 'split') {
      const first = visit(node.first), second = visit(node.second);
      if (!first) return second;
      if (!second) return first;
      return first === node.first && second === node.second ? node : {...node, first, second};
    }
    const tabs = node.tabs.filter(tab => tab.kind === 'session' || !tab.ownerSessionId || tab.ownerSessionId === owner);
    // Preserve intentionally empty panes, but don't leave blank columns for another session's files.
    if (!tabs.length && node.tabs.length) return undefined;
    const remembered = selections.get(fileSelectionKey(owner, node.id));
    const activeTabId = tabs.some(tab => tab.id === node.activeTabId) ? node.activeTabId
      : tabs.find(tab => tab.id === remembered)?.id ?? tabs[0]?.id ?? null;
    return tabs.length === node.tabs.length && activeTabId === node.activeTabId ? node : {...node, tabs, activeTabId};
  }
  // A completely file-only workspace may temporarily have no visible tab.
  return visit(layout) ?? {kind: 'pane', id: 'session-files-empty', tabs: [], activeTabId: null};
}

/** Companion previews live inside a session; independently opened files stay in the top bar. */
export function workspaceNavigationLayout(layout: PaneLayout): PaneLayout {
  if (layout.kind === 'split') {
    return {...layout, first: workspaceNavigationLayout(layout.first), second: workspaceNavigationLayout(layout.second)};
  }
  const tabs = layout.tabs.filter(tab => tab.kind === 'session' || !tab.ownerSessionId);
  return {...layout, tabs, activeTabId: tabs.some(tab => tab.id === layout.activeTabId) ? layout.activeTabId : null};
}

export function workspaceNavigationTarget(layout: PaneLayout, focused?: WorkspaceTab): WorkspaceTabTarget | undefined {
  if (!focused) return undefined;
  const owner = focused.tab.kind !== 'session' ? focused.tab.ownerSessionId : undefined;
  const target = owner ? workspaceTabs(layout).find(item => item.tab.kind === 'session' && item.tab.sessionId === owner) : focused;
  return target ? {paneId: target.paneId, tabId: target.tab.id} : undefined;
}

/** Capture companions before prompting, so later opens cannot be swept into an old close. */
export function withSessionCompanions(layout: PaneLayout, targets: readonly WorkspaceTabTarget[]): WorkspaceTabTarget[] {
  const tabs = workspaceTabs(layout);
  const has = (item: WorkspaceTab) => targets.some(target => target.paneId === item.paneId && target.tabId === item.tab.id);
  const sessions = new Set(tabs.flatMap(item => item.tab.kind === 'session' && has(item) ? [item.tab.sessionId] : []));
  return [...targets, ...tabs.filter(item => item.tab.kind !== 'session' && item.tab.ownerSessionId && sessions.has(item.tab.ownerSessionId) && !has(item))
    .map(item => ({paneId: item.paneId, tabId: item.tab.id}))];
}

/** Prune only emptied companion columns / the explicitly closed pane, never new or hidden views. */
export function removeClosedViews(layout: PaneLayout, targets: readonly WorkspaceTabTarget[], focusedPaneId?: string, closingPaneId?: string): {layout: PaneLayout; focusedPaneId?: string; blocked?: boolean} {
  // A late companion cannot be discarded without confirmation or orphaned by deleting its owner.
  if (withSessionCompanions(layout, targets).length > targets.length) return {layout, focusedPaneId, blocked: true};
  const next = removeWorkspaceTabs(layout, targets, focusedPaneId);
  // Closing the last tab of a pane closes the pane (user request 2026-09-28), whatever the tab was: session,
  // companion, or a file/diff/history/review view opened from the side bar. Panes that were already empty (a fresh
  // split waiting for a session) are not touched, and the root pane stays so the caller can leave the workspace.
  const emptied = new Set(targets.map(target => target.paneId));
  if (closingPaneId) emptied.add(closingPaneId);
  for (const paneId of emptied) {
    if (!workspaceTabs(next.layout).some(item => item.paneId === paneId)) next.layout = closePane(next.layout, paneId) ?? next.layout;
  }
  if (next.focusedPaneId && !paneIdsIn(next.layout).includes(next.focusedPaneId))
    next.focusedPaneId = workspaceTabs(next.layout).find(item => item.active)?.paneId ?? paneIdsIn(next.layout)[0];
  return next;
}

/** Reuse a file-only column, but never cover another session when split capacity is exhausted. */
export function fileViewPlacement(layout: PaneLayout, ownerSessionId: string | undefined, sourcePaneId: string | undefined, allowSplit: boolean): {paneId: string; split: boolean} {
  const tabs = workspaceTabs(layout);
  const source = sourcePaneId ?? tabs.find(item => item.tab.kind === 'session' && item.tab.sessionId === ownerSessionId)?.paneId;
  const dedicated = tabs.find(item => item.tab.kind !== 'session' && Boolean(item.tab.ownerSessionId) === Boolean(ownerSessionId)
    && !tabs.some(other => other.paneId === item.paneId && other.tab.kind === 'session'));
  const mixed = tabs.find(item => item.tab.kind !== 'session' && item.tab.ownerSessionId === ownerSessionId && (!ownerSessionId || item.paneId === source));
  const filePane = dedicated?.paneId ?? mixed?.paneId;
  return {paneId: filePane ?? source ?? paneIdsIn(layout)[0], split: !filePane && allowSplit && paneCount(layout) < 4};
}

/** Must match the SessionWorkspace React key; different scopes still need a dirty-close guard. */
export function sessionWorkspaceKey(session: Session, projects: Snapshot['projects']): string {
  return session.projectId ? `${session.projectId}:${canonicalScopePath(session.worktreePath ?? projects.find(project => project.id === session.projectId)?.path) ?? session.id}` : session.id;
}
