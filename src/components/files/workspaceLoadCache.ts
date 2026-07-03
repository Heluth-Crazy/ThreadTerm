import { git, invoke, type GitStatusEntry } from '../../lib/tauri-bridge';
import type { DirEntry } from './fileMeta';

export const WORKSPACE_LOAD_TIMEOUT_MS = 10_000;

interface CacheEntry<T> {
  value?: T;
  inFlight?: Promise<T>;
  version: number;
}

const directoryCache = new Map<string, CacheEntry<DirEntry[]>>();
const changesCache = new Map<string, CacheEntry<GitStatusEntry[]>>();

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function loadCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  loader: () => Promise<T>,
  timeoutMs = WORKSPACE_LOAD_TIMEOUT_MS,
): Promise<T> {
  const previous = cache.get(key);
  if (previous?.inFlight) {
    const inFlight = previous.inFlight;
    const version = previous.version;
    return withTimeout(
      inFlight,
      timeoutMs,
      `Workspace request timed out after ${timeoutMs}ms.`,
      () => clearTimedOutInFlight(cache, key, inFlight, version),
    );
  }

  const version = (previous?.version ?? 0) + 1;
  const promise = loader()
    .then((value) => {
      const current = cache.get(key);
      if (!current || current.version === version) {
        cache.set(key, { value, version });
      }
      return value;
    })
    .finally(() => {
      const current = cache.get(key);
      if (current?.version === version && current.inFlight === promise) {
        if (current.value !== undefined) {
          cache.set(key, { value: current.value, version });
        } else {
          cache.delete(key);
        }
      }
    });

  cache.set(key, { value: previous?.value, inFlight: promise, version });
  return withTimeout(
    promise,
    timeoutMs,
    `Workspace request timed out after ${timeoutMs}ms.`,
    () => clearTimedOutInFlight(cache, key, promise, version),
  );
}

function clearTimedOutInFlight<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  promise: Promise<T>,
  version: number,
) {
  const current = cache.get(key);
  if (current?.version !== version || current.inFlight !== promise) return;
  if (current.value !== undefined) {
    cache.set(key, { value: current.value, version });
  } else {
    cache.delete(key);
  }
}

export function getCachedWorkspaceDirectory(path: string): DirEntry[] | null {
  return directoryCache.get(path)?.value ?? null;
}

export function getCachedWorkspaceChanges(path: string): GitStatusEntry[] | null {
  return changesCache.get(path)?.value ?? null;
}

export function loadWorkspaceDirectory(path: string): Promise<DirEntry[]> {
  return loadCached(directoryCache, path, async () => {
    const result = await invoke<DirEntry[]>('read_directory', { path });
    return result ?? [];
  });
}

export function loadWorkspaceChanges(path: string): Promise<GitStatusEntry[]> {
  return loadCached(changesCache, path, () => git.changes.status(path));
}

export function clearWorkspaceLoadCaches(): void {
  directoryCache.clear();
  changesCache.clear();
}
