import type { StateStorage } from 'zustand/middleware';

/**
 * FIX-3 (deep-research-defect-fix / second-diagnosis 问题一-B):
 *
 * Wrap `localStorage` with a trailing-debounced `setItem` so a burst of
 * per-chunk store mutations (`updateCardOutput` / `updateCardReplyPreview`,
 * one per PTY output chunk) no longer triggers one synchronous full
 * `JSON.stringify(cards)` + blocking `localStorage` write *per chunk* —
 * that was the main-thread I/O / serialization jank under sustained
 * streaming output.
 *
 * Contract:
 * - `getItem` / `removeItem` stay synchronous and pass through, so store
 *   rehydrate and clear semantics are byte-for-byte unchanged.
 * - `setItem` keeps only the latest pending value and writes at most once
 *   per `delayMs`; the pending write is flushed on tab hide / unload so a
 *   normal close never loses the final state.
 * - Worst-case data loss on a hard crash is ≤ `delayMs` of *metadata*
 *   mutations. Acceptable: cards metadata is non-transactional and live
 *   terminal content is owned by the backend PTY, not this store.
 *
 * `storage` key / `version` / `migrate` / `partialize` are untouched, so
 * this is a pure write-timing change with no migration and full backward
 * compatibility.
 */
export function createThrottledLocalStorage(delayMs = 500): StateStorage {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: string } | null = null;
  let warnedPersistFailure = false;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      try {
        localStorage.setItem(pending.name, pending.value);
        warnedPersistFailure = false;
      } catch (error) {
        // Quota exceeded / storage disabled: same failure mode a direct
        // setItem would have had. Never throw from the persist path — but
        // surface it once (audit P2-4): a silently-full quota means EVERY
        // subsequent persist (cards metadata included) is being dropped.
        if (!warnedPersistFailure) {
          warnedPersistFailure = true;
          // eslint-disable-next-line no-console
          console.warn(
            '[throttledStorage] persist failed — localStorage may be full or disabled; further state changes will not survive a restart:',
            error,
          );
        }
      }
      pending = null;
    }
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  return {
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      pending = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      localStorage.removeItem(name);
    },
  };
}
