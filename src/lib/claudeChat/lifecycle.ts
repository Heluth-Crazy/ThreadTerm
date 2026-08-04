/**
 * Claude Chat resource ownership for card-level terminal lifecycle actions.
 *
 * A card may disappear while its React view is already unmounted, so teardown
 * cannot live in ClaudeChatView. The controller is deliberately independent of
 * React and keeps only a small, bounded diagnostic history.
 */
import { claudeChat } from './api';
import { isTauriEnv } from '../tauri-bridge';
import { logger } from '../logger';
import { useClaudeChatStore } from '../../stores/claudeChatStore';

export type ClaudeChatCleanupReason = 'remove' | 'archive' | 'type-change' | 'app-exit';
export type ClaudeChatCleanupState = 'pending' | 'succeeded' | 'failed';

export interface ClaudeChatCleanupResult {
  cardId: string;
  reason: ClaudeChatCleanupReason;
  ok: boolean;
  attempts: number;
  error: string | null;
}

export interface ClaudeChatCleanupRecord extends ClaudeChatCleanupResult {
  state: ClaudeChatCleanupState;
  startedAt: number;
  completedAt: number | null;
}

export interface ClaudeChatLifecycleDiagnostics {
  pendingCount: number;
  failedCount: number;
  succeededCount: number;
  retryCount: number;
  recent: ClaudeChatCleanupRecord[];
}

interface ClaudeChatLifecycleDependencies {
  stop: (cardId: string) => Promise<void>;
  resetCard: (cardId: string) => void;
  isDesktop: () => boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  maxDiagnosticRecords?: number;
  onFailure?: (record: ClaudeChatCleanupRecord) => void;
}

export interface ClaudeChatLifecycleController {
  releaseCard: (
    cardId: string,
    reason: ClaudeChatCleanupReason,
  ) => Promise<ClaudeChatCleanupResult>;
  waitForCard: (cardId: string) => Promise<ClaudeChatCleanupResult | null>;
  diagnostics: () => ClaudeChatLifecycleDiagnostics;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAYS_MS = [0, 100, 500] as const;
const DEFAULT_MAX_DIAGNOSTIC_RECORDS = 32;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return operation;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(
      () => reject(new Error(`Claude Chat cleanup timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

/** Create an isolated controller for the product singleton and deterministic tests. */
export function createClaudeChatLifecycleController(
  dependencies: ClaudeChatLifecycleDependencies,
): ClaudeChatLifecycleController {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? wait;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxDiagnosticRecords = Math.max(
    1,
    dependencies.maxDiagnosticRecords ?? DEFAULT_MAX_DIAGNOSTIC_RECORDS,
  );
  const inFlight = new Map<string, Promise<ClaudeChatCleanupResult>>();
  const recent = new Map<string, ClaudeChatCleanupRecord>();
  let failedCount = 0;
  let succeededCount = 0;
  let retryCount = 0;

  const publish = (record: ClaudeChatCleanupRecord) => {
    recent.delete(record.cardId);
    recent.set(record.cardId, { ...record });
    while (recent.size > maxDiagnosticRecords) {
      const oldest = recent.keys().next().value as string | undefined;
      if (!oldest) break;
      recent.delete(oldest);
    }
  };

  const releaseCard = (
    cardId: string,
    reason: ClaudeChatCleanupReason,
  ): Promise<ClaudeChatCleanupResult> => {
    // Rebuildable view state should be released even when the native session
    // is already gone or the app is running in a browser-only test surface.
    dependencies.resetCard(cardId);

    const active = inFlight.get(cardId);
    if (active) return active;

    const record: ClaudeChatCleanupRecord = {
      cardId,
      reason,
      state: 'pending',
      ok: false,
      attempts: 0,
      error: null,
      startedAt: now(),
      completedAt: null,
    };
    publish(record);

    const task = (async (): Promise<ClaudeChatCleanupResult> => {
      if (!dependencies.isDesktop()) {
        record.state = 'succeeded';
        record.ok = true;
        record.completedAt = now();
        succeededCount += 1;
        publish(record);
        return { ...record };
      }

      const attempts = Math.max(1, retryDelaysMs.length);
      for (let index = 0; index < attempts; index += 1) {
        const delayMs = retryDelaysMs[index] ?? 0;
        if (delayMs > 0) await sleep(delayMs);
        record.attempts = index + 1;
        publish(record);
        try {
          await withTimeout(Promise.resolve().then(() => dependencies.stop(cardId)), timeoutMs);
          record.state = 'succeeded';
          record.ok = true;
          record.error = null;
          record.completedAt = now();
          succeededCount += 1;
          publish(record);
          return { ...record };
        } catch (error) {
          record.error = errorText(error);
          if (index + 1 < attempts) retryCount += 1;
        }
      }

      record.state = 'failed';
      record.completedAt = now();
      failedCount += 1;
      publish(record);
      dependencies.onFailure?.({ ...record });
      return { ...record };
    })();

    inFlight.set(cardId, task);
    void task.finally(() => {
      if (inFlight.get(cardId) === task) inFlight.delete(cardId);
    });
    return task;
  };

  return {
    releaseCard,
    waitForCard: async (cardId) => inFlight.get(cardId) ?? null,
    diagnostics: () => ({
      pendingCount: inFlight.size,
      failedCount,
      succeededCount,
      retryCount,
      recent: [...recent.values()].map((record) => ({ ...record })),
    }),
  };
}

const controller = createClaudeChatLifecycleController({
  stop: (cardId) => claudeChat.stop(cardId),
  resetCard: (cardId) => useClaudeChatStore.getState().resetCard(cardId),
  // Keep environment detection lazy so importing the terminal store does not
  // require every unrelated test/surface to provide the full Tauri bridge.
  isDesktop: () => isTauriEnv(),
  onFailure: (record) => {
    logger.error(
      `[ClaudeChatLifecycle] failed to release ${record.cardId} (${record.reason}) after ${record.attempts} attempts: ${record.error ?? 'unknown error'}`,
    );
  },
});

export function releaseClaudeChatCard(
  cardId: string,
  reason: ClaudeChatCleanupReason,
): Promise<ClaudeChatCleanupResult> {
  return controller.releaseCard(cardId, reason);
}

export function waitForClaudeChatCleanup(
  cardId: string,
): Promise<ClaudeChatCleanupResult | null> {
  return controller.waitForCard(cardId);
}

export function getClaudeChatLifecycleDiagnostics(): ClaudeChatLifecycleDiagnostics {
  return controller.diagnostics();
}
