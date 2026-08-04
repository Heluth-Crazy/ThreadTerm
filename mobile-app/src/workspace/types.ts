import type {
  DraftConflictState,
  WorkspaceDraftMeta,
  WorkspaceRecord,
  WorkspaceTab,
  WorkspaceTabKind,
} from '@shared/lib/workspace/types';
import type { CardMeta } from '@shared/mobile/bridge/protocol';
import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';

export type TerminalCloseChoice =
  | 'closeTabOnly'
  | 'closeAndEnd'
  | 'continueWaiting'
  | 'keepTerminal'
  | 'forceEnd'
  | 'cancel';
export type TerminalClosePhase =
  | 'confirm'
  | 'gracefulEnding'
  | 'timedOut'
  | 'error'
  | 'forcing';
export interface TerminalCloseResult {
  outcome: 'closed' | 'ended' | 'timedOut' | 'inProgress' | 'cancelled' | 'failed';
  attemptId?: string;
  stage?: 'interrupt' | 'agentExit' | 'shellExit';
  message?: string;
}
export type DirtyCloseChoice = 'saveAndClose' | 'discardAndClose' | 'cancel';
export type DiffViewMode = 'original' | 'current' | 'diff';
export type SyncLabel = 'synced' | 'pending' | 'unsynced' | 'conflict' | 'offline';

export interface WorkspaceListItem {
  /** Stable key for the worktree group (legacy: executionContextKey). */
  key: string;
  /** Server workspace id when known from v2; otherwise synthetic. */
  workspaceId: string | null;
  projectName: string;
  projectPath: string;
  worktreePath: string;
  branchLabel?: string | null;
  cards: CardMeta[];
  availability: 'available' | 'unavailable' | 'legacy';
}

export interface WorkspaceShellModel {
  workspaceId: string;
  label: string;
  projectPath: string;
  worktreePath: string;
  branchLabel?: string | null;
  tabs: WorkspaceTab[];
  activeTabId: string;
  /** Device-local active tab — independent of desktop surface. */
  deviceActiveTabId: string;
  draftMetas: WorkspaceDraftMeta[];
  permission: BridgeDevicePermission;
  revision: number;
  connectionOpen: boolean;
  secureReady: boolean;
  cards: CardMeta[];
}

export interface FileEditorModel {
  workspaceId: string;
  tabId: string;
  relativePath: string;
  title: string;
  contents: string;
  authoritativeRevision: number;
  pendingRevision: number | null;
  syncLabel: SyncLabel;
  dirty: boolean;
  conflict: DraftConflictState;
  readOnly: boolean;
  leaseHolder: string | null;
  hasLease: boolean;
  unsyncedLocal: boolean;
}

export interface DiffViewerModel {
  workspaceId: string;
  tabId: string;
  title: string;
  relativePath: string;
  original: string;
  current: string;
  /** Unified-ish diff text from desktop when available. */
  diffText: string;
  mode: DiffViewMode;
  readOnly: boolean;
}

export interface SyntheticTabOptions {
  workspaceKey: string;
  projectName: string;
  worktreePath: string;
  cards: CardMeta[];
}

/** Build client-side tabs for legacy terminal-only mode (no v2 snapshot). */
export function syntheticTabsFromCards(options: SyntheticTabOptions): WorkspaceTab[] {
  const now = Date.now();
  const home: WorkspaceTab = {
    id: 'home',
    workspaceId: options.workspaceKey,
    kind: 'home',
    title: 'Home',
    sharedOrder: 0,
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
  };
  const terminalTabs: WorkspaceTab[] = options.cards.map((card, index) => ({
    id: `terminal:${card.id}`,
    workspaceId: options.workspaceKey,
    kind: 'terminal' as WorkspaceTabKind,
    title: card.terminalType || card.projectName || card.id.slice(0, 8),
    cardId: card.id,
    sharedOrder: index + 1,
    createdAtUnixMs: card.createdAt ?? now,
    updatedAtUnixMs: card.lastActivity ?? now,
  }));
  return [home, ...terminalTabs];
}

export function draftMetaForTab(
  metas: WorkspaceDraftMeta[],
  tabId: string,
): WorkspaceDraftMeta | null {
  return metas.find((meta) => meta.tabId === tabId) ?? null;
}

export function workspaceRecordStub(
  id: string,
  displayPath: string,
): WorkspaceRecord {
  const now = Date.now();
  return {
    id,
    canonicalRoot: displayPath,
    displayPath,
    availability: 'available',
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
  };
}
