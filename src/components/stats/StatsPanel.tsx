/**
 * StatsPanel — right sidebar showing token usage + cost aggregated across all
 * supported AI CLI sessions on the machine. Mounted by TerminalManager behind a
 * `statsOpen` toggle, same pattern as ArchivedCardsPanel.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, RefreshCw, X } from 'lucide-react';
import { useStatsStore } from '../../stores/statsStore';
import { formatCost, formatTokens } from '../../lib/statsFormat';
import { tokenStats } from '../../lib/tauri-bridge';
import type {
  StatBucket,
  StatsDashboard,
  StatsDashboardFilters,
  StatsPricingEntry,
  StatsRange,
  StatsSourceFilter,
  StatsScope,
  StatsStatusFilter,
  StatsProxyStatus,
} from '../../types/stats';

const RANGES: StatsRange[] = ['today', '7d', '30d', 'all'];
const SCOPES: StatsScope[] = ['all', 'claude', 'codex', 'opencode', 'gemini', 'grok'];
const SCOPE_LABEL_FALLBACKS: Record<StatsScope, string> = {
  all: 'All',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  grok: 'Grok Build',
};
const UNASSIGNED_PROJECT_FILTER = '__unassigned__';

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export interface StatsPanelProps {
  onClose: () => void;
  /** Current left-side project/worktree selection. */
  projectPath?: string | null;
}

export function StatsPanel({ onClose, projectPath }: StatsPanelProps) {
  const { t } = useTranslation('terminal');
  const snapshot = useStatsStore((s) => s.snapshot);
  const dashboard = useStatsStore((s) => s.dashboard);
  const dashboardLoading = useStatsStore((s) => s.dashboardLoading);
  const dashboardError = useStatsStore((s) => s.dashboardError);
  const loading = useStatsStore((s) => s.loading);
  const error = useStatsStore((s) => s.error);
  const range = useStatsStore((s) => s.range);
  const scope = useStatsStore((s) => s.scope);
  const scanned = useStatsStore((s) => s.scanned);
  const total = useStatsStore((s) => s.total);
  const activeSilent = useStatsStore((s) => s.activeSilent);
  const setRange = useStatsStore((s) => s.setRange);
  const setScope = useStatsStore((s) => s.setScope);
  const dashboardFilters = useStatsStore((s) => s.dashboardFilters);
  const setDashboardFilters = useStatsStore((s) => s.setDashboardFilters);
  const loadMoreDashboard = useStatsStore((s) => s.loadMoreDashboard);
  const compute = useStatsStore((s) => s.compute);
  const [proxyStatus, setProxyStatus] = useState<StatsProxyStatus | null>(null);
  const activeProjectPath = projectPath?.trim() || undefined;
  // `null` is an initial sentinel. `undefined` is a real "all projects"
  // selection and must still clear a filter left by a previous panel mount.
  const syncedProjectPath = useRef<string | undefined | null>(null);

  // Opening stats follows the same project/worktree selection as the left
  // rail. A user can still clear or edit the field to inspect all projects or
  // a historical path that is no longer present in the rail.
  useEffect(() => {
    if (syncedProjectPath.current === activeProjectPath) return;
    syncedProjectPath.current = activeProjectPath;
    const current = useStatsStore.getState().dashboardFilters;
    if (current.projectPath !== activeProjectPath) {
      setDashboardFilters({ ...current, projectPath: activeProjectPath });
    }
  }, [activeProjectPath, setDashboardFilters]);

  const updateDashboardFilters = (patch: StatsDashboardFilters) => {
    setDashboardFilters({ ...dashboardFilters, ...patch });
  };

  // Query persisted SQLite data before starting the process's first session
  // sync. `loadDashboard` coalesces with the project-filter effect above, so a
  // project-scoped first open still performs one DB read and one sync at most.
  useEffect(() => {
    const state = useStatsStore.getState();
    void state.loadDashboard().finally(() => {
      useStatsStore.getState().ensureInitialSync();
    });
  }, []);

  // While the panel is open, the silent auto-refresh polls at the faster
  // interval; closed panels only need to keep per-card badges loosely fresh.
  useEffect(() => {
    const setPanelOpen = useStatsStore.getState().setPanelOpen;
    setPanelOpen(true);
    return () => setPanelOpen(false);
  }, []);

  useEffect(() => {
    if (typeof tokenStats.proxyStatus !== 'function') return;
    void tokenStats.proxyStatus().then(setProxyStatus).catch(() => setProxyStatus(null));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-15 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="truncate text-sm font-semibold">{t('stats.title', { defaultValue: 'Token usage' })}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => compute()}
            title={t('stats.refresh', { defaultValue: 'Refresh' })}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading || dashboardLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('stats.close', { defaultValue: 'Close' })}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('stats.rangeLabel', { defaultValue: 'Range' })}
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                range === r ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {t(`stats.range.${r}`, { defaultValue: r })}
            </button>
          ))}
        </div>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('stats.scopeLabel', { defaultValue: 'Scope' })}
        >
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                scope === s ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {t(`stats.scope.${s}`, { defaultValue: SCOPE_LABEL_FALLBACKS[s] })}
            </button>
            ))}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <input
            value={dashboardFilters.projectPath === UNASSIGNED_PROJECT_FILTER ? '' : dashboardFilters.projectPath ?? ''}
            onChange={(event) => updateDashboardFilters({ projectPath: event.target.value || undefined })}
            placeholder={t('stats.projectFilter', { defaultValue: 'Project directory' })}
            aria-label={t('stats.projectFilter', { defaultValue: 'Project directory' })}
            title={dashboardFilters.projectPath === UNASSIGNED_PROJECT_FILTER
              ? t('stats.unassigned', { defaultValue: 'Unassigned' })
              : dashboardFilters.projectPath ?? undefined}
            className="col-span-2 min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[11px]"
          />
          <input
            value={dashboardFilters.appType ?? ''}
            onChange={(event) => updateDashboardFilters({ appType: event.target.value || undefined })}
            placeholder={t('stats.appFilter', { defaultValue: 'App' })}
            aria-label={t('stats.appFilter', { defaultValue: 'App' })}
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[11px]"
          />
          <input
            value={dashboardFilters.model ?? ''}
            onChange={(event) => updateDashboardFilters({ model: event.target.value || undefined })}
            placeholder={t('stats.modelFilter', { defaultValue: 'Model' })}
            aria-label={t('stats.modelFilter', { defaultValue: 'Model' })}
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[11px]"
          />
          <select
            value={dashboardFilters.status ?? 'all'}
            onChange={(event) => updateDashboardFilters({ status: event.target.value as StatsStatusFilter })}
            aria-label={t('stats.statusFilter', { defaultValue: 'Status' })}
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[11px]"
          >
            <option value="all">{t('stats.status.all', { defaultValue: 'All status' })}</option>
            <option value="success">{t('stats.status.success', { defaultValue: 'Success' })}</option>
            <option value="failure">{t('stats.status.failure', { defaultValue: 'Failure' })}</option>
          </select>
          <select
            value={dashboardFilters.source ?? 'all'}
            onChange={(event) => updateDashboardFilters({ source: event.target.value as StatsSourceFilter })}
            aria-label={t('stats.sourceFilter', { defaultValue: 'Source' })}
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[11px]"
          >
            <option value="all">{t('stats.source.all', { defaultValue: 'All sources' })}</option>
            <option value="proxy">{t('stats.source.proxy', { defaultValue: 'Proxy' })}</option>
            <option value="session_log">{t('stats.source.session', { defaultValue: 'Session log' })}</option>
          </select>
          <div className="col-span-2 grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => updateDashboardFilters({ projectPath: undefined })}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
            >
              {t('stats.allProjects', { defaultValue: 'All projects' })}
            </button>
            <button
              type="button"
              aria-pressed={dashboardFilters.projectPath === UNASSIGNED_PROJECT_FILTER}
              onClick={() => updateDashboardFilters({ projectPath: UNASSIGNED_PROJECT_FILTER })}
              className={`rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent ${
                dashboardFilters.projectPath === UNASSIGNED_PROJECT_FILTER ? 'bg-primary/15 text-primary' : ''
              }`}
            >
              {t('stats.unassigned', { defaultValue: 'Unassigned' })}
            </button>
          </div>
        </div>
        {proxyStatus?.running && (
          <span className="text-[10px] text-emerald-500">
            {t('stats.proxyActive', { defaultValue: 'Loopback stats proxy active' })}
          </span>
        )}
        {loading && !activeSilent && dashboard && (
          <span className="text-[10px] text-muted-foreground">
            {t('stats.loading', { defaultValue: 'Scanning sessions…' })}
            {total ? ` (${scanned}/${total})` : ''}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error || dashboardError ? (
          <p className="text-xs text-destructive">{error || dashboardError}</p>
        ) : !dashboard && dashboardLoading ? (
          <p className="text-xs text-muted-foreground">
            {t('stats.loadingDashboard', { defaultValue: 'Loading saved statistics…' })}
          </p>
        ) : !dashboard && loading ? (
          <p className="text-xs text-muted-foreground">
            {t('stats.loading', { defaultValue: 'Scanning sessions…' })}
            {total ? ` (${scanned}/${total})` : ''}
          </p>
        ) : dashboard ? (
          <DashboardContent dashboard={dashboard} onLoadMore={loadMoreDashboard} loading={dashboardLoading} />
        ) : !snapshot || snapshot.totalCalls === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('stats.empty', { defaultValue: 'No usage in this window.' })}
          </p>
        ) : (
          <>
            <div className="mb-4 rounded-lg border border-border bg-foreground/5 p-3">
              <div className="text-2xl font-semibold tabular-nums">{formatCost(snapshot.totalCostUsd)}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {formatTokens(snapshot.totalTokens)} {t('stats.realTokens', { defaultValue: 'real tokens' })} ·{' '}
                {snapshot.sessionCount} {t('stats.sessions', { defaultValue: 'sessions' })} ·{' '}
                {snapshot.totalCalls} {t('stats.calls', { defaultValue: 'calls' })}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground tabular-nums">
                <span>{t('stats.inputOutputTokens', { defaultValue: 'input + output' })} {formatTokens(snapshot.inputOutputTokens)}</span>
                <span>{t('stats.cacheTokens', { defaultValue: 'cache' })} {formatTokens(snapshot.cacheTokens)}</span>
                <span>{t('stats.usageInput', { defaultValue: 'input' })} {formatTokens(snapshot.usage.input)}</span>
                <span>{t('stats.usageOutput', { defaultValue: 'output' })} {formatTokens(snapshot.usage.output)}</span>
                <span>{t('stats.usageCacheWrite', { defaultValue: 'cache write' })} {formatTokens(snapshot.usage.cacheCreation)}</span>
                <span>{t('stats.usageCacheRead', { defaultValue: 'cache read' })} {formatTokens(snapshot.usage.cacheRead)}</span>
              </div>
            </div>

            <BucketList title={t('stats.byModel', { defaultValue: 'By model' })} buckets={snapshot.byModel} />
            <BucketList
              title={t('stats.byProject', { defaultValue: 'By project' })}
              buckets={snapshot.byProject}
              labelTransform={basename}
            />
          </>
        )}
      </div>
    </div>
  );
}

function DashboardContent({
  dashboard,
  onLoadMore,
  loading,
}: {
  dashboard: StatsDashboard;
  onLoadMore: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation('terminal');
  const { overview } = dashboard;
  if (overview.requestCount === 0) {
    return <p className="text-xs text-muted-foreground">{t('stats.empty', { defaultValue: 'No usage in this window.' })}</p>;
  }
  const displayTrends = compactTrendPoints(dashboard.trends);
  const maxTrend = Math.max(...displayTrends.map((point) => point.costUsd), 0.0001);
  return (
    <>
      <div className="mb-4 rounded-lg border border-border bg-foreground/5 p-3">
        <div className="text-2xl font-semibold tabular-nums">{formatCost(overview.totalCostUsd)}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {formatTokens(overview.realTotalTokens)} {t('stats.realTokens', { defaultValue: 'real tokens' })} · {overview.requestCount}{' '}
          {t('stats.requests', { defaultValue: 'requests' })} · {overview.sessionCount}{' '}
          {t('stats.sessions', { defaultValue: 'sessions' })}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground tabular-nums">
          <span>{t('stats.successRate', { defaultValue: 'Success' })} {(overview.successRate * 100).toFixed(1)}%</span>
          <span>{t('stats.cacheHitRate', { defaultValue: 'Cache hit' })} {(overview.cacheHitRate * 100).toFixed(1)}%</span>
          <span>{t('stats.usageInput', { defaultValue: 'input' })} {formatTokens(overview.inputTokens)}</span>
          <span>{t('stats.usageOutput', { defaultValue: 'output' })} {formatTokens(overview.outputTokens)}</span>
          <span>{t('stats.usageCacheWrite', { defaultValue: 'cache write' })} {formatTokens(overview.cacheCreationTokens)}</span>
          <span>{t('stats.usageCacheRead', { defaultValue: 'cache read' })} {formatTokens(overview.cacheReadTokens)}</span>
          {overview.unpricedRequestCount > 0 && (
            <span className="text-amber-500">
              {overview.unpricedRequestCount} {t('stats.unpriced', { defaultValue: 'unpriced' })}
            </span>
          )}
        </div>
      </div>

      {displayTrends.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('stats.trend', { defaultValue: 'Trend' })}</h3>
          <div className="flex h-20 items-end gap-px rounded-md border border-border/60 bg-foreground/[0.03] px-2 py-2">
            {displayTrends.map((point) => (
              <div
                key={point.periodStart}
                data-testid="stats-trend-bar"
                className="min-w-[2px] flex-1 rounded-t bg-primary/60"
                style={{ height: `${Math.max(4, (point.costUsd / maxTrend) * 100)}%` }}
                title={`${formatTrendPeriod(point.periodStart, point.periodEnd)} · ${formatCost(point.costUsd)}`}
              />
            ))}
          </div>
        </div>
      )}

      <DashboardBreakdown title={t('stats.byProvider', { defaultValue: 'By provider' })} rows={dashboard.byProvider} />
      <DashboardBreakdown title={t('stats.byModel', { defaultValue: 'By model' })} rows={dashboard.byModel} />

      <div className="mb-4">
        <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('stats.requestLogs', { defaultValue: 'Request logs' })}</h3>
        <ul className="space-y-1.5">
          {dashboard.requestLogs.map((log) => (
            <li key={log.requestId} className="rounded-md border border-border/60 bg-foreground/[0.03] px-2 py-1.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{log.model || 'unknown'}</span>
                <span className={log.success ? 'text-emerald-500' : 'text-destructive'}>
                  {log.statusCode ?? (log.success ? 'ok' : 'error')}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-muted-foreground tabular-nums">
                <span
                  className="truncate"
                  title={log.projectPath ?? t('stats.unassigned', { defaultValue: 'Unassigned project' })}
                >
                  {log.provider} · {log.projectPath ? basename(log.projectPath) : t('stats.unassigned', { defaultValue: 'Unassigned' })} ·{' '}
                  {formatTokens(log.realTotalTokens)} tokens
                </span>
                <span className={log.pricingStatus === 'unpriced' ? 'text-amber-500' : undefined}>
                  {log.pricingStatus === 'unpriced'
                    ? t('stats.unpriced', { defaultValue: 'unpriced' })
                    : formatCost(log.costUsd)}
                </span>
              </div>
            </li>
          ))}
        </ul>
        {dashboard.nextCursor && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="mt-2 w-full rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            {loading ? t('stats.loadingMore', { defaultValue: 'Loading…' }) : t('stats.loadMore', { defaultValue: 'Load more' })}
          </button>
        )}
      </div>
      <PricingEditor />
    </>
  );
}

const MAX_DISPLAY_TREND_BARS = 48;

function compactTrendPoints(
  trends: StatsDashboard['trends'],
): Array<StatsDashboard['trends'][number] & { periodEnd: number }> {
  if (trends.length === 0) return [];
  const bucketSize = Math.max(1, Math.ceil(trends.length / MAX_DISPLAY_TREND_BARS));
  const points: Array<StatsDashboard['trends'][number] & { periodEnd: number }> = [];
  for (let index = 0; index < trends.length; index += bucketSize) {
    const bucket = trends.slice(index, index + bucketSize);
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    points.push({
      periodStart: first.periodStart,
      periodEnd: last.periodStart,
      requestCount: bucket.reduce((sum, point) => sum + point.requestCount, 0),
      successCount: bucket.reduce((sum, point) => sum + point.successCount, 0),
      totalTokens: bucket.reduce((sum, point) => sum + point.totalTokens, 0),
      realTotalTokens: bucket.reduce((sum, point) => sum + point.realTotalTokens, 0),
      costUsd: bucket.reduce(
        (sum, point) => sum + (Number.isFinite(point.costUsd) ? point.costUsd : 0),
        0,
      ),
    });
  }
  return points;
}

function formatTrendPeriod(periodStart: number, periodEnd: number): string {
  const start = new Date(periodStart * 1000).toLocaleDateString();
  if (periodStart === periodEnd) return start;
  return `${start} – ${new Date(periodEnd * 1000).toLocaleDateString()}`;
}

function PricingEditor() {
  const { t } = useTranslation('terminal');
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<StatsPricingEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void tokenStats.pricingList()
      .then(setEntries)
      .finally(() => setLoading(false));
  }, [open]);

  const save = (entry: StatsPricingEntry) => {
    void tokenStats.pricingUpsert(entry).then(() => {
      setEntries((current) => {
        const next = current.filter((item) => item.model !== entry.model);
        return [...next, entry].sort((a, b) => a.model.localeCompare(b.model));
      });
    });
  };

  const remove = (model: string) => {
    void tokenStats.pricingDelete(model).then(() => {
      setEntries((current) => current.filter((entry) => entry.model !== model));
    });
  };

  return (
    <div className="mb-4 rounded-md border border-border/60 bg-foreground/[0.03] p-2">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{t('stats.pricingOverrides', { defaultValue: 'Pricing overrides' })}</span>
        <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {loading ? (
            <p className="text-[11px] text-muted-foreground">{t('stats.loadingPricing', { defaultValue: 'Loading pricing…' })}</p>
          ) : entries.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t('stats.noCustomRates', { defaultValue: 'No custom rates. Built-in cc-switch rates are active.' })}</p>
          ) : (
            entries.map((entry) => (
              <PricingRow key={entry.model} entry={entry} onSave={save} onRemove={remove} />
            ))
          )}
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
            onClick={() => setEntries((current) => [
              ...current,
              {
                model: 'custom-model',
                inputPerMtok: 0,
                outputPerMtok: 0,
                cacheWritePerMtok: 0,
                cacheReadPerMtok: 0,
                enabled: true,
              },
            ])}
          >
            {t('stats.addModelRate', { defaultValue: 'Add model rate' })}
          </button>
        </div>
      )}
    </div>
  );
}

function PricingRow({
  entry,
  onSave,
  onRemove,
}: {
  entry: StatsPricingEntry;
  onSave: (entry: StatsPricingEntry) => void;
  onRemove: (model: string) => void;
}) {
  const { t } = useTranslation('terminal');
  const [draft, setDraft] = useState(entry);
  return (
    <div className="space-y-1 rounded border border-border/60 p-1.5">
      <input
        value={draft.model}
        onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px]"
        aria-label="Model"
      />
      <div className="grid grid-cols-2 gap-1">
        {(['inputPerMtok', 'outputPerMtok', 'cacheWritePerMtok', 'cacheReadPerMtok'] as const).map((field) => (
          <input
            key={field}
            type="number"
            min="0"
            step="any"
            value={draft[field]}
            onChange={(event) => setDraft({ ...draft, [field]: Number(event.target.value) })}
            className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] tabular-nums"
            aria-label={field}
          />
        ))}
      </div>
      <div className="flex justify-end gap-1">
        <button type="button" className="rounded px-1.5 py-1 text-[11px] text-primary hover:bg-primary/10" onClick={() => onSave(draft)}>
          {t('stats.savePricing', { defaultValue: 'Save' })}
        </button>
        <button type="button" className="rounded px-1.5 py-1 text-[11px] text-destructive hover:bg-destructive/10" onClick={() => onRemove(draft.model)}>
          {t('stats.removePricing', { defaultValue: 'Remove' })}
        </button>
      </div>
    </div>
  );
}

function DashboardBreakdown({
  title,
  rows,
}: {
  title: string;
  rows: StatsDashboard['byProvider'];
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((row) => row.costUsd), 0.0001);
  return (
    <div className="mb-4">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="space-y-1.5">
        {rows.slice(0, 12).map((row) => (
          <li key={row.key} className="relative overflow-hidden rounded-md border border-border/60 bg-foreground/[0.03] px-2 py-1.5">
            <div className="absolute inset-y-0 left-0 bg-primary/10" style={{ width: `${(row.costUsd / max) * 100}%` }} aria-hidden />
            <div className="relative flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate font-medium">{row.label || 'unknown'}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatCost(row.costUsd)}</span>
            </div>
            <div className="relative mt-0.5 text-[11px] tabular-nums text-muted-foreground">
              {formatTokens(row.realTotalTokens)} tokens · {row.calls} calls · {(row.cacheHitRate * 100).toFixed(1)}% cache hit
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BucketList({
  title,
  buckets,
  labelTransform,
}: {
  title: string;
  buckets: StatBucket[];
  labelTransform?: (s: string) => string;
}) {
  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((b) => b.costUsd), 0.0001);
  return (
    <div className="mb-4">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {buckets.slice(0, 12).map((b) => (
          <li
            key={b.key}
            className="relative overflow-hidden rounded-md border border-border/60 bg-foreground/[0.03] px-2 py-1.5"
          >
            <div
              className="absolute inset-y-0 left-0 bg-primary/10"
              style={{ width: `${(b.costUsd / max) * 100}%` }}
              aria-hidden
            />
            <div className="relative flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate font-medium">
                {labelTransform ? labelTransform(b.label) : b.label || 'unknown'}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatCost(b.costUsd)}</span>
            </div>
            <div className="relative mt-0.5 text-[11px] tabular-nums text-muted-foreground">
              {formatTokens(b.totalTokens)} total · {formatTokens(b.inputOutputTokens)} i/o · {formatTokens(b.cacheTokens)} cache
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
