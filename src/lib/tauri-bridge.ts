import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

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

  getRecentOutput: (ptyId: string): Promise<string | null> =>
    invoke<string | null>('pty_get_recent_output', { ptyId }),

  onOutput: (cb: (payload: { id: string; data: string }) => void): Promise<() => void> =>
    listen<{ id: string; data: string }>('pty-output', (e) => cb(e.payload)),

  onExit: (cb: (payload: { id: string; code?: number }) => void): Promise<() => void> =>
    listen<{ id: string; code?: number }>('pty-exit', (e) => cb(e.payload)),

  onStateChanged: (
    cb: (payload: { ptyId: string; state: SessionState }) => void,
  ): Promise<() => void> =>
    listen<{ ptyId: string; state: SessionState }>('session-state-changed', (e) => cb(e.payload)),

  onAttentionRequired: (cb: (payload: AttentionRequiredEvent) => void): Promise<() => void> =>
    listen<AttentionRequiredEvent>('attention-required', (e) => cb(e.payload)),
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
};
