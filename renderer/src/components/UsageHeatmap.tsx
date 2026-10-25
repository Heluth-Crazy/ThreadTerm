import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UsageLedgerSeries, UsageLedgerSeriesPoint } from '@threadterm/protocol';
import {
  addDays, buildHeatmap, dayIndex, heatLevel, isLocalDay, quantileThresholds, resolveWeekStart, visibleMonthLabels,
} from '../usageHeatmap';
import { activeTimeText, compactTokens, costText, dayHasUsage, fullNumber, numberLocale, type UsageLocale } from '../usageFormat';
import { labelWidth } from '../usageTextMetrics';
import type { UsageCopy } from '../usageCopy';
import { AgentIcon } from './PrototypeIcon';

export type HeatMetric = 'tokens' | 'cost' | 'active';

/** Level 0 is an empty day; 1-4 come from the quantile thresholds. */
const LEVEL_CLASS = ['is-empty', 'is-1', 'is-2', 'is-3', 'is-4'] as const;
/** Cells scale with the card so a year fits at 1280 px; very wide cards keep a readable cell and stay left-aligned. */
const CELL_MIN = 10;
const CELL_MAX = 16;
const CELL_GAP = 2;

type Props = {
  series: UsageLedgerSeries | undefined;
  locale: UsageLocale;
  copy: UsageCopy;
  weekStartPreference: 'auto' | 'monday' | 'sunday';
  providerName: (id: string) => string;
  onSelectDay: (day: string) => void;
  from: string;
  to: string;
};

function metricValue(point: UsageLedgerSeriesPoint | undefined, metric: HeatMetric): number {
  if (!point) return 0;
  return metric === 'tokens' ? point.tokens.total : metric === 'cost' ? point.cost.apiEquivalentUsd ?? 0 : point.activeTimeMs;
}

function metricText(value: number, metric: HeatMetric, locale: UsageLocale): string {
  return metric === 'tokens' ? `${compactTokens(value, locale)} ${locale === 'zh-CN' ? 'token' : 'tokens'}`
    : metric === 'cost' ? costText(value, locale) : activeTimeText(value, locale);
}

export function UsageHeatmap({ series, locale, copy, weekStartPreference, providerName, onSelectDay, from, to }: Props) {
  const [metric, setMetric] = useState<HeatMetric>('tokens');
  const [tableOpen, setTableOpen] = useState(false);
  const [tip, setTip] = useState<{ day: string; x: number; y: number; below: boolean }>();
  const [focusDay, setFocusDay] = useState<string>(() => localTodayClamped(from, to));
  const [cell, setCell] = useState(11);
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const weekStartsOn = resolveWeekStart(weekStartPreference, locale);
  const points = useMemo(() => new Map((series?.points ?? []).map(point => [point.start, point])), [series]);
  const valueFor = (day: string) => metricValue(points.get(day), metric);
  const grid = useMemo(() => buildHeatmap(new Map([...points.keys()].map(day => [day, valueFor(day)])), {
    from, to, weekStartsOn,
  }), [points, from, to, weekStartsOn, metric]);
  const thresholds = useMemo(() => quantileThresholds([...points.keys()].map(day => valueFor(day))), [points, metric]);
  const legendNumbers = thresholds.map(value => metricText(value, metric, locale));
  const pitch = cell + CELL_GAP;
  // The design labels Mon/Wed/Fri; a Sunday-first week moves them one row down.
  const weekdayLabels = Array.from({ length: 7 }, (_, row) => {
    const mondayFirstRow = weekStartsOn === 'monday' ? row + 1 : row === 0 ? 7 : row;
    return mondayFirstRow === 1 ? copy.heatmap.weekdays[0]! : mondayFirstRow === 3 ? copy.heatmap.weekdays[2]! : mondayFirstRow === 5 ? copy.heatmap.weekdays[4]! : '';
  });
  const monthLabels = useMemo(() => visibleMonthLabels(
    grid.months.map(month => ({ column: month.column, text: copy.heatmap.monthNames[month.month] ?? '' })),
    { columns: grid.columns.length, pitch, widthOf: label => labelWidth(label) },
  ), [grid.months, grid.columns.length, pitch, copy]);
  const shownMonths = new Set(monthLabels.map(month => month.column));

  // Cells fill the card at 1280 and shrink to 10 px before the grid starts scrolling (narrow windows, design §5).
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || tableOpen || grid.columns.length === 0) return;
    const measure = () => {
      const width = node.clientWidth;
      if (!width) return;
      const fit = (width - CELL_GAP * (grid.columns.length - 1)) / grid.columns.length;
      const next = Math.min(CELL_MAX, Math.max(CELL_MIN, Math.round(fit * 100) / 100));
      setCell(current => current === next ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [grid.columns.length, tableOpen]);

  // Today stays in view: a grid wider than its box opens scrolled to the newest end.
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const end = node.scrollWidth - node.clientWidth;
    if (end > 0) node.scrollLeft = end;
  }, [cell, grid.columns.length, from, to, tableOpen]);

  const move = (day: string, delta: number) => addDays(day, delta);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches('[data-heat-day]')) return;
    const current = target.dataset.heatDay!;
    let next: string | undefined;
    if (event.key === 'ArrowLeft') next = move(current, -7);
    else if (event.key === 'ArrowRight') next = move(current, 7);
    else if (event.key === 'ArrowUp') next = move(current, -1);
    else if (event.key === 'ArrowDown') next = move(current, 1);
    else if (event.key === 'Home') next = from;
    else if (event.key === 'End') next = to;
    if (!next) return;
    event.preventDefault();
    const clamped = dayIndex(next) < dayIndex(from) ? from : dayIndex(next) > dayIndex(to) ? to : next;
    setFocusDay(clamped);
    requestAnimationFrame(() => host.current?.querySelector<HTMLElement>(`[data-heat-day="${clamped}"]`)?.focus());
  };

  const showTip = (day: string, element: HTMLElement) => {
    const box = element.getBoundingClientRect(), origin = host.current?.getBoundingClientRect();
    if (!origin) return;
    // Cells in the first rows flip the tooltip below themselves so it never covers the card header.
    const below = box.top - origin.top < 140;
    setTip({ day, x: box.left - origin.left + box.width / 2, y: box.top - origin.top + (below ? box.height : 0), below });
  };

  const dayLabel = (day: string) => {
    const point = points.get(day);
    const text = point && dayHasUsage(point) ? metricText(metricValue(point, metric), metric, locale) : copy.heatmap.emptyDay;
    return copy.heatmap.dayLabel(formatDay(day, locale), text);
  };

  const rows = [...points.values()].filter(point => metricValue(point, metric) > 0).sort((left, right) => right.start.localeCompare(left.start));

  return <section className="usage-heat" aria-label={copy.heatmap.title}>
    <header className="usage-section-head">
      <h2>{copy.heatmap.title}</h2>
      <div className="usage-seg" role="group" aria-label={copy.heatmap.metric}>
        {(['tokens', 'cost', 'active'] as HeatMetric[]).map(value => <button key={value} type="button" className="usage-seg-item" aria-pressed={metric === value}
          title={value === 'cost' ? copy.heatmap.costHint : undefined}
          onClick={() => setMetric(value)}>
          {value === 'tokens' ? copy.heatmap.tokens : value === 'cost' ? copy.heatmap.cost : copy.heatmap.activeTime}
        </button>)}
      </div>
      <button type="button" className="btn btn-ghost usage-table-toggle" aria-pressed={tableOpen} onClick={() => setTableOpen(value => !value)}>
        {tableOpen ? copy.heatmap.asChart : copy.heatmap.asTable}
      </button>
    </header>
    {tableOpen ? <div className="usage-table-wrap">
      <table className="usage-table">
        <caption>{copy.heatmap.tableCaption}</caption>
        <thead><tr><th scope="col">{copy.heatmap.date}</th><th scope="col">{copy.heatmap.value}</th><th scope="col">{copy.heatmap.tokens}</th><th scope="col">{copy.heatmap.cost}</th></tr></thead>
        <tbody>{rows.slice(0, 400).map(point => <tr key={point.start}>
          <th scope="row">{formatDay(point.start, locale)}</th>
          <td>{metricText(metricValue(point, metric), metric, locale)}</td>
          <td>{fullNumber(point.tokens.total, locale)}</td>
          <td>{point.cost.apiEquivalentUsd === null ? copy.unknown : costText(point.cost.apiEquivalentUsd, locale)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <div className="usage-heat-body" ref={host} style={{ '--heat-cell': `${cell}px` } as React.CSSProperties}>
      <div className="usage-heat-weekdays" aria-hidden="true">
        {weekdayLabels.map((label, row) => <span key={row}>{label}</span>)}
      </div>
      <div className="usage-heat-scroll" ref={scroll}>
        <div className="usage-heat-inner">
          <div className="usage-heat-months" style={{ gridTemplateColumns: `repeat(${grid.columns.length}, ${cell}px)` }} aria-hidden="true">
            {grid.months.map(month => <span key={month.column} style={{ gridColumnStart: month.column + 1 }}>
              {shownMonths.has(month.column) ? copy.heatmap.monthNames[month.month] : ''}
            </span>)}
          </div>
          <div className="usage-heat-grid" role="grid" aria-label={copy.heatmap.tableCaption} style={{ gridTemplateColumns: `repeat(${grid.columns.length}, ${cell}px)`, gridTemplateRows: `repeat(7, ${cell}px)` }} onKeyDown={onKeyDown} onMouseLeave={() => setTip(undefined)}>
            {grid.columns.map((column, columnIndex) => column.map((cellValue, row) => cellValue
              ? <button
                key={cellValue.day}
                type="button"
                role="gridcell"
                data-heat-day={cellValue.day}
                className={`usage-heat-cell ${LEVEL_CLASS[heatLevel(cellValue.value, thresholds)]}`}
                style={{ gridColumn: columnIndex + 1, gridRow: row + 1 }}
                tabIndex={cellValue.day === focusDay ? 0 : -1}
                aria-label={dayLabel(cellValue.day)}
                title={dayLabel(cellValue.day)}
                onMouseEnter={event => showTip(cellValue.day, event.currentTarget)}
                onFocus={event => showTip(cellValue.day, event.currentTarget)}
                onBlur={() => setTip(undefined)}
                onClick={() => onSelectDay(cellValue.day)}
              />
              : <span key={`${columnIndex}-${row}`} className="usage-heat-cell is-pad" style={{ gridColumn: columnIndex + 1, gridRow: row + 1 }} aria-hidden="true" />))}
          </div>
          <div className="usage-heat-foot">
            <span className="usage-legend" title={copy.heatmap.legendLevels(legendNumbers)}>
              <span>{copy.heatmap.less}</span>
              {[0, 1, 2, 3, 4].map(level => <i key={level} className={`usage-swatch seq-${level}`} aria-hidden="true" />)}
              <span>{copy.heatmap.more}</span>
            </span>
          </div>
        </div>
      </div>
      {tip && <HeatTooltip day={tip.day} point={points.get(tip.day)} locale={locale} copy={copy} providerName={providerName} x={tip.x} y={tip.y} below={tip.below} />}
    </div>}
  </section>;
}

function HeatTooltip({ day, point, locale, copy, providerName, x, y, below }: {
  day: string; point: UsageLedgerSeriesPoint | undefined; locale: UsageLocale; copy: UsageCopy;
  providerName: (id: string) => string; x: number; y: number; below: boolean;
}) {
  const used = point !== undefined && dayHasUsage(point);
  const sources = (point?.values ?? []).filter(value => value.tokens > 0 || value.requests > 0);
  const cost = point?.cost.apiEquivalentUsd;
  return <div className={`usage-tip${below ? ' is-below' : ''}`} role="tooltip" style={{ left: x, top: y }}>
    <b>{copy.heatmap.tooltipTitle(formatDay(day, locale))}</b>
    {point && used ? <>
      <span>{copy.heatmap.tokenTotal(fullNumber(point.tokens.total, locale))}</span>
      <span className="usage-tip-buckets">{bucketLine(point, locale, copy)}</span>
      <span>{cost === null || cost === undefined ? `${copy.heatmap.costLine(copy.unknown)}` : copy.heatmap.costLine(costText(cost, locale))}</span>
      <span>{copy.heatmap.activeLine(activeTimeText(point.activeTimeMs, locale))}</span>
      <span>{copy.heatmap.requestsLine(point.requests)}</span>
      {sources.length > 0 && <span className="usage-tip-sources">{sources.map(value => <i key={value.key}><AgentIcon provider={value.key} />{providerName(value.key)}</i>)}</span>}
    </> : <span>{copy.heatmap.emptyDay}</span>}
  </div>;
}

function bucketLine(point: UsageLedgerSeriesPoint, locale: UsageLocale, copy: UsageCopy): string {
  const tokens = point.tokens;
  const parts: Array<[string, number | null]> = [
    [copy.buckets.input, tokens.input],
    [copy.buckets.cacheRead, tokens.cacheRead],
    [copy.buckets.cacheWrite, (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0) + (tokens.cacheWriteUnknown ?? 0) || null],
    [copy.buckets.output, tokens.output],
    [copy.buckets.reasoning, tokens.reasoning],
  ];
  return parts.filter(([, value]) => value !== null && value > 0).map(([label, value]) => `${label} ${compactTokens(value!, locale)}`).join(' · ');
}

function formatDay(day: string, locale: UsageLocale): string {
  if (!isLocalDay(day)) return day;
  return new Intl.DateTimeFormat(numberLocale(locale), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

function localTodayClamped(from: string, to: string): string {
  const today = new Date();
  const value = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
  return dayIndex(value) < dayIndex(from) ? from : dayIndex(value) > dayIndex(addDays(to, -1)) ? addDays(to, -1) : value;
}
