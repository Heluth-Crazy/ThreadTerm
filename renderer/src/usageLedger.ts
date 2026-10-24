// Data access for the Usage page. Every read is an aggregate RPC; the page never holds a record list.
// The page scans only when it opens or the user asks: no timers, no polling. Progress arrives as events.
import { useEffect, useRef, useState } from 'react';
import { operationId, request, subscribeEvents } from './bridge';
import type {
  UsageLedgerProgress,
  UsageLedgerSettings,
  UsageLedgerSummary,
  UsageLedgerSeries,
  UsageLedgerStack,
  UsageLedgerGranularity,
  UsageLedgerScope,
} from '@threadterm/protocol';

export type UsageRangePreset = '7d' | '30d' | '90d' | 'year' | 'custom';

export const USAGE_RANGES: UsageRangePreset[] = ['7d', '30d', '90d', 'year', 'custom'];

export function localDay(date: Date = new Date()): string {
  const year = date.getFullYear(), month = `${date.getMonth() + 1}`.padStart(2, '0'), day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftLocalDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(year!, month! - 1, date!);
  value.setDate(value.getDate() + delta);
  return localDay(value);
}

/** `[from, to)`: `to` is exclusive, so "last 7 days" ends tomorrow. */
export function rangeFor(preset: Exclude<UsageRangePreset, 'custom'>, today = localDay()): { from: string; to: string } {
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
  return { from: shiftLocalDay(today, -(days - 1)), to: shiftLocalDay(today, 1) };
}

/** The heatmap always shows the last year, independent of the selected range (design §5). */
export function heatmapRange(today = localDay()): { from: string; to: string } {
  return { from: shiftLocalDay(today, -364), to: shiftLocalDay(today, 1) };
}

/** Daily buckets for short ranges, weekly up to a year, monthly for a year and longer. */
export function granularityFor(from: string, to: string): UsageLedgerGranularity {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days <= 45) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

export type UsageScanState = {
  scanId: string;
  provider?: string;
  state: UsageLedgerProgress['state'];
  phase?: UsageLedgerProgress['phase'];
  filesRead: number;
  filesFound: number;
  error?: string | null;
};

export type UsageQuery = { from: string; to: string; scope: UsageLedgerScope; projectId?: string; includeOutside: boolean };

function filtersOf(query: UsageQuery) {
  return {
    from: query.from,
    to: query.to,
    scope: query.scope,
    includeOutside: query.includeOutside,
    ...(query.projectId ? { projectId: query.projectId } : {}),
  };
}

export type UsageLedgerData = {
  settings: UsageLedgerSettings | undefined;
  summary: UsageLedgerSummary | undefined;
  trend: UsageLedgerSeries | undefined;
  heat: UsageLedgerSeries | undefined;
  loading: boolean;
  error: string | undefined;
  scan: UsageScanState | undefined;
  refresh: () => void;
  cancel: () => void;
  settingsError: string | undefined;
};

/**
 * Reads the ledger aggregates for one query and one trend stack. `heat` is a separate daily series over the past
 * year so the calendar keeps its own metric switch. Opening the page starts exactly one incremental refresh.
 */
export function useUsageLedger(query: UsageQuery, granularity: UsageLedgerGranularity, stack: UsageLedgerStack, weekStart: 'auto' | 'monday' | 'sunday'): UsageLedgerData {
  const [settings, setSettings] = useState<UsageLedgerSettings>();
  const [settingsError, setSettingsError] = useState<string>();
  const [summary, setSummary] = useState<UsageLedgerSummary>();
  const [trend, setTrend] = useState<UsageLedgerSeries>();
  const [heat, setHeat] = useState<UsageLedgerSeries>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [scan, setScan] = useState<UsageScanState>();
  const generation = useRef(0);
  const started = useRef(false);
  const latestQuery = useRef({ query, granularity, stack, weekStart });
  latestQuery.current = { query, granularity, stack, weekStart };
  const [reloadKey, setReloadKey] = useState(0);

  const load = async () => {
    const token = ++generation.current;
    const current = latestQuery.current;
    const filters = filtersOf(current.query);
    const today = localDay();
    setLoading(true);
    try {
      const [nextSummary, nextTrend, nextHeat] = await Promise.all([
        request('usage.ledger.summary', { filters }),
        request('usage.ledger.series', { filters, granularity: current.granularity, stack: current.stack, weekStart: current.weekStart }),
        request('usage.ledger.series', { filters: filtersOf({ ...current.query, ...heatmapRange(today) }), granularity: 'day', stack: current.stack, weekStart: current.weekStart }),
      ]);
      if (token !== generation.current) return;
      setSummary(nextSummary); setTrend(nextTrend); setHeat(nextHeat); setError(undefined);
    } catch (caught) {
      if (token !== generation.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  };

  // Settings once: page defaults (week start, whether outside usage may be included) and the provider toggles.
  useEffect(() => {
    let current = true;
    void request('usage.ledger.settings', {}).then(result => {
      if (!current) return;
      setSettings(result.value); setSettingsError(undefined);
    }).catch(caught => { if (current) setSettingsError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { current = false; };
  }, []);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [query.from, query.to, query.scope, query.projectId, query.includeOutside, granularity, stack, weekStart, reloadKey]);

  // One incremental refresh when the page opens; a settings read failure must not block reading the ledger.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void request('usage.ledger.refresh', { operationId: operationId() }).then(result => {
      setScan(current => current?.scanId === result.scanId ? current : { scanId: result.scanId, state: 'running', filesRead: 0, filesFound: 0 });
    }).catch(() => undefined);
  }, []);

  // Progress is the only source of scan state: no timer asks the runtime again.
  useEffect(() => subscribeEvents(event => {
    if (event.event !== 'usage.ledger.progress') return;
    const progress = event.data as UsageLedgerProgress;
    setScan(current => ({
      scanId: progress.scanId,
      provider: progress.provider ?? (progress.state === 'running' ? current?.provider : undefined),
      state: progress.state,
      phase: progress.phase,
      filesRead: progress.stats?.filesRead ?? current?.filesRead ?? 0,
      filesFound: progress.stats?.filesFound ?? current?.filesFound ?? 0,
      error: progress.error ?? undefined,
    }));
    if (progress.state !== 'running' && progress.phase !== 'pricing') setReloadKey(value => value + 1);
  }), []);

  const refresh = () => {
    void request('usage.ledger.refresh', { operationId: operationId() }).then(result => {
      setScan(current => current?.scanId === result.scanId ? { ...current, state: 'running' } : { scanId: result.scanId, state: 'running', filesRead: 0, filesFound: 0 });
    }).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)));
  };
  const cancel = () => {
    if (!scan) return;
    void request('usage.ledger.cancel', { scanId: scan.scanId, operationId: operationId() }).catch(() => undefined);
  };

  return { settings, summary, trend, heat, loading, error, scan, refresh, cancel, settingsError };
}
