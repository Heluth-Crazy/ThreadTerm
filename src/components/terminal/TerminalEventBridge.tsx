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
 *   attention-required          → completion coordinator / interaction ledger
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
  isHeadlessAlternateScreen,
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
import {
  AGENT_CLI_COMPATIBILITY_IDLE_MS,
  AGENT_CLI_MIN_RUNNING_MS,
  AGENT_CLI_PROMPT_SETTLE_MS,
  detectAgentCliPrompt,
  getAgentCliCompletionFingerprint,
  isAgentCliCompatibilityCandidate,
} from './agentCliCompletion';

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

interface CompatibilityRun {
  generation: number;
  runningSince: number;
  lastOutputAt: number;
  phase: 'running' | 'idle';
}

interface CompatibilityTimers {
  prompt?: number;
  idle?: number;
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
  /** Runtime-only guarded Agent CLI compatibility state. */
  const compatibilityRunsRef = useRef<Map<string, CompatibilityRun>>(new Map());
  const compatibilityTimersRef = useRef<Map<string, CompatibilityTimers>>(new Map());
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
    const compatibilityRuns = compatibilityRunsRef.current;
    const compatibilityTimers = compatibilityTimersRef.current;

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
          // A full-screen TUI emits renderer frames (cursor moves, clears and
          // complete screen repaints), not append-only terminal output. Keep
          // its clean headless preview for cards, but do not turn every frame
          // into `lastOutput`/`lastActivity` churn. Identical previews already
          // no-op in the store, isolating Workbench from cosmetic redraws.
          store.updateCardOutputAndPreview(
            cardId,
            isHeadlessAlternateScreen(cardId) ? null : data,
            preview,
          );
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

    function clearCompatibilityTimers(cardId: string) {
      const timers = compatibilityTimers.get(cardId);
      if (!timers) return;
      if (timers.prompt !== undefined) window.clearTimeout(timers.prompt);
      if (timers.idle !== undefined) window.clearTimeout(timers.idle);
      compatibilityTimers.delete(cardId);
    }

    function clearCompatibilityRun(cardId: string) {
      clearCompatibilityTimers(cardId);
      compatibilityRuns.delete(cardId);
    }

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
      clearCompatibilityRun(runtime.cardId);
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
      noteCompatibilityOutput(card);
      try {
        feedHeadless(card.id, data, () => {
          if (
            !cancelled &&
            lifecycle.isCurrent(id, runtime.generation) &&
            getCardForPtyId(id)?.id === card.id
          ) {
            outputBuffer.requestPreview(card.id, () => readHeadlessPreview(card.id));
          }
          maybeScheduleCompatibilityPrompt(card.id);
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
              noteCompatibilityOutput(card);
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
                  maybeScheduleCompatibilityPrompt(card.id);
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

    function compatibilityEnabled(): boolean {
      return useTerminalStore.getState().agentCliCompatibilityCompletionEnabled;
    }

    function ensureCompatibilityRun(card: TerminalCard): CompatibilityRun | null {
      if (!compatibilityEnabled() || !isAgentCliCompatibilityCandidate(card)) {
        clearCompatibilityRun(card.id);
        return null;
      }

      const checkpoint = getReplyInputCheckpoint(card);
      if (card.messageCount <= checkpoint) {
        clearCompatibilityRun(card.id);
        return null;
      }

      const existing = compatibilityRuns.get(card.id);
      if (existing?.generation === card.messageCount) return existing;
      if (existing) clearCompatibilityRun(card.id);

      const now = Date.now();
      const run: CompatibilityRun = {
        generation: card.messageCount,
        runningSince: runningState.get(card.id)?.runningSince ?? now,
        lastOutputAt: now,
        phase: card.status === 'running' ? 'running' : 'idle',
      };
      compatibilityRuns.set(card.id, run);
      return run;
    }

    function compatibilityPreview(card: TerminalCard): string {
      return readHeadlessPreview(card.id) || card.lastReplyPreview || card.lastOutput;
    }

    function publishCompatibilityCompletion(
      cardId: string,
      source: 'agent_cli_prompt' | 'agent_cli_idle',
      prompt: string | null = null,
    ) {
      if (!compatibilityEnabled()) return;
      const store = useTerminalStore.getState();
      const card = store.getCardById(cardId);
      if (!card || !isAgentCliCompatibilityCandidate(card)) return;

      const checkpoint = getReplyInputCheckpoint(card);
      if (card.messageCount <= checkpoint) {
        clearCompatibilityRun(cardId);
        return;
      }
      const run = compatibilityRuns.get(cardId);
      if (!run || run.generation !== card.messageCount) return;

      // Consume this generation before calling the coordinator.  A stronger
      // structured signal already committed for the same episode therefore
      // cannot cause a later compatibility timer to reopen it.
      clearCompatibilityRun(cardId);
      replyInputCheckpoint.set(cardId, card.messageCount);

      outputBuffer.flushCard(cardId);
      const latestCard = store.getCardById(cardId) ?? card;
      const preview = buildCardPreview(latestCard, { maxLines: 3 });
      const snippet =
        preview.bodyLines.join('\n').trim() ||
        i18n.t('terminal:notifications.replyReadyBodyFallback');
      const fingerprint =
        source === 'agent_cli_prompt' && prompt
          ? getAgentCliCompletionFingerprint(latestCard.terminalType, prompt) ??
            normalizeNotificationFingerprint(`${latestCard.terminalType}:${prompt}`)
          : normalizeNotificationFingerprint(snippet);
      const title = i18n.t('terminal:notifications.replyReadyTitle', {
        project: latestCard.projectName,
      });
      const result = store.ingestCompletionSignal(
        {
          cardId,
          episodeKey: `completion:${cardId}:${latestCard.messageCount}`,
          fingerprint,
          source,
          confidence: 'compatible',
          outcome: 'completed',
          at: Date.now(),
          summary: snippet,
        },
        {
          kind: 'completed',
          title,
          body: snippet.slice(0, 240),
        },
      );
      if (result.kind !== 'ignored') {
        store.appendEvent(cardId, {
          kind: 'notification',
          summary: i18n.t('terminal:notifications.replyReadyEvent'),
        });
      }
    }

    function scheduleCompatibilityIdle(card: TerminalCard, run: CompatibilityRun) {
      if (!compatibilityEnabled() || !isAgentCliCompatibilityCandidate(card)) return;
      const latest = useTerminalStore.getState().getCardById(card.id);
      if (!latest || latest.messageCount !== run.generation) return;

      const timers = compatibilityTimers.get(card.id) ?? {};
      if (timers.idle !== undefined) window.clearTimeout(timers.idle);
      const now = Date.now();
      const minRunningDelay = Math.max(
        0,
        AGENT_CLI_MIN_RUNNING_MS - (now - run.runningSince),
      );
      const quietDelay = Math.max(
        0,
        AGENT_CLI_COMPATIBILITY_IDLE_MS - (now - run.lastOutputAt),
      );
      const delay = Math.max(minRunningDelay, quietDelay);
      const timer = window.setTimeout(() => {
        const currentTimers = compatibilityTimers.get(card.id);
        if (currentTimers?.idle === timer) {
          delete currentTimers.idle;
          if (currentTimers.prompt === undefined) compatibilityTimers.delete(card.id);
        }

        const current = useTerminalStore.getState().getCardById(card.id);
        const activeRun = compatibilityRuns.get(card.id);
        if (
          !current ||
          !activeRun ||
          activeRun.generation !== current.messageCount ||
          !compatibilityEnabled() ||
          current.status === 'waiting'
        ) {
          clearCompatibilityRun(card.id);
          return;
        }

        const elapsed = Date.now() - activeRun.runningSince;
        const quiet = Date.now() - activeRun.lastOutputAt;
        if (
          elapsed < AGENT_CLI_MIN_RUNNING_MS ||
          quiet < AGENT_CLI_COMPATIBILITY_IDLE_MS
        ) {
          scheduleCompatibilityIdle(current, activeRun);
          return;
        }

        const prompt = detectAgentCliPrompt(current.terminalType, compatibilityPreview(current));
        publishCompatibilityCompletion(
          current.id,
          prompt ? 'agent_cli_prompt' : 'agent_cli_idle',
          prompt,
        );
      }, delay);
      timers.idle = timer;
      compatibilityTimers.set(card.id, timers);
    }

    function scheduleCompatibilityPrompt(card: TerminalCard, prompt: string) {
      const run = ensureCompatibilityRun(card);
      if (!run || run.generation !== card.messageCount) return;

      const timers = compatibilityTimers.get(card.id) ?? {};
      if (timers.prompt !== undefined) window.clearTimeout(timers.prompt);
      // A prompt is stronger than quiet-idle evidence.  Do not let an old
      // idle timer win while the 500 ms settle window is pending.
      if (timers.idle !== undefined) {
        window.clearTimeout(timers.idle);
        delete timers.idle;
      }
      const settleDelay = Math.max(
        AGENT_CLI_PROMPT_SETTLE_MS,
        AGENT_CLI_MIN_RUNNING_MS - (Date.now() - run.runningSince),
      );
      const timer = window.setTimeout(() => {
        const currentTimers = compatibilityTimers.get(card.id);
        if (currentTimers?.prompt === timer) {
          delete currentTimers.prompt;
          if (currentTimers.idle === undefined) compatibilityTimers.delete(card.id);
        }
        const current = useTerminalStore.getState().getCardById(card.id);
        const activeRun = compatibilityRuns.get(card.id);
        if (
          !current ||
          !activeRun ||
          activeRun.generation !== current.messageCount ||
          !compatibilityEnabled() ||
          current.status === 'waiting'
        ) {
          clearCompatibilityRun(card.id);
          return;
        }
        const latestPrompt = detectAgentCliPrompt(
          current.terminalType,
          compatibilityPreview(current),
        );
        if (!latestPrompt) {
          if (activeRun.phase === 'idle') scheduleCompatibilityIdle(current, activeRun);
          return;
        }
        publishCompatibilityCompletion(current.id, 'agent_cli_prompt', latestPrompt);
      }, settleDelay);
      timers.prompt = timer;
      compatibilityTimers.set(card.id, timers);
    }

    function noteCompatibilityOutput(card: TerminalCard) {
      if (!compatibilityEnabled() || !isAgentCliCompatibilityCandidate(card)) return;
      const run = ensureCompatibilityRun(card);
      if (!run) return;
      run.lastOutputAt = Date.now();
      clearCompatibilityTimers(card.id);
      if (run.phase === 'idle') scheduleCompatibilityIdle(card, run);
    }

    function maybeScheduleCompatibilityPrompt(cardId: string) {
      const card = useTerminalStore.getState().getCardById(cardId);
      if (!card || !compatibilityEnabled() || !isAgentCliCompatibilityCandidate(card)) return;
      const prompt = detectAgentCliPrompt(card.terminalType, compatibilityPreview(card));
      if (prompt) scheduleCompatibilityPrompt(card, prompt);
    }

    function handleCompatibilitySubmission(card: TerminalCard) {
      clearCompatibilityRun(card.id);
      if (!compatibilityEnabled() || !isAgentCliCompatibilityCandidate(card)) return;
      const checkpoint = getReplyInputCheckpoint(card);
      if (card.messageCount <= checkpoint || card.status !== 'running') return;

      const now = Date.now();
      runningState.set(card.id, { runningSince: now });
      compatibilityRuns.set(card.id, {
        generation: card.messageCount,
        runningSince: now,
        lastOutputAt: now,
        phase: 'running',
      });
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
        const latestCard = useTerminalStore.getState().getCardById(cardId) ?? card;
        const compatibilityRun = ensureCompatibilityRun(latestCard);
        if (compatibilityRun) {
          compatibilityRun.phase = 'running';
          clearCompatibilityTimers(cardId);
        }
        return;
      }

      if (next === 'waiting') {
        clearCompatibilityRun(cardId);
        runningStateRef.current.delete(cardId);
        return;
      }

      if (next === 'completed' || next === 'failed') {
        clearCompatibilityRun(cardId);
      }

      // Detect Running → Idle transition = agent finished responding.
      if (prev === 'running' && next === 'idle') {
        const rs = runningStateRef.current.get(cardId) ?? { runningSince: card.lastActivity };
        runningStateRef.current.delete(cardId);

        const latestCard = getCardForPtyId(ptyId) ?? card;
        const inputCheckpoint = getReplyInputCheckpoint(latestCard);
        const currentInputCount = latestCard.messageCount;
        if (currentInputCount <= inputCheckpoint) return;

        if (isAgentCliCompatibilityCandidate(latestCard) && compatibilityEnabled()) {
          const compatibilityRun = ensureCompatibilityRun(latestCard);
          if (!compatibilityRun) return;
          compatibilityRun.runningSince = rs.runningSince;
          compatibilityRun.phase = 'idle';
          scheduleCompatibilityIdle(latestCard, compatibilityRun);
          return;
        }

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

        const title = i18n.t('terminal:notifications.replyReadyTitle', {
          project: latestCard.projectName,
        });
        const result = store.ingestCompletionSignal(
          {
            cardId,
            episodeKey: `completion:${cardId}:${currentInputCount}`,
            fingerprint: normalizeNotificationFingerprint(snippet),
            source: 'agent_cli_idle',
            confidence: 'compatible',
            outcome: 'completed',
            at: Date.now(),
            summary: snippet,
          },
          {
            kind: 'completed',
            title,
            body: snippet.slice(0, 240),
          },
        );
        if (result.kind !== 'ignored') {
          store.appendEvent(cardId, {
            kind: 'notification',
            summary: i18n.t('terminal:notifications.replyReadyEvent'),
          });
        }
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
      if (key !== MANAGED_STATE_KEYS.terminal) return;

      try {
        const rehydrate = useTerminalStore.persist.rehydrate();
        void Promise.resolve(rehydrate)
          .then(() => {
            if (cancelled) return;
            return syncLiveSessionStates();
          })
          .catch((error) => {
            console.error(
              '[TerminalEventBridge] failed to rehydrate terminal store after managed-state change:',
              error,
            );
          });
      } catch (error) {
        console.error(
          '[TerminalEventBridge] failed to rehydrate terminal store after managed-state change:',
          error,
        );
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

        // One-shot exits are the authoritative task boundary. They never use
        // interactive auto-restart semantics, and an intentional/unknown
        // termination is persisted as interrupted without creating evidence.
        const oneShotRun = card.executionMode === 'oneShot' ? card.oneShotRun : undefined;
        if (oneShotRun) {
          const outcome =
            code === 0
              ? 'completed'
              : typeof code === 'number'
                ? 'failed'
                : 'interrupted';
          const changed = store.finishOneShotRun(card.id, {
            generation: oneShotRun.generation,
            state: outcome,
            ...(typeof code === 'number' ? { exitCode: code } : {}),
          });
          if (!changed) return;

          if (outcome !== 'interrupted') {
            const latestCard = store.getCardById(card.id) ?? card;
            const preview = buildCardPreview(latestCard, { maxLines: 3 });
            const snippet =
              preview.bodyLines.join('\n').trim() ||
              i18n.t('terminal:notifications.replyReadyBodyFallback');
            const result = store.ingestCompletionSignal(
              {
                cardId: card.id,
                episodeKey: `one-shot:${oneShotRun.generation}`,
                fingerprint: normalizeNotificationFingerprint(
                  `one-shot:${oneShotRun.generation}:${code}:${snippet}`,
                ),
                source: 'one_shot_exit',
                confidence: 'authoritative',
                outcome,
                at: Date.now(),
                summary: snippet,
              },
              {
                kind: outcome === 'completed' ? 'completed' : 'failed',
                title:
                  outcome === 'completed'
                    ? i18n.t('terminal:notifications.oneShotCompletedTitle', {
                        project: latestCard.projectName,
                        defaultValue: '✓ {{project}} completed',
                      })
                    : i18n.t('terminal:notifications.oneShotFailedTitle', {
                        project: latestCard.projectName,
                        defaultValue: '✕ {{project}} failed',
                      }),
                body: snippet,
              },
            );
            if (result.kind !== 'ignored') {
              store.appendEvent(card.id, {
                kind: 'notification',
                summary:
                  outcome === 'completed'
                    ? i18n.t('terminal:notifications.oneShotCompletedEvent', {
                        defaultValue: 'one-shot completed',
                      })
                    : i18n.t('terminal:notifications.oneShotFailedEvent', {
                        defaultValue: 'one-shot failed',
                      }),
              });
            }
          }

          store.appendEvent(card.id, {
            kind: 'closed',
            summary:
              outcome === 'failed'
                ? i18n.t('terminal:notifications.processExited', { code })
                : outcome === 'completed'
                  ? i18n.t('terminal:notifications.processCompleted')
                  : i18n.t('terminal:notifications.sessionClosed'),
          });
          return;
        }

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

        // Approval/error attention is a terminal boundary for compatibility
        // completion; leave interaction/failure producers to publish their
        // own semantic notification below.
        if (type === 'waiting' || type === 'error') clearCompatibilityRun(cardId);

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

        const body = missingCli
          ? i18n.t('terminal:notifications.missingCliBody', { cli: missingCli })
          : message ||
            (kind === 'failed'
              ? i18n.t('terminal:notifications.errorBodyFallback')
              : i18n.t('terminal:notifications.inputBodyFallback'));

        if (kind === 'failed') {
          const result = store.ingestCompletionSignal(
            {
              cardId,
              episodeKey: `failure:${cardId}:${generation}`,
              fingerprint,
              source: 'agent_cli_prompt',
              confidence: 'compatible',
              outcome: 'failed',
              at: Date.now(),
              summary: body,
              family: 'failure',
              origin: 'pty',
            },
            { kind, title, body },
          );
          if (result.kind !== 'ignored') {
            store.appendEvent(cardId, { kind: 'notification', summary: title });
          }
          return;
        }

        // Waiting/approval semantics remain owned by the PTY interaction
        // producer. They intentionally do not enter the completion precedence
        // path.
        store.pushNotification({
          cardId,
          kind,
          title,
          body,
          routing: {
            origin: 'pty',
            family: 'interaction',
            episodeKey: buildInteractionEpisodeKey(cardId, generation),
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
    let previousMessageCountByCard = new Map(
      useTerminalStore.getState().cards.map((card) => [card.id, card.messageCount]),
    );
    const unsubscribeStoreLifecycle = useTerminalStore.subscribe((state, previousState) => {
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

      for (const card of state.cards) {
        const previousCount = previousMessageCountByCard.get(card.id);
        if (previousCount !== undefined && previousCount !== card.messageCount) {
          handleCompatibilitySubmission(card);
        }
        previousMessageCountByCard.set(card.id, card.messageCount);
      }
      for (const cardId of previousMessageCountByCard.keys()) {
        if (!currentPtyByCard.has(cardId)) {
          clearCompatibilityRun(cardId);
          previousMessageCountByCard.delete(cardId);
        }
      }

      if (
        previousState.agentCliCompatibilityCompletionEnabled &&
        !state.agentCliCompatibilityCompletionEnabled
      ) {
        for (const cardId of compatibilityRuns.keys()) clearCompatibilityRun(cardId);
      }

      if (state.notifications !== previousState.notifications) {
        for (const notification of state.notifications) {
          const source = notification.routing?.signalSource;
          if (
            source === 'codex_chat' ||
            source === 'claude_chat'
          ) {
            const activeRun = compatibilityRuns.get(notification.cardId);
            if (
              activeRun &&
              notification.routing?.episodeKey ===
                `completion:${notification.cardId}:${activeRun.generation}`
            ) {
              clearCompatibilityRun(notification.cardId);
            }
          }
        }
      }

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
      for (const cardId of compatibilityTimers.keys()) clearCompatibilityTimers(cardId);
      compatibilityRuns.clear();
      compatibilityTimers.clear();
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
