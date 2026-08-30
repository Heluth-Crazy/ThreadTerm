import { listen as tauriListen } from '@tauri-apps/api/event';
import {
  invoke as tauriInvoke,
  isTauri as tauriIsTauri,
} from '@tauri-apps/api/core';
import type { StateStorage } from 'zustand/middleware';

export const MANAGED_STATE_CHANGED_EVENT = 'managed-state://changed';

export const MANAGED_STATE_KEYS = {
  terminal: 'threadterm-terminal-store',
  workbench: 'threadterm-workbench-store',
  overlay: 'threadterm-overlay',
  language: 'userLanguage',
  themeMode: 'themeMode',
  themePack: 'themePackId',
  legacyTheme: 'theme',
  customThemes: 'threadterm-custom-theme-packs',
  previewUrls: 'threadterm-html-preview-service-urls',
  shortcutHintDismissed: 'threadterm-shortcut-hint-dismissed',
  workspaceSidebarDisclosure: 'threadterm-workspace-sidebar-disclosure',
} as const;

export type ManagedStateKey =
  (typeof MANAGED_STATE_KEYS)[keyof typeof MANAGED_STATE_KEYS];

interface ManagedStateRead {
  initialized: boolean;
  value: string | null;
  recoveredBackup: boolean;
}

interface ManagedStateWrite {
  imported: boolean;
}

interface ManagedStateSetOutcome {
  reconciled: boolean;
}

interface ManagedStateChanged {
  key: string;
  sourceId: string;
}

const MANAGED_STATE_KEY_SET = new Set<string>(Object.values(MANAGED_STATE_KEYS));
const valueCache = new Map<ManagedStateKey, string | null>();

function createSourceId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `webview:${randomUuid}`;
  return `webview:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

const sourceId = createSourceId();

function hasManagedStateBackend(): boolean {
  if (tauriIsTauri()) return true;
  if (typeof window === 'undefined') return false;
  return (
    typeof (
      window as {
        __TAURI__?: unknown;
        __TAURI_INTERNALS__?: unknown;
      }
    ).__TAURI_INTERNALS__ !== 'undefined'
    || typeof (
      window as {
        __TAURI__?: unknown;
        __TAURI_INTERNALS__?: unknown;
      }
    ).__TAURI__ !== 'undefined'
  );
}

function assertManagedStateKey(key: string): asserts key is ManagedStateKey {
  if (!MANAGED_STATE_KEY_SET.has(key)) {
    throw new Error(`State key is not owned by ThreadTerm: ${key}`);
  }
}

function readLegacyValue(key: ManagedStateKey): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    console.warn(`[managedState] could not read legacy value for ${key}`, error);
    return null;
  }
}

function writeBrowserValue(key: ManagedStateKey, value: string | null): void {
  if (typeof window === 'undefined') return;
  if (value === null) {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, value);
  }
}

async function readDesktopValue(key: ManagedStateKey): Promise<string | null> {
  const current = await tauriInvoke<ManagedStateRead>('managed_state_get', { key });
  if (current.initialized) {
    valueCache.set(key, current.value);
    return current.value;
  }

  const legacyValue = readLegacyValue(key);
  const imported = await tauriInvoke<ManagedStateWrite>('managed_state_import_legacy', {
    key,
    value: legacyValue,
    sourceId,
  });
  if (imported.imported) {
    valueCache.set(key, legacyValue);
    return legacyValue;
  }

  // Another WebView won the one-time import race. Re-read the managed value
  // instead of returning this WebView's potentially different legacy cache.
  const authoritative = await tauriInvoke<ManagedStateRead>('managed_state_get', { key });
  if (!authoritative.initialized) {
    throw new Error(`Managed state import did not initialize ${key}`);
  }
  valueCache.set(key, authoritative.value);
  return authoritative.value;
}

export function readManagedStateItem(
  key: ManagedStateKey,
): string | null | Promise<string | null> {
  if (!hasManagedStateBackend()) {
    return readLegacyValue(key);
  }
  if (valueCache.has(key)) {
    return valueCache.get(key) ?? null;
  }
  return readDesktopValue(key);
}

export function writeManagedStateItem(
  key: ManagedStateKey,
  value: string,
): void | Promise<void> {
  if (!hasManagedStateBackend()) {
    writeBrowserValue(key, value);
    valueCache.set(key, value);
    return;
  }

  if (key === MANAGED_STATE_KEYS.terminal) {
    return tauriInvoke<ManagedStateSetOutcome>('managed_state_set_v2', {
      key,
      value,
      sourceId,
    }).then(({ reconciled }) => {
      if (reconciled) {
        // Backend reconciliation may have merged this write with a newer
        // authoritative card. Let the next read pull that value.
        valueCache.delete(key);
      } else {
        valueCache.set(key, value);
      }
    });
  }

  return tauriInvoke<void>('managed_state_set', { key, value, sourceId }).then(() => {
    valueCache.set(key, value);
  });
}

export function removeManagedStateItem(
  key: ManagedStateKey,
): void | Promise<void> {
  if (!hasManagedStateBackend()) {
    writeBrowserValue(key, null);
    valueCache.set(key, null);
    return;
  }
  return tauriInvoke<void>('managed_state_remove', { key, sourceId }).then(() => {
    valueCache.set(key, null);
  });
}

export const managedStateStorage: StateStorage<void | Promise<void>> = {
  getItem: (name) => {
    assertManagedStateKey(name);
    return readManagedStateItem(name);
  },
  setItem: (name, value) => {
    assertManagedStateKey(name);
    return writeManagedStateItem(name, value);
  },
  removeItem: (name) => {
    assertManagedStateKey(name);
    return removeManagedStateItem(name);
  },
};

export async function preloadManagedState(
  keys: readonly ManagedStateKey[],
): Promise<void> {
  await Promise.all(keys.map((key) => readManagedStateItem(key)));
}

export function getPreloadedManagedStateItem(
  key: ManagedStateKey,
): string | null {
  if (!hasManagedStateBackend()) {
    return readLegacyValue(key);
  }
  if (valueCache.has(key)) {
    return valueCache.get(key) ?? null;
  }
  return null;
}

export function invalidateManagedStateItems(
  keys: readonly ManagedStateKey[],
): void {
  for (const key of keys) valueCache.delete(key);
}

export function writeManagedPreference(
  key: ManagedStateKey,
  value: string | null,
  options: { keepLegacyPaintCache?: boolean } = {},
): void {
  valueCache.set(key, value);
  if (options.keepLegacyPaintCache) {
    try {
      writeBrowserValue(key, value);
    } catch (error) {
      console.debug(`[managedState] could not update paint cache for ${key}`, error);
    }
  }

  try {
    const write = value === null
      ? removeManagedStateItem(key)
      : writeManagedStateItem(key, value);
    if (write instanceof Promise) {
      void write.catch((error) => {
        console.error(`[managedState] could not persist ${key}`, error);
      });
    }
  } catch (error) {
    console.error(`[managedState] could not persist ${key}`, error);
  }
}

export async function listenManagedStateChanges(
  handler: (key: ManagedStateKey) => void,
): Promise<() => void> {
  if (!hasManagedStateBackend()) {
    if (typeof window === 'undefined') return () => {};
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || !MANAGED_STATE_KEY_SET.has(event.key)) return;
      const key = event.key as ManagedStateKey;
      valueCache.delete(key);
      handler(key);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }

  return tauriListen<ManagedStateChanged>(MANAGED_STATE_CHANGED_EVENT, (event) => {
    const { key, sourceId: eventSourceId } = event.payload;
    if (eventSourceId === sourceId || !MANAGED_STATE_KEY_SET.has(key)) return;
    const managedKey = key as ManagedStateKey;
    valueCache.delete(managedKey);
    handler(managedKey);
  });
}

export function resetManagedStateCacheForTests(): void {
  valueCache.clear();
}
