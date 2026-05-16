import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type { ResolvedThemeMode, ThemeModeTokens } from '../theme/themeTypes';

/** Returns true when running inside the Tauri desktop webview. */
export const isTauriEnv = (): boolean =>
  typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

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

export interface BlockStartedEvent {
  sessionId: string;
  blockId: string;
  command: string;
  cwd: string;
  startedAt: number;
}

export interface BlockFinishedEvent {
  sessionId: string;
  blockId: string;
  /**
   * `null` represents an aborted block (the prompt restarted before the
   * previous command's `D` arrived — see `pty/blocks.rs` S3-2 fix). The
   * store maps `null/undefined → state: 'aborted'`.
   */
  exitCode: number | null;
  finishedAt: number;
  durationMs?: number | null;
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

  getRecentOutput: (ptyId: string): Promise<string | null> =>
    invoke<string | null>('pty_get_recent_output', { ptyId }),

  attachSnapshot: (ptyId: string): Promise<PtyAttachSnapshot | null> =>
    invoke<PtyAttachSnapshot | null>('pty_attach_snapshot', { ptyId }),

  ack: (id: string, count: number): Promise<void> =>
    invoke<void>('pty_ack', { id, count }),

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

  onBlockStarted: (cb: (payload: BlockStartedEvent) => void): Promise<() => void> =>
    listen<BlockStartedEvent>('pty://block-started', (e) => cb(e.payload)),

  onBlockFinished: (cb: (payload: BlockFinishedEvent) => void): Promise<() => void> =>
    listen<BlockFinishedEvent>('pty://block-finished', (e) => cb(e.payload)),

  setCommandBlocksEnabled: (enabled: boolean): Promise<boolean> =>
    invoke<boolean>('set_command_blocks_enabled', { enabled }),

  getCommandBlocksEnabled: (): Promise<boolean> =>
    invoke<boolean>('get_command_blocks_enabled'),
};

export type SupportedShell = 'zsh' | 'bash' | 'fish' | 'pwsh';

export interface ShellIntegrationPreview {
  rcPath: string;
  before: string;
  after: string;
  diff: string;
  noChanges: boolean;
}

export const shellIntegration = {
  detectShell: (): Promise<SupportedShell | null> =>
    invoke<SupportedShell | null>('detect_shell'),

  preview: (shell: SupportedShell): Promise<ShellIntegrationPreview> =>
    invoke<ShellIntegrationPreview>('preview_shell_integration', { shell }),

  install: (shell: SupportedShell): Promise<boolean> =>
    invoke<boolean>('install_shell_integration', { shell }),

  uninstall: (shell: SupportedShell): Promise<boolean> =>
    invoke<boolean>('uninstall_shell_integration', { shell }),
};

export interface ProviderSessionInfo {
  id: string;
  provider: 'claude' | 'codex';
  projectPath: string;
  updatedAt?: number;
}

export const providerSessions = {
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

  pairQr: (host?: string): Promise<PairQrResponse> =>
    invoke<PairQrResponse>('bridge_pair_qr', {
      host: host ?? null,
    }),

  devices: (): Promise<BridgeDevice[]> =>
    invoke<BridgeDevice[]>('bridge_devices'),

  revokeDevice: (deviceId: string): Promise<boolean> =>
    invoke<boolean>('bridge_revoke_device', { deviceId }),

  broadcastTheme: (tokens: ThemeModeTokens, mode: ResolvedThemeMode): Promise<void> =>
    invoke<void>('bridge_broadcast_theme', {
      app: tokens.app,
      terminal: tokens.terminal,
      mode,
    }),
};
