import { git, invoke, type GitStatusEntry } from '../../lib/tauri-bridge';
import type { DirEntry } from './fileMeta';

export const WORKSPACE_LOAD_TIMEOUT_MS = 10_000;
export const WORKSPACE_DIRECTORY_CACHE_MAX_ENTRIES = 128;
export const WORKSPACE_DIRECTORY_CACHE_MAX_ESTIMATED_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_CHANGES_CACHE_MAX_ENTRIES = 16;
export const WORKSPACE_CHANGES_CACHE_MAX_ESTIMATED_BYTES = 2 * 1024 * 1024;

interface CacheEntry<T> {
  value?: T;
  inFlight?: Promise<T>;
  version: number;
  estimatedBytes: number;
}

const directoryCache = new Map<string, CacheEntry<DirEntry[]>>();
const changesCache = new Map<string, CacheEntry<GitStatusEntry[]>>();
const directoryCacheCounters = { evictions: 0 };
const changesCacheCounters = { evictions: 0 };

interface CacheBudget<T> {
  maxEntries: number;
  maxEstimatedBytes: number;
  estimateValueBytes: (value: T) => number;
}

interface CacheCounters {
  evictions: number;
}

const directoryCacheBudget: CacheBudget<DirEntry[]> = {
  maxEntries: WORKSPACE_DIRECTORY_CACHE_MAX_ENTRIES,
  maxEstimatedBytes: WORKSPACE_DIRECTORY_CACHE_MAX_ESTIMATED_BYTES,
  estimateValueBytes: (entries) =>
    entries.reduce((bytes, entry) => bytes + estimateStringBytes(entry.name) + estimateStringBytes(entry.path) + 16, 0),
};

const changesCacheBudget: CacheBudget<GitStatusEntry[]> = {
  maxEntries: WORKSPACE_CHANGES_CACHE_MAX_ENTRIES,
  maxEstimatedBytes: WORKSPACE_CHANGES_CACHE_MAX_ESTIMATED_BYTES,
  estimateValueBytes: (entries) =>
    entries.reduce(
      (bytes, entry) =>
        bytes +
        estimateStringBytes(entry.path) +
        estimateStringBytes(entry.absolutePath) +
        estimateStringBytes(entry.repositoryRoot) +
        estimateStringBytes(entry.staged) +
        estimateStringBytes(entry.unstaged) +
        24,
      0,
    ),
};

function estimateStringBytes(value: string | null | undefined): number {
  return value ? value.length * 2 : 0;
}

function cacheEstimatedBytes<T>(cache: Map<string, CacheEntry<T>>): number {
  let total = 0;
  for (const entry of cache.values()) total += entry.estimatedBytes;
  return total;
}

function setCacheEntry<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  entry: CacheEntry<T>,
  budget: CacheBudget<T>,
  counters: CacheCounters,
): void {
  // Map insertion order is the LRU order. Reinsert hits and writes at the end.
  cache.delete(key);
  cache.set(key, entry);
  let estimatedBytes = cacheEstimatedBytes(cache);
  while (cache.size > budget.maxEntries || estimatedBytes > budget.maxEstimatedBytes) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    estimatedBytes -= oldest?.estimatedBytes ?? 0;
    counters.evictions += 1;
  }
}

function getCachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (entry?.value === undefined) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout: () => void): Promise<T> {
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
  budget: CacheBudget<T>,
  counters: CacheCounters,
  timeoutMs = WORKSPACE_LOAD_TIMEOUT_MS,
): Promise<T> {
  const previous = cache.get(key);
  if (previous?.inFlight) {
    setCacheEntry(cache, key, previous, budget, counters);
    const inFlight = previous.inFlight;
    const version = previous.version;
    return withTimeout(inFlight, timeoutMs, `Workspace request timed out after ${timeoutMs}ms.`, () =>
      clearTimedOutInFlight(cache, key, inFlight, version),
    );
  }

  const version = (previous?.version ?? 0) + 1;
  let promise!: Promise<T>;
  promise = loader()
    .then((value) => {
      const current = cache.get(key);
      if (current?.version === version && current.inFlight === promise) {
        setCacheEntry(
          cache,
          key,
          {
            value,
            version,
            estimatedBytes: budget.estimateValueBytes(value),
          },
          budget,
          counters,
        );
      }
      return value;
    })
    .finally(() => {
      const current = cache.get(key);
      if (current?.version === version && current.inFlight === promise) {
        if (current.value !== undefined) {
          setCacheEntry(
            cache,
            key,
            {
              value: current.value,
              version,
              estimatedBytes: current.estimatedBytes,
            },
            budget,
            counters,
          );
        } else {
          cache.delete(key);
        }
      }
    });

  setCacheEntry(
    cache,
    key,
    {
      value: previous?.value,
      inFlight: promise,
      version,
      estimatedBytes: previous?.estimatedBytes ?? 0,
    },
    budget,
    counters,
  );
  return withTimeout(promise, timeoutMs, `Workspace request timed out after ${timeoutMs}ms.`, () =>
    clearTimedOutInFlight(cache, key, promise, version),
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
    cache.set(key, {
      value: current.value,
      version,
      estimatedBytes: current.estimatedBytes,
    });
  } else {
    cache.delete(key);
  }
}

export function getCachedWorkspaceDirectory(path: string): DirEntry[] | null {
  return getCachedValue(directoryCache, path);
}

export function getCachedWorkspaceChanges(path: string): GitStatusEntry[] | null {
  return getCachedValue(changesCache, path);
}

export function loadWorkspaceDirectory(path: string): Promise<DirEntry[]> {
  return loadCached(
    directoryCache,
    path,
    async () => {
      const result = await invoke<DirEntry[]>('read_directory', { path });
      return result ?? [];
    },
    directoryCacheBudget,
    directoryCacheCounters,
  );
}

export function loadWorkspaceChanges(path: string): Promise<GitStatusEntry[]> {
  return loadCached(changesCache, path, () => git.changes.status(path), changesCacheBudget, changesCacheCounters);
}

export function clearWorkspaceLoadCaches(): void {
  directoryCache.clear();
  changesCache.clear();
  directoryCacheCounters.evictions = 0;
  changesCacheCounters.evictions = 0;
}

export interface WorkspaceLoadCachePartDiagnostics {
  entryCount: number;
  valueEntryCount: number;
  inFlightCount: number;
  estimatedBytes: number;
  maxEntries: number;
  maxEstimatedBytes: number;
  evictionCount: number;
}

export interface WorkspaceLoadCacheDiagnostics {
  directory: WorkspaceLoadCachePartDiagnostics;
  changes: WorkspaceLoadCachePartDiagnostics;
}

function cachePartDiagnostics<T>(
  cache: Map<string, CacheEntry<T>>,
  budget: CacheBudget<T>,
  counters: CacheCounters,
): WorkspaceLoadCachePartDiagnostics {
  let valueEntryCount = 0;
  let inFlightCount = 0;
  for (const entry of cache.values()) {
    if (entry.value !== undefined) valueEntryCount += 1;
    if (entry.inFlight) inFlightCount += 1;
  }
  return {
    entryCount: cache.size,
    valueEntryCount,
    inFlightCount,
    estimatedBytes: cacheEstimatedBytes(cache),
    maxEntries: budget.maxEntries,
    maxEstimatedBytes: budget.maxEstimatedBytes,
    evictionCount: counters.evictions,
  };
}

/** Read-only cache counters for Release memory diagnostics. */
export function getWorkspaceLoadCacheDiagnostics(): WorkspaceLoadCacheDiagnostics {
  return {
    directory: cachePartDiagnostics(directoryCache, directoryCacheBudget, directoryCacheCounters),
    changes: cachePartDiagnostics(changesCache, changesCacheBudget, changesCacheCounters),
  };
}
