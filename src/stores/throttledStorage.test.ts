import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createThrottledPersistStorage,
  type ThrottledPersistStorage,
} from './throttledStorage';

interface TestState {
  value: string;
}

const storedValue = (value: string) => ({ state: { value }, version: 18 });

describe('createThrottledPersistStorage', () => {
  const storages: Array<ThrottledPersistStorage<TestState>> = [];
  const createStorage = (delayMs = 500, maxWaitMs = 2000) => {
    const storage = createThrottledPersistStorage<TestState>(delayMs, maxWaitMs);
    storages.push(storage);
    return storage;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    for (const storage of storages.splice(0)) storage.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces object updates and stringifies only at the flush boundary', () => {
    const setSpy = vi.spyOn(localStorage, 'setItem');
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    const storage = createStorage();

    for (let i = 0; i < 100; i += 1) {
      storage.setItem('threadterm-terminal-store', storedValue(`v${i}`));
    }
    expect(setSpy).not.toHaveBeenCalled();
    expect(stringifySpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(stringifySpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('threadterm-terminal-store') ?? '{}'))
      .toEqual(storedValue('v99'));
  });

  it('parses getItem synchronously with the existing versioned JSON shape', () => {
    localStorage.setItem('k', JSON.stringify(storedValue('direct')));
    const storage = createStorage();
    expect(storage.getItem('k')).toEqual(storedValue('direct'));
  });

  it('round-trips a large current-version payload without truncation', () => {
    const storage = createStorage();
    const largeValue = storedValue('界'.repeat(750_000));

    storage.setItem('k', largeValue);
    vi.advanceTimersByTime(500);

    expect(storage.getItem('k')).toEqual(largeValue);
  });

  it('ignores corrupted persisted data without deleting the original value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const corrupted = '{"state":{"value":"unfinished"';
    localStorage.setItem('k', corrupted);
    const storage = createStorage();

    expect(storage.getItem('k')).toBeNull();
    expect(localStorage.getItem('k')).toBe(corrupted);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('removeItem drops a pending write and clears synchronously', () => {
    const storage = createStorage();
    storage.setItem('k', storedValue('pending'));
    storage.removeItem('k');

    vi.advanceTimersByTime(2000);

    expect(localStorage.getItem('k')).toBeNull();
    expect(storage.getDiagnostics()).toMatchObject({ pending: false });
  });

  it('flushes the pending write on beforeunload', () => {
    const storage = createStorage();
    storage.setItem('k', storedValue('onunload'));

    window.dispatchEvent(new Event('beforeunload'));

    expect(storage.getItem('k')).toEqual(storedValue('onunload'));
  });

  it('flushes the pending write when the tab becomes hidden', () => {
    const storage = createStorage();
    storage.setItem('k', storedValue('hidden'));
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');

    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockRestore();

    expect(storage.getItem('k')).toEqual(storedValue('hidden'));
  });

  it('flushes within maxWait while updates continuously reset the trailing timer', () => {
    const setSpy = vi.spyOn(localStorage, 'setItem');
    const storage = createStorage(500, 1200);

    storage.setItem('k', storedValue('v0'));
    vi.advanceTimersByTime(300);
    storage.setItem('k', storedValue('v1'));
    vi.advanceTimersByTime(300);
    storage.setItem('k', storedValue('v2'));
    vi.advanceTimersByTime(300);
    storage.setItem('k', storedValue('v3'));
    vi.advanceTimersByTime(299);
    expect(setSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(storage.getItem('k')).toEqual(storedValue('v3'));
    expect(storage.getDiagnostics()).toMatchObject({
      pending: false,
      serializationCount: 1,
      writeCount: 1,
    });
  });

  it('warns once per consecutive persistence-failure period', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const storage = createStorage();

    storage.setItem('k', storedValue('v1'));
    vi.advanceTimersByTime(500);
    storage.setItem('k', storedValue('v2'));
    vi.advanceTimersByTime(500);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    setSpy.mockRestore();
    storage.setItem('k', storedValue('ok'));
    vi.advanceTimersByTime(500);
    expect(storage.getItem('k')).toEqual(storedValue('ok'));

    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    storage.setItem('k', storedValue('v3'));
    vi.advanceTimersByTime(500);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
