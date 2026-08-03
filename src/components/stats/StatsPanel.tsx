/**
 * StatsPanel — right sidebar showing token usage + cost aggregated across all
 * supported AI CLI sessions on the machine. Mounted by TerminalManager behind a
 * `statsOpen` toggle, same pattern as ArchivedCardsPanel.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, RefreshCw, X } from 'lucide-react';
import { useStatsStore } from '../../stores/statsStore';
import { formatCost, formatTokens } from '../../lib/statsFormat';
import type { StatBucket, StatsRange, StatsScope } from '../../types/stats';

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

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export interface StatsPanelProps {
  onClose: () => void;
}

export function StatsPanel({ onClose }: StatsPanelProps) {
  const { t } = useTranslation('terminal');
  const snapshot = useStatsStore((s) => s.snapshot);
  const loading = useStatsStore((s) => s.loading);
  const error = useStatsStore((s) => s.error);
  const range = useStatsStore((s) => s.range);
  const scope = useStatsStore((s) => s.scope);
  const scanned = useStatsStore((s) => s.scanned);
  const total = useStatsStore((s) => s.total);
  const setRange = useStatsStore((s) => s.setRange);
  const setScope = useStatsStore((s) => s.setScope);
  const compute = useStatsStore((s) => s.compute);

  // Compute on first open if we have nothing yet.
  useEffect(() => {
    if (!snapshot && !loading) compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While the panel is open, the silent auto-refresh polls at the faster
  // interval; closed panels only need to keep per-card badges loosely fresh.
  useEffect(() => {
    const setPanelOpen = useStatsStore.getState().setPanelOpen;
    setPanelOpen(true);
    return () => setPanelOpen(false);
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
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : loading && !snapshot ? (
          <p className="text-xs text-muted-foreground">
            {t('stats.loading', { defaultValue: 'Scanning sessions…' })}
            {total ? ` (${scanned}/${total})` : ''}
          </p>
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
