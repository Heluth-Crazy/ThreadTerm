/**
 * In-memory workspace authority for non-Tauri unit tests and browser preview.
 * Mirrors the durable service contract used by desktop UI (tabs, drafts, close).
 */

import type {
  ClosePrepareResult,
  CloseTabDecision,
  DraftPatch,
  DraftPatchResult,
  OpenTabRequest,
  WorkspaceDiagnostics,
  WorkspaceDraft,
  WorkspaceDraftMeta,
  WorkspaceEvent,
  WorkspaceRecord,
  WorkspaceSnapshot,
  WorkspaceTab,
  WorkspaceViewState,
} from './types';
import {
  DESKTOP_MAIN_SURFACE,
  HOME_TAB_ID,
  MAX_DRAFT_BYTES,
} from './types';
import { normalizeComparablePath } from '../worktreePaths';

interface LocalWorkspace {
  record: WorkspaceRecord;
  tabs: Map<string, WorkspaceTab>;
  drafts: Map<string, WorkspaceDraft>;
  viewStates: Map<string, WorkspaceViewState>;
}

let nextId = 1;
const workspacesById = new Map<string, LocalWorkspace>();
const workspacesByRoot = new Map<string, string>();
const listeners = new Set<(event: WorkspaceEvent) => void>();

function nowMs(): number {
  return Date.now();
}

function normalizeRoot(rootPath: string): string {
  return rootPath.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

function publish(event: WorkspaceEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

function getOrThrow(workspaceId: string): LocalWorkspace {
  const ws = workspacesById.get(workspaceId);
  if (!ws) {
    throw new Error(`workspace_not_found: Workspace not found: ${workspaceId}`);
  }
  return ws;
}

function syntheticHome(workspaceId: string): WorkspaceTab {
  const now = nowMs();
  return {
    id: HOME_TAB_ID,
    workspaceId,
    kind: 'home',
    title: 'Home',
    cardId: null,
    relativePath: null,
    sharedOrder: 0,
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
  };
}

function draftMeta(draft: WorkspaceDraft): WorkspaceDraftMeta {
  const { contents: _c, ...meta } = draft;
  return meta;
}

export const localWorkspaceAuthority = {
  reset(): void {
    workspacesById.clear();
    workspacesByRoot.clear();
    listeners.clear();
    nextId = 1;
  },

  ensure(rootPath: string): Promise<WorkspaceRecord> {
    const canonicalRoot = normalizeRoot(rootPath);
    const key = normalizeComparablePath(canonicalRoot);
    const existingId = workspacesByRoot.get(key);
    if (existingId) {
      const ws = workspacesById.get(existingId);
      if (ws) return Promise.resolve(ws.record);
    }
    const now = nowMs();
    const id = `local-ws-${nextId++}`;
    const record: WorkspaceRecord = {
      id,
      canonicalRoot,
      displayPath: canonicalRoot,
      availability: 'available',
      createdAtUnixMs: now,
      updatedAtUnixMs: now,
    };
    workspacesById.set(id, {
      record,
      tabs: new Map(),
      drafts: new Map(),
      viewStates: new Map(),
    });
    workspacesByRoot.set(key, id);
    publish({ type: 'workspaceChanged', workspaceId: id, availability: 'available' });
    return Promise.resolve(record);
  },

  get(workspaceId: string): Promise<WorkspaceRecord> {
    return Promise.resolve(getOrThrow(workspaceId).record);
  },

  list(): Promise<WorkspaceRecord[]> {
    return Promise.resolve([...workspacesById.values()].map((w) => w.record));
  },

  getSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
    const ws = getOrThrow(workspaceId);
    const tabs = [...ws.tabs.values()].sort((a, b) => a.sharedOrder - b.sharedOrder);
    return Promise.resolve({
      workspace: ws.record,
      tabs,
      draftMetas: [...ws.drafts.values()].map(draftMeta),
      viewStates: [...ws.viewStates.values()],
      activeLeases: [],
    });
  },

  openTab(workspaceId: string, request: OpenTabRequest): Promise<WorkspaceTab> {
    if (request.kind === 'home') {
      return Promise.resolve(syntheticHome(workspaceId));
    }
    const ws = getOrThrow(workspaceId);
    const relativePath = request.relativePath?.replace(/\\/g, '/').replace(/^\.\//, '') || null;
    let tabId: string;
    if (request.kind === 'terminal') {
      if (!request.cardId) {
        return Promise.reject(new Error('invalid_argument: Terminal tabs require cardId.'));
      }
      tabId = `terminal:${request.cardId}`;
    } else if (request.kind === 'file') {
      if (!relativePath) {
        return Promise.reject(new Error('invalid_argument: File tabs require relativePath.'));
      }
      tabId = `file:${relativePath}`;
    } else if (request.kind === 'diff') {
      if (!relativePath) {
        return Promise.reject(new Error('invalid_argument: Diff tabs require relativePath.'));
      }
      tabId = `diff:${relativePath}`;
    } else {
      return Promise.reject(new Error('invalid_argument: Unsupported tab kind.'));
    }

    const existing = ws.tabs.get(tabId);
    if (existing) return Promise.resolve(existing);

    const now = nowMs();
    let maxOrder = 0;
    for (const tab of ws.tabs.values()) {
      maxOrder = Math.max(maxOrder, tab.sharedOrder);
    }
    const tab: WorkspaceTab = {
      id: tabId,
      workspaceId,
      kind: request.kind,
      title: request.title,
      cardId: request.cardId ?? null,
      relativePath,
      sharedOrder: maxOrder + 1,
      createdAtUnixMs: now,
      updatedAtUnixMs: now,
    };
    ws.tabs.set(tabId, tab);
    publish({ type: 'tabsChanged', workspaceId, tabIds: [tabId] });
    return Promise.resolve(tab);
  },

  reorderTabs(workspaceId: string, orderedTabIds: string[]): Promise<WorkspaceTab[]> {
    const ws = getOrThrow(workspaceId);
    let order = 1;
    const now = nowMs();
    for (const tabId of orderedTabIds) {
      if (tabId === HOME_TAB_ID) continue;
      const tab = ws.tabs.get(tabId);
      if (!tab) continue;
      tab.sharedOrder = order;
      tab.updatedAtUnixMs = now;
      order += 1;
    }
    const tabs = [...ws.tabs.values()].sort((a, b) => a.sharedOrder - b.sharedOrder);
    publish({
      type: 'tabsChanged',
      workspaceId,
      tabIds: tabs.map((t) => t.id),
    });
    return Promise.resolve(tabs);
  },

  setActiveTab(
    workspaceId: string,
    activeTabId: string,
    surfaceId: string = DESKTOP_MAIN_SURFACE,
  ): Promise<WorkspaceViewState> {
    const ws = getOrThrow(workspaceId);
    if (activeTabId !== HOME_TAB_ID && !ws.tabs.has(activeTabId)) {
      return Promise.reject(new Error(`tab_not_found: Tab not found: ${activeTabId}`));
    }
    const state: WorkspaceViewState = {
      workspaceId,
      surfaceId,
      activeTabId,
      lastSeenAtUnixMs: nowMs(),
    };
    ws.viewStates.set(surfaceId, state);
    return Promise.resolve(state);
  },

  getDraft(workspaceId: string, tabId: string): Promise<WorkspaceDraft | null> {
    const ws = getOrThrow(workspaceId);
    return Promise.resolve(ws.drafts.get(tabId) ?? null);
  },

  ensureDraft(workspaceId: string, tabId: string): Promise<WorkspaceDraft> {
    const ws = getOrThrow(workspaceId);
    const existing = ws.drafts.get(tabId);
    if (existing) return Promise.resolve(existing);
    const now = nowMs();
    const draft: WorkspaceDraft = {
      workspaceId,
      tabId,
      revision: 0,
      dirty: false,
      conflict: 'none',
      baseModifiedUnixMs: null,
      baseHash: null,
      sizeBytes: 0,
      updatedAtUnixMs: now,
      contents: '',
    };
    ws.drafts.set(tabId, draft);
    return Promise.resolve(draft);
  },

  applyDraftPatch(
    patch: DraftPatch,
    _options?: { surfaceId?: string; requireLease?: boolean },
  ): Promise<DraftPatchResult> {
    const ws = getOrThrow(patch.workspaceId);
    let draft = ws.drafts.get(patch.tabId);
    if (!draft) {
      draft = {
        workspaceId: patch.workspaceId,
        tabId: patch.tabId,
        revision: 0,
        dirty: false,
        conflict: 'none',
        baseModifiedUnixMs: null,
        baseHash: null,
        sizeBytes: 0,
        updatedAtUnixMs: nowMs(),
        contents: '',
      };
    }
    if (draft.revision !== patch.baseRevision && patch.baseRevision !== 0) {
      return Promise.reject(
        new Error(`stale_revision: Expected revision ${draft.revision}`),
      );
    }
    const nextText =
      typeof patch.fullText === 'string'
        ? patch.fullText
        : patch.changes.reduce((text, change) => {
            return text.slice(0, change.from) + change.insert + text.slice(change.to);
          }, draft.contents);
    if (new TextEncoder().encode(nextText).length > MAX_DRAFT_BYTES) {
      return Promise.reject(new Error('file_too_large: Draft exceeds size limit.'));
    }
    draft = {
      ...draft,
      contents: nextText,
      revision: draft.revision + 1,
      dirty: true,
      sizeBytes: new TextEncoder().encode(nextText).length,
      updatedAtUnixMs: nowMs(),
    };
    ws.drafts.set(patch.tabId, draft);
    publish({
      type: 'draftRevision',
      workspaceId: patch.workspaceId,
      tabId: patch.tabId,
      revision: draft.revision,
      dirty: draft.dirty,
      conflict: draft.conflict,
    });
    return Promise.resolve({
      revision: draft.revision,
      dirty: draft.dirty,
      sizeBytes: draft.sizeBytes,
    });
  },

  prepareClose(workspaceId: string, tabIds: string[]): Promise<ClosePrepareResult> {
    const ws = getOrThrow(workspaceId);
    const cleanTabIds: string[] = [];
    const dirtyTabIds: string[] = [];
    const conflictTabIds: string[] = [];
    for (const tabId of tabIds) {
      if (tabId === HOME_TAB_ID) continue;
      const draft = ws.drafts.get(tabId);
      if (draft && draft.conflict !== 'none') {
        conflictTabIds.push(tabId);
      } else if (draft?.dirty) {
        dirtyTabIds.push(tabId);
      } else {
        cleanTabIds.push(tabId);
      }
    }
    return Promise.resolve({ cleanTabIds, dirtyTabIds, conflictTabIds });
  },

  commitClose(workspaceId: string, decisions: CloseTabDecision[]): Promise<string[]> {
    const ws = getOrThrow(workspaceId);
    for (const decision of decisions) {
      if (decision.tabId === HOME_TAB_ID) {
        return Promise.reject(new Error('invalid_argument: Home tab cannot be closed.'));
      }
    }
    const closed: string[] = [];
    for (const decision of decisions) {
      if (decision.kind === 'keepOpen') continue;
      if (decision.kind === 'discardAndClose' || decision.kind === 'closeClean') {
        ws.drafts.delete(decision.tabId);
        ws.tabs.delete(decision.tabId);
        closed.push(decision.tabId);
      } else if (decision.kind === 'saveAndClose') {
        // Local mode cannot write disk; treat save as discard of draft + close tab.
        ws.drafts.delete(decision.tabId);
        ws.tabs.delete(decision.tabId);
        closed.push(decision.tabId);
      }
    }
    if (closed.length > 0) {
      publish({ type: 'tabsChanged', workspaceId, tabIds: closed });
    }
    return Promise.resolve(closed);
  },

  diagnostics(): Promise<WorkspaceDiagnostics> {
    let tabCount = 0;
    let dirtyDraftCount = 0;
    let conflictDraftCount = 0;
    let loadedDraftBytes = 0;
    for (const ws of workspacesById.values()) {
      tabCount += ws.tabs.size;
      for (const draft of ws.drafts.values()) {
        loadedDraftBytes += draft.sizeBytes;
        if (draft.dirty) dirtyDraftCount += 1;
        if (draft.conflict !== 'none') conflictDraftCount += 1;
      }
    }
    return Promise.resolve({
      registeredWorkspaces: workspacesById.size,
      availableWorkspaces: workspacesById.size,
      tabCount,
      dirtyDraftCount,
      conflictDraftCount,
      loadedDraftBytes,
      activeLeases: 0,
      pendingPersistenceOps: 0,
      persistenceFailures: 0,
    });
  },

  onEvent(cb: (event: WorkspaceEvent) => void): Promise<() => void> {
    listeners.add(cb);
    return Promise.resolve(() => {
      listeners.delete(cb);
    });
  },

  /** Mark a tab dirty without full text (UI dirty badge fallback). */
  markDirtyLocal(workspaceId: string, tabId: string, dirty: boolean): void {
    const ws = workspacesById.get(workspaceId);
    if (!ws) return;
    const existing = ws.drafts.get(tabId);
    if (!dirty) {
      if (existing?.dirty) {
        existing.dirty = false;
        publish({
          type: 'draftRevision',
          workspaceId,
          tabId,
          revision: existing.revision,
          dirty: false,
          conflict: existing.conflict,
        });
      }
      return;
    }
    if (existing) {
      // Avoid republishing when already dirty — prevents render loops via
      // onDirtyChange → markDirtyLocal → draftRevision → setState.
      if (existing.dirty) return;
      existing.dirty = true;
      publish({
        type: 'draftRevision',
        workspaceId,
        tabId,
        revision: existing.revision,
        dirty: true,
        conflict: existing.conflict,
      });
      return;
    }
    const draft: WorkspaceDraft = {
      workspaceId,
      tabId,
      revision: 1,
      dirty: true,
      conflict: 'none',
      baseModifiedUnixMs: null,
      baseHash: null,
      sizeBytes: 0,
      updatedAtUnixMs: nowMs(),
      contents: '',
    };
    ws.drafts.set(tabId, draft);
    publish({
      type: 'draftRevision',
      workspaceId,
      tabId,
      revision: 1,
      dirty: true,
      conflict: 'none',
    });
  },
};
