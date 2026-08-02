/**
 * Workspace authority DTOs — field names and enum values are contract-locked
 * with Rust (`src-tauri/src/workspace/types.rs` and error.rs).
 */

export const WORKSPACE_EVENT_CHANNEL = 'workspace://changed' as const;
export const HOME_TAB_ID = 'home' as const;
export const DESKTOP_MAIN_SURFACE = 'desktop:main' as const;
export const MAX_DRAFT_BYTES = 1024 * 1024;
export const LEASE_DISCONNECT_GRACE_MS = 30_000;

export const WORKSPACE_ERROR_CODES = [
  'workspace_not_found',
  'workspace_unavailable',
  'tab_not_found',
  'path_outside_workspace',
  'path_invalid',
  'permission_denied',
  'lease_required',
  'lease_conflict',
  'stale_revision',
  'file_conflict',
  'file_too_large',
  'file_binary',
  'file_not_utf8',
  'file_not_found',
  'persistence_failed',
  'secure_transport_required',
  'invalid_argument',
] as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export type WorkspaceTabKind = 'home' | 'terminal' | 'file' | 'diff';
export type WorkspaceAvailability = 'available' | 'unavailable';
export type DraftConflictState = 'none' | 'external_change' | 'stale_revision';
export type CloseTabDecisionKind =
  | 'closeClean'
  | 'saveAndClose'
  | 'discardAndClose'
  | 'keepOpen';

export interface WorkspaceRecord {
  id: string;
  canonicalRoot: string;
  displayPath: string;
  availability: WorkspaceAvailability;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface WorkspaceTab {
  id: string;
  workspaceId: string;
  kind: WorkspaceTabKind;
  title: string;
  cardId?: string | null;
  relativePath?: string | null;
  sharedOrder: number;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface WorkspaceDraftMeta {
  workspaceId: string;
  tabId: string;
  revision: number;
  dirty: boolean;
  conflict: DraftConflictState;
  baseModifiedUnixMs?: number | null;
  baseHash?: string | null;
  sizeBytes: number;
  updatedAtUnixMs: number;
}

export interface WorkspaceDraft extends WorkspaceDraftMeta {
  contents: string;
}

export interface WorkspaceViewState {
  workspaceId: string;
  surfaceId: string;
  activeTabId: string;
  lastSeenAtUnixMs: number;
}

export interface EditorLeaseSnapshot {
  workspaceId: string;
  tabId: string;
  holderSurfaceId: string;
  revision: number;
  acquiredAtUnixMs: number;
  renewedAtUnixMs: number;
  expiresAtUnixMs?: number | null;
}

export interface WorkspaceSnapshot {
  workspace: WorkspaceRecord;
  tabs: WorkspaceTab[];
  draftMetas: WorkspaceDraftMeta[];
  viewStates: WorkspaceViewState[];
  activeLeases: EditorLeaseSnapshot[];
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface DraftPatch {
  workspaceId: string;
  tabId: string;
  baseRevision: number;
  changes: TextChange[];
  fullText?: string | null;
}

export interface DraftPatchResult {
  revision: number;
  dirty: boolean;
  sizeBytes: number;
}

export interface CloseTabDecision {
  tabId: string;
  kind: CloseTabDecisionKind;
  expectedRevision?: number | null;
}

export interface ClosePrepareResult {
  cleanTabIds: string[];
  dirtyTabIds: string[];
  conflictTabIds: string[];
}

export interface OpenTabRequest {
  kind: WorkspaceTabKind;
  title: string;
  cardId?: string | null;
  relativePath?: string | null;
}

export interface WorkspaceFileContent {
  workspaceId: string;
  relativePath: string;
  absolutePath: string;
  contents: string;
  sizeBytes: number;
  modifiedUnixMs?: number | null;
  contentHash: string;
}

export interface WorkspaceSaveResult {
  file: WorkspaceFileContent;
  draftMeta?: WorkspaceDraftMeta | null;
}

export interface WorkspaceDiagnostics {
  registeredWorkspaces: number;
  availableWorkspaces: number;
  tabCount: number;
  dirtyDraftCount: number;
  conflictDraftCount: number;
  loadedDraftBytes: number;
  activeLeases: number;
  pendingPersistenceOps: number;
  persistenceFailures: number;
}

export type WorkspaceEvent =
  | {
      type: 'workspaceChanged';
      workspaceId: string;
      availability: WorkspaceAvailability;
    }
  | {
      type: 'tabsChanged';
      workspaceId: string;
      tabIds: string[];
    }
  | {
      type: 'draftRevision';
      workspaceId: string;
      tabId: string;
      revision: number;
      dirty: boolean;
      conflict: DraftConflictState;
    }
  | {
      type: 'leaseChanged';
      workspaceId: string;
      tabId: string;
      holderSurfaceId?: string | null;
      revision: number;
    }
  | {
      type: 'conflict';
      workspaceId: string;
      tabId: string;
      conflict: DraftConflictState;
      revision: number;
    };

export function parseWorkspaceErrorCode(message: string): WorkspaceErrorCode | null {
  const code = message.split(':')[0]?.trim();
  if (!code) return null;
  return (WORKSPACE_ERROR_CODES as readonly string[]).includes(code)
    ? (code as WorkspaceErrorCode)
    : null;
}
