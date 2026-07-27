import { listen as tauriListen } from '@tauri-apps/api/event';
import { invoke, isTauriEnv } from '../tauri-bridge';

export type ClaudeChatPhase =
  | 'checking'
  | 'starting'
  | 'ready'
  | 'running'
  | 'idle'
  | 'error'
  | 'closed'
  | 'disconnected';

export interface ClaudeChatProbeResult {
  ok: boolean;
  missing?: string | null;
  detail?: string | null;
  nodeVersion?: string | null;
  claudeVersion?: string | null;
}

export interface ClaudeChatStartResult {
  sessionId: string | null;
}

export interface ClaudeChatImage {
  mediaType: string;
  base64: string;
}

export interface ClaudeChatStatusEvent {
  ev: 'session.status';
  cardId: string;
  phase: ClaudeChatPhase;
  sessionId?: string | null;
  detail?: string | null;
}

export interface ClaudeChatMessageEvent {
  ev: 'session.event';
  cardId: string;
  message: unknown;
}

export interface ClaudeChatRequestEvent {
  ev: 'session.request';
  cardId: string;
  requestId: string;
  kind: string;
  toolName?: string | null;
  input?: unknown;
  suggestions?: unknown;
}

export interface ClaudeChatRequestCancelledEvent {
  ev: 'session.request_cancelled';
  cardId: string;
  requestId: string;
}

export type ClaudeChatEventPayload =
  | ClaudeChatStatusEvent
  | ClaudeChatMessageEvent;

export type ClaudeChatRequestPayload =
  | ClaudeChatRequestEvent
  | ClaudeChatRequestCancelledEvent;

export interface ClaudeChatDisconnectedPayload {
  message: string;
}

async function listenIfDesktop<T>(
  event: string,
  callback: (payload: T) => void,
): Promise<() => void> {
  if (!isTauriEnv()) return () => {};
  return tauriListen<T>(event, ({ payload }) => callback(payload));
}

export const claudeChat = {
  probe: (force = false): Promise<ClaudeChatProbeResult> => {
    if (!isTauriEnv()) {
      return Promise.resolve({
        ok: false,
        missing: 'desktop',
        detail: 'Claude Chat requires the desktop app.',
      });
    }
    return invoke<ClaudeChatProbeResult>('claude_chat_probe', { force });
  },

  start: (input: {
    cardId: string;
    cwd: string;
    sessionId?: string | null;
    forkSession?: boolean;
    model?: string | null;
    permissionMode?: string | null;
  }): Promise<ClaudeChatStartResult> =>
    invoke<ClaudeChatStartResult>('claude_chat_start', {
      cardId: input.cardId,
      cwd: input.cwd,
      sessionId: input.sessionId ?? null,
      forkSession: input.forkSession ?? false,
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? null,
    }),

  send: (
    cardId: string,
    text: string,
    images?: ClaudeChatImage[],
  ): Promise<void> =>
    invoke<void>('claude_chat_send', {
      cardId,
      text,
      images: images ?? null,
    }),

  interrupt: (cardId: string): Promise<void> =>
    invoke<void>('claude_chat_interrupt', { cardId }),

  setModel: (cardId: string, model?: string | null): Promise<void> =>
    invoke<void>('claude_chat_set_model', {
      cardId,
      model: model ?? null,
    }),

  setPermissionMode: (cardId: string, mode: string): Promise<void> =>
    invoke<void>('claude_chat_set_permission_mode', { cardId, mode }),

  decide: (input: {
    cardId: string;
    requestId: string;
    behavior: 'allow' | 'deny';
    updatedInput?: unknown;
    updatedPermissions?: unknown;
    message?: string | null;
  }): Promise<void> =>
    invoke<void>('claude_chat_decision', {
      cardId: input.cardId,
      requestId: input.requestId,
      behavior: input.behavior,
      updatedInput: input.updatedInput ?? null,
      updatedPermissions: input.updatedPermissions ?? null,
      message: input.message ?? null,
    }),

  stop: (cardId: string): Promise<void> =>
    invoke<void>('claude_chat_stop', { cardId }),

  history: (
    sessionId: string,
    dir?: string | null,
    limit?: number | null,
  ): Promise<{ totalMessages: number; messages: unknown[] }> =>
    invoke<{ totalMessages: number; messages: unknown[] }>(
      'claude_chat_history',
      {
        sessionId,
        dir: dir ?? null,
        limit: limit ?? null,
      },
    ),

  onEvent: (
    callback: (payload: ClaudeChatEventPayload) => void,
  ): Promise<() => void> =>
    listenIfDesktop<ClaudeChatEventPayload>(
      'claude-chat://event',
      callback,
    ),

  onRequest: (
    callback: (payload: ClaudeChatRequestPayload) => void,
  ): Promise<() => void> =>
    listenIfDesktop<ClaudeChatRequestPayload>(
      'claude-chat://request',
      callback,
    ),

  onDisconnected: (
    callback: (payload: ClaudeChatDisconnectedPayload) => void,
  ): Promise<() => void> =>
    listenIfDesktop<ClaudeChatDisconnectedPayload>(
      'claude-chat://disconnected',
      callback,
    ),
};
