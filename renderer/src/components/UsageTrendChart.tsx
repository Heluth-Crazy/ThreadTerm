import { useCallback, useMemo, useRef, useState } from 'react';
import type { UsageLedgerSeries } from '@threadterm/protocol';
import { axisTicks, providerSlots, stackedColumns, thinLabels, tokenSlots, type AxisLabel, type TrendColumn } from '../usageSeries';
import { compactTokens, fullNumber, type UsageLocale } from '../usageFormat';
import { labelWidth } from '../usageTextMetrics';
import type { UsageCopy } from '../usageCopy';

type Props = {
  series: UsageLedgerSeries | undefined;
  stack: 'provider' | 'tokens';
  locale: UsageLocale;
  copy: UsageCopy;
  /** The first history read is still running: an empty chart must not claim there was no usage. */
  reading?: boolean;
  providerName: (id: string) => string;
  onToggleStack: (stack: 'provider' | 'tokens') => void;
  onGranularity: (value: 'day' | 'week' | 'month') => void;
};

const labelLocale = (locale: UsageLocale) => locale === 'zh-CN' ? 'zh-CN' : 'en-US';

/** Token-type keys become local words; provider ids keep their display name. */
function seriesLabel(key: string, stack: 'provider' | 'tokens', copy: UsageCopy, providerName: (id: string) => string): string {
  if (key === 'other') return copy.trend.other;
  if (stack === 'provider') return providerName(key);
  if (key === 'cacheWrite5m') return `${copy.buckets.cacheWrite} (5m)`;
  if (key === 'cacheWrite1h') return `${copy.buckets.cacheWrite} (1h)`;
  if (key === 'cacheWriteUnknown') return copy.buckets.cacheWrite;
  return (copy.buckets as Record<string, string>)[key] ?? key;
}

function periodLabel(column: TrendColumn, locale: UsageLocale, granularity: 'day' | 'week' | 'month'): string {
  const start = new Date(`${column.start}T00:00:00Z`);
  if (granularity === 'month') return new Intl.DateTimeFormat(labelLocale(locale), { year: 'numeric', month: 'short', timeZone: 'UTC' }).format(start);
  const format = new Intl.DateTimeFormat(labelLocale(locale), { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return granularity === 'day' ? format.format(start) : `${format.format(start)} – ${format.format(new Date(`${column.end}T00:00:00Z`))}`;
}

/** X-axis labels: a day or a week start date, or the month name — never the full tooltip label. */
function axisLabel(column: TrendColumn, locale: UsageLocale, granularity: 'day' | 'week' | 'month'): string {
  const start = new Date(`${column.start}T00:00:00Z`);
  const format = new Intl.DateTimeFormat(labelLocale(locale), granularity === 'month'
    ? { month: 'short', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return format.format(start);
}

export function UsageTrendChart({ series, stack, locale, copy, reading, providerName, onToggleStack, onGranularity }: Props) {
  const [tableOpen, setTableOpen] = useState(false);
  const [tip, setTip] = useState<{ column: number; x: number; y: number }>();
  const host = useRef<HTMLDivElement>(null);
  const resizeObserver = useRef<ResizeObserver>(undefined);
  const [plotWidth, setPlotWidth] = useState(0);
  const granularity = series?.granularity ?? 'day';
  const points = series?.points ?? [];
  const columns = useMemo(() => stackedColumns(points, 'tokens'), [points]);
  const max = Math.max(0, ...columns.map(column => column.total));
  const ticks = axisTicks(max);
  const yMax = ticks.at(-1) ?? max;
  const keys = useMemo(() => [...new Set(columns.flatMap(column => column.segments.map(segment => segment.key)))], [columns]);
  const slots = stack === 'provider' ? providerSlots(keys.filter(key => key !== 'other')) : tokenSlots(keys);
  const slotOf = (key: string) => key === 'other' ? 8 : slots.get(key) ?? 8;
  const totals = new Map<string, number>();
  for (const column of columns) for (const segment of column.segments) totals.set(segment.key, (totals.get(segment.key) ?? 0) + segment.value);
  const legend = keys.length >= 2 ? [...totals.entries()].sort((left, right) => right[1] - left[1]) : [];
  const heightOf = (value: number) => yMax > 0 ? `${(value / yMax) * 100}%` : '0%';
  // One direct label carries the tallest column's total (the axis scale is the other half of the reading); the legend
  // and tooltip carry the rest.
  const directColumn = columns.reduce<TrendColumn | undefined>((best, column) => !best || column.total > best.total ? column : best, undefined);

  // Bands spread across the whole plot, so thinning needs the real band pitch. The chart only exists once there are
  // columns, so the width is measured when its node appears and re-measured on resize (no timers, no polling).
  const measurePlot = useCallback((node: HTMLDivElement | null) => {
    resizeObserver.current?.disconnect();
    resizeObserver.current = undefined;
    if (!node) return;
    const measure = () => setPlotWidth(node.clientWidth);
    measure();
    resizeObserver.current = new ResizeObserver(measure);
    resizeObserver.current.observe(node);
  }, []);

  // Day charts label every seventh day; week and month charts label every band and let the thinner drop collisions.
  const candidates = useMemo<AxisLabel[]>(() => columns.flatMap((column, index) => {
    if (granularity === 'day' && index % 7 !== 0 && index !== columns.length - 1) return [];
    return [{ index, label: axisLabel(column, locale, granularity) }];
  }), [columns, granularity, locale]);
  const pitch = columns.length > 0 ? plotWidth / columns.length : 0;
  const xTicks = useMemo(() => thinLabels(candidates, pitch, label => labelWidth(label)), [candidates, pitch]);
  const xLabels = new Map(xTicks.map(tick => [tick.index, tick.label]));

  const showTip = (index: number, element: HTMLElement) => {
    const box = element.getBoundingClientRect(), origin = host.current?.getBoundingClientRect();
    if (!origin) return;
    setTip({ column: index, x: box.left - origin.left + box.width / 2, y: box.top - origin.top });
  };

  const columnLabel = (column: TrendColumn) => `${periodLabel(column, locale, granularity)} — ${copy.trend.total} ${compactTokens(column.total, locale)}`;

  return <section className="usage-trend" aria-label={copy.trend.title}>
    <header className="usage-section-head">
      <h2>{copy.trend.title}</h2>
      <div className="usage-seg" role="group" aria-label={copy.trend.granularity}>
        {(['day', 'week', 'month'] as const).map(value => <button key={value} type="button" className="usage-seg-item" aria-pressed={granularity === value} onClick={() => onGranularity(value)}>
          {copy.trend[value]}
        </button>)}
      </div>
      <div className="usage-seg" role="group" aria-label={copy.trend.stack}>
        {(['provider', 'tokens'] as const).map(value => <button key={value} type="button" className="usage-seg-item" aria-pressed={stack === value} onClick={() => onToggleStack(value)}>
          {value === 'provider' ? copy.trend.provider : copy.trend.tokens}
        </button>)}
      </div>
      <div className="usage-legend usage-legend-trend">
        {legend.map(([key, total]) => <span key={key}><i className={`usage-swatch sv-${slotOf(key)}`} aria-hidden="true" />{seriesLabel(key, stack, copy, providerName)}<em>{compactTokens(total, locale)}</em></span>)}
      </div>
      <button type="button" className="btn btn-ghost usage-table-toggle" aria-pressed={tableOpen} onClick={() => setTableOpen(value => !value)}>
        {tableOpen ? copy.trend.asChart : copy.trend.asTable}
      </button>
    </header>
    {points.length === 0 || max <= 0
      ? <p className="usage-empty">{reading ? copy.readingHistory : copy.trend.empty}</p>
      : tableOpen ? <div className="usage-table-wrap">
        <table className="usage-table">
          <caption>{copy.trend.tableCaption}</caption>
          <thead><tr><th scope="col">{copy.trend.period}</th>{keys.map(key => <th key={key} scope="col">{seriesLabel(key, stack, copy, providerName)}</th>)}<th scope="col">{copy.trend.total}</th></tr></thead>
          <tbody>{columns.map(column => <tr key={column.start}>
            <th scope="row">{periodLabel(column, locale, granularity)}</th>
            {keys.map(key => <td key={key}>{fullNumber(column.segments.find(segment => segment.key === key)?.value ?? 0, locale)}</td>)}
            <td>{fullNumber(column.total, locale)}</td>
          </tr>)}</tbody>
        </table>
      </div> : <div className="usage-chart" ref={host} onMouseLeave={() => setTip(undefined)}>
        <div className="usage-chart-axis" aria-hidden="true">
          {[...ticks].reverse().map(tick => <span key={tick}>{compactTokens(tick, locale)}</span>)}
        </div>
        <div className="usage-chart-main">
          <div className="usage-chart-plot" ref={measurePlot} role="img" aria-label={copy.trend.tableCaption}>
            <div className="usage-chart-grid" aria-hidden="true">
              {[...ticks].reverse().map(tick => <i key={tick} />)}
            </div>
            <div className="usage-chart-columns">
              {columns.map((column, index) => <button
                key={column.start}
                type="button"
                className={`usage-chart-col${tip?.column === index ? ' is-active' : ''}`}
                aria-label={columnLabel(column)}
                onMouseEnter={event => showTip(index, event.currentTarget)}
                onFocus={event => showTip(index, event.currentTarget)}
                onBlur={() => setTip(undefined)}
              >
                <span className="usage-chart-stack">
                  {column.segments.map((segment, segmentIndex) => <i
                    key={segment.key}
                    className={`usage-chart-seg sv-${slotOf(segment.key)}${segmentIndex === column.segments.length - 1 ? ' is-top' : ''}`}
                    style={{ height: heightOf(segment.value) }}
                  />)}
                </span>
                {directColumn === column && column.total > 0 && <span className="usage-chart-direct" style={{ bottom: `calc(${heightOf(column.total)} + 2px)` }}>{compactTokens(column.total, locale)}</span>}
              </button>)}
            </div>
          </div>
          <div className="usage-chart-xaxis" aria-hidden="true">
            {columns.map((column, index) => <span key={column.start}>{xLabels.get(index) ?? ''}</span>)}
          </div>
        </div>
        {tip && <div className="usage-tip usage-tip-chart" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          <b>{periodLabel(columns[tip.column]!, locale, granularity)}</b>
          {columns[tip.column]!.segments.length === 0
            ? <span>{copy.trend.empty}</span>
            : [...columns[tip.column]!.segments].reverse().map(segment => <span key={segment.key}><i className={`usage-swatch sv-${slotOf(segment.key)}`} aria-hidden="true" />{seriesLabel(segment.key, stack, copy, providerName)}<em>{compactTokens(segment.value, locale)}</em></span>)}
          <span className="usage-tip-total">{copy.trend.total}<em>{compactTokens(columns[tip.column]!.total, locale)}</em></span>
        </div>}
      </div>}
  </section>;
}
