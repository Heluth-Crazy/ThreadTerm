import { invoke as tauriInvoke, isTauri as tauriIsTauri } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type { ResolvedThemeMode, ThemeModeTokens } from '../theme/themeTypes';
import type { CardMeta } from '../mobile/bridge/protocol';
import type {
  StatsDoneEvent,
  StatsErrorEvent,
  StatsProgressEvent,
  StatsRange,
  StatsScope,
} from '../types/stats';

/** Returns true when running inside the Tauri desktop webview. */
export const isTauriEnv = (): boolean =>
  tauriIsTauri() ||
  typeof (
    window as {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    }
  ).__TAURI_INTERNALS__ !== 'undefined' ||
  typeof (
    window as {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    }
  ).__TAURI__ !== 'undefined';

/** Re-export the Tauri invoke primitive for overlay/window commands. */
export const invoke = tauriInvoke;

const listen = isTauriEnv()
  ? tauriListen
  : async <T>(_event: string, _handler: (e: { payload: T }) => void): Promise<() => void> =>
      () => {};

export type SessionState = 'Idle' | 'Running' | 'WaitingForInput' | 'Completed' | 'Failed';

export interface PtyOutputPayload {
  id: string;
  data: string;
  seq: number;
}

export interface PtyAttachSnapshot {
  ptyId: string;
  data: string;
  seq: number;
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
  history?: string;
}

export interface AttentionRequiredEvent {
  ptyId: string;
  sessionId: string;
  type: 'waiting' | 'error';
  message: string;
}

export const pty = {
  create: (id: string, workingDir: string, rows: number, cols: number): Promise<string> =>
    invoke<string>('pty_create', { id, workingDir, rows, cols }),

  input: (id: string, data: string): Promise<void> =>
    invoke<void>('pty_input', { id, data }),

  resize: (id: string, rows: number, cols: number): Promise<void> =>
    invoke<void>('pty_resize', { id, rows, cols }),

  kill: (id: string): Promise<void> =>
    invoke<void>('pty_kill', { id }),

  getSessionState: (ptyId: string): Promise<SessionState> =>
    invoke<SessionState>('pty_get_session_state', { ptyId }),

  /**
   * Batch variant of {@link getSessionState} (audit P2-5): one IPC returns
   * every live session's state keyed by PTY id. Ids missing from the map
   * mean the PTY is no longer registered on the backend.
   */
  getAllSessionStates: (): Promise<Record<string, SessionState>> =>
    invoke<Record<string, SessionState>>('pty_get_all_session_states'),

  getRecentOutput: (ptyId: string): Promise<string | null> =>
    invoke<string | null>('pty_get_recent_output', { ptyId }),

  attachSnapshot: (ptyId: string): Promise<PtyAttachSnapshot | null> =>
    invoke<PtyAttachSnapshot | null>('pty_attach_snapshot', { ptyId }),

  registerOutputConsumer: (id: string, consumerId: string): Promise<void> =>
    invoke<void>('pty_register_output_consumer', { id, consumerId }),

  unregisterOutputConsumer: (id: string, consumerId: string): Promise<void> =>
    invoke<void>('pty_unregister_output_consumer', { id, consumerId }),

  ack: (
    id: string,
    throughSeq: number,
    consumerKind: 'background' | 'renderer',
    consumerId?: string,
  ): Promise<void> =>
    invoke<void>('pty_ack', { id, throughSeq, consumerKind, consumerId }),

  onOutput: (cb: (payload: PtyOutputPayload) => void): Promise<() => void> =>
    listen<PtyOutputPayload>('pty-output', (e) => cb(e.payload)),

  onExit: (cb: (payload: { id: string; code?: number | null }) => void): Promise<() => void> =>
    listen<{ id: string; code?: number | null }>('pty-exit', (e) => cb(e.payload)),

  onStateChanged: (
    cb: (payload: { ptyId: string; state: SessionState }) => void,
  ): Promise<() => void> =>
    listen<{ ptyId: string; state: SessionState }>('session-state-changed', (e) => cb(e.payload)),

  onAttentionRequired: (cb: (payload: AttentionRequiredEvent) => void): Promise<() => void> =>
    listen<AttentionRequiredEvent>('attention-required', (e) => cb(e.payload)),

};

export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string | null;
  isMain: boolean;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
}

export interface BranchRow {
  branch: string;
  head: string;
  isCurrent: boolean;
  worktreePath?: string | null;
  isMainWorktree: boolean;
  lastCommitUnix: number;
  upstream?: string | null;
}

export interface GitStatusEntry {
  path: string;
  absolutePath: string;
  repositoryRoot: string;
  staged?: string | null;
  unstaged?: string | null;
  isUntracked: boolean;
}

export interface GitFileDiff {
  path: string;
  stagedDiff: string;
  unstagedDiff: string;
  isBinary: boolean;
}

export type GitTextDiffSectionKind = 'staged' | 'unstaged';

export interface GitTextDiffSection {
  kind: GitTextDiffSectionKind;
  baseLabel: string;
  currentLabel: string;
  baseContents: string;
  currentContents: string;
  editable: boolean;
  currentModifiedUnixMs?: number | null;
}

export interface GitTextDiff {
  path: string;
  repositoryRoot: string;
  isBinary: boolean;
  sections: GitTextDiffSection[];
}

export const git = {
  branches: {
    overview: (projectPath: string): Promise<BranchRow[]> =>
      invoke<BranchRow[]>('git_branch_overview', { projectPath }),
  },
  changes: {
    status: (projectPath: string): Promise<GitStatusEntry[]> =>
      invoke<GitStatusEntry[]>('git_status', { projectPath }),
    diff: (projectPath: string, path: string): Promise<GitFileDiff> =>
      invoke<GitFileDiff>('git_file_diff', { projectPath, path }),
    textDiff: (projectPath: string, path: string): Promise<GitTextDiff> =>
      invoke<GitTextDiff>('git_file_text_diff', { projectPath, path }),
  },
  worktrees: {
    list: (projectPath: string): Promise<WorktreeInfo[]> =>
      invoke<WorktreeInfo[]>('git_worktree_list', { projectPath }),
    add: (
      projectPath: string,
      branch: string,
      worktreePath?: string,
    ): Promise<WorktreeInfo> =>
      invoke<WorktreeInfo>('git_worktree_add', {
        projectPath,
        branch,
        worktreePath,
      }),
  },
};

export interface WorkspaceFile {
  path: string;
  contents: string;
  sizeBytes: number;
  modifiedUnixMs?: number | null;
}

export const workspaceFiles = {
  read: (rootPath: string, path: string): Promise<WorkspaceFile> =>
    invoke<WorkspaceFile>('workspace_read_file', { rootPath, path }),
  write: (
    rootPath: string,
    path: string,
    contents: string,
    expectedModifiedUnixMs?: number | null,
  ): Promise<WorkspaceFile> =>
    invoke<WorkspaceFile>('workspace_write_file', {
      rootPath,
      path,
      contents,
      expectedModifiedUnixMs: expectedModifiedUnixMs ?? null,
    }),
};

export interface ProviderSessionInfo {
  id: string;
  provider: 'claude' | 'codex';
  projectPath: string;
  updatedAt?: number | null;
}

export type {
  AgentSessionAvailability,
  AgentSessionPage,
  AgentSessionProvider,
  AgentSessionSummary,
  ListAgentSessionsRequest,
  TitleKind,
} from '../types/agentSession';

import type {
  AgentSessionPage,
  ListAgentSessionsRequest,
} from '../types/agentSession';

export const providerSessions = {
  listRecent: (limit?: number): Promise<ProviderSessionInfo[]> =>
    invoke<ProviderSessionInfo[]>('provider_list_recent_sessions', {
      limit: limit ?? null,
    }),

  findRecent: (
    provider: 'claude' | 'codex',
    projectPath: string,
    sinceMs?: number,
  ): Promise<ProviderSessionInfo | null> =>
    invoke<ProviderSessionInfo | null>('provider_find_recent_session', {
      provider,
      projectPath,
      sinceMs: sinceMs ?? null,
    }),

  /** On-demand paginated catalog. Does not create cards. */
  listAgentSessions: (request: ListAgentSessionsRequest): Promise<AgentSessionPage> =>
    invoke<AgentSessionPage>('provider_list_agent_sessions', { request }),
};

export interface CodexAppStatus {
  running: boolean;
  initialized: boolean;
  userAgent?: string | null;
  codexHome?: string | null;
  platformOs?: string | null;
  lastError?: string | null;
}

export interface CodexAppOpenCardResult {
  cardId: string;
  threadId: string;
  sessionId?: string | null;
  threadPath?: string | null;
  status: 'resumed' | 'listed' | 'created';
  thread: unknown;
}

export interface CodexAppNotificationPayload {
  cardId?: string | null;
  method: string;
  params: unknown;
  raw: unknown;
}

export interface CodexAppRequestPayload {
  requestId: unknown;
  cardId?: string | null;
  method: string;
  params: unknown;
  raw: unknown;
}

export interface CodexAppDisconnectedPayload {
  message: string;
}

export const codexApp = {
  status: (): Promise<CodexAppStatus> =>
    invoke<CodexAppStatus>('codex_app_status'),

  openCard: (input: {
    cardId: string;
    cwd: string;
    codexAppThreadId?: string | null;
    providerSessionId?: string | null;
  }): Promise<CodexAppOpenCardResult> =>
    invoke<CodexAppOpenCardResult>('codex_app_open_card', {
      cardId: input.cardId,
      cwd: input.cwd,
      codexAppThreadId: input.codexAppThreadId ?? null,
      providerSessionId: input.providerSessionId ?? null,
    }),

  sendMessage: (input: {
    cardId: string;
    threadId: string;
    text: string;
    input?: unknown[] | null;
    cwd?: string | null;
  }): Promise<unknown> =>
    invoke<unknown>('codex_app_send_message', {
      cardId: input.cardId,
      threadId: input.threadId,
      text: input.text,
      input: input.input ?? null,
      cwd: input.cwd ?? null,
    }),

  respondRequest: (requestId: unknown, response: unknown): Promise<void> =>
    invoke<void>('codex_app_respond_request', { requestId, response }),

  interrupt: (threadId: string, turnId: string): Promise<unknown> =>
    invoke<unknown>('codex_app_interrupt', { threadId, turnId }),

  compact: (threadId: string): Promise<unknown> =>
    invoke<unknown>('codex_app_compact', { threadId }),

  setGoal: (
    threadId: string,
    objective: string,
    tokenBudget?: number | null,
  ): Promise<unknown> =>
    invoke<unknown>('codex_app_set_goal', {
      threadId,
      objective,
      tokenBudget: tokenBudget ?? null,
    }),

  listSkills: (cwd: string): Promise<unknown> =>
    invoke<unknown>('codex_app_list_skills', { cwd }),

  onNotification: (cb: (payload: CodexAppNotificationPayload) => void): Promise<() => void> =>
    listen<CodexAppNotificationPayload>('codex-app://notification', (e) => cb(e.payload)),

  onRequest: (cb: (payload: CodexAppRequestPayload) => void): Promise<() => void> =>
    listen<CodexAppRequestPayload>('codex-app://request', (e) => cb(e.payload)),

  onDisconnected: (cb: (payload: CodexAppDisconnectedPayload) => void): Promise<() => void> =>
    listen<CodexAppDisconnectedPayload>('codex-app://disconnected', (e) => cb(e.payload)),
};

export const tokenStats = {
  compute: (scope: StatsScope, range: StatsRange, requestId: number): Promise<void> =>
    invoke<void>('stats_compute', { scope, range, requestId }),

  cancel: (): Promise<void> => invoke<void>('stats_cancel'),

  /** Clear ingested rows + sync cursors; next compute re-ingests from scratch. */
  rebuild: (): Promise<void> => invoke<void>('stats_rebuild'),

  onProgress: (cb: (payload: StatsProgressEvent) => void): Promise<() => void> =>
    listen<StatsProgressEvent>('stats://progress', (e) => cb(e.payload)),

  onDone: (cb: (payload: StatsDoneEvent) => void): Promise<() => void> =>
    listen<StatsDoneEvent>('stats://done', (e) => cb(e.payload)),

  onError: (cb: (payload: StatsErrorEvent) => void): Promise<() => void> =>
    listen<StatsErrorEvent>('stats://error', (e) => cb(e.payload)),
};

export interface BridgeStatus {
  running: boolean;
  host?: string | null;
  port?: number | null;
  url?: string | null;
}

export interface PairQrResponse {
  host: string;
  port: number;
  otp: string;
  url: string;
  expiresInSeconds: number;
}

export type BridgeDevicePermission = 'read_only' | 'full';

export interface BridgeDevice {
  id: string;
  name: string;
  permission: BridgeDevicePermission;
  createdAt: number;
  lastSeenAt?: number | null;
}

export interface MobileSpawnCardRequest {
  requestId: string;
  terminalType: string;
  projectPath: string;
  command?: string | null;
}

export interface MobileCardRequest {
  requestId: string;
  cardId: string;
}

export interface MobileRenameCardRequest {
  requestId: string;
  cardId: string;
  projectName: string;
}

export interface MobileCommandResult {
  requestId: string;
  ok: boolean;
  cardId?: string | null;
  errorCode?: string | null;
  message?: string | null;
}

// ── Supervisor (AI Supervisor v0.1) ─────────────────────────────────────────

export interface SupervisorAlertPayload {
  cardId: string;
  ruleId: string;
  sampleText: string;
  /** Unix epoch milliseconds when the backend matched the rule. */
  ts: number;
}

/**
 * Subscribe to `supervisor://alert` events. Returns a no-op unsubscribe in
 * non-Tauri environments (mirrors the pattern used by `pty.onOutput` etc.).
 */
export const subscribeSupervisorAlert = (
  cb: (payload: SupervisorAlertPayload) => void,
): Promise<() => void> =>
  listen<SupervisorAlertPayload>('supervisor://alert', (e) => cb(e.payload));

/**
 * Toggle the Rust supervisor singleton. `watchedCardIds` is the current
 * `pinnedCardIds` snapshot when `enabled = true`; pass `[]` when disabling.
 */
export const invokeSupervisorEnable = (
  enabled: boolean,
  watchedCardIds: string[],
): Promise<void> =>
  invoke<void>('supervisor_enable', { enabled, watchedCardIds });

export const mobileBridge = {
  start: (host?: string, port?: number): Promise<BridgeStatus> =>
    invoke<BridgeStatus>('bridge_start', {
      host: host ?? null,
      port: port ?? null,
    }),

  stop: (): Promise<BridgeStatus> =>
    invoke<BridgeStatus>('bridge_stop'),

  status: (): Promise<BridgeStatus> =>
    invoke<BridgeStatus>('bridge_status'),

  pairQr: (
    host?: string,
    permission: BridgeDevicePermission = 'read_only',
  ): Promise<PairQrResponse> =>
    invoke<PairQrResponse>('bridge_pair_qr', {
      host: host ?? null,
      permission,
    }),

  devices: (): Promise<BridgeDevice[]> =>
    invoke<BridgeDevice[]>('bridge_devices'),

  revokeDevice: (deviceId: string): Promise<boolean> =>
    invoke<boolean>('bridge_revoke_device', { deviceId }),

  syncCards: (cards: CardMeta[]): Promise<void> =>
    invoke<void>('bridge_sync_cards', { cards }),

  resolveSpawn: (result: MobileCommandResult): Promise<void> =>
    invoke<void>('bridge_resolve_mobile_spawn', { ...result }),

  resolveActivate: (result: MobileCommandResult): Promise<void> =>
    invoke<void>('bridge_resolve_mobile_activate', { ...result }),

  resolveClose: (result: MobileCommandResult): Promise<void> =>
    invoke<void>('bridge_resolve_mobile_close', { ...result }),

  resolveRenameCard: (result: MobileCommandResult): Promise<void> =>
    invoke<void>('bridge_resolve_mobile_rename_card', { ...result }),

  onSpawnCard: (cb: (payload: MobileSpawnCardRequest) => void): Promise<() => void> =>
    listen<MobileSpawnCardRequest>('mobile://spawn-card', (e) => cb(e.payload)),

  onActivateCard: (cb: (payload: MobileCardRequest) => void): Promise<() => void> =>
    listen<MobileCardRequest>('mobile://activate-card', (e) => cb(e.payload)),

  onRemoveCard: (cb: (payload: MobileCardRequest) => void): Promise<() => void> =>
    listen<MobileCardRequest>('mobile://remove-card', (e) => cb(e.payload)),

  onRenameCard: (cb: (payload: MobileRenameCardRequest) => void): Promise<() => void> =>
    listen<MobileRenameCardRequest>('mobile://rename-card', (e) => cb(e.payload)),

  broadcastTheme: (tokens: ThemeModeTokens, mode: ResolvedThemeMode): Promise<void> =>
    invoke<void>('bridge_broadcast_theme', {
      app: tokens.app,
      terminal: tokens.terminal,
      mode,
    }),
};
