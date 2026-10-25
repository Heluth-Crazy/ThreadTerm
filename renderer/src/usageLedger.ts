// Data access for the Usage page. Every read is an aggregate RPC; the page never holds a record list.
// Scans run only on open or request. Progress events drive throttled reads; there is no idle polling.
import { useEffect, useRef, useState } from 'react';
import { operationId, request, subscribeEvents } from './bridge';
import { sessionQuery, type SessionQuery, type UsageSessionSort } from './usageSessions';
import { createUsageProgressThrottle, hasReadProviderHistory, usageScanErrorCode } from './usageScan';
import type {
  UsageLedgerBreakdown,
  UsageLedgerProgress,
  UsageLedgerSessionDetail,
  UsageLedgerSessions,
  UsageLedgerSettings,
  UsageLedgerSettingsResult,
  UsageLedgerSources,
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

export type UsageQuery = {
  from: string;
  to: string;
  scope: UsageLedgerScope;
  projectId?: string;
  /** Row-click filters from the breakdown lists. */
  provider?: string;
  model?: string;
  includeOutside: boolean;
};

/** The wire filters for one query. Absent keys are omitted so the runtime keeps its own defaults. */
export function filtersOf(query: UsageQuery) {
  return {
    from: query.from,
    to: query.to,
    scope: query.scope,
    includeOutside: query.includeOutside,
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
    ...(query.model ? { model: query.model } : {}),
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
  /** Bumped when a scan reaches a terminal state, so every section below re-reads its own aggregate. */
  version: number;
  /** Event-throttled refreshes while history is still being counted. */
  liveVersion: number;
  firstScan: boolean;
  reload: () => void;
  refresh: () => void;
  cancel: () => void;
  settingsError: string | undefined;
  /** Applies a settings change the page itself made (week start), without another read. */
  setSettings: (value: UsageLedgerSettings) => void;
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
  // The saved week boundary is the runtime's own default when the caller passes `auto`; it arrives with the settings
  // read, so the series is asked again once with the preference the settings hold.
  const [savedWeekStart, setSavedWeekStart] = useState<'auto' | 'monday' | 'sunday'>();
  const latestQuery = useRef({ query, granularity, stack, weekStart });
  latestQuery.current = { query, granularity, stack, weekStart };
  const [reloadKey, setReloadKey] = useState(0);
  const [liveVersion, setLiveVersion] = useState(0);
  const [firstScanId, setFirstScanId] = useState<string>();
  const pendingFirstRead = useRef(false);
  const refreshGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

  const load = async () => {
    const token = ++generation.current;
    const current = latestQuery.current;
    const filters = filtersOf(current.query);
    const weekStartValue = current.weekStart === 'auto' ? savedWeekStart ?? 'auto' : current.weekStart;
    const today = localDay();
    setLoading(true);
    try {
      const [nextSummary, nextTrend, nextHeat] = await Promise.all([
        request('usage.ledger.summary', { filters }),
        request('usage.ledger.series', { filters, granularity: current.granularity, stack: current.stack, weekStart: weekStartValue }),
        request('usage.ledger.series', { filters: filtersOf({ ...current.query, ...heatmapRange(today) }), granularity: 'day', stack: current.stack, weekStart: weekStartValue }),
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

  const refresh = async () => {
    const token = ++refreshGeneration.current;
    let firstRead = false;
    try {
      const sources = await request('usage.ledger.sources', {});
      firstRead = !hasReadProviderHistory(sources.providers);
    } catch { /* A source-status failure must not prevent retrying the scan. */ }
    if (!mounted.current || token !== refreshGeneration.current) return;
    pendingFirstRead.current = firstRead;
    try {
      const result = await request('usage.ledger.refresh', { operationId: operationId() });
      if (!mounted.current || token !== refreshGeneration.current) return;
      setFirstScanId(firstRead ? result.scanId : undefined);
      setScan(current => current?.scanId === result.scanId ? current : { scanId: result.scanId, state: 'running', filesRead: 0, filesFound: 0 });
    } catch (caught) {
      if (mounted.current && token === refreshGeneration.current) setScan({ scanId: '', state: 'failed', filesRead: 0, filesFound: 0, error: usageScanErrorCode(caught) });
    }
  };

  // Settings once: page defaults (week start, whether outside usage may be included) and the provider toggles.
  useEffect(() => {
    let current = true;
    void request('usage.ledger.settings', {}).then(result => {
      if (!current) return;
      setSettings(result.value); setSavedWeekStart(result.value.weekStart); setSettingsError(undefined);
    }).catch(caught => { if (current) setSettingsError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { current = false; };
  }, []);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [query.from, query.to, query.scope, query.projectId, query.provider, query.model, query.includeOutside, granularity, stack, weekStart, savedWeekStart, reloadKey, liveVersion]);

  // One incremental refresh when the page opens; a settings read failure must not block reading the ledger.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh();
  }, []);

  // Settings can change in another window or in Settings → Usage while this page is open; a settings event re-reads
  // them once (and refreshes the aggregates a week-start or provider-scope change invalidates). Still no polling.
  useEffect(() => subscribeEvents(event => {
    if (event.event !== 'state.changed') return;
    if ((event.data as { kind?: string } | undefined)?.kind !== 'settings') return;
    void request('usage.ledger.settings', {}).then(result => {
      setSettings(result.value);
      setSavedWeekStart(result.value.weekStart);
      setReloadKey(value => value + 1);
    }).catch(() => undefined);
  }), []);

  // A pending timeout belongs to actual progress, and is discarded at completion or unmount.
  useEffect(() => {
    const updates = createUsageProgressThrottle(() => setLiveVersion(value => value + 1));
    let scanId: string | undefined;
    const unsubscribe = subscribeEvents(event => {
      if (event.event !== 'usage.ledger.progress') return;
      const progress = event.data as UsageLedgerProgress;
      if (scanId !== progress.scanId) {
        updates.cancel(); scanId = progress.scanId;
        setFirstScanId(pendingFirstRead.current ? progress.scanId : undefined); pendingFirstRead.current = false;
      }
      setScan(current => ({
        scanId: progress.scanId,
        provider: progress.provider ?? (progress.state === 'running' && current?.scanId === progress.scanId ? current.provider : undefined),
        state: progress.state,
        phase: progress.phase,
        filesRead: progress.stats?.filesRead ?? (current?.scanId === progress.scanId ? current.filesRead : 0),
        filesFound: progress.stats?.filesFound ?? (current?.scanId === progress.scanId ? current.filesFound : 0),
        error: progress.error ?? undefined,
      }));
      if (progress.state === 'running') updates.progress();
      else { updates.cancel(); setFirstScanId(undefined); pendingFirstRead.current = false; setReloadKey(value => value + 1); }
    });
    return () => { unsubscribe(); updates.dispose(); };
  }, []);

  const cancel = () => {
    if (!scan) return;
    void request('usage.ledger.cancel', { scanId: scan.scanId, operationId: operationId() }).catch(() => undefined);
  };

  return { settings, summary, trend, heat, loading, error, scan, version: reloadKey, liveVersion, firstScan: Boolean(scan && firstScanId === scan.scanId), reload: () => setReloadKey(value => value + 1), refresh, cancel, settingsError, setSettings };
}

const errorText = (caught: unknown) => caught instanceof Error ? caught.message : String(caught);

export type UsageBreakdownDimension = 'provider' | 'model' | 'project';

/**
 * The three breakdown lists for one range and scope. They are read together so a row in one list never filters against
 * a different window than the one next to it.
 */
export function useUsageBreakdowns(query: UsageQuery, version: number): {
  breakdowns: Partial<Record<UsageBreakdownDimension, UsageLedgerBreakdown>>;
  loading: boolean;
  error: string | undefined;
} {
  const [breakdowns, setBreakdowns] = useState<Partial<Record<UsageBreakdownDimension, UsageLedgerBreakdown>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    const token = ++generation.current;
    const filters = filtersOf(latest.current);
    setLoading(true);
    void Promise.all((['provider', 'model', 'project'] as UsageBreakdownDimension[]).map(dimension =>
      request('usage.ledger.breakdown', { filters, dimension }).then(value => [dimension, value] as const)))
      .then(entries => {
        if (token !== generation.current) return;
        setBreakdowns(Object.fromEntries(entries)); setError(undefined);
      })
      .catch(caught => { if (token === generation.current) setError(errorText(caught)); })
      .finally(() => { if (token === generation.current) setLoading(false); });
  }, [query.from, query.to, query.scope, query.projectId, query.provider, query.model, query.includeOutside, version]);

  return { breakdowns, loading, error };
}

/** One page of sessions. `params` is produced by `sessionQuery`, so sorting and paging are already bounded. */
export function useUsageSessions(query: UsageQuery, params: SessionQuery, version: number): {
  page: UsageLedgerSessions | undefined;
  loading: boolean;
  error: string | undefined;
} {
  const [page, setPage] = useState<UsageLedgerSessions>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    const token = ++generation.current;
    const filters = filtersOf(latest.current);
    setLoading(true);
    void request('usage.ledger.sessions', { filters, ...params })
      .then(value => { if (token !== generation.current) return; setPage(value); setError(undefined); })
      .catch(caught => { if (token === generation.current) setError(errorText(caught)); })
      .finally(() => { if (token === generation.current) setLoading(false); });
  }, [query.from, query.to, query.scope, query.projectId, query.provider, query.model, query.includeOutside, params.sort, params.order, params.limit, params.offset, params.search, version]);

  return { page, loading, error };
}

/** A single session's own days and sub-agents; only read while the drawer is open. */
export function useUsageSession(
  query: UsageQuery,
  target: { provider: string; nativeSessionId: string } | undefined,
  version: number,
): { detail: UsageLedgerSessionDetail | undefined; loading: boolean; error: string | undefined } {
  const [detail, setDetail] = useState<UsageLedgerSessionDetail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const latest = useRef(query);
  latest.current = query;
  const provider = target?.provider, nativeSessionId = target?.nativeSessionId;

  useEffect(() => {
    if (!provider || !nativeSessionId) { setDetail(undefined); setError(undefined); setLoading(false); return; }
    const token = ++generation.current;
    const filters = filtersOf(latest.current);
    setLoading(true);
    void request('usage.ledger.session', { filters, provider, nativeSessionId })
      .then(value => { if (token !== generation.current) return; setDetail(value ?? undefined); setError(undefined); })
      .catch(caught => { if (token === generation.current) setError(errorText(caught)); })
      .finally(() => { if (token === generation.current) setLoading(false); });
  }, [provider, nativeSessionId, query.from, query.to, query.scope, query.projectId, query.provider, query.model, query.includeOutside, version]);

  return { detail, loading, error };
}

/** Sources are read on demand (panel opened, scan finished, rebuild), never on a schedule. */
export function useUsageSources(version: number, enabled: boolean): {
  sources: UsageLedgerSources | undefined;
  loading: boolean;
  error: string | undefined;
  read: () => void;
} {
  const [sources, setSources] = useState<UsageLedgerSources>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [key, setKey] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const token = ++generation.current;
    setLoading(true);
    void request('usage.ledger.sources', {})
      .then(value => { if (token !== generation.current) return; setSources(value); setError(undefined); })
      .catch(caught => { if (token === generation.current) setError(errorText(caught)); })
      .finally(() => { if (token === generation.current) setLoading(false); });
  }, [enabled, version, key]);

  return { sources, loading, error, read: () => setKey(value => value + 1) };
}

/** Settings write with the runtime's optimistic revision; the caller owns the draft and the retry. */
export function updateUsageSettings(value: Partial<UsageLedgerSettings>, expectedRevision: number): Promise<UsageLedgerSettingsResult> {
  return request('usage.ledger.settings.update', { value, expectedRevision, operationId: operationId() });
}

export function readUsageSettings(): Promise<UsageLedgerSettingsResult> {
  return request('usage.ledger.settings', {});
}

/** Drops rebuildable native observations and cursors; the following scan is a full one. */
export function rebuildUsageLedger(): Promise<{ scanId: string; state: 'running' | 'already_running' }> {
  return request('usage.ledger.rebuild', { operationId: operationId() });
}

/** Sort options for the sessions list, in the order the select shows them. */
export const USAGE_SESSION_SORT_OPTIONS: UsageSessionSort[] = ['tokens', 'cost', 'recent', 'activeTime'];

/** Convenience for the page: the request parameters for one list state. */
export const sessionsRequest = (options: { sort: UsageSessionSort; offset: number; search?: string }) => sessionQuery(options);
