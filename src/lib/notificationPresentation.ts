import type { NotificationEntry } from '../types/terminal';
import { sanitizeNotificationSummary } from './notificationLedger';

export const NOTIFICATION_PRESENTATION_SLOT_COUNT = 4;
export const NOTIFICATION_PRESENTATION_ACTIVE_MS = 10_000;
export const NOTIFICATION_DELIVERY_DECISION_TIMEOUT_MS = 2_000;

const MAX_SEEN_NOTIFICATION_IDS = 2_048;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface NotificationPresentationItem {
  readonly id: string;
  readonly entry: NotificationEntry;
  readonly summary: string;
}

export interface NotificationPresentationSnapshot {
  readonly visible: readonly NotificationPresentationItem[];
  readonly queued: readonly NotificationPresentationItem[];
  readonly background: readonly NotificationPresentationItem[];
  readonly windowFocused: boolean;
  readonly paused: boolean;
  readonly hidden: boolean;
}

export interface NotificationPresentationGlobalState {
  readonly paused?: boolean;
  readonly hidden?: boolean;
}

export interface NotificationPresentationDiff {
  /** Added/updated arrays follow the same newest-first ordering as snapshots. */
  readonly added?: readonly NotificationEntry[];
  readonly updated?: readonly NotificationEntry[];
  readonly removedIds?: readonly string[];
}

export interface NotificationPresentationControllerOptions {
  readonly initialNotifications?: readonly NotificationEntry[];
  readonly windowFocused?: boolean;
  readonly now?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly awaitDelivery?: boolean;
}

export interface NotificationPresentationController {
  /** Seed hydrated entries as historical; this never presents them. */
  seed(notifications: readonly NotificationEntry[]): void;
  /** Consume a committed newest-first ledger snapshot. */
  ingestSnapshot(notifications: readonly NotificationEntry[]): void;
  /** Consume an additive committed ledger diff. */
  ingestDiff(diff: NotificationPresentationDiff): void;
  /** Alias useful to bridge code that receives either full snapshots or diffs. */
  ingest(notifications: readonly NotificationEntry[]): void;
  resolveDelivery(notificationId: string, accepted: boolean): void;
  setWindowFocused(focused: boolean): void;
  setGlobalPresentationState(state: NotificationPresentationGlobalState): void;
  setGlobalPaused(paused: boolean): void;
  setGlobalHidden(hidden: boolean): void;
  setItemInteraction(
    notificationId: string,
    interaction: { hovered?: boolean; keyboardFocused?: boolean },
  ): void;
  setItemHover(notificationId: string, hovered: boolean): void;
  setItemKeyboardFocus(notificationId: string, focused: boolean): void;
  /** Close only the runtime presentation; never acknowledges the ledger entry. */
  close(notificationId: string): void;
  autoCollapse(notificationId: string): void;
  /** External acknowledgement/read signal. This never calls a store action. */
  acknowledge(notificationId: string): void;
  /** External remove signal for one entry. */
  remove(notificationId: string): void;
  /** External clear signal for the entire ledger. */
  clear(): void;
  getSnapshot(): NotificationPresentationSnapshot;
  getServerSnapshot(): NotificationPresentationSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

interface PresentationRecord {
  entry: NotificationEntry;
  order: number;
  remainingMs: number;
  timer: TimerHandle | null;
  timerStartedAt: number | null;
  hovered: boolean;
  keyboardFocused: boolean;
  deliveryResolved: boolean;
  observedInBackground: boolean;
}

interface IndexedEntry {
  entry: NotificationEntry;
  index: number;
}

const EMPTY_SNAPSHOT: NotificationPresentationSnapshot = Object.freeze({
  visible: Object.freeze([]),
  queued: Object.freeze([]),
  background: Object.freeze([]),
  windowFocused: true,
  paused: false,
  hidden: false,
});

function cloneEntry(entry: NotificationEntry): NotificationEntry {
  return Object.freeze({
    ...entry,
    routing: entry.routing ? Object.freeze({ ...entry.routing }) : undefined,
  });
}

function presentationSummary(entry: NotificationEntry): string {
  return (
    sanitizeNotificationSummary(entry.body) || sanitizeNotificationSummary(entry.title)
  );
}

function compareRecords(
  leftId: string,
  rightId: string,
  records: ReadonlyMap<string, PresentationRecord>,
): number {
  const left = records.get(leftId);
  const right = records.get(rightId);
  if (!left || !right) return 0;
  return left.entry.at - right.entry.at || left.order - right.order;
}

function createSnapshot(
  visibleIds: readonly string[],
  queuedIds: readonly string[],
  backgroundIds: readonly string[],
  records: ReadonlyMap<string, PresentationRecord>,
  windowFocused: boolean,
  globalPaused: boolean,
  globalHidden: boolean,
): NotificationPresentationSnapshot {
  const item = (id: string): NotificationPresentationItem | null => {
    const record = records.get(id);
    if (!record) return null;
    return Object.freeze({
      id,
      entry: record.entry,
      summary: presentationSummary(record.entry),
    });
  };
  const items = (ids: readonly string[]) =>
    Object.freeze(
      ids.map(item).filter((value): value is NotificationPresentationItem => value !== null),
    );

  return Object.freeze({
    visible: items(visibleIds),
    queued: items(queuedIds),
    background: items(backgroundIds),
    windowFocused,
    paused: globalPaused || globalHidden || !windowFocused,
    hidden: globalHidden || !windowFocused,
  });
}

/**
 * Runtime-only FIFO coordinator for in-app notification presentation.
 *
 * The controller consumes committed ledger data but never mutates or
 * acknowledges that ledger. Hydrated IDs are seeded as historical, while
 * entries first observed during this runtime are presented exactly once.
 */
export function createNotificationPresentationController(
  options: NotificationPresentationControllerOptions = {},
): NotificationPresentationController {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const records = new Map<string, PresentationRecord>();
  const seenIds = new Map<string, true>();
  const listeners = new Set<() => void>();
  const visibleIds: string[] = [];
  const queuedIds: string[] = [];
  const backgroundIds: string[] = [];
  const pendingDeliveryIds = new Set<string>();
  const pendingDeliveryTimers = new Map<string, TimerHandle>();
  const awaitDelivery = options.awaitDelivery ?? false;

  let nextOrder = 0;
  let windowFocused = options.windowFocused ?? true;
  let globalPaused = false;
  let globalHidden = false;
  let disposed = false;
  let snapshot = EMPTY_SNAPSHOT;

  const rememberSeen = (id: string) => {
    if (seenIds.has(id)) return;
    seenIds.set(id, true);
    while (seenIds.size > MAX_SEEN_NOTIFICATION_IDS) {
      let removable: string | undefined;
      for (const candidate of seenIds.keys()) {
        if (!records.has(candidate)) {
          removable = candidate;
          break;
        }
      }
      // Current ledger entries remain remembered even when the runtime has
      // observed a very long history of removed entries.
      if (removable === undefined) break;
      seenIds.delete(removable);
    }
  };

  const clearTimer = (record: PresentationRecord) => {
    if (record.timer !== null) {
      cancel(record.timer);
      record.timer = null;
    }
    record.timerStartedAt = null;
  };

  const pauseTimer = (record: PresentationRecord) => {
    if (record.timerStartedAt !== null) {
      record.remainingMs = Math.max(
        0,
        record.remainingMs - Math.max(0, now() - record.timerStartedAt),
      );
    }
    clearTimer(record);
  };

  const isVisible = (id: string) => visibleIds.includes(id);

  const removeId = (ids: string[], id: string): boolean => {
    const index = ids.indexOf(id);
    if (index < 0) return false;
    ids.splice(index, 1);
    return true;
  };

  const removePresentation = (id: string) => {
    const deliveryTimer = pendingDeliveryTimers.get(id);
    if (deliveryTimer !== undefined) {
      cancel(deliveryTimer);
      pendingDeliveryTimers.delete(id);
    }
    pendingDeliveryIds.delete(id);
    const record = records.get(id);
    if (record) {
      clearTimer(record);
      record.remainingMs = NOTIFICATION_PRESENTATION_ACTIVE_MS;
      record.hovered = false;
      record.keyboardFocused = false;
    }
    removeId(visibleIds, id);
    removeId(queuedIds, id);
    removeId(backgroundIds, id);
  };

  const sortQueue = (ids: string[]) => {
    ids.sort((left, right) => compareRecords(left, right, records));
  };

  const timerEligible = (id: string, record: PresentationRecord) =>
    isVisible(id) &&
    windowFocused &&
    !globalPaused &&
    !globalHidden &&
    !record.hovered &&
    !record.keyboardFocused;

  let expireVisible: (id: string) => void;

  const syncTimer = (id: string) => {
    const record = records.get(id);
    if (!record || !isVisible(id)) {
      if (record) clearTimer(record);
      return;
    }

    if (!timerEligible(id, record)) {
      pauseTimer(record);
      return;
    }
    if (record.timer !== null) return;
    if (record.remainingMs <= 0) {
      expireVisible(id);
      return;
    }

    record.timerStartedAt = now();
    record.timer = schedule(() => {
      const current = records.get(id);
      if (!current || !isVisible(id)) return;
      current.timer = null;
      if (current.timerStartedAt !== null) {
        current.remainingMs = Math.max(
          0,
          current.remainingMs - Math.max(0, now() - current.timerStartedAt),
        );
      }
      current.timerStartedAt = null;
      if (current.remainingMs <= 0 && timerEligible(id, current)) {
        expireVisible(id);
      } else {
        syncTimer(id);
      }
    }, record.remainingMs);
  };

  const syncVisibleTimers = () => {
    for (const id of [...visibleIds]) syncTimer(id);
  };

  const fillVisible = () => {
    while (visibleIds.length < NOTIFICATION_PRESENTATION_SLOT_COUNT && queuedIds.length > 0) {
      const id = queuedIds.shift();
      if (!id || !records.has(id)) continue;
      visibleIds.push(id);
      const record = records.get(id);
      if (record) {
        record.remainingMs = NOTIFICATION_PRESENTATION_ACTIVE_MS;
        record.timerStartedAt = null;
      }
    }
    syncVisibleTimers();
  };

  const publish = () => {
    snapshot = createSnapshot(
      visibleIds,
      queuedIds,
      backgroundIds,
      records,
      windowFocused,
      globalPaused,
      globalHidden,
    );
    for (const listener of [...listeners]) listener();
  };

  const removeAndRefill = (id: string) => {
    const wasVisible = isVisible(id);
    removePresentation(id);
    if (wasVisible) fillVisible();
    publish();
  };

  expireVisible = (id: string) => {
    if (disposed || !isVisible(id)) return;
    removeAndRefill(id);
  };

  const addNewRecord = (entry: NotificationEntry) => {
    const normalized = cloneEntry(entry);
    const record: PresentationRecord = {
      entry: normalized,
      order: nextOrder++,
      remainingMs: NOTIFICATION_PRESENTATION_ACTIVE_MS,
      timer: null,
      timerStartedAt: null,
      hovered: false,
      keyboardFocused: false,
      deliveryResolved: !awaitDelivery,
      observedInBackground: !windowFocused,
    };
    records.set(normalized.id, record);
    rememberSeen(normalized.id);
    if (awaitDelivery && !normalized.read) {
      const timer = schedule(() => resolveDelivery(normalized.id, false), NOTIFICATION_DELIVERY_DECISION_TIMEOUT_MS);
      pendingDeliveryTimers.set(normalized.id, timer);
    }
  };

  const upsertEntries = (entries: readonly NotificationEntry[]) => {
    const uniqueEntries = new Map<string, IndexedEntry>();
    entries.forEach((entry, index) => {
      const prior = uniqueEntries.get(entry.id);
      uniqueEntries.set(entry.id, prior ? { entry, index: prior.index } : { entry, index });
    });

    // Snapshots and diffs are newest-first. For equal timestamps the oldest
    // event is therefore at the largest source index and must be admitted
    // first; assigning `order` after this sort keeps the later queue sort from
    // undoing the stable FIFO decision.
    const orderedEntries = [...uniqueEntries.values()].sort(
      (left, right) => left.entry.at - right.entry.at || right.index - left.index,
    );
    const orderedNewIds: string[] = [];

    for (const { entry } of orderedEntries) {
      const existing = records.get(entry.id);
      if (existing) {
        existing.entry = cloneEntry(entry);
        if (existing.entry.read) removePresentation(entry.id);
        continue;
      }

      const wasSeen = seenIds.has(entry.id);
      addNewRecord(entry);
      if (!wasSeen && !entry.read) {
        if (awaitDelivery) pendingDeliveryIds.add(entry.id);
        else orderedNewIds.push(entry.id);
      }
    }

    if (orderedNewIds.length > 0) {
      if (windowFocused) queuedIds.push(...orderedNewIds);
      else backgroundIds.push(...orderedNewIds);
    }
    sortQueue(queuedIds);
    sortQueue(backgroundIds);
  };

  const seed = (notifications: readonly NotificationEntry[]) => {
    if (disposed) return;
    for (const entry of notifications) {
      const existing = records.get(entry.id);
      if (existing) {
        existing.entry = cloneEntry(entry);
        continue;
      }
      const normalized = cloneEntry(entry);
      records.set(entry.id, {
        entry: normalized,
        order: nextOrder++,
        remainingMs: NOTIFICATION_PRESENTATION_ACTIVE_MS,
        timer: null,
        timerStartedAt: null,
        hovered: false,
        keyboardFocused: false,
        deliveryResolved: true,
        observedInBackground: false,
      });
      rememberSeen(entry.id);
    }
    publish();
  };

  const ingestSnapshot = (notifications: readonly NotificationEntry[]) => {
    if (disposed) return;
    const incomingIds = new Set(notifications.map((entry) => entry.id));
    for (const id of [...records.keys()]) {
      if (incomingIds.has(id)) continue;
      removePresentation(id);
      records.delete(id);
    }
    upsertEntries(notifications);
    fillVisible();
    publish();
  };

  const ingestDiff = (diff: NotificationPresentationDiff) => {
    if (disposed) return;
    for (const id of diff.removedIds ?? []) {
      removePresentation(id);
      records.delete(id);
    }
    upsertEntries([...(diff.added ?? []), ...(diff.updated ?? [])]);
    fillVisible();
    publish();
  };

  const setWindowFocused = (focused: boolean) => {
    if (disposed || windowFocused === focused) return;
    windowFocused = focused;
    if (focused && backgroundIds.length > 0) {
      queuedIds.push(...backgroundIds);
      backgroundIds.length = 0;
      sortQueue(queuedIds);
      fillVisible();
    } else {
      syncVisibleTimers();
    }
    publish();
  };

  const resolveDelivery = (notificationId: string, accepted: boolean) => {
    if (disposed) return;
    const wasPending = pendingDeliveryIds.delete(notificationId);
    const deliveryTimer = pendingDeliveryTimers.get(notificationId);
    if (deliveryTimer !== undefined) {
      cancel(deliveryTimer);
      pendingDeliveryTimers.delete(notificationId);
    }
    const record = records.get(notificationId);
    if (!record || record.entry.read) return;
    // A missing-receipt timeout intentionally admits the in-app fallback, but
    // a real native receipt can still arrive after that timeout. Reconcile a
    // late foreground acceptance so it does not leave both presenters visible.
    // Background-origin entries deliberately keep their one focus catch-up.
    if (!wasPending && record.deliveryResolved) {
      if (accepted && !record.observedInBackground) {
        const wasVisible = isVisible(notificationId);
        removePresentation(notificationId);
        if (wasVisible) fillVisible();
        publish();
      }
      return;
    }
    record.deliveryResolved = true;
    // Native acceptance suppresses the immediate foreground fallback. A
    // background event remains eligible for exactly one focus catch-up.
    if (accepted && record.observedInBackground) {
      if (windowFocused) queuedIds.push(notificationId);
      else backgroundIds.push(notificationId);
    } else if (!accepted) {
      if (windowFocused) queuedIds.push(notificationId);
      else backgroundIds.push(notificationId);
    }
    sortQueue(queuedIds);
    sortQueue(backgroundIds);
    fillVisible();
    publish();
  };

  const setGlobalPresentationState = (state: NotificationPresentationGlobalState) => {
    if (disposed) return;
    let changed = false;
    if (state.paused !== undefined && state.paused !== globalPaused) {
      globalPaused = state.paused;
      changed = true;
    }
    if (state.hidden !== undefined && state.hidden !== globalHidden) {
      globalHidden = state.hidden;
      changed = true;
    }
    if (!changed) return;
    syncVisibleTimers();
    publish();
  };

  const setItemInteraction = (
    notificationId: string,
    interaction: { hovered?: boolean; keyboardFocused?: boolean },
  ) => {
    if (disposed) return;
    const record = records.get(notificationId);
    if (!record || !isVisible(notificationId)) return;
    let changed = false;
    if (interaction.hovered !== undefined && interaction.hovered !== record.hovered) {
      record.hovered = interaction.hovered;
      changed = true;
    }
    if (
      interaction.keyboardFocused !== undefined &&
      interaction.keyboardFocused !== record.keyboardFocused
    ) {
      record.keyboardFocused = interaction.keyboardFocused;
      changed = true;
    }
    if (!changed) return;
    syncTimer(notificationId);
    publish();
  };

  const close = (notificationId: string) => {
    if (disposed || !records.has(notificationId)) return;
    removeAndRefill(notificationId);
  };

  const acknowledge = (notificationId: string) => {
    if (disposed) return;
    const record = records.get(notificationId);
    if (!record) return;
    record.entry = cloneEntry({ ...record.entry, read: true });
    removeAndRefill(notificationId);
  };

  const remove = (notificationId: string) => {
    if (disposed || !records.has(notificationId)) return;
    const wasVisible = isVisible(notificationId);
    removePresentation(notificationId);
    records.delete(notificationId);
    if (wasVisible) fillVisible();
    publish();
  };

  const clear = () => {
    if (disposed) return;
    for (const record of records.values()) clearTimer(record);
    for (const timer of pendingDeliveryTimers.values()) cancel(timer);
    pendingDeliveryTimers.clear();
    visibleIds.length = 0;
    queuedIds.length = 0;
    backgroundIds.length = 0;
    records.clear();
    publish();
  };

  const controller: NotificationPresentationController = {
    seed,
    ingestSnapshot,
    ingestDiff,
    ingest: ingestSnapshot,
    resolveDelivery,
    setWindowFocused,
    setGlobalPresentationState,
    setGlobalPaused: (paused) => setGlobalPresentationState({ paused }),
    setGlobalHidden: (hidden) => setGlobalPresentationState({ hidden }),
    setItemInteraction,
    setItemHover: (notificationId, hovered) =>
      setItemInteraction(notificationId, { hovered }),
    setItemKeyboardFocus: (notificationId, focused) =>
      setItemInteraction(notificationId, { keyboardFocused: focused }),
    close,
    autoCollapse: close,
    acknowledge,
    remove,
    clear,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const record of records.values()) clearTimer(record);
      for (const timer of pendingDeliveryTimers.values()) cancel(timer);
      pendingDeliveryTimers.clear();
      listeners.clear();
      visibleIds.length = 0;
      queuedIds.length = 0;
      backgroundIds.length = 0;
      records.clear();
      seenIds.clear();
      snapshot = EMPTY_SNAPSHOT;
    },
  };

  if (options.initialNotifications) seed(options.initialNotifications);
  else publish();

  return controller;
}

/**
 * A tiny runtime-only relay between the OS bridge and the main-window
 * presentation provider. It carries no notification content and is scoped to
 * the current renderer process.
 */
class NotificationPresentationDeliveryBus {
  private readonly listeners = new Set<(notificationId: string, accepted: boolean) => void>();
  private readonly decisions = new Map<string, boolean>();
  private readonly limit = 2_048;

  resolve(notificationId: string, accepted: boolean): void {
    this.decisions.delete(notificationId);
    this.decisions.set(notificationId, accepted);
    while (this.decisions.size > this.limit) {
      const oldest = this.decisions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.decisions.delete(oldest);
    }
    for (const listener of this.listeners) listener(notificationId, accepted);
  }

  get(notificationId: string): boolean | undefined {
    return this.decisions.get(notificationId);
  }

  subscribe(listener: (notificationId: string, accepted: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const notificationPresentationDeliveryBus = new NotificationPresentationDeliveryBus();
