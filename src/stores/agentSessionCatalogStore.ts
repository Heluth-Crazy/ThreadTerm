import { useEffect } from 'react';
import { create } from 'zustand';
import { isTauriEnv, providerSessions } from '../lib/tauri-bridge';
import { agentSessionSelectionKey } from '../lib/agentSessionTitle';
import { nextAgentSessionCatalogRequestId } from '../lib/agentSessionRequestId';
import {
  AGENT_SESSION_CATALOG_STALL_TIMEOUT_MS,
  AGENT_SESSION_CATALOG_STALLED_ERROR,
  isValidAgentSessionCatalogProgress,
  mergeAgentSessionCatalogProgress,
} from '../lib/agentSessionCatalogProgress';
import type {
  AgentSessionAvailability,
  AgentSessionCatalogProgress,
  AgentSessionPage,
  AgentSessionProvider,
  AgentSessionSummary,
} from '../types/agentSession';

export type CatalogLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface ProviderCatalogState {
  loadState: CatalogLoadState;
  availability: AgentSessionAvailability | null;
  items: AgentSessionSummary[];
  nextCursor: string | null;
  warning: string | null;
  errorMessage: string | null;
  scannedAt: number | null;
  generation: number;
  activeRequestId: number | null;
  progress: AgentSessionCatalogProgress | null;
}

export const AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER = 400;
export {
  AGENT_SESSION_CATALOG_STALL_TIMEOUT_MS,
  AGENT_SESSION_CATALOG_STALLED_ERROR,
} from '../lib/agentSessionCatalogProgress';

const watchdogs = new Map<number, ReturnType<typeof setTimeout>>();

function emptyProviderState(): ProviderCatalogState {
  return {
    loadState: 'idle',
    availability: null,
    items: [],
    nextCursor: null,
    warning: null,
    errorMessage: null,
    scannedAt: null,
    generation: 0,
    activeRequestId: null,
    progress: null,
  };
}

function initialProviders(): Record<
  AgentSessionProvider,
  ProviderCatalogState
> {
  return {
    claude: emptyProviderState(),
    codex: emptyProviderState(),
    opencode: emptyProviderState(),
    gemini: emptyProviderState(),
    kimi: emptyProviderState(),
    grok: emptyProviderState(),
  };
}

interface AgentSessionCatalogStore {
  activeProvider: AgentSessionProvider;
  query: string;
  selectedKeys: Set<string>;
  selectedSummaries: Map<string, AgentSessionSummary>;
  providers: Record<AgentSessionProvider, ProviderCatalogState>;
  requestSeq: number;
  setActiveProvider: (provider: AgentSessionProvider) => void;
  setQuery: (query: string) => void;
  toggleSelected: (provider: AgentSessionProvider, id: string) => void;
  clearSelection: () => void;
  reset: () => void;
  ensureLoaded: (provider?: AgentSessionProvider) => Promise<void>;
  loadMore: (provider?: AgentSessionProvider) => Promise<void>;
  retry: (provider?: AgentSessionProvider) => Promise<void>;
  handleProgress: (progress: AgentSessionCatalogProgress) => void;
  getSelectedSummaries: () => AgentSessionSummary[];
}

function clearWatchdog(requestId: number | null): void {
  if (requestId === null) return;
  const watchdog = watchdogs.get(requestId);
  if (watchdog !== undefined) {
    clearTimeout(watchdog);
    watchdogs.delete(requestId);
  }
}

function cancelRequest(requestId: number | null): void {
  if (requestId === null) return;
  clearWatchdog(requestId);
  if (isTauriEnv()) {
    void providerSessions.cancelAgentSessionScan(requestId).catch(() => {
      // The request may already have settled and unregistered.
    });
  }
}

function cancelProviderRequests(
  providers: Record<AgentSessionProvider, ProviderCatalogState>,
): void {
  for (const provider of Object.values(providers)) {
    cancelRequest(provider.activeRequestId);
  }
}

function armWatchdog(provider: AgentSessionProvider, requestId: number): void {
  clearWatchdog(requestId);
  const watchdog = setTimeout(() => {
    watchdogs.delete(requestId);
    const store = useAgentSessionCatalogStore.getState();
    const current = store.providers[provider];
    if (
      current.loadState !== 'loading' ||
      current.activeRequestId !== requestId
    ) {
      return;
    }
    cancelRequest(requestId);
    useAgentSessionCatalogStore.setState({
      providers: {
        ...store.providers,
        [provider]: {
          ...current,
          loadState: 'error',
          availability: 'error',
          activeRequestId: null,
          progress: null,
          errorMessage: AGENT_SESSION_CATALOG_STALLED_ERROR,
        },
      },
    });
  }, AGENT_SESSION_CATALOG_STALL_TIMEOUT_MS);
  watchdogs.set(requestId, watchdog);
}

async function fetchPage(
  provider: AgentSessionProvider,
  cursor: string | null,
  query: string,
  requestId: number,
): Promise<AgentSessionPage> {
  if (!isTauriEnv()) {
    return {
      provider,
      availability: 'unavailable',
      items: [],
      nextCursor: null,
      scannedAt: Date.now(),
      warning: 'Session recovery is available in the desktop app only',
    };
  }
  return providerSessions.listAgentSessions({
    requestId,
    provider,
    cursor,
    limit: 40,
    query: query.trim() ? query.trim() : null,
  });
}

export const useAgentSessionCatalogStore = create<AgentSessionCatalogStore>(
  (set, get) => ({
    activeProvider: 'claude',
    query: '',
    selectedKeys: new Set(),
    selectedSummaries: new Map(),
    providers: initialProviders(),
    requestSeq: 0,

    setActiveProvider: (provider) => {
      set({ activeProvider: provider });
      void get().ensureLoaded(provider);
    },

    setQuery: (query) => {
      cancelProviderRequests(get().providers);
      set({
        query,
        providers: initialProviders(),
        requestSeq: get().requestSeq + 1,
      });
      void get().ensureLoaded(get().activeProvider);
    },

    toggleSelected: (provider, id) => {
      const key = agentSessionSelectionKey(provider, id);
      const selectedKeys = new Set(get().selectedKeys);
      const selectedSummaries = new Map(get().selectedSummaries);
      if (selectedKeys.has(key)) {
        selectedKeys.delete(key);
        selectedSummaries.delete(key);
      } else {
        const summary = get().providers[provider].items.find(
          (item) => item.id === id,
        );
        if (!summary) return;
        selectedKeys.add(key);
        selectedSummaries.set(key, summary);
      }
      set({ selectedKeys, selectedSummaries });
    },

    clearSelection: () =>
      set({ selectedKeys: new Set(), selectedSummaries: new Map() }),

    reset: () => {
      cancelProviderRequests(get().providers);
      set({
        activeProvider: 'claude',
        query: '',
        selectedKeys: new Set(),
        selectedSummaries: new Map(),
        providers: initialProviders(),
        requestSeq: get().requestSeq + 1,
      });
    },

    ensureLoaded: async (providerArg) => {
      const provider = providerArg ?? get().activeProvider;
      const state = get().providers[provider];
      if (state.loadState === 'loading') return;
      if (state.loadState === 'ready' || state.loadState === 'error') return;

      const generation = get().requestSeq + 1;
      const requestId = nextAgentSessionCatalogRequestId();
      const query = get().query;
      set({
        requestSeq: generation,
        providers: {
          ...get().providers,
          [provider]: {
            ...state,
            generation,
            loadState: 'loading',
            errorMessage: null,
            activeRequestId: requestId,
            progress: null,
          },
        },
      });
      armWatchdog(provider, requestId);

      try {
        const page = await fetchPage(provider, null, query, requestId);
        const latest = get().providers[provider];
        if (
          latest.generation !== generation ||
          latest.activeRequestId !== requestId
        )
          return;
        clearWatchdog(requestId);
        set({
          providers: {
            ...get().providers,
            [provider]: {
              ...latest,
              loadState: page.availability === 'error' ? 'error' : 'ready',
              availability: page.availability,
              items: page.items.slice(
                0,
                AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER,
              ),
              nextCursor: page.nextCursor ?? null,
              warning: page.warning ?? null,
              errorMessage: null,
              scannedAt: page.scannedAt,
              activeRequestId: null,
              progress: null,
            },
          },
        });
      } catch (error) {
        const latest = get().providers[provider];
        if (
          latest.generation !== generation ||
          latest.activeRequestId !== requestId
        )
          return;
        clearWatchdog(requestId);
        set({
          providers: {
            ...get().providers,
            [provider]: {
              ...latest,
              loadState: 'error',
              availability: 'error',
              errorMessage:
                error instanceof Error
                  ? error.message
                  : 'Failed to load sessions',
              activeRequestId: null,
              progress: null,
            },
          },
        });
      }
    },

    loadMore: async (providerArg) => {
      const provider = providerArg ?? get().activeProvider;
      const state = get().providers[provider];
      if (state.loadState === 'loading' || !state.nextCursor) return;

      const generation = get().requestSeq + 1;
      const requestId = nextAgentSessionCatalogRequestId();
      const query = get().query;
      set({
        requestSeq: generation,
        providers: {
          ...get().providers,
          [provider]: {
            ...state,
            generation,
            loadState: 'loading',
            activeRequestId: requestId,
            progress: null,
            errorMessage: null,
          },
        },
      });
      armWatchdog(provider, requestId);

      try {
        const page = await fetchPage(
          provider,
          state.nextCursor,
          query,
          requestId,
        );
        const latest = get().providers[provider];
        if (
          latest.generation !== generation ||
          latest.activeRequestId !== requestId
        )
          return;
        clearWatchdog(requestId);
        const merged = [...latest.items, ...page.items].slice(
          0,
          AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER,
        );
        set({
          providers: {
            ...get().providers,
            [provider]: {
              ...latest,
              loadState: page.availability === 'error' ? 'error' : 'ready',
              availability: page.availability,
              items: merged,
              nextCursor: page.nextCursor ?? null,
              warning: page.warning ?? null,
              scannedAt: page.scannedAt,
              activeRequestId: null,
              progress: null,
            },
          },
        });
      } catch (error) {
        const latest = get().providers[provider];
        if (
          latest.generation !== generation ||
          latest.activeRequestId !== requestId
        )
          return;
        clearWatchdog(requestId);
        set({
          providers: {
            ...get().providers,
            [provider]: {
              ...latest,
              loadState: 'error',
              availability: 'error',
              errorMessage:
                error instanceof Error
                  ? error.message
                  : 'Failed to load more sessions',
              activeRequestId: null,
              progress: null,
            },
          },
        });
      }
    },

    retry: async (providerArg) => {
      const provider = providerArg ?? get().activeProvider;
      cancelRequest(get().providers[provider].activeRequestId);
      set({
        requestSeq: get().requestSeq + 1,
        providers: {
          ...get().providers,
          [provider]: emptyProviderState(),
        },
      });
      await get().ensureLoaded(provider);
    },

    handleProgress: (progress) => {
      if (!isValidAgentSessionCatalogProgress(progress)) return;
      const current = get().providers[progress.provider];
      if (
        !current ||
        current.loadState !== 'loading' ||
        current.activeRequestId !== progress.requestId
      ) {
        return;
      }
      const nextProgress = mergeAgentSessionCatalogProgress(
        current.progress,
        progress,
      );
      set({
        providers: {
          ...get().providers,
          [progress.provider]: {
            ...current,
            progress: nextProgress,
          },
        },
      });
      armWatchdog(progress.provider, progress.requestId);
    },

    getSelectedSummaries: () => {
      return Array.from(get().selectedSummaries.values());
    },
  }),
);

/** Mount once near the other application-level Tauri event subscriptions. */
export function useAgentSessionCatalogSubscription(): void {
  useEffect(() => {
    if (typeof providerSessions.onCatalogProgress !== 'function') return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    providerSessions
      .onCatalogProgress(useAgentSessionCatalogStore.getState().handleProgress)
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          stop = unlisten;
        }
      })
      .catch(() => {
        // Browser mode has no Tauri event stream.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}

export interface AgentSessionCatalogDiagnostics {
  rowCount: number;
  maxRowCount: number;
  selectedSummaryCount: number;
  estimatedBytes: number;
}

function estimateSummaryBytes(summary: AgentSessionSummary): number {
  return [
    summary.provider,
    summary.id,
    summary.projectPath,
    summary.nativeTitle,
    summary.firstUserMessagePreview,
    summary.gitBranch,
    summary.sourceKind,
    summary.parentSessionId,
  ].reduce((bytes, value) => bytes + (value?.length ?? 0) * 2, 64);
}

/** Read-only catalog counters for Release memory diagnostics. */
export function getAgentSessionCatalogDiagnostics(): AgentSessionCatalogDiagnostics {
  const state = useAgentSessionCatalogStore.getState();
  const providerStates = Object.values(state.providers);
  const items = providerStates.flatMap((provider) => provider.items);
  return {
    rowCount: items.length,
    maxRowCount:
      providerStates.length * AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER,
    selectedSummaryCount: state.selectedSummaries.size,
    estimatedBytes: items.reduce(
      (bytes, summary) => bytes + estimateSummaryBytes(summary),
      0,
    ),
  };
}
