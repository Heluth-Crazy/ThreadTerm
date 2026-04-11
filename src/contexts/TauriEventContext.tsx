import React, { createContext, useContext, useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { pty, ai, invoke } from '../lib/tauri-bridge';

// Match the message types from the old WebSocket protocol
export type AppMessageType =
  | 'claude-response'
  | 'claude-complete'
  | 'claude-error'
  | 'codex-response'
  | 'codex-complete'
  | 'codex-error'
  | 'session-created'
  | 'claude-permission-request'
  | 'claude-permission-cancelled'
  | 'token-budget'
  | 'session-aborted'
  | 'projects-updated'
  | 'file-changed'
  | 'git-status-changed'
  | 'error';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppMessage = Record<string, any> & {
  type: string;
  sessionId?: string;
};

/**
 * Matches the shape that WebSocketContext exposed so all consumers
 * can switch with a simple import-path change.
 */
interface TauriEventContextValue {
  ws: null; // always null — no real WebSocket in Tauri
  sendMessage: (message: unknown) => boolean;
  latestMessage: AppMessage | null;
  messageSequence: number;
  getBufferedMessagesSince: (sequence: number) => Array<{ sequence: number; message: AppMessage }>;
  isConnected: boolean;
}

const TauriEventContext = createContext<TauriEventContextValue | null>(null);

export const useWebSocket = () => {
  const context = useContext(TauriEventContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a TauriEventProvider');
  }
  return context;
};

// Alias
export const useTauriEvents = useWebSocket;

const MAX_BUFFERED = 5000;

export function TauriEventProvider({ children }: { children: React.ReactNode }) {
  const [latestMessage, setLatestMessage] = useState<AppMessage | null>(null);
  const [messageSequence, setMessageSequence] = useState(0);

  // Per-session JSONL line buffers
  const lineBuffers = useRef<Map<string, string>>(new Map());
  // ptyId → sessionId mapping (they may differ)
  const ptyToSession = useRef<Map<string, string>>(new Map());

  // Buffered messages for replay
  const bufferedRef = useRef<Array<{ sequence: number; message: AppMessage }>>([]);
  const seqRef = useRef(0);

  const pushMessage = useCallback((msg: AppMessage) => {
    const next = seqRef.current + 1;
    seqRef.current = next;
    if (bufferedRef.current.length >= MAX_BUFFERED) {
      bufferedRef.current.shift();
    }
    bufferedRef.current.push({ sequence: next, message: msg });
    setLatestMessage(msg);
    setMessageSequence(next);
  }, []);

  const getBufferedMessagesSince = useCallback((sequence: number) => {
    const norm = Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 0;
    return bufferedRef.current.filter((e) => e.sequence > norm);
  }, []);

  // ── Parse raw PTY output into structured messages ────────────────────────
  const parsePtyOutput = useCallback(
    (ptyId: string, rawData: string) => {
      const sessionId = ptyToSession.current.get(ptyId) ?? ptyId;

      const existing = lineBuffers.current.get(sessionId) ?? '';
      const combined = existing + rawData;
      const lines = combined.split('\n');

      // Keep last partial line
      lineBuffers.current.set(sessionId, lines[lines.length - 1]);

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line || !line.startsWith('{')) continue;

        try {
          const parsed = JSON.parse(line);
          const ptype: string = parsed.type ?? '';

          if (ptype === 'assistant' || ptype === 'content_block_delta' || ptype === 'content_block_start') {
            pushMessage({
              type: 'claude-response',
              sessionId,
              data: parsed,
              ...(parsed.message ? { message: parsed.message } : {}),
            });
          } else if (ptype === 'result') {
            pushMessage({
              type: 'claude-complete',
              sessionId,
              data: parsed,
              content: parsed.result,
            });
          } else if (ptype === 'error') {
            pushMessage({
              type: 'claude-error',
              sessionId,
              data: parsed,
              error: parsed.error?.message ?? 'Unknown error',
            });
          } else if (ptype === 'permission_request' || ptype === 'tool_approval_request') {
            pushMessage({
              type: 'claude-permission-request',
              sessionId,
              toolName: parsed.tool_name,
              toolInput: parsed.tool_input,
              input: parsed.tool_input,
              requestId: parsed.permission_id ?? parsed.id ?? '',
              permissionId: parsed.permission_id ?? parsed.id ?? '',
            });
          } else if (ptype === 'system' && parsed.session_id) {
            pushMessage({
              type: 'session-created',
              sessionId,
              claudeSessionId: parsed.session_id,
            });
          } else if (ptype === 'token_budget' || ptype === 'usage') {
            pushMessage({
              type: 'token-budget',
              sessionId,
              data: parsed,
              inputTokens: parsed.input_tokens,
              outputTokens: parsed.output_tokens,
            });
          }
          // Ignore unrecognised JSON lines (e.g. heartbeats)
        } catch {
          // Not valid JSON — raw terminal output, skip
        }
      }
    },
    [pushMessage],
  );

  // ── Listen to PTY events ─────────────────────────────────────────────────
  useEffect(() => {
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    pty
      .onOutput(({ id, data }) => {
        parsePtyOutput(id, data);
      })
      .then((u) => {
        unlistenOutput = u;
      });

    pty
      .onExit(({ id }) => {
        const sessionId = ptyToSession.current.get(id) ?? id;
        lineBuffers.current.delete(sessionId);
        ptyToSession.current.delete(id);
      })
      .then((u) => {
        unlistenExit = u;
      });

    return () => {
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, [parsePtyOutput]);

  // ── sendMessage (same shape as WebSocketContext) ─────────────────────────
  // The consumers send objects like:
  //   { type: 'claude-command', command: '...', options: { sessionId, ... } }
  //   { type: 'claude-permission-response', requestId, allow }
  //   { type: 'abort-session', sessionId, provider }
  //   { type: 'start-watching', projectPath }
  //   { type: 'stop-watching', projectPath }
  const sendMessage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (message: any): boolean => {
      if (!message || typeof message !== 'object') return false;
      const { type } = message;

      try {
        if (type === 'claude-command' || type === 'send-message' || type === 'codex-command' || type === 'send-codex-message') {
          const sid: string = message.options?.sessionId ?? '';
          if (!sid) return false;
          // Find ptyId for this session
          let ptyId: string | undefined;
          for (const [pid, s] of ptyToSession.current) {
            if (s === sid) { ptyId = pid; break; }
          }
          if (!ptyId) ptyId = sid; // fallback: ptyId === sessionId
          ai.sendMessage(ptyId, message.command ?? '').catch(() => {});
          return true;
        }

        if (type === 'abort-session') {
          const sid: string = message.sessionId ?? '';
          if (!sid) return false;
          let ptyId: string = sid;
          for (const [pid, s] of ptyToSession.current) {
            if (s === sid) { ptyId = pid; break; }
          }
          ai.abortSession(ptyId).catch(() => {});
          return true;
        }

        if (type === 'claude-permission-response') {
          const { requestId, allow } = message;
          const sid = message.sessionId ?? '';
          invoke('ai_approve_tool', {
            sessionId: sid,
            permissionId: requestId ?? '',
            approved: !!allow,
          }).catch(() => {});
          return true;
        }

        // File-watching is a no-op in Tauri — Rust handles it natively
        if (type === 'start-watching' || type === 'stop-watching') {
          return true;
        }

        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  // ── Expose a helper for starting sessions (used by higher-level code) ────
  // This isn't in the original WebSocket interface, but it's called by
  // TauriEventProvider internally when ai.startSession returns a ptyId.
  // External callers use `ai.startSession` from tauri-bridge directly
  // and then register the mapping:
  useEffect(() => {
    // Expose a way for components to register ptyId→sessionId mappings
    // via a global callback (lightweight; avoids prop drilling)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__registerPtySession = (ptyId: string, sessionId: string) => {
      ptyToSession.current.set(ptyId, sessionId);
    };
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__registerPtySession;
    };
  }, []);

  const value = useMemo<TauriEventContextValue>(
    () => ({
      ws: null,
      sendMessage,
      latestMessage,
      messageSequence,
      getBufferedMessagesSince,
      isConnected: true, // always connected in Tauri
    }),
    [sendMessage, latestMessage, messageSequence, getBufferedMessagesSince],
  );

  return (
    <TauriEventContext.Provider value={value}>
      {children}
    </TauriEventContext.Provider>
  );
}

export default TauriEventContext;
