import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Snapshot, UsageLedgerScope, UsageLedgerStack } from '@threadterm/protocol';
import { agentName } from '../agents';
import { useTranslation } from '../i18n';
import { usageCopy } from '../usageCopy';
import {
  compactTokens, costCoverage, costDisplay, evidenceLine, fullNumber, percentText, reportedCostText, tilesState, tokenShares, type UsageLocale,
} from '../usageFormat';
import { heatmapRange, granularityFor, localDay, rangeFor, shiftLocalDay, USAGE_RANGES, useUsageBreakdowns, useUsageLedger, type UsageQuery, type UsageRangePreset } from '../usageLedger';
import { Select } from './ui/Select';
import { Icon } from './PrototypeIcon';
import { WbIcon } from '../workbench/icons';
import { UsageBreakdowns, type BreakdownFilter } from './UsageBreakdowns';
import { UsageHeatmap } from './UsageHeatmap';
import { UsageSessions } from './UsageSessions';
import { UsageSources } from './UsageSources';
import { UsageTrendChart } from './UsageTrendChart';
import { aggregateActiveTime, usageDays } from '../usagePresentation';
import { usageScanNotice } from '../usageScan';
import { UsageScanNotice } from './UsageScanNotice';
import './usage-page.css';

type Props = {
  /** Set when the project overview opened the page: the whole page is filtered to that project. */
  initialProjectId?: string;
  data: Snapshot | undefined;
  /** Opens a ThreadTerm session's Chat from the sessions list. */
  onOpenSession?: (sessionId: string) => void;
};

/** The Usage page: scope, range, tiles, calendar, trend, breakdowns, sessions and sources. Aggregate RPCs only. */
export function UsagePage({ initialProjectId, data, onOpenSession }: Props) {
  const { locale } = useTranslation();
  const usageLocale: UsageLocale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const copy = usageCopy(usageLocale);
  const providerName = (id: string) => agentName(id, data?.providers ?? []) || id;
  const [scope, setScope] = useState<UsageLedgerScope>('all');
  const [preset, setPreset] = useState<UsageRangePreset>('30d');
  const [customFrom, setCustomFrom] = useState(() => shiftLocalDay(localDay(), -29));
  const [customTo, setCustomTo] = useState(() => localDay());
  const [projectId, setProjectId] = useState(initialProjectId);
  const [provider, setProvider] = useState<string>();
  const [model, setModel] = useState<string>();
  // A saved "outside off" setting forces the ThreadTerm scope; turning it back on restores what the user had.
  const forcedScope = useRef<UsageLedgerScope | undefined>(undefined);
  const [stack, setStack] = useState<UsageLedgerStack>('provider');
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month' | undefined>(undefined);
  useEffect(() => { setProjectId(initialProjectId); }, [initialProjectId]);

  const today = localDay();
  const range = preset === 'custom' && customFrom <= customTo
    ? { from: customFrom, to: shiftLocalDay(customTo, 1) }
    : rangeFor(preset === 'custom' ? '30d' : preset, today);
  const includeOutside = scope !== 'threadterm';
  const effectiveGranularity = granularity ?? granularityFor(range.from, range.to);
  const query: UsageQuery = useMemo(() => ({ from: range.from, to: range.to, scope, projectId, provider, model, includeOutside }), [range.from, range.to, scope, projectId, provider, model, includeOutside]);
  // The week boundary is a saved preference (Settings → Usage); the page reads it with the rest of its settings.
  const ledger = useUsageLedger({ from: range.from, to: range.to, scope, projectId, provider, model, includeOutside }, effectiveGranularity, stack, 'auto');
  const settings = ledger.settings;
  const weekStartPreference = settings?.weekStart ?? 'auto';
  const outsideAllowed = settings?.includeOutside !== false;
  const breakdowns = useUsageBreakdowns(query, ledger.version + ledger.liveVersion);

  // A saved "outside usage off" setting is a product rule, not a suggestion: the scope switch keeps only ThreadTerm,
  // and the remembered scope comes back when the setting does (the page must not stay pinned to In ThreadTerm).
  useEffect(() => {
    if (!settings) return;
    if (!settings.includeOutside) {
      if (scope !== 'threadterm') { forcedScope.current = scope; setScope('threadterm'); }
    } else if (forcedScope.current) {
      const previous = forcedScope.current ?? 'all';
      forcedScope.current = undefined;
      setScope(previous);
    }
  }, [settings?.includeOutside, scope]);

  const summary = ledger.summary;
  const trend = ledger.trend;
  const activeDays = useMemo(() => usageDays(ledger.heat, range.from, range.to), [ledger.heat, range.from, range.to]);
  const sessionsWithoutUsage = summary?.sessionsWithoutUsage ?? 0;
  const shares = summary ? tokenShares(summary.tokens) : [];
  const evidence = summary ? evidenceLine(summary.quality) : undefined;
  const coverage = summary ? costCoverage(summary.cost) : undefined;
  const cost = summary ? costDisplay(summary.cost, usageLocale, summary.pricingPending) : undefined;
  const hasUsage = Boolean(summary && summary.requests > 0);
  const rangeLabel = (value: UsageRangePreset) => copy.range[value] ?? value;
  const projectName = projectId ? data?.projects.find(project => project.id === projectId)?.name ?? projectId : undefined;
  const scan = ledger.scan;
  const running = scan?.state === 'running';
  const scanNotice = usageScanNotice(scan, ledger.firstScan, usageLocale, providerName);
  // Two different silences: while history is still being read the tiles hold a placeholder, and only a finished read
  // with nothing in range may say there was no usage.
  const tiles = tilesState({ requests: summary?.requests ?? 0, loading: ledger.loading, scanning: running });
  const reading = tiles === 'reading';
  const placeholder = <span className="usage-skel" aria-hidden="true" />;

  const displayShares = [
    ...shares.filter(item => item.key === 'input' || item.key === 'cacheRead'),
    { key: 'cacheWrite5m', share: shares.filter(item => item.key.startsWith('cacheWrite')).reduce((sum, item) => sum + item.share, 0) },
    ...shares.filter(item => item.key === 'output'),
  ].filter(item => item.share > 0);
  const bucketSplit = displayShares.map(item => {
    const label = item.key === 'cacheWrite5m' ? copy.buckets.cacheWrite : item.key === 'cacheWrite1h' ? `${copy.buckets.cacheWrite} (1h)` : item.key === 'cacheWriteUnknown' ? copy.buckets.cacheWrite : item.key === 'input' ? copy.buckets.input : item.key === 'cacheRead' ? copy.buckets.cacheRead : item.key === 'output' ? copy.buckets.output : copy.buckets.reasoning;
    return `${label} ${percentText(item.share, usageLocale)}`;
  }).join(' · ');
  const reasoningShare = summary && summary.tokens.total > 0 && summary.tokens.reasoning ? summary.tokens.reasoning / summary.tokens.total : 0;
  const activeFilters: Array<{ key: string; label: string; clear: () => void }> = [
    ...(provider ? [{ key: 'provider', label: copy.breakdown.filtered(providerName(provider)), clear: () => setProvider(undefined) }] : []),
    ...(model ? [{ key: 'model', label: copy.breakdown.filtered(model), clear: () => setModel(undefined) }] : []),
    ...(projectName ? [{ key: 'project', label: copy.projectFilter(projectName), clear: () => setProjectId(undefined) }] : []),
  ];

  const tile = (label: string, value: ReactNode, sub: ReactNode, extra?: ReactNode, labelTitle?: string) =>
    <div className="usage-tile"><span className="usage-tile-label" title={labelTitle}>{label}</span><b className="usage-tile-value tnum">{value}</b><span className="usage-tile-sub">{sub}</span>{extra}</div>;

  return <section className="usage-page" aria-label={copy.title}>
    <header className="wb-panel-head usage-head">
      <Icon name="layers" /><strong>{copy.title}</strong>
      <div className="seg" role="group" aria-label={copy.scope.label}>
        {(['all', 'threadterm', 'outside'] as UsageLedgerScope[]).map(value => <button key={value} type="button" className={`seg-btn btn-tab${scope === value ? ' active' : ''}`} aria-pressed={scope === value}
          disabled={!outsideAllowed && value !== 'threadterm'}
          title={!outsideAllowed && value !== 'threadterm' ? copy.outsideDisabled : undefined}
          onClick={() => setScope(value)}>
          {value === 'all' ? copy.scope.all : value === 'threadterm' ? copy.scope.threadterm : copy.scope.outside}
        </button>)}
      </div>
      <div className="usage-range">
        <Select value={preset} aria-label={copy.range.label} onChange={event => { setPreset(event.target.value as UsageRangePreset); setGranularity(undefined); }}>
          {USAGE_RANGES.map(value => <option key={value} value={value}>{rangeLabel(value)}</option>)}
        </Select>
        {preset === 'custom' && <>
          <input type="date" className="usage-date" aria-label={copy.range.from} value={customFrom} max={customTo} onChange={event => { setCustomFrom(event.target.value); setGranularity(undefined); }} />
          <span aria-hidden="true">–</span>
          <input type="date" className="usage-date" aria-label={copy.range.to} value={customTo} min={customFrom} max={today} onChange={event => { setCustomTo(event.target.value); setGranularity(undefined); }} />
        </>}
      </div>
      {activeFilters.map(filter => <button key={filter.key} type="button" className="chip chip-btn is-plain usage-filter" title={`${filter.label} · ${copy.breakdown.clearFilter}`} onClick={filter.clear}>
        <span>{filter.label}</span><Icon name="close" />
      </button>)}
      <span className="usage-head-spacer" />
      <span className="usage-progress" />
      <button type="button" className="icon-btn" aria-label={copy.refresh} title={copy.refresh} aria-busy={running} onClick={ledger.refresh}><WbIcon name="refresh" /></button>
    </header>
    <div className="usage-scroll">
      {scanNotice && <UsageScanNotice notice={scanNotice} onAction={running ? ledger.cancel : ledger.refresh} />}
      {ledger.error ? <p className="surface-error" role="alert">{copy.unavailable} {ledger.error}</p> : <>
          <div className="usage-tiles" aria-busy={reading || undefined}>
            {tile(copy.tiles.tokens,
              reading ? placeholder : hasUsage ? compactTokens(summary!.tokens.total, usageLocale) : copy.unknown,
              reading ? copy.readingHistory : hasUsage && evidence ? `${copy.evidence.exact} ${percentText(evidence.exact, usageLocale)}${evidence.derived > 0 ? ` · ${copy.evidence.derived} ${percentText(evidence.derived, usageLocale)}` : ''}${evidence.estimated > 0 ? ` · ≈ ${percentText(evidence.estimated, usageLocale)}` : ''}` : copy.noData,
              !reading && bucketSplit && <span className="usage-tile-extra" title={reasoningShare > 0 ? `${copy.buckets.reasoning} ${percentText(reasoningShare, usageLocale)}` : undefined}>{bucketSplit}</span>)}
            {tile(copy.tiles.cost,
              reading ? placeholder : hasUsage ? cost!.text : copy.unknown,
              reading ? copy.readingHistory : hasUsage && coverage && coverage.pricedTokens > 0 ? copy.tiles.priced(percentText(coverage.priced, usageLocale)) : hasUsage && cost?.noPrice ? copy.cost.noPrice : undefined,
              !reading && <span className="usage-tile-extra">{[
                summary?.cost.reportedUsd ? `${reportedCostText(summary.cost.reportedUsd, usageLocale)} ${copy.tiles.reportedCost}` : undefined,
                coverage && coverage.unpricedTokens > 0 ? copy.evidence.unpriced(compactTokens(coverage.unpricedTokens, usageLocale)) : undefined,
              ].filter(Boolean).join(' · ')}</span>,
              copy.cost.tooltip)}
            {tile(copy.tiles.requests,
              reading ? placeholder : hasUsage ? fullNumber(summary!.requests, usageLocale) : copy.unknown,
              reading ? copy.readingHistory : hasUsage ? copy.tiles.sessions(summary!.sessions) : copy.noData,
              sessionsWithoutUsage > 0 ? <span className="usage-tile-extra">{copy.evidence.sessionsWithoutUsage(sessionsWithoutUsage)}</span> : undefined)}
            {tile(copy.tiles.activeTime,
              reading ? placeholder : hasUsage ? aggregateActiveTime(summary!.activeTimeMs, summary!.requests, usageLocale) : copy.unknown,
              reading ? copy.readingHistory : hasUsage ? activeDays === undefined ? undefined : copy.tiles.days(activeDays) : copy.noData,
              undefined, copy.tiles.estimatedMethod)}
          </div>
          {settings && !settings.includeOutside && <p className="usage-note">{copy.outsideDisabled}</p>}
          <UsageHeatmap
            series={ledger.heat}
            locale={usageLocale}
            copy={copy}
            weekStartPreference={weekStartPreference}
            providerName={providerName}
            from={heatmapRange(today).from}
            to={shiftLocalDay(heatmapRange(today).to, -1)}
            onSelectDay={day => { setPreset('custom'); setCustomFrom(day); setCustomTo(day); setGranularity(undefined); }}
          />
          <UsageTrendChart
            series={trend}
            stack={stack}
            locale={usageLocale}
            copy={copy}
            reading={reading}
            providerName={providerName}
            onToggleStack={setStack}
            onGranularity={value => setGranularity(value)}
          />
          <UsageBreakdowns
            breakdowns={breakdowns.breakdowns}
            locale={usageLocale}
            copy={copy}
            providerName={providerName}
            loading={breakdowns.loading}
            selected={{ provider, model, projectId }}
            onFilter={(filter: BreakdownFilter) => {
              if ('provider' in filter) setProvider(filter.provider);
              if ('model' in filter) setModel(filter.model);
              if ('projectId' in filter) setProjectId(filter.projectId);
            }}
          />
          {breakdowns.error && <p className="surface-error" role="alert">{breakdowns.error}</p>}
          <UsageSessions
            query={query}
            data={data}
            locale={usageLocale}
            copy={copy}
            providerName={providerName}
            version={ledger.version}
            liveVersion={ledger.liveVersion}
            onOpenSession={onOpenSession}
            onImported={ledger.reload}
          />
          <UsageSources locale={usageLocale} copy={copy} providerName={providerName} version={ledger.version} onRebuilt={ledger.reload} />
        </>}
    </div>
  </section>;
}
