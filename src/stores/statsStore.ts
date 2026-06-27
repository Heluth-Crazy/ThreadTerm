import { useEffect } from 'react';
import { create } from 'zustand';
import { tokenStats } from '../lib/tauri-bridge';
import { useTerminalStore } from './terminalStore';
import type {
  AgentStats,
  StatBucket,
  StatsDoneEvent,
  StatsErrorEvent,
  StatsProgressEvent,
  StatsRange,
  StatsScope,
} from '../types/stats';
import type { TerminalCard } from '../types/terminal';

let requestCounter = 0;

export const STATS_AUTO_REFRESH_INTERVAL_MS = 20_000;

interface StatsState {
  snapshot: AgentStats | null;
  /** sessionId → bucket, used by per-card token badges. */
  bySession: Record<string, StatBucket>;
  loading: boolean;
  error: string | null;
  scope: StatsScope;
  range: StatsRange;
  scanned: number;
  total: number;
  activeRequestId: number;
  activeSilent: boolean;
  lastComputedAt: number | null;

  setScope: (scope: StatsScope) => void;
  setRange: (range: StatsRange) => void;
  compute: (opts?: { silent?: boolean }) => void;
  handleProgress: (payload: StatsProgressEvent) => void;
  handleDone: (payload: StatsDoneEvent) => void;
  handleError: (payload: StatsErrorEvent) => void;
}

function isStatsBackedAiCard(
  card: Pick<TerminalCard, 'providerSessionId' | 'terminalType'>,
): boolean {
  return (
    (card.terminalType === 'claude' || card.terminalType === 'codex') &&
    Boolean(card.providerSessionId)
  );
}

export const useStatsStore = create<StatsState>((set, get) => ({
  snapshot: null,
  bySession: {},
  loading: false,
  error: null,
  scope: 'all',
  range: '30d',
  scanned: 0,
  total: 0,
  activeRequestId: 0,
  activeSilent: false,
  lastComputedAt: null,

  setScope: (scope) => {
    set({ scope });
    get().compute();
  },
  setRange: (range) => {
    set({ range });
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
 * Polling is limited to visible windows with bound Claude/Codex sessions.
 */
export function useStatsAutoRefresh(): void {
  const hasAiCards = useTerminalStore((state) => state.cards.some(isStatsBackedAiCard));

  useEffect(() => {
    if (!hasAiCards || typeof document === 'undefined') return;

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
      intervalId = window.setInterval(computeSilent, STATS_AUTO_REFRESH_INTERVAL_MS);
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
  }, [hasAiCards]);
}

/** Convenience selector for a single session's bucket (per-card badge). */
export function selectSessionBucket(sessionId: string | undefined): StatBucket | undefined {
  if (!sessionId) return undefined;
  return useStatsStore.getState().bySession[sessionId];
}

export type { AgentStats };
