import type { PersistStorage, StorageValue } from 'zustand/middleware';

export interface ThrottledPersistDiagnostics {
  pending: boolean;
  trailingTimerScheduled: boolean;
  maxWaitTimerScheduled: boolean;
  serializationCount: number;
  writeCount: number;
}

export interface ThrottledPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
  dispose: () => void;
  getDiagnostics: () => ThrottledPersistDiagnostics;
}

/**
 * Debounce Zustand persistence at the object-storage boundary.
 *
 * `createJSONStorage(StateStorage)` stringifies before `StateStorage.setItem`,
 * so delaying only the string write still serializes the complete store on
 * every hot-path mutation. This storage retains the latest immutable
 * `StorageValue` and performs both stringify and localStorage I/O at flush.
 * A max-wait timer bounds selector/float/restart-preview staleness under a
 * stream that never becomes idle.
 */
export function createThrottledPersistStorage<S>(
  delayMs = 500,
  maxWaitMs = 2000,
  getStorage: () => Storage = () => localStorage,
): ThrottledPersistStorage<S> {
  const boundedMaxWaitMs = Math.max(delayMs, maxWaitMs);
  const storage = getStorage();
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: StorageValue<S> } | null = null;
  let warnedPersistFailure = false;
  let serializationCount = 0;
  let writeCount = 0;

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

  const flush = (): void => {
    clearTimers();
    const next = pending;
    pending = null;
    if (!next) return;

    try {
      serializationCount += 1;
      const serialized = JSON.stringify(next.value);
      storage.setItem(next.name, serialized);
      writeCount += 1;
      warnedPersistFailure = false;
    } catch (error) {
      if (!warnedPersistFailure) {
        warnedPersistFailure = true;
        console.warn(
          '[throttledStorage] persist failed — localStorage may be full or disabled; further state changes will not survive a restart:',
          error,
        );
      }
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
      return raw === null ? null : (JSON.parse(raw) as StorageValue<S>);
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
      storage.removeItem(name);
    },
    flush,
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
