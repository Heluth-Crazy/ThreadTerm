import { create } from 'zustand';
import { isTauriEnv, providerSessions } from '../lib/tauri-bridge';
import { agentSessionSelectionKey } from '../lib/agentSessionTitle';
import type {
  AgentSessionAvailability,
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
}

const MAX_ROWS_PER_PROVIDER = 400;

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
  };
}

function initialProviders(): Record<AgentSessionProvider, ProviderCatalogState> {
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
  getSelectedSummaries: () => AgentSessionSummary[];
}

async function fetchPage(
  provider: AgentSessionProvider,
  cursor: string | null,
  query: string,
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
    provider,
    cursor,
    limit: 40,
    query: query.trim() ? query.trim() : null,
  });
}

export const useAgentSessionCatalogStore = create<AgentSessionCatalogStore>((set, get) => ({
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
      const summary = get().providers[provider].items.find((item) => item.id === id);
      if (!summary) return;
      selectedKeys.add(key);
      selectedSummaries.set(key, summary);
    }
    set({ selectedKeys, selectedSummaries });
  },

  clearSelection: () => set({ selectedKeys: new Set(), selectedSummaries: new Map() }),

  reset: () =>
    set({
      activeProvider: 'claude',
      query: '',
      selectedKeys: new Set(),
      selectedSummaries: new Map(),
      providers: initialProviders(),
      requestSeq: get().requestSeq + 1,
    }),

  ensureLoaded: async (providerArg) => {
    const provider = providerArg ?? get().activeProvider;
    const state = get().providers[provider];
    if (state.loadState === 'loading') return;
    if (state.loadState === 'ready' || state.loadState === 'error') return;

    const generation = get().requestSeq + 1;
    set({
      requestSeq: generation,
      providers: {
        ...get().providers,
        [provider]: {
          ...state,
          generation,
          loadState: 'loading',
          errorMessage: null,
        },
      },
    });

    try {
      const page = await fetchPage(provider, null, get().query);
      const latest = get().providers[provider];
      if (latest.generation !== generation) return;
      set({
        providers: {
          ...get().providers,
          [provider]: {
            ...latest,
            loadState: 'ready',
            availability: page.availability,
            items: page.items.slice(0, MAX_ROWS_PER_PROVIDER),
            nextCursor: page.nextCursor ?? null,
            warning: page.warning ?? null,
            errorMessage: null,
            scannedAt: page.scannedAt,
          },
        },
      });
    } catch (error) {
      const latest = get().providers[provider];
      if (latest.generation !== generation) return;
      set({
        providers: {
          ...get().providers,
          [provider]: {
            ...latest,
            loadState: 'error',
            availability: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to load sessions',
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
    set({
      requestSeq: generation,
      providers: {
        ...get().providers,
        [provider]: { ...state, generation, loadState: 'loading' },
      },
    });

    try {
      const page = await fetchPage(provider, state.nextCursor, get().query);
      const latest = get().providers[provider];
      if (latest.generation !== generation) return;
      const merged = [...latest.items, ...page.items].slice(0, MAX_ROWS_PER_PROVIDER);
      set({
        providers: {
          ...get().providers,
          [provider]: {
            ...latest,
            loadState: 'ready',
            availability: page.availability,
            items: merged,
            nextCursor: page.nextCursor ?? null,
            warning: page.warning ?? null,
            scannedAt: page.scannedAt,
          },
        },
      });
    } catch (error) {
      const latest = get().providers[provider];
      if (latest.generation !== generation) return;
      set({
        providers: {
          ...get().providers,
          [provider]: {
            ...latest,
            loadState: 'error',
            availability: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to load more sessions',
          },
        },
      });
    }
  },

  retry: async (providerArg) => {
    const provider = providerArg ?? get().activeProvider;
    set({
      requestSeq: get().requestSeq + 1,
      providers: {
        ...get().providers,
        [provider]: emptyProviderState(),
      },
    });
    await get().ensureLoaded(provider);
  },

  getSelectedSummaries: () => {
    return Array.from(get().selectedSummaries.values());
  },
}));
