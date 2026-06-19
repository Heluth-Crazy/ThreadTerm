import { useEffect } from 'react';
import { create } from 'zustand';
import { tokenStats } from '../lib/tauri-bridge';
import type {
  AgentStats,
  StatBucket,
  StatsDoneEvent,
  StatsErrorEvent,
  StatsProgressEvent,
  StatsRange,
  StatsScope,
} from '../types/stats';

let requestCounter = 0;

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
  lastComputedAt: number | null;

  setScope: (scope: StatsScope) => void;
  setRange: (range: StatsRange) => void;
  compute: () => void;
  handleProgress: (payload: StatsProgressEvent) => void;
  handleDone: (payload: StatsDoneEvent) => void;
  handleError: (payload: StatsErrorEvent) => void;
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
  lastComputedAt: null,

  setScope: (scope) => {
    set({ scope });
    get().compute();
  },
  setRange: (range) => {
    set({ range });
    get().compute();
  },
  compute: () => {
    const requestId = (requestCounter += 1);
    set({ loading: true, error: null, scanned: 0, total: 0, activeRequestId: requestId });
    void tokenStats.compute(get().scope, get().range, requestId).catch((err) => {
      if (get().activeRequestId === requestId) {
        set({ loading: false, error: String(err) });
      }
    });
  },
  handleProgress: (payload) => {
    if (payload.requestId !== get().activeRequestId) return;
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
      error: null,
      lastComputedAt: Date.now(),
    });
  },
  handleError: (payload) => {
    if (payload.requestId !== get().activeRequestId) return;
    set({ loading: false, error: payload.error });
  },
}));

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

/** Convenience selector for a single session's bucket (per-card badge). */
export function selectSessionBucket(sessionId: string | undefined): StatBucket | undefined {
  if (!sessionId) return undefined;
  return useStatsStore.getState().bySession[sessionId];
}

export type { AgentStats };
