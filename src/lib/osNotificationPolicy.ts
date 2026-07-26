import type {
  NotificationEntry,
  NotificationOrigin,
} from '../types/terminal';

export const OS_NOTIFICATION_COALESCE_MS = 500;

const DEFAULT_CACHE_LIMIT = 256;
const WORKTREE_SYSTEM_CARD_ID = 'system:worktrees';

const INTERACTION_PRIORITY: Record<NotificationOrigin, number> = {
  codex_request: 30,
  supervisor: 20,
  pty: 10,
  reply: 0,
  auto_restart: 0,
};

export interface OsNotificationEnvironment {
  enabled: boolean;
  foreground: boolean;
  focusedCardId: string | null;
}

export interface OsNotificationCoordinatorOptions {
  getEnvironment: () => OsNotificationEnvironment;
  dispatch: (notification: NotificationEntry) => void | Promise<void>;
  coalesceMs?: number;
  cacheLimit?: number;
}

interface InteractionRecord {
  observed: Map<NotificationOrigin, Set<string>>;
}

interface PendingInteraction {
  genericCandidate: NotificationEntry | null;
  genericPriority: number;
  codexCandidates: Map<string, NotificationEntry>;
  observed: Map<NotificationOrigin, Set<string>>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One user-submit generation is the shared semantic episode across PTY,
 * Supervisor, and structured provider request signals.
 */
export function buildInteractionEpisodeKey(cardId: string, generation: number): string {
  return `interaction:${cardId}:${Math.max(0, generation)}`;
}

/** Collapse redraw/spacing differences into a bounded semantic identity. */
export function normalizeNotificationFingerprint(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return normalized.slice(0, 240) || 'unknown';
}

/**
 * Decide only the OS-toast channel. In-app notification evidence is preserved.
 */
export function shouldDispatchOsNotification(
  notification: NotificationEntry,
  environment: OsNotificationEnvironment,
): boolean {
  if (!environment.enabled) return false;

  if (notification.cardId === WORKTREE_SYSTEM_CARD_ID) {
    if (notification.kind === 'completed') return false;
    if (notification.kind === 'failed') return !environment.foreground;
  }

  if (notification.kind === 'completed') {
    return !environment.foreground;
  }

  if (
    environment.foreground &&
    environment.focusedCardId === notification.cardId
  ) {
    return false;
  }

  return true;
}

/**
 * Coordinates delayed interaction toasts at the side-effect boundary.
 *
 * - PTY/Supervisor signals in the same episode collapse to the higher priority.
 * - Structured Codex requests supersede generic signals, while distinct
 *   structured request fingerprints remain distinct.
 * - Exact source fingerprints are remembered for the episode, so a prompt
 *   redraw cannot toast again. A changed fingerprint or new generation rearms.
 */
export class OsNotificationCoordinator {
  private readonly getEnvironment: () => OsNotificationEnvironment;
  private readonly dispatch: (notification: NotificationEntry) => void | Promise<void>;
  private readonly coalesceMs: number;
  private readonly cacheLimit: number;
  private readonly processedIds = new Map<string, true>();
  private readonly interactionRecords = new Map<string, InteractionRecord>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private disposed = false;

  constructor(options: OsNotificationCoordinatorOptions) {
    this.getEnvironment = options.getEnvironment;
    this.dispatch = options.dispatch;
    this.coalesceMs = options.coalesceMs ?? OS_NOTIFICATION_COALESCE_MS;
    this.cacheLimit = Math.max(16, options.cacheLimit ?? DEFAULT_CACHE_LIMIT);
  }

  accept(notification: NotificationEntry): void {
    if (this.disposed || this.processedIds.has(notification.id)) return;
    this.rememberProcessedId(notification.id);

    const { routing } = notification;
    if (routing?.family !== 'interaction' || !routing.episodeKey) {
      this.dispatchIfAllowed(notification);
      return;
    }

    const episodeKey = routing.episodeKey;
    const origin = routing.origin;
    const fingerprint = normalizeNotificationFingerprint(
      routing.fingerprint ?? `${notification.title}\n${notification.body}`,
    );
    const record = this.interactionRecords.get(episodeKey);
    if (record && this.consumeIfAlreadyObserved(record, origin, fingerprint)) {
      this.touchInteractionRecord(episodeKey, record);
      return;
    }

    if (!shouldDispatchOsNotification(notification, this.getEnvironment())) {
      this.rememberInteraction(episodeKey, origin, fingerprint);
      return;
    }

    this.queueInteraction(notification, episodeKey, origin, fingerprint);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingInteractions.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingInteractions.clear();
    this.interactionRecords.clear();
    this.processedIds.clear();
  }

  private dispatchIfAllowed(notification: NotificationEntry): void {
    if (!shouldDispatchOsNotification(notification, this.getEnvironment())) return;
    void this.dispatch(notification);
  }

  private queueInteraction(
    notification: NotificationEntry,
    episodeKey: string,
    origin: NotificationOrigin,
    fingerprint: string,
  ): void {
    let pending = this.pendingInteractions.get(episodeKey);

    const existingForOrigin = pending?.observed.get(origin);
    if (existingForOrigin && !existingForOrigin.has(fingerprint)) {
      // The producer changed semantic prompt inside the same user-submit
      // generation. Finish the old episode batch and rearm for the new prompt.
      this.flushInteraction(episodeKey);
      pending = undefined;
    }

    if (!pending) {
      pending = {
        genericCandidate: null,
        genericPriority: Number.NEGATIVE_INFINITY,
        codexCandidates: new Map(),
        observed: new Map(),
        timer: setTimeout(() => {
          this.flushInteraction(episodeKey);
        }, this.coalesceMs),
      };
      this.pendingInteractions.set(episodeKey, pending);
      this.trimPendingInteractions();
    }

    addObservedFingerprint(pending.observed, origin, fingerprint);

    if (origin === 'codex_request') {
      pending.codexCandidates.set(fingerprint, notification);
      return;
    }

    const priority = INTERACTION_PRIORITY[origin];
    if (priority > pending.genericPriority) {
      pending.genericCandidate = notification;
      pending.genericPriority = priority;
    }
  }

  private flushInteraction(episodeKey: string): void {
    const pending = this.pendingInteractions.get(episodeKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInteractions.delete(episodeKey);

    const record = this.interactionRecords.get(episodeKey) ?? {
      observed: new Map<NotificationOrigin, Set<string>>(),
    };
    mergeObservedFingerprints(record.observed, pending.observed);
    this.touchInteractionRecord(episodeKey, record);

    const candidates =
      pending.codexCandidates.size > 0
        ? Array.from(pending.codexCandidates.values())
        : pending.genericCandidate
          ? [pending.genericCandidate]
          : [];

    for (const candidate of candidates) {
      this.dispatchIfAllowed(candidate);
    }
  }

  private consumeIfAlreadyObserved(
    record: InteractionRecord,
    origin: NotificationOrigin,
    fingerprint: string,
  ): boolean {
    const sameOrigin = record.observed.get(origin);
    if (sameOrigin?.has(fingerprint)) return true;

    if (sameOrigin && sameOrigin.size > 0) {
      // Same producer, changed semantic signal: this is a new prompt.
      return false;
    }

    if (record.observed.size > 0) {
      // A related producer already represented this episode. Remember the
      // late source so repeats stay quiet, but do not emit a second toast.
      addObservedFingerprint(record.observed, origin, fingerprint);
      return true;
    }

    return false;
  }

  private rememberInteraction(
    episodeKey: string,
    origin: NotificationOrigin,
    fingerprint: string,
  ): void {
    const record = this.interactionRecords.get(episodeKey) ?? {
      observed: new Map<NotificationOrigin, Set<string>>(),
    };
    addObservedFingerprint(record.observed, origin, fingerprint);
    this.touchInteractionRecord(episodeKey, record);
  }

  private touchInteractionRecord(
    episodeKey: string,
    record: InteractionRecord,
  ): void {
    this.interactionRecords.delete(episodeKey);
    this.interactionRecords.set(episodeKey, record);
    trimOldest(this.interactionRecords, this.cacheLimit);
  }

  private rememberProcessedId(id: string): void {
    this.processedIds.set(id, true);
    trimOldest(this.processedIds, this.cacheLimit);
  }

  private trimPendingInteractions(): void {
    while (this.pendingInteractions.size > this.cacheLimit) {
      const oldest = this.pendingInteractions.keys().next().value as string | undefined;
      if (!oldest) return;
      this.flushInteraction(oldest);
    }
  }
}

function addObservedFingerprint(
  observed: Map<NotificationOrigin, Set<string>>,
  origin: NotificationOrigin,
  fingerprint: string,
): void {
  const fingerprints = observed.get(origin) ?? new Set<string>();
  fingerprints.add(fingerprint);
  observed.set(origin, fingerprints);
}

function mergeObservedFingerprints(
  target: Map<NotificationOrigin, Set<string>>,
  source: Map<NotificationOrigin, Set<string>>,
): void {
  for (const [origin, fingerprints] of source) {
    for (const fingerprint of fingerprints) {
      addObservedFingerprint(target, origin, fingerprint);
    }
  }
}

function trimOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
