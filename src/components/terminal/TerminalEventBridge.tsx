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
  SessionState,
} from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard, TerminalStatus } from '../../types/terminal';
import {
  feedHeadless,
  disposeHeadless,
  disposeAllHeadless,
  getHeadlessPreviewDiagnostics,
  readHeadlessPreview,
} from './headlessPreview';
import { createCardOutputBuffer } from './outputBuffer';
import { createOutputAcknowledger } from './outputAcknowledger';
import { createPtyRuntimeLifecycle } from './ptyRuntimeLifecycle';
import { buildCardPreview } from './cardPreview';
import { getMissingAiCliName } from './providerSession';
import i18n from '../../i18n/config';
import { getPendingAutoRestart } from '../../lib/autoRestart';
import { logger } from '../../lib/logger';
import {
  buildInteractionEpisodeKey,
  normalizeNotificationFingerprint,
} from '../../lib/osNotificationPolicy';
import {
  listenManagedStateChanges,
  MANAGED_STATE_KEYS,
} from '../../lib/managedState';

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
const MAX_PENDING_BACKGROUND_OUTPUT_BYTES = 4 * 1024 * 1024;

interface RunningState {
  runningSince: number;
}

interface AttentionEpisode {
  generation: number;
  fingerprints: Set<string>;
}

export interface TerminalEventBridgeDiagnostics {
  activeRuntimeCount: number;
  activeRuntimeIds: string[];
  activeHeadlessCount: number;
  pendingOutputCardCount: number;
  pendingAckCount: number;
  lastOutputSeqCount: number;
  lastProcessedOutputSeqCount: number;
  autoRestartTimerCount: number;
  pendingBackgroundOutputCount: number;
  pendingBackgroundOutputBytes: number;
  backgroundOutputGapCount: number;
}

const EMPTY_DIAGNOSTICS: TerminalEventBridgeDiagnostics = {
  activeRuntimeCount: 0,
  activeRuntimeIds: [],
  activeHeadlessCount: 0,
  pendingOutputCardCount: 0,
  pendingAckCount: 0,
  lastOutputSeqCount: 0,
  lastProcessedOutputSeqCount: 0,
  autoRestartTimerCount: 0,
  pendingBackgroundOutputCount: 0,
  pendingBackgroundOutputBytes: 0,
  backgroundOutputGapCount: 0,
};

let readBridgeDiagnostics = (): TerminalEventBridgeDiagnostics => ({ ...EMPTY_DIAGNOSTICS });

/** Read-only dev/test snapshot; production hot paths do not update counters. */
export function getTerminalEventBridgeDiagnostics(): TerminalEventBridgeDiagnostics {
  return readBridgeDiagnostics();
}

function isTransientStatus(status: TerminalStatus): boolean {
  return status === 'running' || status === 'waiting';
}

export function TerminalEventBridge(): null {
  const attentionEpisodesRef = useRef<Map<string, AttentionEpisode>>(new Map());
  /** Per-card state for the Running→Idle reply detector. */
  const runningStateRef = useRef<Map<string, RunningState>>(new Map());
  /** Per-card last reply notification timestamp, for debouncing. */
  const replyDebounceRef = useRef<Map<string, number>>(new Map());
  /** Last user-submit count already considered for reply notifications. */
  const replyInputCheckpointRef = useRef<Map<string, number>>(new Map());
  /** Last backend output sequence applied to preview/store per PTY id. */
  const lastOutputSeqRef = useRef<Map<string, number>>(new Map());
  /** Last sequence fully processed by the headless/background consumer. */
  const lastProcessedOutputSeqRef = useRef<Map<string, number>>(new Map());
  /** Transient retry timers; persisted card state stores only serializable metadata. */
  const autoRestartTimersRef = useRef<Map<string, number>>(new Map());
  const bridgeMountedAtRef = useRef(Date.now());

  useEffect(() => {
    // Effect replay/HMR creates a new ACK transport. Forget the prior
    // in-memory watermarks so the mount-time atomic snapshot is processed and
    // cumulatively ACKed again even if the previous transport failed mid-send.
    lastOutputSeqRef.current.clear();
    lastProcessedOutputSeqRef.current.clear();
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    let syncInFlight = false;
    let backgroundSnapshotReady = false;
    const pendingBackgroundOutput: Array<{
      id: string;
      data: string;
      seq: number;
      byteLength: number;
    }> = [];
    const droppedBackgroundThrough = new Map<string, number>();
    let pendingBackgroundOutputBytes = 0;
    let backgroundOutputGapCount = 0;
    let lastSnapshotSessionIds = new Set<string>();
    const attentionEpisodes = attentionEpisodesRef.current;
    const runningState = runningStateRef.current;
    const replyDebounce = replyDebounceRef.current;
    const replyInputCheckpoint = replyInputCheckpointRef.current;
    const lastOutputSeq = lastOutputSeqRef.current;
    const lastProcessedOutputSeq = lastProcessedOutputSeqRef.current;
    const autoRestartTimers = autoRestartTimersRef.current;

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
        flushCardUpdate: (cardId, data, preview) => {
          const store = useTerminalStore.getState();
          if (!store.cards.some((card) => card.id === cardId)) return;
          store.updateCardOutputAndPreview(cardId, data, preview);
        },
      },
      OUTPUT_FLUSH_MS,
    );
    const outputAcknowledger = createOutputAcknowledger((request) =>
      pty.ack(
        request.id,
        request.throughSeq,
        request.consumerKind,
        request.consumerId,
      ),
    );

    const lifecycle = createPtyRuntimeLifecycle((runtime) => {
      disposeHeadless(runtime.cardId);
      outputBuffer.discardCard(runtime.cardId);
      outputAcknowledger.discard(runtime.ptyId);
      lastOutputSeqRef.current.delete(runtime.ptyId);
      lastProcessedOutputSeqRef.current.delete(runtime.ptyId);
      attentionEpisodesRef.current.delete(runtime.cardId);
      runningStateRef.current.delete(runtime.cardId);
      replyDebounceRef.current.delete(runtime.cardId);
      replyInputCheckpointRef.current.delete(runtime.cardId);
      clearAutoRestartTimer(runtime.cardId);
      for (let index = pendingBackgroundOutput.length - 1; index >= 0; index -= 1) {
        if (pendingBackgroundOutput[index].id === runtime.ptyId) {
          const [removed] = pendingBackgroundOutput.splice(index, 1);
          pendingBackgroundOutputBytes = Math.max(
            0,
            pendingBackgroundOutputBytes - removed.byteLength,
          );
        }
      }
      droppedBackgroundThrough.delete(runtime.ptyId);
    });

    const diagnosticsReader = (): TerminalEventBridgeDiagnostics => {
      const runtime = lifecycle.getDiagnostics();
      return {
        activeRuntimeCount: runtime.activeCount,
        activeRuntimeIds: runtime.runtimes.map((entry) => entry.ptyId),
        activeHeadlessCount: getHeadlessPreviewDiagnostics().activeCount,
        pendingOutputCardCount: outputBuffer.getDiagnostics().pendingCardCount,
        pendingAckCount: outputAcknowledger.getDiagnostics().pendingCount,
        lastOutputSeqCount: lastOutputSeqRef.current.size,
        lastProcessedOutputSeqCount: lastProcessedOutputSeqRef.current.size,
        autoRestartTimerCount: autoRestartTimersRef.current.size,
        pendingBackgroundOutputCount: pendingBackgroundOutput.length,
        pendingBackgroundOutputBytes,
        backgroundOutputGapCount,
      };
    };
    readBridgeDiagnostics = diagnosticsReader;

    const acknowledgeBackgroundOutput = (id: string, seq: number, generation: number) => {
      if (cancelled) return;
      if (!lifecycle.isCurrent(id, generation)) {
        // The card/session was disposed while xterm was draining this chunk.
        // The backend session is normally being killed, but preserve the
        // missing-card tail ACK contract without recreating retry state.
        void pty.ack(id, seq, 'background').catch(() => {});
        return;
      }
      const processed = lastProcessedOutputSeqRef.current.get(id) ?? 0;
      lastProcessedOutputSeqRef.current.set(id, Math.max(processed, seq));
      outputAcknowledger.ack({ id, throughSeq: seq, consumerKind: 'background' });
    };

    const acknowledgeMissingBackgroundOutput = (id: string, seq: number) => {
      if (cancelled) return;
      outputAcknowledger.ack({ id, throughSeq: seq, consumerKind: 'background' });
    };

    const queuePendingBackgroundOutput = (
      output: { id: string; data: string; seq: number },
    ) => {
      const byteLength = new TextEncoder().encode(output.data).byteLength;
      pendingBackgroundOutput.push({ ...output, byteLength });
      pendingBackgroundOutputBytes += byteLength;

      while (
        pendingBackgroundOutputBytes > MAX_PENDING_BACKGROUND_OUTPUT_BYTES &&
        pendingBackgroundOutput.length > 0
      ) {
        const dropped = pendingBackgroundOutput.shift();
        if (!dropped) break;
        pendingBackgroundOutputBytes = Math.max(
          0,
          pendingBackgroundOutputBytes - dropped.byteLength,
        );
        droppedBackgroundThrough.set(
          dropped.id,
          Math.max(droppedBackgroundThrough.get(dropped.id) ?? 0, dropped.seq),
        );
        backgroundOutputGapCount += 1;
        if (
          backgroundOutputGapCount === 1 ||
          (backgroundOutputGapCount & (backgroundOutputGapCount - 1)) === 0
        ) {
          logger.warn(
            '[TerminalEventBridge] Background output queue reached its memory limit; awaiting an authoritative snapshot.',
            {
              droppedChunks: backgroundOutputGapCount,
              pendingBytes: pendingBackgroundOutputBytes,
            },
          );
        }
      }
    };

    const backgroundGapsCoveredBySnapshot = () => {
      for (const [id, droppedThrough] of droppedBackgroundThrough) {
        if (!getCardForPtyId(id) || !lastSnapshotSessionIds.has(id)) {
          logger.warn(
            '[TerminalEventBridge] Background preview gap could not be snapshot-recovered because the PTY is no longer live.',
            { id, droppedThrough },
          );
          droppedBackgroundThrough.delete(id);
          continue;
        }
        if ((lastProcessedOutputSeqRef.current.get(id) ?? 0) < droppedThrough) {
          return false;
        }
        droppedBackgroundThrough.delete(id);
      }
      return true;
    };

    const processBackgroundOutput = ({ id, data, seq }: { id: string; data: string; seq: number }) => {
      const card = getCardForPtyId(id);
      if (!card) {
        acknowledgeMissingBackgroundOutput(id, seq);
        return;
      }
      const runtime = lifecycle.activate(id, card.id);
      const lastSeq = lastOutputSeqRef.current.get(id) ?? 0;
      if (seq <= lastSeq) {
        if (seq <= (lastProcessedOutputSeqRef.current.get(id) ?? 0)) {
          acknowledgeBackgroundOutput(id, seq, runtime.generation);
        }
        return;
      }
      lastOutputSeqRef.current.set(id, seq);

      outputBuffer.pushChunk(card.id, data);
      if (!data) {
        acknowledgeBackgroundOutput(id, seq, runtime.generation);
        return;
      }
      try {
        feedHeadless(card.id, data, () => {
          if (
            !cancelled &&
            lifecycle.isCurrent(id, runtime.generation) &&
            getCardForPtyId(id)?.id === card.id
          ) {
            outputBuffer.requestPreview(card.id, () => readHeadlessPreview(card.id));
          }
          acknowledgeBackgroundOutput(id, seq, runtime.generation);
        });
      } catch {
        acknowledgeBackgroundOutput(id, seq, runtime.generation);
      }
    };

    const reconcileBackgroundSnapshots = async (): Promise<boolean> => {
      let states: Record<string, SessionState>;
      try {
        states = await pty.getAllSessionStates();
      } catch {
        return false;
      }
      lastSnapshotSessionIds = new Set(Object.keys(states));

      let succeeded = true;
      await Promise.all(
        Object.keys(states).map(async (id) => {
          try {
            const snapshot = await pty.attachSnapshot(id);
            if (cancelled || !snapshot || snapshot.seq <= 0) return;
            const data = `${snapshot.history || ''}${snapshot.data || ''}`;
            await new Promise<void>((resolve) => {
              const card = getCardForPtyId(id);
              if (!card) {
                acknowledgeMissingBackgroundOutput(id, snapshot.seq);
                resolve();
                return;
              }
              const runtime = lifecycle.activate(id, card.id);
              const lastSeq = lastOutputSeqRef.current.get(id) ?? 0;
              const lastProcessed = lastProcessedOutputSeqRef.current.get(id) ?? 0;
              if (snapshot.seq <= lastProcessed) {
                outputAcknowledger.ack({
                  id,
                  throughSeq: snapshot.seq,
                  consumerKind: 'background',
                });
                resolve();
                return;
              }
              lastOutputSeqRef.current.set(id, Math.max(lastSeq, snapshot.seq));
              outputBuffer.pushChunk(card.id, data);
              if (!data) {
                acknowledgeBackgroundOutput(id, snapshot.seq, runtime.generation);
                resolve();
                return;
              }
              disposeHeadless(card.id);
              try {
                feedHeadless(card.id, data, () => {
                  if (
                    !cancelled &&
                    lifecycle.isCurrent(id, runtime.generation) &&
                    getCardForPtyId(id)?.id === card.id
                  ) {
                    outputBuffer.requestPreview(card.id, () => readHeadlessPreview(card.id));
                  }
                  acknowledgeBackgroundOutput(id, snapshot.seq, runtime.generation);
                  resolve();
                });
              } catch {
                acknowledgeBackgroundOutput(id, snapshot.seq, runtime.generation);
                resolve();
              }
            });
          } catch {
            succeeded = false;
          }
        }),
      );
      return succeeded;
    };

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
          routing: {
            origin: 'auto_restart',
            family: 'failure',
            episodeKey: `failure:${card.id}:auto-restart-limit:${decision.maxRetries}`,
            fingerprint: `auto-restart-limit:${decision.maxRetries}`,
          },
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
          routing: {
            origin: 'reply',
            family: 'completion',
            episodeKey: `completion:${cardId}:${currentInputCount}`,
            fingerprint: normalizeNotificationFingerprint(snippet),
          },
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

    void syncLiveSessionStates();
    const syncTimer = window.setInterval(syncWhenVisible, SESSION_STATE_SYNC_MS);
    window.addEventListener('focus', syncWhenVisible);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void listenManagedStateChanges((key) => {
      if (key === MANAGED_STATE_KEYS.terminal) {
        void syncLiveSessionStates();
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    }).catch((error) => {
      console.error('[TerminalEventBridge] failed to attach managed-state listener:', error);
    });

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
      const unsubOutput = await pty.onOutput((output) => {
        if (!backgroundSnapshotReady) {
          if (!getCardForPtyId(output.id)) {
            acknowledgeMissingBackgroundOutput(output.id, output.seq);
            return;
          }
          queuePendingBackgroundOutput(output);
          return;
        }
        processBackgroundOutput(output);
      });
      if (cancelled) {
        unsubOutput?.();
        return;
      }
      unlisteners.push(unsubOutput);

      // The listener is installed before attach so output produced during HMR
      // or WebView recreation is queued. The atomic snapshot establishes the
      // cumulative background watermark; queued events newer than that barrier
      // are then processed in sequence order. This resumes a PTY that reached
      // its high watermark while no JS listener existed.
      let reconcileDelayMs = 100;
      while (!cancelled) {
        const reconciled = await reconcileBackgroundSnapshots();
        if (reconciled && backgroundGapsCoveredBySnapshot()) break;
        await new Promise((resolve) => window.setTimeout(resolve, reconcileDelayMs));
        reconcileDelayMs = Math.min(reconcileDelayMs * 2, 2000);
      }
      if (cancelled) return;
      backgroundSnapshotReady = true;
      pendingBackgroundOutput
        .sort((left, right) => left.seq - right.seq)
        .forEach(processBackgroundOutput);
      pendingBackgroundOutput.length = 0;
      pendingBackgroundOutputBytes = 0;

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
      //         the card or the app went through a Shell.tsx remount; treating
      //         these as "failed" was the root cause of every card showing
      //         red after a navigation)
      const unsubExit = await pty.onExit(({ id, code }) => {
        const card = getCardForPtyId(id);
        // Drain coalesced output BEFORE status/notification handling so the
        // exit notification snippet includes the final chunks.
        if (card) outputBuffer.flushCard(card.id);
        lifecycle.dispose(id, 'exit');
        if (!card) return;
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

        const store = useTerminalStore.getState();

        // getMissingAiCliName inspects card.lastOutput — drain pending
        // chunks so the detection sees the freshest tail.
        outputBuffer.flushCard(cardId);

        const kind = type === 'error' ? 'failed' : 'waiting';
        const latestCard = store.getCardById(cardId) ?? card;
        const generation = latestCard.messageCount;
        const fingerprint = normalizeNotificationFingerprint(
          `${type}:${payload.fingerprint ?? message}`,
        );
        const previousEpisode = attentionEpisodesRef.current.get(cardId);
        const episode =
          previousEpisode?.generation === generation
            ? previousEpisode
            : { generation, fingerprints: new Set<string>() };
        if (episode.fingerprints.has(fingerprint)) return;
        episode.fingerprints.add(fingerprint);
        attentionEpisodesRef.current.set(cardId, episode);

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
          routing: {
            origin: 'pty',
            family: kind === 'waiting' ? 'interaction' : 'failure',
            episodeKey:
              kind === 'waiting'
                ? buildInteractionEpisodeKey(cardId, generation)
                : `failure:${cardId}:${generation}`,
            fingerprint,
          },
        });
        store.markUnread(cardId, true);
        store.appendEvent(cardId, { kind: 'notification', summary: title });
      });
      if (cancelled) {
        unsubAttention?.();
        return;
      }
      unlisteners.push(unsubAttention);

    })().catch((err) => {
      // Surfacing the error is not critical — the bridge simply won't update
      // the store. Log for diagnosis.
      console.error('[TerminalEventBridge] failed to attach listeners:', err);
    });

    let previousPtyByCard = new Map(
      useTerminalStore.getState().cards.map((card) => [card.id, card.ptyId || card.id]),
    );
    const unsubscribeStoreLifecycle = useTerminalStore.subscribe((state) => {
      const currentPtyByCard = new Map(
        state.cards.map((card) => [card.id, card.ptyId || card.id]),
      );
      for (const [cardId, previousPtyId] of previousPtyByCard) {
        const currentPtyId = currentPtyByCard.get(cardId);
        if (currentPtyId === previousPtyId) continue;
        lifecycle.dispose(
          previousPtyId,
          currentPtyId === undefined ? 'card-removed' : 'pty-replaced',
        );
      }
      previousPtyByCard = currentPtyByCard;

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
      unsubscribeStoreLifecycle();
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
      lifecycle.disposeAll('bridge-unmount');
      outputAcknowledger.dispose();
      // Hot-reload / bridge unmount: drop all headless emulators so we
      // don't accumulate duplicate listeners across HMR cycles.
      disposeAllHeadless();
      for (const timer of autoRestartTimers.values()) {
        window.clearTimeout(timer);
      }
      autoRestartTimers.clear();
      attentionEpisodes.clear();
      runningState.clear();
      replyDebounce.clear();
      replyInputCheckpoint.clear();
      lastOutputSeq.clear();
      lastProcessedOutputSeq.clear();
      pendingBackgroundOutput.length = 0;
      pendingBackgroundOutputBytes = 0;
      droppedBackgroundThrough.clear();
      if (readBridgeDiagnostics === diagnosticsReader) {
        readBridgeDiagnostics = () => ({ ...EMPTY_DIAGNOSTICS });
      }
    };
  }, []);

  return null;
}
