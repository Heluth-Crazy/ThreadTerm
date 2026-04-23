/**
 * TerminalEventBridge
 *
 * Headless component that subscribes to Tauri PTY events and keeps the
 * {@link useTerminalStore} in sync with the Rust backend's view of each
 * session. It does not render anything.
 *
 * Wiring:
 *   pty-output                  → updateCardOutput + updateCardReplyPreview
 *   session-state-changed       → updateCardStatus
 *   attention-required          → pushNotification + markUnread
 *   pty-exit                    → updateCardStatus('completed' | 'failed')
 *
 * Ids: the frontend `TerminalCard.id` is used as the Rust session id (ptyId)
 * when creating sessions, so the mapping is 1:1 and lookup by ptyId is direct.
 */
import { useEffect, useRef } from 'react';
import { pty } from '../../lib/tauri-bridge';
import type { AttentionRequiredEvent, SessionState } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalStatus } from '../../types/terminal';

// Map Rust SessionState → UI TerminalStatus.
function mapSessionState(state: SessionState): TerminalStatus {
  switch (state) {
    case 'Running':
      return 'running';
    case 'WaitingForInput':
      return 'waiting';
    case 'Completed':
      return 'completed';
    case 'Failed':
      return 'failed';
    case 'Idle':
    default:
      return 'idle';
  }
}

// Extract a compact "assistant reply" preview from a chunk of output.
//
// For plain shells we just take the tail of the ANSI-stripped output.
// For AI CLIs that print prompt markers (e.g. "▌ Assistant:", "Claude:"),
// try to take lines after the marker. This is a best-effort heuristic.
function extractReplyPreview(existing: string, chunk: string): string {
  const combined = (existing + chunk).replace(/\r/g, '');
  const lines = combined.split('\n').filter((l) => l.trim().length > 0);
  // Keep last ~5 non-empty lines, truncated.
  const tail = lines.slice(-5);
  return tail.join('\n').slice(-500);
}

export function TerminalEventBridge(): null {
  const bufferRef = useRef<Map<string, string>>(new Map());
  const attentionDebounceRef = useRef<Map<string, number>>(new Map());

  // On first mount, any cards that were persisted as `running`, `waiting`,
  // or `failed` are stale — their PTY died when the app was closed. Reset
  // them to `idle` so the UI reflects reality, and record a timeline event
  // so the user can see why the state changed.
  useEffect(() => {
    const store = useTerminalStore.getState();
    for (const card of store.cards) {
      if (card.status === 'running' || card.status === 'waiting') {
        store.updateCardStatus(card.id, 'idle');
        store.appendEvent(card.id, {
          kind: 'status',
          summary: 'session reset on app restart',
        });
      }
    }
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    // Helper to check if the given ptyId corresponds to a known card.
    function hasCard(ptyId: string): boolean {
      return !!useTerminalStore.getState().getCardById(ptyId);
    }

    (async () => {
      // ── pty-output ─────────────────────────────────────────────────────
      const unsubOutput = await pty.onOutput(({ id, data }) => {
        if (!hasCard(id)) return;
        const store = useTerminalStore.getState();
        store.updateCardOutput(id, data);
        // maintain a rolling per-card buffer for reply-preview extraction
        const buf = bufferRef.current.get(id) ?? '';
        const next = (buf + data).slice(-2000);
        bufferRef.current.set(id, next);
        store.updateCardReplyPreview(id, extractReplyPreview('', next));
      });
      if (cancelled) {
        unsubOutput?.();
        return;
      }
      unlisteners.push(unsubOutput);

      // ── session-state-changed ─────────────────────────────────────────
      const unsubState = await pty.onStateChanged(({ ptyId, state }) => {
        if (!hasCard(ptyId)) return;
        const mapped = mapSessionState(state);
        useTerminalStore.getState().updateCardStatus(ptyId, mapped);
      });
      if (cancelled) {
        unsubState?.();
        return;
      }
      unlisteners.push(unsubState);

      // ── pty-exit → completed / failed ─────────────────────────────────
      const unsubExit = await pty.onExit(({ id, code }) => {
        if (!hasCard(id)) return;
        const nextStatus: TerminalStatus = code && code !== 0 ? 'failed' : 'completed';
        const store = useTerminalStore.getState();
        store.updateCardStatus(id, nextStatus);
        store.appendEvent(id, {
          kind: 'closed',
          summary:
            nextStatus === 'failed'
              ? `process exited with code ${code ?? '?'}`
              : 'process completed',
        });
      });
      if (cancelled) {
        unsubExit?.();
        return;
      }
      unlisteners.push(unsubExit);

      // ── attention-required → notification + unread flag ───────────────
      const unsubAttention = await pty.onAttentionRequired((payload: AttentionRequiredEvent) => {
        const { ptyId, type, message } = payload;
        if (!hasCard(ptyId)) return;

        // frontend-side debounce to avoid notification spam even if the
        // Rust debounce window is short
        const now = Date.now();
        const last = attentionDebounceRef.current.get(ptyId) ?? 0;
        if (now - last < 4000) return;
        attentionDebounceRef.current.set(ptyId, now);

        const store = useTerminalStore.getState();
        const card = store.getCardById(ptyId);
        if (!card) return;

        const kind = type === 'error' ? 'failed' : 'waiting';
        const title =
          kind === 'failed'
            ? `⚠ ${card.projectName} reported an error`
            : `• ${card.projectName} needs your input`;

        store.pushNotification({
          cardId: ptyId,
          kind,
          title,
          body: message || (kind === 'failed' ? 'Error detected in output' : 'Awaiting input'),
        });
        store.markUnread(ptyId, true);
        store.appendEvent(ptyId, { kind: 'notification', summary: title });
      });
      if (cancelled) {
        unsubAttention?.();
        return;
      }
      unlisteners.push(unsubAttention);
    })().catch((err) => {
      // Surfacing the error is not critical — the bridge simply won't update
      // the store. Log for diagnosis.
      // eslint-disable-next-line no-console
      console.error('[TerminalEventBridge] failed to attach listeners:', err);
    });

    return () => {
      cancelled = true;
      for (const un of unlisteners) {
        try {
          un();
        } catch {
          /* noop */
        }
      }
      unlisteners.length = 0;
    };
  }, []);

  return null;
}
