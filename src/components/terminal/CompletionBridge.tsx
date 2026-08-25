import { useEffect } from 'react';
import { claudeChat, type ClaudeChatEventPayload } from '../../lib/claudeChat/api';
import { getString, isRecord } from '../../lib/codexApp/normalize';
import { logger } from '../../lib/logger';
import {
  codexApp,
  isTauriEnv,
  type CodexAppNotificationPayload,
} from '../../lib/tauri-bridge';
import { normalizeNotificationFingerprint } from '../../lib/osNotificationPolicy';
import type {
  CompletionSignal,
  TerminalCard,
} from '../../types/terminal';
import { sanitizeNotificationSummary } from '../../lib/notificationLedger';
import { useTerminalStore } from '../../stores/terminalStore';
import i18n from '../../i18n/config';

let activeBridgeUsers = 0;
let disposeSharedBridge: (() => void) | null = null;

/**
 * Application-scoped structured completion listener.
 *
 * Conversation views continue to own rendering; this bridge owns only the
 * completion-to-ledger boundary and therefore remains alive while views are
 * LRU-evicted or hidden.
 */
export function CompletionBridge(): null {
  useEffect(() => {
    if (!isTauriEnv()) return;
    const release = acquireCompletionBridge();
    return release;
  }, []);

  return null;
}

function acquireCompletionBridge(): () => void {
  activeBridgeUsers += 1;
  if (activeBridgeUsers === 1) {
    disposeSharedBridge = startCompletionBridge();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeBridgeUsers = Math.max(0, activeBridgeUsers - 1);
    if (activeBridgeUsers === 0) {
      disposeSharedBridge?.();
      disposeSharedBridge = null;
    }
  };
}

function startCompletionBridge(): () => void {
  let disposed = false;
  const unlisteners: Array<{ name: string; unlisten: () => void }> = [];

  const disposeListener = (name: string, unlisten: () => void) => {
    try {
      unlisten();
    } catch (error) {
      logger.warn(`[CompletionBridge] failed to unlisten ${name}`, error);
    }
  };

  const register = (name: string, registration: Promise<() => void>) => {
    void registration
      .then((unlisten) => {
        if (disposed) {
          disposeListener(name, unlisten);
          return;
        }
        unlisteners.push({ name, unlisten });
      })
      .catch((error) => {
        logger.warn(`[CompletionBridge] failed to listen for ${name}`, error);
      });
  };

  register(
    'codex',
    codexApp.onNotification((payload) => {
      if (disposed) return;
      const signal = completionSignalFromCodexPayload(
        payload,
        useTerminalStore.getState().cards,
      );
      if (signal) publishCompletion(signal);
    }),
  );
  register(
    'claude',
    claudeChat.onEvent((payload) => {
      if (disposed) return;
      const signal = completionSignalFromClaudePayload(
        payload,
        useTerminalStore.getState().cards,
      );
      if (signal) publishCompletion(signal);
    }),
  );

  return () => {
    disposed = true;
    for (const listener of unlisteners.splice(0)) {
      disposeListener(listener.name, listener.unlisten);
    }
  };
}

export function completionSignalFromCodexPayload(
  payload: CodexAppNotificationPayload,
  cards: readonly TerminalCard[],
  now = Date.now(),
): CompletionSignal | null {
  if (payload.method !== 'turn/completed') return null;
  const params = isRecord(payload.params) ? payload.params : {};
  const turn = isRecord(params.turn) ? params.turn : params;
  const threadId =
    getString(params, 'threadId') ??
    getString(turn, 'threadId') ??
    getString(params.thread, 'id');
  const card =
    (payload.cardId && cards.find((candidate) => candidate.id === payload.cardId)) ||
    cards.find((candidate) => candidate.codexAppThreadId === threadId);
  if (!card) return null;

  const turnId =
    getString(turn, 'id') ??
    getString(params, 'turnId') ??
    `${threadId ?? card.codexAppThreadId ?? card.id}:${card.messageCount}`;
  const status = (
    getString(turn, 'status') ?? getString(params, 'status') ?? ''
  ).toLocaleLowerCase();
  const error = getString(turn, 'error') ?? getString(params, 'error');
  const failed =
    Boolean(error) ||
    ['failed', 'failure', 'error', 'cancelled', 'canceled', 'aborted', 'interrupted']
      .includes(status);
  const successfulStatuses = new Set(['', 'completed', 'complete', 'success', 'succeeded', 'done']);
  if (!failed && !successfulStatuses.has(status)) return null;

  return {
    cardId: card.id,
    episodeKey: completionEpisodeKey(card),
    fingerprint: normalizeNotificationFingerprint(`codex:${threadId ?? card.id}:${turnId}`),
    source: 'codex_chat',
    confidence: 'authoritative',
    outcome: failed ? 'failed' : 'completed',
    at: now,
    summary: codexTurnSummary(turn, error),
  };
}

export function completionSignalFromClaudePayload(
  payload: ClaudeChatEventPayload,
  cards: readonly TerminalCard[],
  now = Date.now(),
): CompletionSignal | null {
  if (payload.ev !== 'session.event' || !isRecord(payload.message)) return null;
  const message = payload.message;
  if (message.type !== 'result') return null;
  const card = cards.find((candidate) => candidate.id === payload.cardId);
  if (!card) return null;

  const subtype = getString(message, 'subtype')?.toLocaleLowerCase() ?? '';
  const failed =
    message.is_error === true ||
    subtype === 'error' ||
    subtype === 'failed' ||
    subtype === 'failure' ||
    subtype === 'cancelled' ||
    subtype === 'canceled';
  const sessionId = getString(message, 'session_id') ?? 'session';
  const fingerprint =
    getString(message, 'uuid') ??
    `result:${sessionId}:${subtype || 'completed'}:${getNumber(message, 'duration_ms') ?? getNumber(message, 'num_turns') ?? 'unknown'}`;

  return {
    cardId: card.id,
    episodeKey: completionEpisodeKey(card),
    fingerprint: normalizeNotificationFingerprint(`claude:${fingerprint}`),
    source: 'claude_chat',
    confidence: 'authoritative',
    outcome: failed ? 'failed' : 'completed',
    at: now,
    summary: claudeResultSummary(message),
  };
}

function completionEpisodeKey(card: TerminalCard): string {
  return `completion:${card.id}:${Math.max(0, card.messageCount)}`;
}

function publishCompletion(signal: CompletionSignal): void {
  const store = useTerminalStore.getState();
  const card = store.getCardById(signal.cardId);
  if (!card) return;

  const failed = signal.outcome === 'failed';
  const title = i18n.t(
    failed ? 'terminal:notifications.errorTitle' : 'terminal:notifications.replyReadyTitle',
    { project: card.projectName },
  );
  const fallback = i18n.t(
    failed
      ? 'terminal:notifications.errorBodyFallback'
      : 'terminal:notifications.replyReadyBodyFallback',
  );
  const body = sanitizeNotificationSummary(signal.summary) || fallback;
  const result = store.ingestCompletionSignal(signal, {
    kind: failed ? 'failed' : 'completed',
    title,
    body,
  });
  if (result.kind === 'ignored') return;

  store.appendEvent(card.id, {
    kind: 'notification',
    summary: title,
  });
}

function codexTurnSummary(turn: Record<string, unknown>, error: string | null): string {
  if (error) return error;
  for (const key of ['summary', 'result', 'output', 'message']) {
    const value = getString(turn, key);
    if (value) return value;
  }
  if (Array.isArray(turn.items)) {
    for (let index = turn.items.length - 1; index >= 0; index -= 1) {
      const item = turn.items[index];
      if (!isRecord(item)) continue;
      const type = getString(item, 'type');
      if (type !== 'agentMessage' && type !== 'assistant') continue;
      const text = getString(item, 'text') ?? getString(item, 'body');
      if (text) return text;
    }
  }
  return '';
}

function claudeResultSummary(message: Record<string, unknown>): string {
  for (const key of ['result', 'error', 'message']) {
    const value = getString(message, key);
    if (value) return value;
  }
  return getString(message, 'subtype') ?? '';
}

function getNumber(record: unknown, key: string): number | null {
  if (!isRecord(record)) return null;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
