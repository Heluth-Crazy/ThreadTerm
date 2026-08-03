import { create } from 'zustand';
import { isTauriEnv, providerSessions } from '../lib/tauri-bridge';
import {
  AGENT_SESSION_PROVIDERS,
  MAX_AGENT_SESSION_METADATA_KEYS,
  agentSessionMetadataCacheKey,
  isAgentSessionProvider,
  type AgentSessionMetadataKey,
  type AgentSessionMetadataResult,
  type AgentSessionMetadataState,
  type AgentSessionProvider,
  type AgentSessionSummary,
} from '../types/agentSession';

export const METADATA_CACHE_MAX_ENTRIES = 512;
export const METADATA_CACHE_SUCCESS_TTL_MS = 60_000;
export const METADATA_CACHE_FAILURE_TTL_MS = 15_000;

export type MetadataCacheStatus =
  | 'idle'
  | 'loading'
  | 'found'
  | 'missing'
  | 'unavailable'
  | 'error';

export interface MetadataCacheEntry {
  key: AgentSessionMetadataKey;
  status: MetadataCacheStatus;
  summary: AgentSessionSummary | null;
  warning: string | null;
  updatedAt: number;
  generation: number;
  expiresAt: number;
}

interface AgentSessionMetadataCacheStore {
  entries: Map<string, MetadataCacheEntry>;
  inFlight: Map<string, Promise<void>>;
  nextGeneration: number;
  epoch: number;
  ensureKeys: (keys: AgentSessionMetadataKey[]) => Promise<void>;
  getEntry: (
    provider: AgentSessionProvider,
    sessionId: string,
    projectPath: string | null | undefined,
  ) => MetadataCacheEntry | undefined;
  touchKey: (
    provider: AgentSessionProvider,
    sessionId: string,
    projectPath: string | null | undefined,
  ) => void;
  invalidateKey: (
    provider: AgentSessionProvider,
    sessionId: string,
    projectPath?: string | null,
  ) => void;
  clear: () => void;
}

function nowMs(): number {
  return Date.now();
}

function normalizeKey(key: AgentSessionMetadataKey): AgentSessionMetadataKey | null {
  const provider = key.provider?.trim().toLowerCase() ?? '';
  const sessionId = key.sessionId?.trim() ?? '';
  if (!isAgentSessionProvider(provider) || !sessionId) return null;
  return {
    provider,
    sessionId,
    projectPath: key.projectPath?.trim() || null,
  };
}

function cacheKeyOf(key: AgentSessionMetadataKey): string {
  return agentSessionMetadataCacheKey(key.provider, key.sessionId, key.projectPath);
}

function isFresh(entry: MetadataCacheEntry, at = nowMs()): boolean {
  return entry.expiresAt > at;
}

function ttlForState(state: AgentSessionMetadataState | 'loading'): number {
  if (state === 'found') return METADATA_CACHE_SUCCESS_TTL_MS;
  return METADATA_CACHE_FAILURE_TTL_MS;
}

function toStatus(state: AgentSessionMetadataState): MetadataCacheStatus {
  return state;
}

function touchLru(
  entries: Map<string, MetadataCacheEntry>,
  key: string,
  entry: MetadataCacheEntry,
): Map<string, MetadataCacheEntry> {
  const next = new Map(entries);
  next.delete(key);
  next.set(key, entry);
  while (next.size > METADATA_CACHE_MAX_ENTRIES) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

async function fetchMetadataChunk(
  keys: AgentSessionMetadataKey[],
): Promise<AgentSessionMetadataResult[]> {
  try {
    if (!isTauriEnv()) {
      return keys.map((key) => ({
        key,
        state: 'unavailable' as const,
        summary: null,
        warning: 'Desktop only',
      }));
    }
    return await providerSessions.resolveMetadata({ keys });
  } catch {
    return keys.map((key) => ({
      key,
      state: 'error' as const,
      summary: null,
      warning: 'Metadata request failed',
    }));
  }
}

export const useAgentSessionMetadataCache = create<AgentSessionMetadataCacheStore>(
  (set, get) => ({
    entries: new Map(),
    inFlight: new Map(),
    nextGeneration: 0,
    epoch: 0,

    getEntry: (provider, sessionId, projectPath) => {
      const key = agentSessionMetadataCacheKey(provider, sessionId, projectPath);
      const entry = get().entries.get(key);
      if (!entry) return undefined;
      if (!isFresh(entry)) return undefined;
      const newestKey = Array.from(get().entries.keys()).at(-1);
      if (newestKey !== key) {
        set((state) => {
          const current = state.entries.get(key);
          return current && current === entry
            ? { entries: touchLru(state.entries, key, current) }
            : {};
        });
      }
      return entry;
    },

    touchKey: (provider, sessionId, projectPath) => {
      const key = agentSessionMetadataCacheKey(provider, sessionId, projectPath);
      set((state) => {
        const entry = state.entries.get(key);
        if (!entry || !isFresh(entry)) return {};
        const newestKey = Array.from(state.entries.keys()).at(-1);
        return newestKey === key
          ? {}
          : { entries: touchLru(state.entries, key, entry) };
      });
    },

    invalidateKey: (provider, sessionId, projectPath) => {
      const exactKey = projectPath === undefined
        ? null
        : agentSessionMetadataCacheKey(provider, sessionId, projectPath);
      const prefix = `${provider}\0${sessionId}\0`;
      set((state) => {
        const entries = new Map(state.entries);
        const inFlight = new Map(state.inFlight);
        const candidates = new Set([
          ...entries.keys(),
          ...inFlight.keys(),
          ...(exactKey ? [exactKey] : []),
        ]);
        for (const key of candidates) {
          if (exactKey ? key !== exactKey : !key.startsWith(prefix)) continue;
          entries.delete(key);
          inFlight.delete(key);
        }
        return { entries, inFlight };
      });
    },

    clear: () => set((state) => ({
      entries: new Map(),
      inFlight: new Map(),
      nextGeneration: 0,
      epoch: state.epoch + 1,
    })),

    ensureKeys: async (rawKeys) => {
      const normalized = rawKeys
        .map(normalizeKey)
        .filter((key): key is AgentSessionMetadataKey => Boolean(key));
      if (normalized.length === 0) return;

      const unique = new Map<string, AgentSessionMetadataKey>();
      for (const key of normalized) {
        unique.set(cacheKeyOf(key), key);
      }
      const keys = Array.from(unique.values());
      const at = nowMs();
      const missing: Array<{
        key: AgentSessionMetadataKey;
        cacheKey: string;
        generation: number;
        epoch: number;
      }> = [];
      const waiters = new Set<Promise<void>>();

      set((state) => {
        let entries = state.entries;
        let nextGeneration = state.nextGeneration;
        for (const key of keys) {
          const cacheKey = cacheKeyOf(key);
          const existing = entries.get(cacheKey);
          if (existing && isFresh(existing, at) && existing.status !== 'loading') {
            entries = touchLru(entries, cacheKey, existing);
            continue;
          }
          const inFlight = state.inFlight.get(cacheKey);
          if (inFlight) {
            waiters.add(inFlight);
            continue;
          }
          const generation = ++nextGeneration;
          missing.push({
            key,
            cacheKey,
            generation,
            epoch: state.epoch,
          });
          entries = touchLru(entries, cacheKey, {
            key,
            status: 'loading',
            summary: existing?.summary ?? null,
            warning: null,
            updatedAt: at,
            generation,
            expiresAt: at + METADATA_CACHE_FAILURE_TTL_MS,
          });
        }
        return { entries, nextGeneration };
      });

      if (missing.length === 0) {
        await Promise.all(waiters);
        return;
      }

      const requests: Promise<void>[] = [];
      let chain = Promise.resolve();
      for (let offset = 0; offset < missing.length; offset += MAX_AGENT_SESSION_METADATA_KEYS) {
        const batch = missing.slice(offset, offset + MAX_AGENT_SESSION_METADATA_KEYS);
        let requestPromise!: Promise<void>;
        requestPromise = chain.then(async () => {
          const results = await fetchMetadataChunk(batch.map((item) => item.key));
          const completedAt = nowMs();
          set((state) => {
            let entries = state.entries;
            const inFlight = new Map(state.inFlight);
            const byKey = new Map(
              results.map((result) => [cacheKeyOf(result.key), result] as const),
            );
            for (const item of batch) {
              const current = entries.get(item.cacheKey);
              const stillCurrent = (
                state.epoch === item.epoch
                && current?.generation === item.generation
              );
              if (stillCurrent) {
                const result = byKey.get(item.cacheKey);
                const status: MetadataCacheStatus = result
                  ? toStatus(result.state)
                  : 'error';
                entries = touchLru(entries, item.cacheKey, {
                  key: item.key,
                  status,
                  summary: result?.summary ?? null,
                  warning: result?.warning ?? (
                    result ? null : 'Metadata result was omitted'
                  ),
                  updatedAt: completedAt,
                  generation: item.generation,
                  expiresAt: completedAt + ttlForState(result?.state ?? 'error'),
                });
              }
              if (inFlight.get(item.cacheKey) === requestPromise) {
                inFlight.delete(item.cacheKey);
              }
            }
            return { entries, inFlight };
          });
        });
        chain = requestPromise.catch(() => undefined);
        requests.push(requestPromise);
        set((state) => {
          const inFlight = new Map(state.inFlight);
          for (const item of batch) inFlight.set(item.cacheKey, requestPromise);
          return { inFlight };
        });
      }

      await Promise.all([...waiters, ...requests]);
    },
  }),
);

export function selectMetadataSummary(
  provider: AgentSessionProvider,
  sessionId: string,
  projectPath: string | null | undefined,
): AgentSessionSummary | null {
  const entry = useAgentSessionMetadataCache
    .getState()
    .getEntry(provider, sessionId, projectPath);
  return entry?.status === 'found' ? entry.summary : null;
}

/** Test helper: seed a cache entry without IPC. */
export function __seedMetadataCacheEntryForTests(entry: MetadataCacheEntry): void {
  useAgentSessionMetadataCache.setState((state) => ({
    entries: touchLru(state.entries, cacheKeyOf(entry.key), entry),
    nextGeneration: Math.max(state.nextGeneration, entry.generation),
  }));
}

export function __resetMetadataCacheForTests(): void {
  useAgentSessionMetadataCache.getState().clear();
}

// Keep provider list referenced so exhaustive updates stay intentional.
void AGENT_SESSION_PROVIDERS;
