import React, { createContext, useContext, useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { pty, ai, invoke, isTauriEnv } from '../lib/tauri-bridge';
import type { SessionState, AttentionRequiredEvent, LoopState } from '../lib/tauri-bridge';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import { useLoopStore } from '../stores/loopStore';
import { useTTS } from '../hooks/useTTS';

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
  sessionStates: Map<string, SessionState>;
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

function loadCodexThreadIds(): Map<string, string> {
  try {
    const stored = localStorage.getItem('codex_thread_ids');
    if (stored) {
      const obj = JSON.parse(stored);
      if (obj && typeof obj === 'object') {
        return new Map(Object.entries(obj));
      }
    }
  } catch { /* ignore corrupt data */ }
  return new Map();
}

function saveCodexThreadIds(map: Map<string, string>): void {
  try {
    const obj = Object.fromEntries(map);
    localStorage.setItem('codex_thread_ids', JSON.stringify(obj));
  } catch { /* ignore */ }
}

function loadClaudeResumeIds(): Map<string, string> {
  try {
    const stored = localStorage.getItem('claude_resume_ids');
    if (stored) {
      const obj = JSON.parse(stored);
      if (obj && typeof obj === 'object') {
        return new Map(Object.entries(obj));
      }
    }
  } catch { /* ignore corrupt data */ }
  return new Map();
}

function saveClaudeResumeIds(map: Map<string, string>): void {
  try {
    const obj = Object.fromEntries(map);
    localStorage.setItem('claude_resume_ids', JSON.stringify(obj));
  } catch { /* ignore */ }
}

export function TauriEventProvider({ children }: { children: React.ReactNode }) {
  const [latestMessage, setLatestMessage] = useState<AppMessage | null>(null);
  const [messageSequence, setMessageSequence] = useState(0);

  // TTS for attention notifications
  const { speak } = useTTS();
  const ttsEnabledRef = useRef(false);

  // Keep ttsEnabled in sync with localStorage
  useEffect(() => {
    const stored = localStorage.getItem('openwork-tts-enabled');
    ttsEnabledRef.current = stored === 'true';

    const onStorage = (e: StorageEvent) => {
      if (e.key === 'openwork-tts-enabled') {
        ttsEnabledRef.current = e.newValue === 'true';
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Session state tracking
  const sessionStatesRef = useRef<Map<string, SessionState>>(new Map());
  const [sessionStates, setSessionStates] = useState<Map<string, SessionState>>(new Map());

  // Per-session JSONL line buffers
  const lineBuffers = useRef<Map<string, string>>(new Map());
  // ptyId → sessionId mapping (they may differ)
  const ptyToSession = useRef<Map<string, string>>(new Map());
  // originalSessionId → Codex thread_id for multi-turn resume (persisted to localStorage)
  const codexThreadIds = useRef<Map<string, string>>(loadCodexThreadIds());
  // panelSessionId → Claude real session_id for multi-turn resume (persisted to localStorage)
  const claudeResumeIds = useRef<Map<string, string>>(loadClaudeResumeIds());

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
      let sessionId = ptyToSession.current.get(ptyId) ?? ptyId;

      // Key line buffers by ptyId (not sessionId) to prevent cross-PTY corruption
      // when multiple PTYs map to the same logical session.
      const existing = lineBuffers.current.get(ptyId) ?? '';
      const combined = existing + rawData;
      const lines = combined.split('\n');

      // Keep last partial line
      lineBuffers.current.set(ptyId, lines[lines.length - 1]);

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line || !line.startsWith('{')) continue;

        try {
          const parsed = JSON.parse(line);
          const ptype: string = parsed.type ?? '';

          if (ptype === 'thread.started' && typeof parsed.thread_id === 'string') {
            const originalSessionId = sessionId;
            sessionId = parsed.thread_id;
            ptyToSession.current.set(ptyId, sessionId);
            // Track originalSessionId → thread_id and thread_id → thread_id for Codex resume
            codexThreadIds.current.set(originalSessionId, parsed.thread_id);
            codexThreadIds.current.set(parsed.thread_id, parsed.thread_id);
            saveCodexThreadIds(codexThreadIds.current);
            pushMessage({
              type: 'session-created',
              sessionId,
              originalSessionId,
            });
            continue;
          }

          if (ptype === 'turn.started') {
            pushMessage({
              type: 'codex-response',
              sessionId,
              data: { type: 'turn_started' },
            });
            continue;
          }

          if (ptype === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
            const item = parsed.item;
            const itemType = typeof item.type === 'string' ? item.type : '';
            const data =
              itemType === 'agent_message'
                ? {
                    itemType,
                    message: {
                      content:
                        typeof item.text === 'string'
                          ? item.text
                          : typeof item.message === 'string'
                            ? item.message
                            : '',
                    },
                  }
                : {
                    itemType,
                    ...item,
                  };

            pushMessage({
              type: 'codex-response',
              sessionId,
              data,
            });
            continue;
          }

          if (ptype === 'turn.completed') {
            pushMessage({
              type: 'codex-complete',
              sessionId,
              data: parsed,
            });
            continue;
          }

          if (ptype === 'error') {
            pushMessage({
              type: 'codex-error',
              sessionId,
              data: parsed,
              error: parsed.message ?? parsed.error?.message ?? 'Unknown error',
            });
            continue;
          }

          if (
            ptype === 'assistant' || ptype === 'content_block_delta' ||
            ptype === 'content_block_start' || ptype === 'content_block_stop' ||
            ptype === 'message_stop' || ptype === 'message_delta'
          ) {
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
            // Store Claude session ID for resume in subsequent chat messages
            const realClaudeId: string = parsed.session_id;
            claudeResumeIds.current.set(sessionId, realClaudeId);
            claudeResumeIds.current.set(realClaudeId, realClaudeId);
            saveClaudeResumeIds(claudeResumeIds.current);

            const originalSessionId = sessionId !== realClaudeId ? sessionId : undefined;
            ptyToSession.current.set(ptyId, realClaudeId);
            sessionId = realClaudeId;

            pushMessage({
              type: 'session-created',
              sessionId: realClaudeId,
              originalSessionId,
              claudeSessionId: realClaudeId,
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
    let unlistenStateChanged: (() => void) | null = null;
    let unlistenAttention: (() => void) | null = null;

    pty
      .onOutput(({ id, data }) => {
        parsePtyOutput(id, data);
      })
      .then((u) => {
        unlistenOutput = u;
      });

    pty
      .onExit(({ id }) => {
        lineBuffers.current.delete(id);
        ptyToSession.current.delete(id);
      })
      .then((u) => {
        unlistenExit = u;
      });

    pty
      .onStateChanged(({ ptyId, state }) => {
        const sessionId = ptyToSession.current.get(ptyId) ?? ptyId;
        sessionStatesRef.current.set(sessionId, state);
        setSessionStates(new Map(sessionStatesRef.current));

        // Map Rust SessionState to the existing sessionStatusStore
        const statusStore = useSessionStatusStore.getState();
        if (state === 'Running') {
          statusStore.setProcessing(sessionId);
        } else if (state === 'Completed') {
          statusStore.setCompleted(sessionId);
        } else if (state === 'Failed') {
          statusStore.setNeedsAttention(sessionId, 'error');
        } else if (state === 'WaitingForInput') {
          statusStore.setNeedsAttention(sessionId, 'permission');
        } else if (state === 'Idle') {
          statusStore.setIdle(sessionId);
        }
      })
      .then((u) => {
        unlistenStateChanged = u;
      });

    pty
      .onAttentionRequired((payload: import('../lib/tauri-bridge').AttentionRequiredEvent) => {
        const sessionId = ptyToSession.current.get(payload.ptyId) ?? payload.ptyId;
        const statusStore = useSessionStatusStore.getState();
        if (payload.type === 'waiting') {
          statusStore.setNeedsAttention(sessionId, 'permission');
        } else if (payload.type === 'error') {
          statusStore.setNeedsAttention(sessionId, 'error');
        }

        if (ttsEnabledRef.current) {
          const shortId = sessionId.slice(0, 8);
          speak(`Session ${shortId} needs your attention`);
        }
      })
      .then((u) => {
        unlistenAttention = u;
      });

    // Listen for loop-state-changed events
    let unlistenLoop: (() => void) | null = null;
    const loopCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    if (isTauriEnv()) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen<LoopState>('loop-state-changed', (event) => {
          const loopState = event.payload;
          const store = useLoopStore.getState();
          store.updateLoop(loopState.loopId, loopState);

          // Auto-remove loops in terminal state after a delay so the user can see the result
          const isTerminal = loopState.status === 'passed' || loopState.status === 'failed' || loopState.status === 'cancelled';
          if (isTerminal) {
            if (!loopCleanupTimers.has(loopState.loopId)) {
              const timer = setTimeout(() => {
                useLoopStore.getState().removeLoop(loopState.loopId);
                loopCleanupTimers.delete(loopState.loopId);
              }, 15_000);
              loopCleanupTimers.set(loopState.loopId, timer);
            }
          }
        }).then((u) => {
          unlistenLoop = u;
        });
      });
    }

    return () => {
      unlistenOutput?.();
      unlistenExit?.();
      unlistenStateChanged?.();
      unlistenAttention?.();
      unlistenLoop?.();
      loopCleanupTimers.forEach((timer) => clearTimeout(timer));
      loopCleanupTimers.clear();
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

          const inferredProvider =
            type === 'codex-command' || type === 'send-codex-message'
              ? 'codex'
              : 'claude';
          const provider: string = message.options?.provider ?? inferredProvider;
          const projectPath: string = message.options?.projectPath ?? '';
          const resumeId: string | undefined = message.options?.resumeSessionId;

          if (provider === 'codex') {
            // Always use exec mode for chat messages — this produces structured
            // JSON output that parsePtyOutput can handle → chat panel gets real responses.
            const codexSid = sid || `codex-${Date.now()}`;
            const doCodexSend = async () => {
              const threadId = codexThreadIds.current.get(codexSid);
              const ptyId = await ai.runCodexExec(codexSid, projectPath, message.command ?? '', threadId || resumeId);
              ptyToSession.current.set(ptyId, codexSid);

              // If there is also an interactive PTY for this session (split-view),
              // mirror the message there so it appears in the terminal too.
              if (sid) {
                for (const [pid, s] of ptyToSession.current) {
                  if (s === sid && pid !== ptyId) {
                    // Found the interactive TUI PTY (not the exec PTY we just created)
                    const cmdText = message.command ?? '';
                    try {
                      await pty.input(pid, cmdText);
                      await new Promise((r) => setTimeout(r, 100));
                      await pty.input(pid, '\r');
                    } catch {
                      // Interactive PTY write failed — non-fatal, exec response still works
                    }
                    break;
                  }
                }
              }
            };
            doCodexSend().catch(console.error);
            return true;
          }

          if (provider === 'claude') {
            // Use print + stream-json mode for chat messages — this produces structured
            // JSON output that parsePtyOutput can handle → chat panel gets real responses.
            // The interactive TUI PTY (Shell.jsx) remains separate for terminal rendering.
            const claudeSid = sid || `claude-${Date.now()}`;
            const doClaudeSend = async () => {
              // Resolve the real Claude session ID for multi-turn resume
              const effectiveResumeId = claudeResumeIds.current.get(claudeSid) || resumeId || sid || undefined;
              const streamArgs: string[] = ['-p', '--output-format', 'stream-json'];
              if (message.options?.model) {
                streamArgs.push('--model', message.options.model);
              }
              if (message.options?.permissionMode) {
                streamArgs.push('--permission-mode', message.options.permissionMode);
              }
              const sessionArgs = message.options?.sessionArgs;
              if (Array.isArray(sessionArgs)) {
                streamArgs.push(...sessionArgs);
              }
              streamArgs.push(message.command ?? '');

              const ptyId = await ai.startSession(
                `claude-chat-${Date.now()}`,
                'claude',
                projectPath,
                effectiveResumeId,
                streamArgs,
              );
              ptyToSession.current.set(ptyId, claudeSid);

              // Mirror the message to the interactive TUI PTY so it appears in the terminal too
              if (sid) {
                for (const [pid, s] of ptyToSession.current) {
                  if (s === sid && pid !== ptyId) {
                    try {
                      await pty.input(pid, (message.command ?? '') + '\r');
                    } catch {
                      // Interactive PTY write failed — non-fatal
                    }
                    break;
                  }
                }
              }
            };
            doClaudeSend().catch((err) => {
              console.error('Claude stream failed:', err);
              pushMessage({
                type: 'claude-error',
                sessionId: claudeSid,
                error: String(err),
              });
            });
            return true;
          }

          // Cursor and other providers: interactive PTY mode
          if (!sid) return false;

          let existingPtyId: string | undefined;
          for (const [pid, s] of ptyToSession.current) {
            if (s === sid) { existingPtyId = pid; break; }
          }

          const doSend = async () => {
            let ptyId = existingPtyId;
            if (!ptyId) {
              try {
                ptyId = await ai.startSession(sid, provider, projectPath, resumeId);
                ptyToSession.current.set(ptyId, sid);
              } catch (e) {
                console.error('Failed to start AI session:', e);
                return;
              }
            }
            await ai.sendMessage(ptyId, message.command ?? '', provider);
          };

          doSend().catch(console.error);
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
      sessionStates,
    }),
    [sendMessage, latestMessage, messageSequence, getBufferedMessagesSince, sessionStates],
  );

  return (
    <TauriEventContext.Provider value={value}>
      {children}
    </TauriEventContext.Provider>
  );
}

export default TauriEventContext;
