import type {
  CompletionSignal,
  NotificationEntry,
  NotificationRouting,
} from '../types/terminal';
import { NOTIFICATION_READ_RETENTION_MS, MAX_NOTIFICATIONS } from '../types/terminal';

/** Stronger completion evidence wins when producers describe one episode. */
export const COMPLETION_SOURCE_PRIORITY: Record<CompletionSignal['source'], number> = {
  codex_chat: 50,
  claude_chat: 50,
  one_shot_exit: 40,
  agent_cli_prompt: 30,
  agent_cli_idle: 20,
};

export type CompletionIngestResult =
  | { kind: 'inserted'; entry: NotificationEntry }
  | { kind: 'upgraded'; entry: NotificationEntry }
  | { kind: 'ignored'; entry?: NotificationEntry };

/** Remove ANSI/control bytes and keep notification summaries deterministic. */
export function sanitizeNotificationSummary(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Keep all unread evidence; only read history is age/count bounded. */
export function retainNotificationHistory(
  notifications: readonly NotificationEntry[],
  now = Date.now(),
  readRetentionMs = NOTIFICATION_READ_RETENTION_MS,
): NotificationEntry[] {
  const cutoff = now - readRetentionMs;
  const retainedReadIds = new Set(
    notifications
      .filter((entry) => entry.read && entry.at >= cutoff)
      .sort((left, right) => right.at - left.at)
      .slice(0, MAX_NOTIFICATIONS)
      .map((entry) => entry.id),
  );

  // The ledger is newest-first. Filter in-place order so unread entries keep
  // their relative position instead of being grouped ahead of newer read
  // entries. Only expired/excess read entries are removed.
  return notifications.filter((entry) => !entry.read || retainedReadIds.has(entry.id));
}

function sameEpisode(entry: NotificationEntry, signal: CompletionSignal): boolean {
  return entry.cardId === signal.cardId
    && entry.routing?.family === (signal.family ?? 'completion')
    && entry.routing.episodeKey === signal.episodeKey;
}

function routingForSignal(signal: CompletionSignal): NotificationRouting {
  return {
    origin: signal.origin ?? 'reply',
    family: signal.family ?? 'completion',
    episodeKey: signal.episodeKey,
    fingerprint: signal.fingerprint,
    signalSource: signal.source,
    confidence: signal.confidence,
  };
}

/**
 * Merges duplicate completion evidence without reopening acknowledged entries.
 * The caller supplies the localized title/body so this pure coordinator stays
 * independent from React and i18n.
 */
export class CompletionCoordinator {
  ingest(
    signal: CompletionSignal,
    notifications: readonly NotificationEntry[],
    buildEntry: (routing: NotificationRouting) => NotificationEntry,
  ): CompletionIngestResult {
    const existing = notifications.find((entry) => sameEpisode(entry, signal));
    if (!existing) {
      return { kind: 'inserted', entry: buildEntry(routingForSignal(signal)) };
    }

    const currentSource = existing.routing?.signalSource;
    const currentPriority = currentSource
      ? COMPLETION_SOURCE_PRIORITY[currentSource]
      : 0;
    const nextPriority = COMPLETION_SOURCE_PRIORITY[signal.source];
    if (nextPriority <= currentPriority || existing.read) {
      return { kind: 'ignored', entry: existing };
    }

    const nextRouting = routingForSignal(signal);
    const nextEntry = buildEntry(nextRouting);
    return {
      kind: 'upgraded',
      entry: {
        ...existing,
        kind: nextEntry.kind,
        title: nextEntry.title,
        body: nextEntry.body,
        routing: nextRouting,
      },
    };
  }
}

export function notificationRoutingFromSignal(signal: CompletionSignal): NotificationRouting {
  return routingForSignal(signal);
}
