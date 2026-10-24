import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Snapshot, UsageLedgerScope, UsageLedgerStack } from '@threadterm/protocol';
import { agentName } from '../agents';
import { useTranslation } from '../i18n';
import { usageCopy } from '../usageCopy';
import {
  activeTimeText, compactTokens, costCoverage, costText, evidenceLine, fullNumber, percentText, reportedCostText, tilesState, tokenShares, type UsageLocale,
} from '../usageFormat';
import { heatmapRange, granularityFor, localDay, rangeFor, shiftLocalDay, USAGE_RANGES, useUsageLedger, type UsageRangePreset } from '../usageLedger';
import { Select } from './ui/Select';
import { Icon } from './PrototypeIcon';
import { WbIcon } from '../workbench/icons';
import { UsageHeatmap } from './UsageHeatmap';
import { UsageTrendChart } from './UsageTrendChart';
import './usage-page.css';

type Props = {
  /** Set when the project overview opened the page: the whole page is filtered to that project. */
  initialProjectId?: string;
  data: Snapshot | undefined;
};

/** The Usage page: scope, range, summary tiles, yearly calendar and trend. Aggregate RPCs only. */
export function UsagePage({ initialProjectId, data }: Props) {
  const { locale } = useTranslation();
  const usageLocale: UsageLocale = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const zh = usageLocale === 'zh-CN';
  const copy = usageCopy(usageLocale);
  const providerName = (id: string) => agentName(id, data?.providers ?? []) || id;
  const [scope, setScope] = useState<UsageLedgerScope>('all');
  const [preset, setPreset] = useState<UsageRangePreset>('30d');
  const [customFrom, setCustomFrom] = useState(() => shiftLocalDay(localDay(), -29));
  const [customTo, setCustomTo] = useState(() => localDay());
  const [projectId, setProjectId] = useState(initialProjectId);
  const [stack, setStack] = useState<UsageLedgerStack>('provider');
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month' | undefined>(undefined);
  useEffect(() => { setProjectId(initialProjectId); }, [initialProjectId]);

  const today = localDay();
  const range = preset === 'custom' && customFrom <= customTo
    ? { from: customFrom, to: shiftLocalDay(customTo, 1) }
    : rangeFor(preset === 'custom' ? '30d' : preset, today);
  const includeOutside = scope !== 'threadterm';
  const weekStartPreference = 'auto';
  const effectiveGranularity = granularity ?? granularityFor(range.from, range.to);
  const ledger = useUsageLedger({ from: range.from, to: range.to, scope, projectId, includeOutside }, effectiveGranularity, stack, weekStartPreference);
  const settings = ledger.settings;
  const outsideAllowed = settings?.includeOutside !== false;

  // A saved "outside usage off" setting is a product rule, not a suggestion: the scope switch keeps only ThreadTerm.
  useEffect(() => { if (settings && !settings.includeOutside && scope !== 'threadterm') setScope('threadterm'); }, [settings?.includeOutside, scope]);

  const summary = ledger.summary;
  const trend = ledger.trend;
  const activeDays = useMemo(() => (trend?.points ?? []).filter(point => point.activeTimeMs > 0).length, [trend]);
  const sessionsWithoutUsage = summary?.sessionsWithoutUsage ?? 0;
  const shares = summary ? tokenShares(summary.tokens) : [];
  const evidence = summary ? evidenceLine(summary.quality) : undefined;
  const coverage = summary ? costCoverage(summary.cost) : undefined;
  const hasUsage = Boolean(summary && summary.requests > 0);
  const rangeLabel = (value: UsageRangePreset) => copy.range[value] ?? value;
  const projectName = projectId ? data?.projects.find(project => project.id === projectId)?.name ?? projectId : undefined;
  const scan = ledger.scan;
  const running = scan?.state === 'running';
  // Two different silences: while history is still being read the tiles hold a placeholder, and only a finished read
  // with nothing in range may say there was no usage.
  const tiles = tilesState({ requests: summary?.requests ?? 0, loading: ledger.loading, scanning: running });
  const reading = tiles === 'reading';
  const placeholder = <span className="usage-skel" aria-hidden="true" />;
  const progressText = running
    ? scan?.phase === 'pricing' ? copy.pricing
      : scan?.provider ? (scan.filesFound > 0 ? copy.reading(providerName(scan.provider), scan.filesRead, scan.filesFound) : copy.readingUnknown(providerName(scan.provider)))
        : copy.busy
    : undefined;

  const bucketSplit = shares.map(item => {
    const label = item.key === 'cacheWrite5m' ? copy.buckets.cacheWrite : item.key === 'cacheWrite1h' ? `${copy.buckets.cacheWrite} (1h)` : item.key === 'cacheWriteUnknown' ? copy.buckets.cacheWrite : item.key === 'input' ? copy.buckets.input : item.key === 'cacheRead' ? copy.buckets.cacheRead : item.key === 'output' ? copy.buckets.output : copy.buckets.reasoning;
    return `${label} ${percentText(item.share, usageLocale)}`;
  }).join(' · ');
  const reasoningShare = summary && summary.tokens.total > 0 && summary.tokens.reasoning ? summary.tokens.reasoning / summary.tokens.total : 0;

  const tile = (label: string, value: ReactNode, sub: ReactNode, extra?: ReactNode) =>
    <div className="usage-tile"><span className="usage-tile-label">{label}</span><b className="usage-tile-value tnum">{value}</b><span className="usage-tile-sub">{sub}</span>{extra}</div>;

  return <section className="usage-page" aria-label={copy.title}>
    <header className="wb-panel-head usage-head">
      <strong>{copy.title}</strong>
      <div className="usage-seg" role="group" aria-label={copy.scope.label}>
        {(['all', 'threadterm', 'outside'] as UsageLedgerScope[]).map(value => <button key={value} type="button" className="usage-seg-item" aria-pressed={scope === value}
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
      {projectName && <button type="button" className="usage-chip" title={copy.clearProject} onClick={() => setProjectId(undefined)}>
        <span>{copy.projectFilter(projectName)}</span><Icon name="close" />
      </button>}
      <span className="usage-head-spacer" />
      <span className="usage-progress" role="status" aria-live="polite">
        {progressText}{running && <button type="button" className="btn btn-sm" onClick={ledger.cancel}>{copy.cancel}</button>}
        {!running && scan?.state === 'failed' && <span className="usage-error-inline">{copy.scanFailed}</span>}
      </span>
      <button type="button" className="icon-btn" aria-label={copy.refresh} title={copy.refresh} aria-busy={running} onClick={ledger.refresh}><WbIcon name="refresh" /></button>
    </header>
    <div className="usage-scroll">
      {ledger.error ? <p className="surface-error" role="alert">{copy.unavailable} {ledger.error}</p> : <>
          <div className="usage-tiles" aria-busy={reading || undefined}>
            {tile(copy.tiles.tokens,
              reading ? placeholder : hasUsage ? compactTokens(summary!.tokens.total, usageLocale) : copy.unknown,
              reading ? copy.readingHistory : hasUsage ? undefined : copy.noData,
              !reading && bucketSplit && <span className="usage-tile-extra" title={reasoningShare > 0 ? `${copy.buckets.reasoning} ${percentText(reasoningShare, usageLocale)}` : undefined}>{bucketSplit}</span>)}
            {tile(copy.tiles.cost,
              reading ? placeholder : hasUsage ? (summary?.pricingPending ? copy.tiles.pending : costText(summary!.cost.apiEquivalentUsd, usageLocale)) : copy.unknown,
              reading ? copy.readingHistory : hasUsage && coverage ? copy.tiles.priced(percentText(coverage.priced, usageLocale)) : undefined,
              !reading && summary?.cost.reportedUsd ? <span className="usage-tile-extra">{reportedCostText(summary.cost.reportedUsd, usageLocale)} {copy.tiles.reportedCost}</span> : undefined)}
            {tile(copy.tiles.requests,
              reading ? placeholder : hasUsage ? fullNumber(summary!.requests, usageLocale) : copy.unknown,
              reading ? copy.readingHistory : hasUsage ? copy.tiles.sessions(summary!.sessions) : copy.noData)}
            {tile(copy.tiles.activeTime,
              reading ? placeholder : hasUsage ? <>≈ <span className="usage-estimated" title={copy.tiles.estimatedMethod}>{activeTimeText(summary!.activeTimeMs, usageLocale)}</span></> : copy.unknown,
              reading ? copy.readingHistory : hasUsage ? copy.tiles.days(activeDays) : copy.noData)}
          </div>
          {hasUsage && <p className="usage-coverage">
            {evidence && <span>{copy.evidence.exact} {percentText(evidence.exact, usageLocale)}</span>}
            {evidence && evidence.derived > 0 && <span>{copy.evidence.derived} {percentText(evidence.derived, usageLocale)}</span>}
            {evidence && evidence.estimated > 0 && <span className="usage-estimated" title={copy.tiles.estimatedMethod}>≈ {percentText(evidence.estimated, usageLocale)}</span>}
            {sessionsWithoutUsage > 0 && <span>{copy.evidence.sessionsWithoutUsage(sessionsWithoutUsage)}</span>}
            {coverage && coverage.unpricedTokens > 0 && <span>{copy.evidence.unpriced(compactTokens(coverage.unpricedTokens, usageLocale))}</span>}
          </p>}
          {settings && !settings.includeOutside && <p className="usage-note">{copy.outsideDisabled}</p>}
          <UsageHeatmap
            series={ledger.heat}
            locale={usageLocale}
            copy={copy}
            weekStartPreference={settings?.weekStart ?? 'auto'}
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
          {/* UA2b mounts breakdowns, the sessions list, Sources and Settings here. */}
        </>}
    </div>
  </section>;
}
