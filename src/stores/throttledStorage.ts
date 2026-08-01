import type {
  PersistStorage,
  StateStorage,
  StorageValue,
} from 'zustand/middleware';

export interface ThrottledPersistDiagnostics {
  pending: boolean;
  trailingTimerScheduled: boolean;
  maxWaitTimerScheduled: boolean;
  serializationCount: number;
  writeCount: number;
}

export interface ThrottledPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
  flushAsync: () => Promise<void>;
  dispose: () => void;
  getDiagnostics: () => ThrottledPersistDiagnostics;
}

/**
 * Debounce Zustand persistence at the object-storage boundary.
 *
 * `createJSONStorage(StateStorage)` stringifies before `StateStorage.setItem`,
 * so delaying only the string write still serializes the complete store on
 * every hot-path mutation. This storage retains the latest immutable
 * `StorageValue` and performs both stringify and storage I/O at flush.
 * A max-wait timer bounds selector/float/restart-preview staleness under a
 * stream that never becomes idle.
 */
export function createThrottledPersistStorage<S>(
  delayMs = 500,
  maxWaitMs = 2000,
  getStorage: () => StateStorage<void | Promise<void>> = () => localStorage,
): ThrottledPersistStorage<S> {
  const boundedMaxWaitMs = Math.max(delayMs, maxWaitMs);
  const storage = getStorage();
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: StorageValue<S> } | null = null;
  let warnedPersistFailure = false;
  let serializationCount = 0;
  let writeCount = 0;
  let activeWrite: Promise<void> | null = null;
  const writeQueue: Array<() => void | Promise<void>> = [];
  const idleWaiters: Array<() => void> = [];

  const clearTimers = (): void => {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  const reportWriteFailure = (error: unknown): void => {
    if (warnedPersistFailure) return;
    warnedPersistFailure = true;
    console.warn(
      '[throttledStorage] persist failed; further state changes may not survive a restart:',
      error,
    );
  };

  const notifyIdle = (): void => {
    if (activeWrite !== null || writeQueue.length > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const drainWrites = (): void => {
    if (activeWrite !== null) return;
    const operation = writeQueue.shift();
    if (!operation) {
      notifyIdle();
      return;
    }
    try {
      const result = operation();
      if (result instanceof Promise) {
        activeWrite = result
          .then(() => {
            writeCount += 1;
            warnedPersistFailure = false;
          })
          .catch(reportWriteFailure)
          .finally(() => {
            activeWrite = null;
            drainWrites();
          });
        return;
      }
      writeCount += 1;
      warnedPersistFailure = false;
    } catch (error) {
      reportWriteFailure(error);
    }
    drainWrites();
  };

  const enqueueWrite = (operation: () => void | Promise<void>): void => {
    writeQueue.push(operation);
    drainWrites();
  };

  const flush = (): void => {
    clearTimers();
    const next = pending;
    pending = null;
    if (!next) return;

    try {
      serializationCount += 1;
      const serialized = JSON.stringify(next.value);
      enqueueWrite(() => storage.setItem(next.name, serialized));
    } catch (error) {
      reportWriteFailure(error);
    }
  };

  const onBeforeUnload = (): void => flush();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    getItem: (name) => {
      const raw = storage.getItem(name);
      const parse = (value: string | null): StorageValue<S> | null => {
        if (value === null) return null;
        try {
          return JSON.parse(value) as StorageValue<S>;
        } catch (error) {
          console.warn(
            '[throttledStorage] persisted state is invalid and will be ignored; the original value was left untouched:',
            error,
          );
          return null;
        }
      };
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      // Zustand creates a new partialized state object for each mutation; keep
      // only the latest reference and serialize it at the actual flush edge.
      pending = { name, value };
      if (trailingTimer !== null) clearTimeout(trailingTimer);
      trailingTimer = setTimeout(flush, delayMs);
      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(flush, boundedMaxWaitMs);
      }
    },
    removeItem: (name) => {
      pending = null;
      clearTimers();
      enqueueWrite(() => storage.removeItem(name));
    },
    flush,
    flushAsync: () => {
      flush();
      if (activeWrite === null && writeQueue.length === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    dispose: () => {
      flush();
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.removeEventListener('beforeunload', onBeforeUnload);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
    getDiagnostics: () => ({
      pending: pending !== null,
      trailingTimerScheduled: trailingTimer !== null,
      maxWaitTimerScheduled: maxWaitTimer !== null,
      serializationCount,
      writeCount,
    }),
  };
}
