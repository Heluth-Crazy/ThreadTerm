import { useEffect } from 'react';
import { create } from 'zustand';
import { tokenStats } from '../lib/tauri-bridge';
import { useTerminalStore } from './terminalStore';
import type {
  AgentStats,
  StatBucket,
  StatsDashboard,
  StatsDashboardFilters,
  StatsDoneEvent,
  StatsErrorEvent,
  StatsProgressEvent,
  StatsRange,
  StatsScope,
} from '../types/stats';
import type { TerminalCard } from '../types/terminal';

let requestCounter = 0;

/**
 * Background stats polling scans every JSONL session file under
 * supported local AI CLI session logs, so the silent interval is
 * deliberately coarse: 60s keeps per-card token badges reasonably fresh,
 * and while the stats panel is closed nobody is watching the numbers, so
 * polling relaxes further to 120s. Opening the panel triggers an immediate
 * compute anyway (StatsPanel mount effect), so a stale badge never survives
 * a panel open.
 */
export const STATS_AUTO_REFRESH_INTERVAL_MS = 60_000;
export const STATS_AUTO_REFRESH_HIDDEN_PANEL_INTERVAL_MS = 120_000;

interface StatsState {
  snapshot: AgentStats | null;
  dashboard: StatsDashboard | null;
  dashboardLoading: boolean;
  dashboardError: string | null;
  /** sessionId → bucket, used by per-card token badges. */
  bySession: Record<string, StatBucket>;
  loading: boolean;
  error: string | null;
  scope: StatsScope;
  range: StatsRange;
  dashboardFilters: StatsDashboardFilters;
  scanned: number;
  total: number;
  activeRequestId: number;
  activeSilent: boolean;
  lastComputedAt: number | null;
  /** True while the stats panel is mounted; auto-refresh polls faster. */
  panelOpen: boolean;

  setPanelOpen: (open: boolean) => void;
  setScope: (scope: StatsScope) => void;
  setRange: (range: StatsRange) => void;
  setDashboardFilters: (filters: StatsDashboardFilters) => void;
  compute: (opts?: { silent?: boolean }) => void;
  loadDashboard: () => void;
  loadMoreDashboard: () => void;
  handleProgress: (payload: StatsProgressEvent) => void;
  handleDone: (payload: StatsDoneEvent) => void;
  handleError: (payload: StatsErrorEvent) => void;
}

function isStatsBackedAiCard(
  card: Pick<TerminalCard, 'providerSessionId' | 'terminalType'>,
): boolean {
  return (
    (
      card.terminalType === 'claude' ||
      card.terminalType === 'codex' ||
      card.terminalType === 'opencode' ||
      card.terminalType === 'gemini' ||
      card.terminalType === 'grok'
    ) &&
    Boolean(card.providerSessionId)
  );
}

function dashboardQueryKey(
  scope: StatsScope,
  range: StatsRange,
  filters: StatsDashboardFilters,
): string {
  return JSON.stringify([
    scope,
    range,
    filters.appType ?? '',
    filters.model ?? '',
    filters.status ?? 'all',
    filters.source ?? 'all',
    filters.projectPath ?? '',
  ]);
}

export const useStatsStore = create<StatsState>((set, get) => ({
  snapshot: null,
  dashboard: null,
  dashboardLoading: false,
  dashboardError: null,
  bySession: {},
  loading: false,
  error: null,
  scope: 'all',
  range: '30d',
  dashboardFilters: { status: 'all', source: 'all' },
  scanned: 0,
  total: 0,
  activeRequestId: 0,
  activeSilent: false,
  lastComputedAt: null,
  panelOpen: false,

  setPanelOpen: (open) => set({ panelOpen: open }),
  setScope: (scope) => {
    set({ scope, dashboard: null, dashboardError: null });
    get().compute();
  },
  setRange: (range) => {
    set({ range, dashboard: null, dashboardError: null });
    get().compute();
  },
  setDashboardFilters: (dashboardFilters) => {
    set({ dashboardFilters, dashboard: null, dashboardError: null });
    get().compute();
  },
  compute: (opts) => {
    const requestId = (requestCounter += 1);
    const silent = opts?.silent === true;
    set(
      silent
        ? { activeRequestId: requestId, activeSilent: true }
        : {
            loading: true,
            error: null,
            scanned: 0,
            total: 0,
            activeRequestId: requestId,
            activeSilent: false,
          },
    );
    void tokenStats.compute(get().scope, get().range, requestId).catch((err) => {
      if (get().activeRequestId === requestId) {
        set((state) => ({
          loading: false,
          activeSilent: false,
          error: state.activeSilent ? state.error : String(err),
        }));
      }
    });
  },
  loadDashboard: () => {
    const scope = get().scope;
    const range = get().range;
    const filters = get().dashboardFilters;
    const queryKey = dashboardQueryKey(scope, range, filters);
    if (typeof tokenStats.dashboard !== 'function') {
      set({ dashboardLoading: false });
      return;
    }
    set({ dashboardLoading: true, dashboardError: null });
    void tokenStats.dashboard(scope, range, 100, undefined, filters).then((dashboard) => {
      if (dashboardQueryKey(get().scope, get().range, get().dashboardFilters) !== queryKey) return;
      set({ dashboard, dashboardLoading: false, dashboardError: null });
    }).catch((err) => {
      if (dashboardQueryKey(get().scope, get().range, get().dashboardFilters) !== queryKey) return;
      set({ dashboardLoading: false, dashboardError: String(err) });
    });
  },
  loadMoreDashboard: () => {
    const state = get();
    const cursor = state.dashboard?.nextCursor;
    if (!cursor || state.dashboardLoading || typeof tokenStats.dashboard !== 'function') return;
    const { scope, range, dashboardFilters: filters } = state;
    const queryKey = dashboardQueryKey(scope, range, filters);
    set({ dashboardLoading: true, dashboardError: null });
    void tokenStats.dashboard(scope, range, 100, cursor, filters).then((page) => {
      if (dashboardQueryKey(get().scope, get().range, get().dashboardFilters) !== queryKey) return;
      const current = get().dashboard;
      if (!current) {
        set({ dashboard: page, dashboardLoading: false, dashboardError: null });
        return;
      }
      set({
        dashboard: {
          ...page,
          requestLogs: [...current.requestLogs, ...page.requestLogs],
        },
        dashboardLoading: false,
        dashboardError: null,
      });
    }).catch((err) => {
      if (dashboardQueryKey(get().scope, get().range, get().dashboardFilters) !== queryKey) return;
      set({ dashboardLoading: false, dashboardError: String(err) });
    });
  },
  handleProgress: (payload) => {
    if (payload.requestId !== get().activeRequestId) return;
    if (get().activeSilent) return;
    set({ scanned: payload.scanned, total: payload.total });
  },
  handleDone: (payload) => {
    if (payload.requestId !== get().activeRequestId) return;
    const bySession: Record<string, StatBucket> = {};
    for (const bucket of payload.stats.bySession) {
      bySession[bucket.key] = bucket;
    }
    set({
      snapshot: payload.stats,
      bySession,
      loading: false,
      activeSilent: false,
      error: null,
      lastComputedAt: Date.now(),
    });
    get().loadDashboard();
  },
  handleError: (payload) => {
    if (payload.requestId !== get().activeRequestId) return;
    set((state) => ({
      loading: false,
      activeSilent: false,
      error: state.activeSilent ? state.error : payload.error,
    }));
  },
}));

function hasStatsBackedAiCards(): boolean {
  return useTerminalStore.getState().cards.some(isStatsBackedAiCard);
}

/**
 * Subscribe to the backend `stats://` event stream once (mount it high in the
 * tree, e.g. TerminalManager). Idempotent per mount; unlistens on unmount.
 */
export function useStatsSubscription(): void {
  useEffect(() => {
    let stops: Array<() => void> = [];
    let cancelled = false;
    const { handleProgress, handleDone, handleError } = useStatsStore.getState();
    Promise.all([
      tokenStats.onProgress(handleProgress),
      tokenStats.onDone(handleDone),
      tokenStats.onError(handleError),
    ])
      .then((unlisten) => {
        if (cancelled) {
          unlisten.forEach((stop) => stop());
        } else {
          stops = unlisten;
        }
      })
      .catch(() => {
        /* non-Tauri env: events never fire */
      });
    return () => {
      cancelled = true;
      stops.forEach((stop) => stop());
    };
  }, []);
}

/**
 * Keeps per-card token badges warm without requiring the stats panel to open.
 * Polling is limited to visible windows with bound, stats-backed AI sessions.
 */
export function useStatsAutoRefresh(): void {
  const hasAiCards = useTerminalStore((state) => state.cards.some(isStatsBackedAiCard));
  const panelOpen = useStatsStore((state) => state.panelOpen);

  useEffect(() => {
    if (!hasAiCards || typeof document === 'undefined') return;

    const intervalMs = panelOpen
      ? STATS_AUTO_REFRESH_INTERVAL_MS
      : STATS_AUTO_REFRESH_HIDDEN_PANEL_INTERVAL_MS;

    let intervalId: number | null = null;

    const clearTimer = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const computeSilent = () => {
      if (!hasStatsBackedAiCards()) return;
      useStatsStore.getState().compute({ silent: true });
    };

    const start = () => {
      clearTimer();
      if (document.visibilityState !== 'visible') return;
      if (!hasStatsBackedAiCards()) return;
      computeSilent();
      intervalId = window.setInterval(computeSilent, intervalMs);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') start();
      else clearTimer();
    };

    start();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [hasAiCards, panelOpen]);
}

/** Convenience selector for a single session's bucket (per-card badge). */
export function selectSessionBucket(sessionId: string | undefined): StatBucket | undefined {
  if (!sessionId) return undefined;
  return useStatsStore.getState().bySession[sessionId];
}

export type { AgentStats };
