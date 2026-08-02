/**
 * Typed Tauri facade for the authoritative workspace service.
 * Desktop UI and future bridge v2 must call through this module only.
 */

import { invoke, isTauriEnv } from '../tauri-bridge';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type {
  ClosePrepareResult,
  CloseTabDecision,
  DraftPatch,
  DraftPatchResult,
  EditorLeaseSnapshot,
  OpenTabRequest,
  WorkspaceDiagnostics,
  WorkspaceDraft,
  WorkspaceEvent,
  WorkspaceFileContent,
  WorkspaceRecord,
  WorkspaceSaveResult,
  WorkspaceSnapshot,
  WorkspaceTab,
  WorkspaceViewState,
} from './types';
import { DESKTOP_MAIN_SURFACE, WORKSPACE_EVENT_CHANNEL } from './types';

async function listenWorkspaceEvent<T>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<() => void> {
  if (typeof isTauriEnv === 'function' && isTauriEnv()) {
    try {
      return await tauriListen<T>(event, handler);
    } catch {
      return () => {};
    }
  }
  return () => {};
}

export const workspaceAuthority = {
  ensure: (rootPath: string): Promise<WorkspaceRecord> =>
    invoke<WorkspaceRecord>('workspace_ensure', { rootPath }),

  get: (workspaceId: string): Promise<WorkspaceRecord> =>
    invoke<WorkspaceRecord>('workspace_get', { workspaceId }),

  list: (): Promise<WorkspaceRecord[]> => invoke<WorkspaceRecord[]>('workspace_list'),

  getSnapshot: (workspaceId: string): Promise<WorkspaceSnapshot> =>
    invoke<WorkspaceSnapshot>('workspace_get_snapshot', { workspaceId }),

  openTab: (workspaceId: string, request: OpenTabRequest): Promise<WorkspaceTab> =>
    invoke<WorkspaceTab>('workspace_open_tab', { workspaceId, request }),

  reorderTabs: (workspaceId: string, orderedTabIds: string[]): Promise<WorkspaceTab[]> =>
    invoke<WorkspaceTab[]>('workspace_reorder_tabs', { workspaceId, orderedTabIds }),

  setActiveTab: (
    workspaceId: string,
    activeTabId: string,
    surfaceId: string = DESKTOP_MAIN_SURFACE,
  ): Promise<WorkspaceViewState> =>
    invoke<WorkspaceViewState>('workspace_set_active_tab', {
      workspaceId,
      surfaceId,
      activeTabId,
    }),

  listDirectory: (
    workspaceId: string,
    relativePath?: string | null,
  ): Promise<
    Array<{ name: string; path: string; isDir: boolean; isHidden: boolean }>
  > =>
    invoke('workspace_list_directory', {
      workspaceId,
      relativePath: relativePath ?? null,
    }),

  readFile: (workspaceId: string, relativePath: string): Promise<WorkspaceFileContent> =>
    invoke<WorkspaceFileContent>('workspace_read_workspace_file', {
      workspaceId,
      relativePath,
    }),

  getDraft: (workspaceId: string, tabId: string): Promise<WorkspaceDraft | null> =>
    invoke<WorkspaceDraft | null>('workspace_get_draft', { workspaceId, tabId }),

  ensureDraft: (workspaceId: string, tabId: string): Promise<WorkspaceDraft> =>
    invoke<WorkspaceDraft>('workspace_ensure_draft', { workspaceId, tabId }),

  applyDraftPatch: (
    patch: DraftPatch,
    options?: { surfaceId?: string; requireLease?: boolean },
  ): Promise<DraftPatchResult> =>
    invoke<DraftPatchResult>('workspace_apply_draft_patch', {
      surfaceId: options?.surfaceId ?? DESKTOP_MAIN_SURFACE,
      patch,
      requireLease: options?.requireLease ?? false,
    }),

  saveDraft: (
    workspaceId: string,
    tabId: string,
    expectedRevision: number,
    force = false,
  ): Promise<WorkspaceSaveResult> =>
    invoke<WorkspaceSaveResult>('workspace_save_draft', {
      workspaceId,
      tabId,
      expectedRevision,
      force,
    }),

  discardDraft: (
    workspaceId: string,
    tabId: string,
    expectedRevision?: number | null,
  ): Promise<void> =>
    invoke<void>('workspace_discard_draft', {
      workspaceId,
      tabId,
      expectedRevision: expectedRevision ?? null,
    }),

  useDiskVersion: (workspaceId: string, tabId: string): Promise<WorkspaceDraft> =>
    invoke<WorkspaceDraft>('workspace_use_disk_version', { workspaceId, tabId }),

  saveAs: (
    workspaceId: string,
    tabId: string,
    newRelativePath: string,
    expectedRevision: number,
  ): Promise<WorkspaceSaveResult> =>
    invoke<WorkspaceSaveResult>('workspace_save_as', {
      workspaceId,
      tabId,
      newRelativePath,
      expectedRevision,
    }),

  prepareClose: (workspaceId: string, tabIds: string[]): Promise<ClosePrepareResult> =>
    invoke<ClosePrepareResult>('workspace_prepare_close', { workspaceId, tabIds }),

  commitClose: (
    workspaceId: string,
    decisions: CloseTabDecision[],
  ): Promise<string[]> =>
    invoke<string[]>('workspace_commit_close', { workspaceId, decisions }),

  acquireLease: (
    workspaceId: string,
    tabId: string,
    surfaceId: string = DESKTOP_MAIN_SURFACE,
  ): Promise<EditorLeaseSnapshot> =>
    invoke<EditorLeaseSnapshot>('workspace_acquire_lease', {
      workspaceId,
      tabId,
      surfaceId,
    }),

  renewLease: (
    workspaceId: string,
    tabId: string,
    surfaceId: string = DESKTOP_MAIN_SURFACE,
  ): Promise<EditorLeaseSnapshot> =>
    invoke<EditorLeaseSnapshot>('workspace_renew_lease', {
      workspaceId,
      tabId,
      surfaceId,
    }),

  releaseLease: (
    workspaceId: string,
    tabId: string,
    surfaceId: string = DESKTOP_MAIN_SURFACE,
  ): Promise<boolean> =>
    invoke<boolean>('workspace_release_lease', {
      workspaceId,
      tabId,
      surfaceId,
    }),

  takeoverLease: (
    workspaceId: string,
    tabId: string,
    surfaceId: string = DESKTOP_MAIN_SURFACE,
  ): Promise<EditorLeaseSnapshot> =>
    invoke<EditorLeaseSnapshot>('workspace_takeover_lease', {
      workspaceId,
      tabId,
      surfaceId,
    }),

  diagnostics: (): Promise<WorkspaceDiagnostics> =>
    invoke<WorkspaceDiagnostics>('workspace_diagnostics'),

  onEvent: (cb: (event: WorkspaceEvent) => void): Promise<() => void> =>
    listenWorkspaceEvent<WorkspaceEvent>(WORKSPACE_EVENT_CHANNEL, (e) =>
      cb(e.payload),
    ),
};
