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
 * Ids: new cards default to `TerminalCard.ptyId === TerminalCard.id`, but
 * event handling resolves by either field so legacy / restored cards do not
 * accidentally split the main terminal and floating overlay into two PTYs.
 */
import { useEffect, useRef } from 'react';
import { isTauriEnv, pty } from '../../lib/tauri-bridge';
import type {
  AttentionRequiredEvent,
  BlockFinishedEvent,
  BlockStartedEvent,
  SessionState,
} from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard, TerminalStatus } from '../../types/terminal';
import { feedHeadless, disposeHeadless, disposeAllHeadless } from './headlessPreview';
import { createCardOutputBuffer } from './outputBuffer';
import { buildCardPreview } from './cardPreview';
import { getMissingAiCliName } from './providerSession';
import { getAbsoluteCursorRow, readBufferRange } from './xtermRegistry';
import i18n from '../../i18n/config.js';
import { getPendingAutoRestart } from '../../lib/autoRestart';

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

// NOTE: the previous ANSI-strip-based reply extractor was removed. It
// could not handle full-screen TUIs (Claude, Codex) because those apps
// use cursor-positioning escape codes to redraw cells, which made the
// post-strip byte stream a garbled concatenation of every screen cell
// that was ever written.
//
// Preview extraction now happens via `feedHeadless` in ./headlessPreview,
// which maintains a headless xterm.js Terminal per session so we can
// read the actual rendered buffer rows — what the user sees on screen.
// ANSI stripping for `lastOutput` (used by the notification snippet
// fallback) still happens inside terminalStore.updateCardOutput.

// ── tuning constants ─────────────────────────────────────────────────────────

/** Minimum time in Running state before Running→Idle counts as a "reply". */
const REPLY_MIN_RUNNING_MS = 1500;

/** Minimum gap between two reply notifications for the same card. */
const REPLY_DEBOUNCE_MS = 3000;

/** Backend status reconciliation cadence for missed cross-webview events.
 *  `session-state-changed` events are the primary channel; this poll is only
 *  a fallback for events dropped across webviews, so a relaxed cadence is
 *  fine (audit P2-5: 2s → 5s, and one batch IPC instead of one per card). */
const SESSION_STATE_SYNC_MS = 5000;

/** Audit P0-2 — per-card output coalescing window. Store writes happen at
 *  most every OUTPUT_FLUSH_MS per card; the real xterm and the headless
 *  preview emulator still receive every chunk immediately. */
const OUTPUT_FLUSH_MS = 100;

interface RunningState {
  runningSince: number;
}

function isTransientStatus(status: TerminalStatus): boolean {
  return status === 'running' || status === 'waiting';
}

export function TerminalEventBridge(): null {
  const attentionDebounceRef = useRef<Map<string, number>>(new Map());
  /** Per-card state for the Running→Idle reply detector. */
  const runningStateRef = useRef<Map<string, RunningState>>(new Map());
  /** Per-card last reply notification timestamp, for debouncing. */
  const replyDebounceRef = useRef<Map<string, number>>(new Map());
  /** Last user-submit count already considered for reply notifications. */
  const replyInputCheckpointRef = useRef<Map<string, number>>(new Map());
  /** Last backend output sequence applied to preview/store per PTY id. */
  const lastOutputSeqRef = useRef<Map<string, number>>(new Map());
  /** Transient retry timers; persisted card state stores only serializable metadata. */
  const autoRestartTimersRef = useRef<Map<string, number>>(new Map());
  const bridgeMountedAtRef = useRef(Date.now());

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    let syncInFlight = false;

    // Resolve Rust PTY ids back to card ids. Most sessions are 1:1, but the
    // floating overlay must tolerate persisted cards where `ptyId` differs.
    function getCardForPtyId(ptyId: string) {
      return useTerminalStore
        .getState()
        .cards.find((card) => (card.ptyId || card.id) === ptyId);
    }

    // Audit P0-2 — coalesce per-chunk store writes. Flushes drop silently
    // when the card was removed while data was pending.
    const outputBuffer = createCardOutputBuffer(
      {
        flushOutput: (cardId, data) => {
          const store = useTerminalStore.getState();
          if (!store.cards.some((card) => card.id === cardId)) return;
          store.updateCardOutput(cardId, data);
        },
        flushPreview: (cardId, preview) => {
          const store = useTerminalStore.getState();
          if (!store.cards.some((card) => card.id === cardId)) return;
          store.updateCardReplyPreview(cardId, preview);
        },
      },
      OUTPUT_FLUSH_MS,
    );

    function clearAutoRestartTimer(cardId: string) {
      const timer = autoRestartTimersRef.current.get(cardId);
      if (timer === undefined) return;
      window.clearTimeout(timer);
      autoRestartTimersRef.current.delete(cardId);
    }

    function scheduleAutoRestart(card: TerminalCard, code: number) {
      const store = useTerminalStore.getState();
      const decision = store.scheduleCardAutoRestart(card.id, {
        exitCode: code,
        now: Date.now(),
      });
      if (!decision) return;

      if (decision.kind === 'limit-reached') {
        clearAutoRestartTimer(card.id);
        store.pushNotification({
          cardId: card.id,
          kind: 'failed',
          title: i18n.t('terminal:notifications.autoRestartLimitTitle', {
            project: card.projectName,
          }),
          body: i18n.t('terminal:notifications.autoRestartLimitBody', {
            max: decision.maxRetries,
          }),
        });
        store.markUnread(card.id, true);
        store.appendEvent(card.id, {
          kind: 'notification',
          summary: i18n.t('terminal:notifications.autoRestartLimitEvent', {
            max: decision.maxRetries,
          }),
        });
        return;
      }

      if (decision.kind !== 'schedule') return;

      clearAutoRestartTimer(card.id);
      const { attempt } = decision;
      const timer = window.setTimeout(() => {
        autoRestartTimersRef.current.delete(card.id);
        const latest = useTerminalStore.getState().getCardById(card.id);
        const pending = getPendingAutoRestart(latest?.autoRestart);
        if (!latest || !pending || pending.attempt !== attempt.attempt) return;
        useTerminalStore.getState().startCardAutoRestart(card.id, {
          attempt: attempt.attempt,
          now: Date.now(),
        });
      }, attempt.delayMs);
      autoRestartTimersRef.current.set(card.id, timer);
    }

    function getReplyInputCheckpoint(card: TerminalCard): number {
      const existing = replyInputCheckpointRef.current.get(card.id);
      if (existing !== undefined) return existing;

      // Existing/persisted cards may already have historical messageCount.
      // Treat those as already-seen so focus/resize redraws after app launch
      // cannot synthesize a "reply ready" notification for old content.
      const baseline = card.createdAt >= bridgeMountedAtRef.current - 1000 ? 0 : card.messageCount;
      replyInputCheckpointRef.current.set(card.id, baseline);
      return baseline;
    }

    function handleSessionState(ptyId: string, state: SessionState) {
      const store = useTerminalStore.getState();
      const card = getCardForPtyId(ptyId);
      if (!card) return;

      // The reply detector below reads lastReplyPreview/lastOutput through
      // buildCardPreview — drain any coalesced output first so the
      // notification snippet reflects the freshest content.
      outputBuffer.flushCard(card.id);

      const cardId = card.id;
      const prev = card.status;
      const next = mapSessionState(state);

      if (next === 'running' && !runningStateRef.current.has(cardId)) {
        runningStateRef.current.set(cardId, { runningSince: Date.now() });
      }

      store.updateCardStatus(cardId, next);

      if (next === 'running') {
        return;
      }

      // Detect Running → Idle transition = agent finished responding.
      if (prev === 'running' && next === 'idle') {
        const rs = runningStateRef.current.get(cardId) ?? { runningSince: card.lastActivity };
        runningStateRef.current.delete(cardId);

        const latestCard = getCardForPtyId(ptyId) ?? card;
        const inputCheckpoint = getReplyInputCheckpoint(latestCard);
        const currentInputCount = latestCard.messageCount;
        if (currentInputCount <= inputCheckpoint) return;

        // Consume this input generation even when the duration/debounce gates
        // below decide not to toast. Otherwise a later focus redraw could reuse
        // the same old input count and create a delayed false notification.
        replyInputCheckpointRef.current.set(cardId, currentInputCount);

        const dt = Date.now() - rs.runningSince;
        if (dt < REPLY_MIN_RUNNING_MS) return;

        const lastReply = replyDebounceRef.current.get(cardId) ?? 0;
        if (Date.now() - lastReply < REPLY_DEBOUNCE_MS) return;
        replyDebounceRef.current.set(cardId, Date.now());

        // Body = the freshest user-facing preview, with shell-startup noise
        // filtered the same way cards are filtered.
        const preview = buildCardPreview(latestCard, { maxLines: 3 });
        const snippet =
          preview.bodyLines.join('\n').trim() ||
          i18n.t('terminal:notifications.replyReadyBodyFallback');

        store.pushNotification({
          cardId,
          kind: 'completed',
          title: i18n.t('terminal:notifications.replyReadyTitle', { project: latestCard.projectName }),
          body: snippet.slice(0, 240),
        });
        store.markUnread(cardId, true);
        store.appendEvent(cardId, {
          kind: 'notification',
          summary: i18n.t('terminal:notifications.replyReadyEvent'),
        });
        return;
      }

      if (prev === 'running') {
        runningStateRef.current.delete(cardId);
      }
    }

    async function syncLiveSessionStates() {
      if (!isTauriEnv() || cancelled || syncInFlight) return;

      const cards = useTerminalStore.getState().cards;
      if (cards.length === 0) return;

      syncInFlight = true;
      try {
        // Audit P2-5 — one batch IPC covers every card instead of one
        // `getSessionState` round-trip per card.
        let states: Record<string, SessionState>;
        try {
          states = await pty.getAllSessionStates();
        } catch {
          // A batch failure is far more likely an IPC / window-lifecycle
          // problem than every PTY dying at once, so skip this round
          // instead of flipping transient cards back to idle.
          return;
        }
        if (cancelled) return;

        for (const card of cards) {
          const ptyId = card.ptyId || card.id;
          const state = states[ptyId];
          if (state !== undefined) {
            handleSessionState(ptyId, state);
            continue;
          }

          // Missing from the map = the PTY is no longer registered. Keep
          // the existing "missing pty → transient cards fall back to idle"
          // semantics (previously signalled by a per-card reject).
          const latest = useTerminalStore
            .getState()
            .cards.find((candidate) => candidate.id === card.id);
          if (!latest || !isTransientStatus(latest.status)) continue;

          runningStateRef.current.delete(latest.id);
          useTerminalStore.getState().updateCardStatus(latest.id, 'idle');
        }
      } finally {
        syncInFlight = false;
      }
    }

    const syncWhenVisible = () => {
      if (document.visibilityState === 'hidden') return;
      void syncLiveSessionStates();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncLiveSessionStates();
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'threadterm-terminal-store') return;
      void syncLiveSessionStates();
    };

    void syncLiveSessionStates();
    const syncTimer = window.setInterval(syncWhenVisible, SESSION_STATE_SYNC_MS);
    window.addEventListener('focus', syncWhenVisible);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('storage', onStorage);

    (async () => {
      // ── pty-output ─────────────────────────────────────────────────────
      //
      // Two independent streams:
      //   1. raw chunk → store.updateCardOutput (strips ANSI for the
      //      tiny `lastOutput` tail used by fallback previews + the
      //      Notifications panel).
      //   2. raw chunk → headless xterm.js → reads the buffer's last
      //      non-blank rows → store.updateCardReplyPreview. This is
      //      the clean, wrap-aware view the card UI shows; it mirrors
      //      what the real xterm in the main window is rendering.
      const unsubOutput = await pty.onOutput(({ id, data, seq }) => {
        const lastSeq = lastOutputSeqRef.current.get(id) ?? 0;
        if (seq <= lastSeq) return;
        lastOutputSeqRef.current.set(id, seq);

        const card = getCardForPtyId(id);
        if (!card) return;
        // Audit P0-2: store writes go through the coalescing buffer instead
        // of mutating `cards` once per chunk. The headless emulator still
        // sees every chunk so the preview stays frame-accurate.
        outputBuffer.pushChunk(card.id, data);
        feedHeadless(card.id, data, (preview) => {
          // Guard against late callbacks after the card was removed.
          if (!getCardForPtyId(id)) return;
          outputBuffer.pushPreview(card.id, preview);
        });
      });
      if (cancelled) {
        unsubOutput?.();
        return;
      }
      unlisteners.push(unsubOutput);

      // ── session-state-changed ─────────────────────────────────────────
      //
      // Also detects Running → Idle transitions that lasted longer than
      // REPLY_MIN_RUNNING_MS and fires a "reply ready" notification — this
      // is the only way users learn that an agent has finished answering
      // without babysitting the terminal.
      const unsubState = await pty.onStateChanged(({ ptyId, state }) => {
        handleSessionState(ptyId, state);
      });
      if (cancelled) {
        unsubState?.();
        return;
      }
      unlisteners.push(unsubState);

      // ── pty-exit → completed / failed ─────────────────────
      //
      // Exit-code semantics:
      //    code === 0                   → completed
      //    code > 0 (non-null)          → failed
      //    code === null | undefined    → idle
      //        (happens when we killed the PTY on purpose, e.g. user removed
      //         the card or the app went through a Shell.jsx remount; treating
      //         these as "failed" was the root cause of every card showing
      //         red after a navigation)
      const unsubExit = await pty.onExit(({ id, code }) => {
        const card = getCardForPtyId(id);
        if (!card) return;
        // Drain coalesced output BEFORE status/notification handling so the
        // exit notification snippet includes the final chunks.
        outputBuffer.flushCard(card.id);
        // Tear down the headless emulator so we don't leak ~60KB per
        // dead session. Safe no-op if the card never had output.
        disposeHeadless(card.id);
        let nextStatus: TerminalStatus;
        if (code === 0) nextStatus = 'completed';
        else if (typeof code === 'number' && code !== 0) nextStatus = 'failed';
        else nextStatus = 'idle';
        const store = useTerminalStore.getState();
        store.updateCardStatus(card.id, nextStatus);
        if (nextStatus === 'completed') {
          store.scheduleCardAutoRestart(card.id, { exitCode: 0, now: Date.now() });
        } else if (nextStatus === 'failed' && typeof code === 'number') {
          scheduleAutoRestart(card, code);
        }
        store.appendEvent(card.id, {
          kind: 'closed',
          summary:
            nextStatus === 'failed'
              ? i18n.t('terminal:notifications.processExited', { code })
              : nextStatus === 'completed'
                ? i18n.t('terminal:notifications.processCompleted')
                : i18n.t('terminal:notifications.sessionClosed'),
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
        const card = getCardForPtyId(ptyId);
        if (!card) return;
        const cardId = card.id;

        // frontend-side debounce to avoid notification spam even if the
        // Rust debounce window is short
        const now = Date.now();
        const last = attentionDebounceRef.current.get(cardId) ?? 0;
        if (now - last < 4000) return;
        attentionDebounceRef.current.set(cardId, now);

        const store = useTerminalStore.getState();

        // getMissingAiCliName inspects card.lastOutput — drain pending
        // chunks so the detection sees the freshest tail.
        outputBuffer.flushCard(cardId);

        const kind = type === 'error' ? 'failed' : 'waiting';
        const latestCard = store.getCardById(cardId) ?? card;
        const missingCli = kind === 'failed' ? getMissingAiCliName(latestCard, message) : null;
        const title = missingCli
          ? i18n.t('terminal:notifications.missingCliTitle', { cli: missingCli })
          : kind === 'failed'
            ? i18n.t('terminal:notifications.errorTitle', { project: card.projectName })
            : i18n.t('terminal:notifications.inputTitle', { project: card.projectName });

        store.pushNotification({
          cardId,
          kind,
          title,
          body: missingCli
            ? i18n.t('terminal:notifications.missingCliBody', { cli: missingCli })
            : message ||
              (kind === 'failed'
                ? i18n.t('terminal:notifications.errorBodyFallback')
                : i18n.t('terminal:notifications.inputBodyFallback')),
        });
        store.markUnread(cardId, true);
        store.appendEvent(cardId, { kind: 'notification', summary: title });
      });
      if (cancelled) {
        unsubAttention?.();
        return;
      }
      unlisteners.push(unsubAttention);

      const unsubBlockStarted = await pty.onBlockStarted((payload: BlockStartedEvent) => {
        const card = getCardForPtyId(payload.sessionId);
        if (!card) return;
        // Plan option A: read `baseY + cursorY` at event-arrival time. May
        // differ from the *exact* emit position by ≤ 1 row; Stage 4 renders
        // with a +1 tolerance. See `xtermRegistry.ts` for the trade-off.
        const bufferStart = getAbsoluteCursorRow(payload.sessionId);
        useTerminalStore.getState().recordBlockStarted({
          cardId: card.id,
          blockId: payload.blockId,
          command: payload.command,
          cwd: payload.cwd,
          startedAt: payload.startedAt,
          bufferStart,
        });
      });
      if (cancelled) {
        unsubBlockStarted?.();
        return;
      }
      unlisteners.push(unsubBlockStarted);

      const unsubBlockFinished = await pty.onBlockFinished((payload: BlockFinishedEvent) => {
        const card = getCardForPtyId(payload.sessionId);
        if (!card) return;
        const bufferEnd = getAbsoluteCursorRow(payload.sessionId);
        // Stage 5.1 — capture the command's output from the live xterm
        // buffer so the Block Inspector + cross-session search can reach
        // it later. `readBufferRange` returns '' when no terminal is
        // registered (floating-only / persisted cards), which is fine —
        // the store treats undefined-or-empty as "no snapshot".
        const cardBlocks = useTerminalStore.getState().blocks?.[card.id] ?? [];
        const started = cardBlocks.find((b) => b.id === payload.blockId);
        const rawOutput = started
          ? readBufferRange(payload.sessionId, started.bufferStart, bufferEnd)
          : '';
        useTerminalStore.getState().recordBlockFinished({
          cardId: card.id,
          blockId: payload.blockId,
          exitCode: payload.exitCode,
          finishedAt: payload.finishedAt,
          durationMs: payload.durationMs,
          bufferEnd,
          output: rawOutput || undefined,
        });
      });
      if (cancelled) {
        unsubBlockFinished?.();
        return;
      }
      unlisteners.push(unsubBlockFinished);
    })().catch((err) => {
      // Surfacing the error is not critical — the bridge simply won't update
      // the store. Log for diagnosis.
      // eslint-disable-next-line no-console
      console.error('[TerminalEventBridge] failed to attach listeners:', err);
    });

    const unsubscribeAutoRestart = useTerminalStore.subscribe((state) => {
      for (const cardId of autoRestartTimersRef.current.keys()) {
        const card = state.cards.find((candidate) => candidate.id === cardId);
        if (!card || !getPendingAutoRestart(card.autoRestart)) {
          clearAutoRestartTimer(cardId);
        }
      }
    });

    return () => {
      cancelled = true;
      window.clearInterval(syncTimer);
      window.removeEventListener('focus', syncWhenVisible);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('storage', onStorage);
      unsubscribeAutoRestart();
      for (const un of unlisteners) {
        try {
          un();
        } catch {
          /* noop */
        }
      }
      unlisteners.length = 0;
      // Flush whatever is still buffered so the persisted preview reflects
      // the last output seen before unmount / HMR.
      outputBuffer.dispose();
      // Hot-reload / bridge unmount: drop all headless emulators so we
      // don't accumulate duplicate listeners across HMR cycles.
      disposeAllHeadless();
      for (const timer of autoRestartTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      autoRestartTimersRef.current.clear();
    };
  }, []);

  return null;
}
