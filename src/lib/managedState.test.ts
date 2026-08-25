import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tauri: false,
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  isTauri: () => mocks.tauri,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

import {
  MANAGED_STATE_CHANGED_EVENT,
  MANAGED_STATE_KEYS,
  listenManagedStateChanges,
  managedStateStorage,
  readManagedStateItem,
  removeManagedStateItem,
  resetManagedStateCacheForTests,
  writeManagedStateItem,
} from './managedState';

interface MemoryEntry {
  initialized: boolean;
  value: string | null;
}

interface MemoryBackendOptions {
  terminalReconciled?: boolean;
  terminalAuthoritativeValue?: string;
}

function installMemoryBackend(options: MemoryBackendOptions = {}) {
  const state = new Map<string, MemoryEntry>();
  mocks.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      const key = String(args.key);
      if (command === 'managed_state_get') {
        const entry = state.get(key) ?? { initialized: false, value: null };
        return { ...entry, recoveredBackup: false };
      }
      if (command === 'managed_state_import_legacy') {
        if (state.get(key)?.initialized) return { imported: false };
        state.set(key, {
          initialized: true,
          value: typeof args.value === 'string' ? args.value : null,
        });
        return { imported: true };
      }
      if (command === 'managed_state_set') {
        state.set(key, { initialized: true, value: String(args.value) });
        return undefined;
      }
      if (command === 'managed_state_set_v2') {
        const reconciled =
          key === MANAGED_STATE_KEYS.terminal && options.terminalReconciled === true;
        state.set(key, {
          initialized: true,
          value: reconciled
            ? options.terminalAuthoritativeValue ?? String(args.value)
            : String(args.value),
        });
        return { reconciled };
      }
      if (command === 'managed_state_remove') {
        state.set(key, { initialized: true, value: null });
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  return state;
}

beforeEach(() => {
  mocks.tauri = false;
  mocks.invoke.mockReset();
  mocks.listen.mockReset();
  localStorage.clear();
  resetManagedStateCacheForTests();
});

describe('managedStateStorage', () => {
  it('preserves synchronous localStorage behavior outside Tauri', () => {
    managedStateStorage.setItem(MANAGED_STATE_KEYS.workbench, 'browser');
    expect(managedStateStorage.getItem(MANAGED_STATE_KEYS.workbench)).toBe('browser');

    managedStateStorage.removeItem(MANAGED_STATE_KEYS.workbench);
    expect(managedStateStorage.getItem(MANAGED_STATE_KEYS.workbench)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('imports a legacy value exactly once before using managed state', async () => {
    mocks.tauri = true;
    const state = installMemoryBackend();
    localStorage.setItem(MANAGED_STATE_KEYS.terminal, 'legacy');

    await expect(readManagedStateItem(MANAGED_STATE_KEYS.terminal)).resolves.toBe('legacy');
    expect(state.get(MANAGED_STATE_KEYS.terminal)).toEqual({
      initialized: true,
      value: 'legacy',
    });

    localStorage.setItem(MANAGED_STATE_KEYS.terminal, 'stale');
    resetManagedStateCacheForTests();
    await expect(readManagedStateItem(MANAGED_STATE_KEYS.terminal)).resolves.toBe('legacy');
  });

  it('keeps a managed tombstone instead of reviving stale localStorage', async () => {
    mocks.tauri = true;
    installMemoryBackend();
    localStorage.setItem(MANAGED_STATE_KEYS.overlay, 'legacy');

    await readManagedStateItem(MANAGED_STATE_KEYS.overlay);
    await removeManagedStateItem(MANAGED_STATE_KEYS.overlay);
    resetManagedStateCacheForTests();

    await expect(readManagedStateItem(MANAGED_STATE_KEYS.overlay)).resolves.toBeNull();
    expect(localStorage.getItem(MANAGED_STATE_KEYS.overlay)).toBe('legacy');
  });

  it('uses v2 for terminal writes and caches the incoming value when unreconciled', async () => {
    mocks.tauri = true;
    installMemoryBackend();

    await writeManagedStateItem(MANAGED_STATE_KEYS.terminal, 'incoming');

    expect(mocks.invoke).toHaveBeenCalledWith('managed_state_set_v2', {
      key: MANAGED_STATE_KEYS.terminal,
      value: 'incoming',
      sourceId: expect.any(String),
    });
    expect(readManagedStateItem(MANAGED_STATE_KEYS.terminal)).toBe('incoming');
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'managed_state_get'),
    ).toHaveLength(0);
  });

  it('clears the origin cache when v2 reconciles and reads the backend authority next', async () => {
    mocks.tauri = true;
    const state = installMemoryBackend({
      terminalReconciled: true,
      terminalAuthoritativeValue: 'authoritative',
    });
    state.set(MANAGED_STATE_KEYS.terminal, {
      initialized: true,
      value: 'cached',
    });
    await expect(readManagedStateItem(MANAGED_STATE_KEYS.terminal)).resolves.toBe('cached');

    await writeManagedStateItem(MANAGED_STATE_KEYS.terminal, 'incoming');

    await expect(readManagedStateItem(MANAGED_STATE_KEYS.terminal)).resolves.toBe(
      'authoritative',
    );
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'managed_state_get'),
    ).toHaveLength(2);
  });

  it('keeps nonterminal desktop writes on the legacy command and cache behavior', async () => {
    mocks.tauri = true;
    installMemoryBackend();

    await writeManagedStateItem(MANAGED_STATE_KEYS.overlay, 'incoming');

    expect(mocks.invoke).toHaveBeenCalledWith('managed_state_set', {
      key: MANAGED_STATE_KEYS.overlay,
      value: 'incoming',
      sourceId: expect.any(String),
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'managed_state_set_v2',
      expect.anything(),
    );
    expect(readManagedStateItem(MANAGED_STATE_KEYS.overlay)).toBe('incoming');
  });

  it('re-reads the winner when another WebView wins the import race', async () => {
    mocks.tauri = true;
    mocks.invoke
      .mockResolvedValueOnce({
        initialized: false,
        value: null,
        recoveredBackup: false,
      })
      .mockResolvedValueOnce({ imported: false })
      .mockResolvedValueOnce({
        initialized: true,
        value: 'other-webview',
        recoveredBackup: false,
      });
    localStorage.setItem(MANAGED_STATE_KEYS.language, 'zh-CN');

    await expect(readManagedStateItem(MANAGED_STATE_KEYS.language)).resolves.toBe(
      'other-webview',
    );
  });

  it('does not silently replace a desktop read failure with legacy data', async () => {
    mocks.tauri = true;
    mocks.invoke.mockRejectedValueOnce(new Error('selected disk unavailable'));
    localStorage.setItem(MANAGED_STATE_KEYS.workbench, 'misleading-old-state');

    await expect(readManagedStateItem(MANAGED_STATE_KEYS.workbench)).rejects.toThrow(
      'selected disk unavailable',
    );
  });

  it('notifies other WebViews but ignores the writer event', async () => {
    mocks.tauri = true;
    installMemoryBackend();
    let eventHandler:
      | ((event: { payload: { key: string; sourceId: string } }) => void)
      | undefined;
    mocks.listen.mockImplementation(async (event, handler) => {
      expect(event).toBe(MANAGED_STATE_CHANGED_EVENT);
      eventHandler = handler;
      return () => {};
    });
    const onChange = vi.fn();
    await listenManagedStateChanges(onChange);
    await writeManagedStateItem(MANAGED_STATE_KEYS.overlay, 'next');
    const writerSourceId = String(
      mocks.invoke.mock.calls.find(([command]) => command === 'managed_state_set')?.[1]
        ?.sourceId,
    );

    eventHandler?.({
      payload: {
        key: MANAGED_STATE_KEYS.overlay,
        sourceId: writerSourceId,
      },
    });
    expect(onChange).not.toHaveBeenCalled();

    eventHandler?.({
      payload: {
        key: MANAGED_STATE_KEYS.overlay,
        sourceId: 'another-webview',
      },
    });
    expect(onChange).toHaveBeenCalledWith(MANAGED_STATE_KEYS.overlay);
  });
});
