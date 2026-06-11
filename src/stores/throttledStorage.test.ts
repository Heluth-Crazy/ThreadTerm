import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottledLocalStorage } from './throttledStorage';

describe('createThrottledLocalStorage (FIX-3 / second-diagnosis 问题一-B)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces a burst of per-chunk setItem into a single delayed write', () => {
    const setSpy = vi.spyOn(localStorage, 'setItem');
    const storage = createThrottledLocalStorage(500);

    for (let i = 0; i < 100; i += 1) {
      storage.setItem('threadterm-terminal-store', `v${i}`);
    }
    // Nothing written yet — all 100 writes are debounced.
    expect(setSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    // Exactly one real write, carrying only the latest value.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith('threadterm-terminal-store', 'v99');
    expect(localStorage.getItem('threadterm-terminal-store')).toBe('v99');
  });

  it('passes getItem through synchronously', () => {
    localStorage.setItem('k', 'direct');
    const storage = createThrottledLocalStorage(500);
    expect(storage.getItem('k')).toBe('direct');
  });

  it('removeItem drops a pending write and clears synchronously', () => {
    const storage = createThrottledLocalStorage(500);
    storage.setItem('k', 'pending');
    storage.removeItem('k');

    vi.advanceTimersByTime(500);

    // The pending debounced write must not resurrect the removed key.
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('flushes the pending write on beforeunload (no data loss on close)', () => {
    const storage = createThrottledLocalStorage(500);
    storage.setItem('k', 'onunload');
    expect(localStorage.getItem('k')).toBeNull();

    window.dispatchEvent(new Event('beforeunload'));

    expect(localStorage.getItem('k')).toBe('onunload');
  });

  it('flushes the pending write when the tab becomes hidden', () => {
    const storage = createThrottledLocalStorage(500);
    storage.setItem('k', 'late');
    expect(localStorage.getItem('k')).toBeNull();

    const spy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    spy.mockRestore();

    expect(localStorage.getItem('k')).toBe('late');
  });

  it('warns once when persist fails (quota), then again after a recovery (audit P2-4)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setSpy = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    const storage = createThrottledLocalStorage(500);

    // Two consecutive failures → exactly one warning (no log spam).
    storage.setItem('k', 'v1');
    vi.advanceTimersByTime(500);
    storage.setItem('k', 'v2');
    vi.advanceTimersByTime(500);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A successful write resets the latch…
    setSpy.mockRestore();
    storage.setItem('k', 'ok');
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem('k')).toBe('ok');

    // …so a NEW failure period warns again.
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    storage.setItem('k', 'v3');
    vi.advanceTimersByTime(500);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
