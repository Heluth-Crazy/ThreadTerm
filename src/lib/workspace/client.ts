/**
 * Desktop workspace client: Tauri authority when available, in-memory otherwise.
 */

import { isTauriEnv } from '../tauri-bridge';
import { workspaceAuthority } from './api';
import { localWorkspaceAuthority } from './localAuthority';
import type {
  ClosePrepareResult,
  CloseTabDecision,
  DraftPatch,
  DraftPatchResult,
  OpenTabRequest,
  WorkspaceDiagnostics,
  WorkspaceDraft,
  WorkspaceEvent,
  WorkspaceRecord,
  WorkspaceSnapshot,
  WorkspaceTab,
  WorkspaceViewState,
} from './types';
import { DESKTOP_MAIN_SURFACE } from './types';

function prefersLocalAuthority(): boolean {
  if (typeof isTauriEnv !== 'function' || !isTauriEnv()) return true;
  try {
    // Unit tests often stub isTauriEnv without full Tauri internals.
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke?: unknown };
      }
    ).__TAURI_INTERNALS__;
    return typeof internals?.invoke !== 'function';
  } catch {
    return true;
  }
}

export const workspaceClient = {
  ensure(rootPath: string): Promise<WorkspaceRecord> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.ensure(rootPath);
    return workspaceAuthority.ensure(rootPath);
  },

  get(workspaceId: string): Promise<WorkspaceRecord> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.get(workspaceId);
    return workspaceAuthority.get(workspaceId);
  },

  list(): Promise<WorkspaceRecord[]> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.list();
    return workspaceAuthority.list();
  },

  getSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.getSnapshot(workspaceId);
    return workspaceAuthority.getSnapshot(workspaceId);
  },

  openTab(workspaceId: string, request: OpenTabRequest): Promise<WorkspaceTab> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.openTab(workspaceId, request);
    return workspaceAuthority.openTab(workspaceId, request);
  },

  reorderTabs(workspaceId: string, orderedTabIds: string[]): Promise<WorkspaceTab[]> {
    if (prefersLocalAuthority()) {
      return localWorkspaceAuthority.reorderTabs(workspaceId, orderedTabIds);
    }
    return workspaceAuthority.reorderTabs(workspaceId, orderedTabIds);
  },

  setActiveTab(
    workspaceId: string,
    activeTabId: string,
    surfaceId: string = DESKTOP_MAIN_SURFACE,
  ): Promise<WorkspaceViewState> {
    if (prefersLocalAuthority()) {
      return localWorkspaceAuthority.setActiveTab(workspaceId, activeTabId, surfaceId);
    }
    return workspaceAuthority.setActiveTab(workspaceId, activeTabId, surfaceId);
  },

  getDraft(workspaceId: string, tabId: string): Promise<WorkspaceDraft | null> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.getDraft(workspaceId, tabId);
    return workspaceAuthority.getDraft(workspaceId, tabId);
  },

  ensureDraft(workspaceId: string, tabId: string): Promise<WorkspaceDraft> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.ensureDraft(workspaceId, tabId);
    return workspaceAuthority.ensureDraft(workspaceId, tabId);
  },

  applyDraftPatch(
    patch: DraftPatch,
    options?: { surfaceId?: string; requireLease?: boolean },
  ): Promise<DraftPatchResult> {
    if (prefersLocalAuthority()) {
      return localWorkspaceAuthority.applyDraftPatch(patch, options);
    }
    return workspaceAuthority.applyDraftPatch(patch, options);
  },

  prepareClose(workspaceId: string, tabIds: string[]): Promise<ClosePrepareResult> {
    if (prefersLocalAuthority()) {
      return localWorkspaceAuthority.prepareClose(workspaceId, tabIds);
    }
    return workspaceAuthority.prepareClose(workspaceId, tabIds);
  },

  commitClose(workspaceId: string, decisions: CloseTabDecision[]): Promise<string[]> {
    if (prefersLocalAuthority()) {
      return localWorkspaceAuthority.commitClose(workspaceId, decisions);
    }
    return workspaceAuthority.commitClose(workspaceId, decisions);
  },

  diagnostics(): Promise<WorkspaceDiagnostics> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.diagnostics();
    return workspaceAuthority.diagnostics();
  },

  onEvent(cb: (event: WorkspaceEvent) => void): Promise<() => void> {
    if (prefersLocalAuthority()) return localWorkspaceAuthority.onEvent(cb);
    return workspaceAuthority.onEvent(cb);
  },

  markDirtyLocal(workspaceId: string, tabId: string, dirty: boolean): void {
    if (prefersLocalAuthority()) {
      localWorkspaceAuthority.markDirtyLocal(workspaceId, tabId, dirty);
    }
  },
};
