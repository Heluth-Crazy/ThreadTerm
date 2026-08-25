import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { NotificationEntry } from '../types/terminal';
import { sanitizeNotificationSummary } from './notificationLedger';
import { isTauriEnv, invoke } from './tauri-bridge';
import { logger } from './logger';

export const NOTIFICATION_ACTIVATED_EVENT = 'notification://activated';

export type NotificationDeliveryStatus =
  | 'accepted'
  | 'degraded'
  | 'failed'
  | 'disabled-by-system';

export type NotificationDeliveryChannel =
  | 'windows-native'
  | 'plugin'
  | 'browser'
  | 'unknown';

export type NotificationDeliveryReason =
  | 'identity-unavailable'
  | 'disabled-for-application'
  | 'disabled-for-user'
  | 'disabled-by-group-policy'
  | 'disabled-by-manifest'
  | 'native-show-failed'
  | 'plugin-fallback-failed';

export type NotificationIdentitySource = 'nsis-shortcut' | 'runtime-registration';

export interface NotificationDeliveryReceipt {
  notificationId: string | null;
  channel: NotificationDeliveryChannel;
  status: NotificationDeliveryStatus;
  targetExists?: boolean;
  reason?: NotificationDeliveryReason;
  identitySource?: NotificationIdentitySource;
}

export interface NotificationActivationPayload {
  notificationId?: string | null;
}

export interface OsNotificationInput {
  notificationId?: string | null;
  cardId?: string | null;
  title: string;
  body: string;
}

export interface NotificationBodyInput {
  sourceLabel?: string | null;
  summary?: string | null;
  previewEnabled: boolean;
}

/** Runtime-only receipt stream for settings/diagnostic consumers. */
class NotificationReceiptBus {
  private current: NotificationDeliveryReceipt | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NotificationDeliveryReceipt | null => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(receipt: NotificationDeliveryReceipt): void {
    this.current = { ...receipt };
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.current = null;
    for (const listener of this.listeners) listener();
  }
}

export const notificationReceiptBus = new NotificationReceiptBus();

/**
 * Build the only body sent to the operating-system channel. The source label
 * remains useful when previews are disabled, while task output is omitted
 * entirely in that mode.
 */
export function buildNotificationBody({
  sourceLabel,
  summary,
  previewEnabled,
}: NotificationBodyInput): string {
  const header = sourceLabel ? `ThreadTerm · ${sourceLabel}` : 'ThreadTerm';
  if (!previewEnabled) return header;
  const sanitized = sanitizeNotificationSummary(summary);
  return sanitized ? `${header}\n${sanitized}` : header;
}

/** Keep Rust's serde receipt optional fields backwards-compatible. */
export function normalizeNotificationReceipt(
  raw: Partial<NotificationDeliveryReceipt> | null | undefined,
  requestedNotificationId?: string | null,
): NotificationDeliveryReceipt {
  const status = raw?.status;
  const channel = raw?.channel;
  return {
    notificationId:
      typeof raw?.notificationId === 'string'
        ? raw.notificationId
        : requestedNotificationId ?? null,
    channel:
      channel === 'windows-native' || channel === 'plugin' || channel === 'browser'
        ? channel
        : 'unknown',
    status:
      status === 'accepted' ||
      status === 'degraded' ||
      status === 'failed' ||
      status === 'disabled-by-system'
        ? status
        : 'failed',
    ...(typeof raw?.targetExists === 'boolean'
      ? { targetExists: raw.targetExists }
      : {}),
    ...(isNotificationDeliveryReason(raw?.reason) ? { reason: raw.reason } : {}),
    ...(raw?.identitySource === 'nsis-shortcut' || raw?.identitySource === 'runtime-registration'
      ? { identitySource: raw.identitySource }
      : {}),
  };
}

function isNotificationDeliveryReason(value: unknown): value is NotificationDeliveryReason {
  return value === 'identity-unavailable' ||
    value === 'disabled-for-application' ||
    value === 'disabled-for-user' ||
    value === 'disabled-by-group-policy' ||
    value === 'disabled-by-manifest' ||
    value === 'native-show-failed' ||
    value === 'plugin-fallback-failed';
}

/**
 * Shared production delivery adapter. Native/plugin fallback decisions remain
 * in Rust; this boundary only sends the typed request and redacts failures.
 */
export async function sendOsNotification(
  input: OsNotificationInput,
): Promise<NotificationDeliveryReceipt> {
  const notificationId = input.notificationId ?? null;
  if (!isTauriEnv()) {
    const receipt = {
      notificationId,
      channel: 'browser',
      status: 'disabled-by-system',
    } as const;
    notificationReceiptBus.publish(receipt);
    return receipt;
  }

  try {
    const raw = await invoke<NotificationDeliveryReceipt>('notification_send_os', {
      notificationId,
      title: input.title,
      body: input.body,
      cardId: input.cardId ?? null,
    });
    const receipt = normalizeNotificationReceipt(raw, notificationId);
    notificationReceiptBus.publish(receipt);
    return receipt;
  } catch {
    // Never pass the error object or body to diagnostics. Rust logs the same
    // redacted contract for failures in its own command boundary.
    logger.warn('[notificationDelivery] OS delivery failed', {
      notificationId,
      channel: 'invoke',
      status: 'failed',
    });
    const receipt: NotificationDeliveryReceipt = {
      notificationId,
      channel: 'unknown',
      status: 'failed',
    };
    notificationReceiptBus.publish(receipt);
    return receipt;
  }
}

/** Build a bounded, deterministic ID for settings' ephemeral test toast. */
let testIdCounter = 0;
export function createNotificationTestId(): string {
  testIdCounter = (testIdCounter + 1) % 100_000;
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${testIdCounter.toString(36)}`;
  return `notification-test:${randomPart}`;
}

export interface NotificationTestActivation {
  notificationId: string;
  cardId: string | null;
  onClicked: () => void;
}

/** Runtime-only registry; settings tests never enter the persisted ledger. */
class NotificationTestActivationRegistry {
  private readonly entries = new Map<string, NotificationTestActivation>();
  private readonly limit = 64;

  register(
    notificationId: string,
    cardId: string | null,
    onClicked: () => void,
  ): () => void {
    this.entries.set(notificationId, { notificationId, cardId, onClicked });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    return () => {
      this.entries.delete(notificationId);
    };
  }

  consume(notificationId: string): NotificationTestActivation | undefined {
    const activation = this.entries.get(notificationId);
    if (activation) this.entries.delete(notificationId);
    return activation;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const notificationTestActivationRegistry = new NotificationTestActivationRegistry();

/**
 * Deduplicates a native event and its matching pending-queue drain for the
 * entire application process. Activation identity is not evicted: reusing a
 * native ID after a queue drain must never execute the target twice.
 */
export class NotificationActivationDedupe {
  private readonly seen = new Set<string>();

  accept(notificationId: string | null | undefined): boolean {
    if (!notificationId || this.seen.has(notificationId)) return false;
    this.seen.add(notificationId);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

export interface NotificationActivationChannelOptions {
  onNotificationId: (notificationId: string) => void | Promise<void>;
}

type ActivationSubscriber = NotificationActivationChannelOptions['onNotificationId'];

/**
 * Process-scoped activation relay. It owns the listener and drain promise
 * independently from React effects, so StrictMode cleanup cannot dispose an
 * in-flight drain or drop an ID while the next effect is subscribing.
 */
class NotificationActivationRelay {
  private readonly dedupe = new NotificationActivationDedupe();
  private readonly subscribers = new Set<ActivationSubscriber>();
  private readonly pending: string[] = [];
  private started: Promise<boolean> | null = null;

  subscribe(subscriber: ActivationSubscriber): () => void {
    this.subscribers.add(subscriber);
    void this.start();
    this.flush();
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  ready(): Promise<boolean> {
    return this.start();
  }

  private start(): Promise<boolean> {
    if (this.started) return this.started;
    this.started = (async () => {
      if (!isTauriEnv()) return true;
      // Listener registration must complete before the Rust queue is drained.
      try {
        await listen<NotificationActivationPayload>(
          NOTIFICATION_ACTIVATED_EVENT,
          (event) => this.receive(event.payload?.notificationId),
        );
      } catch {
        logger.warn('[notificationDelivery] activation listener failed', {
          notificationId: null,
          channel: 'activation',
          status: 'failed',
        });
        return false;
      }
      try {
        const pending = await invoke<string[]>('notification_drain_pending_activations');
        if (Array.isArray(pending)) {
          for (const notificationId of pending) this.receive(notificationId);
        }
      } catch {
        logger.warn('[notificationDelivery] activation drain failed', {
          notificationId: null,
          channel: 'activation-drain',
          status: 'failed',
        });
      }
      return true;
    })();
    return this.started;
  }

  private receive(notificationId: string | null | undefined): void {
    if (!this.dedupe.accept(notificationId)) return;
    if (!notificationId || this.subscribers.size === 0) {
      if (notificationId) this.pending.push(notificationId);
      return;
    }
    this.deliver(notificationId);
  }

  private flush(): void {
    if (this.subscribers.size === 0 || this.pending.length === 0) return;
    const pending = this.pending.splice(0, this.pending.length);
    for (const notificationId of pending) this.deliver(notificationId);
  }

  private deliver(notificationId: string): void {
    for (const subscriber of this.subscribers) {
      try {
        void Promise.resolve(subscriber(notificationId)).catch(() => {
          logger.warn('[notificationDelivery] activation subscriber failed', {
            notificationId,
            channel: 'activation',
            status: 'failed',
          });
        });
      } catch {
        logger.warn('[notificationDelivery] activation subscriber failed', {
          notificationId,
          channel: 'activation',
          status: 'failed',
        });
      }
    }
  }

  /** Test-only reset; production identity remains process-scoped. */
  resetForTests(): void {
    this.subscribers.clear();
    this.pending.splice(0, this.pending.length);
    this.dedupe.clear();
    this.started = null;
  }
}

const notificationActivationRelay = new NotificationActivationRelay();

export function subscribeNotificationActivations(
  options: NotificationActivationChannelOptions,
): () => void {
  return notificationActivationRelay.subscribe(options.onNotificationId);
}

export function notificationActivationReady(): Promise<boolean> {
  return notificationActivationRelay.ready();
}

/**
 * Compatibility helper for non-React consumers. React uses the synchronous
 * subscription plus `notificationActivationReady` to survive StrictMode.
 */
export async function installNotificationActivationChannel(
  options: NotificationActivationChannelOptions,
): Promise<UnlistenFn> {
  const unsubscribe = subscribeNotificationActivations(options);
  await notificationActivationReady();
  return unsubscribe;
}

/** Test-only reset for isolated adapter/bridge suites. */
export function resetNotificationActivationRelayForTests(): void {
  notificationActivationRelay.resetForTests();
}

export type NotificationTargetFeedbackKind = 'missing' | 'stale' | 'error';

export interface NotificationTargetFeedback {
  notificationId: string;
  cardId: string | null;
  kind: NotificationTargetFeedbackKind;
  feedbackKey:
    | 'notifications.targetUnavailable'
    | 'notifications.targetNavigationFailed';
  at: number;
}

class NotificationFeedbackBus {
  private current: NotificationTargetFeedback | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NotificationTargetFeedback | null => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(feedback: Omit<NotificationTargetFeedback, 'at'>): void {
    this.current = { ...feedback, at: Date.now() };
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    if (!this.current) return;
    this.current = null;
    for (const listener of this.listeners) listener();
  }
}

export const notificationFeedbackBus = new NotificationFeedbackBus();

export function publishNotificationTargetFeedback(
  resolution: {
    notificationId: string;
    cardId: string;
    kind: 'missing' | 'stale' | 'error';
    feedbackKey:
      | 'notifications.targetUnavailable'
      | 'notifications.targetNavigationFailed';
  },
): void {
  notificationFeedbackBus.publish({
    notificationId: resolution.notificationId,
    cardId: resolution.cardId,
    kind: resolution.kind,
    feedbackKey: resolution.feedbackKey,
  });
}

export function notificationEntryBody(entry: NotificationEntry, sourceLabel: string): string {
  return buildNotificationBody({
    sourceLabel,
    summary: entry.body,
    previewEnabled: true,
  });
}
