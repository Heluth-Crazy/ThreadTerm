// Calendar-grid maths for the yearly heatmap. Days are local calendar days (`YYYY-MM-DD`); arithmetic runs on UTC
// midnights so daylight saving never shifts a cell into the neighbouring column.

export type WeekStart = 'monday' | 'sunday';

const DAY_MS = 86_400_000;

export function isLocalDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayIndex(value));
}

/** Days since 1970-01-01 for a local calendar day. */
export function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

export function fromIndex(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  return fromIndex(dayIndex(day) + delta);
}

/** 0 = first column of the week (Monday or Sunday by preference). */
export function weekdayOffset(day: string, weekStartsOn: WeekStart): number {
  const sundayFirst = new Date(dayIndex(day) * DAY_MS).getUTCDay();
  return weekStartsOn === 'monday' ? (sundayFirst + 6) % 7 : sundayFirst;
}

export function weekStartFor(day: string, weekStartsOn: WeekStart): string {
  return addDays(day, -weekdayOffset(day, weekStartsOn));
}

/** Locale default from design §3.6: Monday for zh-CN, Sunday for en; the saved setting wins. */
export function resolveWeekStart(preference: 'auto' | 'monday' | 'sunday', locale: 'en' | 'zh-CN'): WeekStart {
  if (preference === 'monday' || preference === 'sunday') return preference;
  return locale === 'zh-CN' ? 'monday' : 'sunday';
}

/** Steps are quantiles of the non-zero days, so one huge day cannot wash out the normal ones. */
export function quantileThresholds(values: readonly number[], steps = 4): number[] {
  const nonZero = values.filter(value => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  if (!nonZero.length || steps < 1) return [];
  const thresholds: number[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const position = (nonZero.length - 1) * step / (steps + 1);
    const low = Math.floor(position);
    const high = Math.min(nonZero.length - 1, low + 1);
    const value = nonZero[low]! + (nonZero[high]! - nonZero[low]!) * (position - low);
    if (!thresholds.length || value > thresholds.at(-1)!) thresholds.push(value);
  }
  return thresholds;
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function heatLevel(value: number, thresholds: readonly number[]): HeatLevel {
  if (!Number.isFinite(value) || value <= 0 || !thresholds.length) return 0;
  let level = 1;
  while (level < 4 && value > thresholds[Math.min(level, thresholds.length - 1)]!) level += 1;
  return level as HeatLevel;
}

export type HeatmapInput = ReadonlyMap<string, number>;

export type HeatmapGrid = {
  /** Column-major weeks; each column has 7 cells (6 while the first or last week is partial). */
  columns: Array<Array<{ day: string; value: number } | null>>;
  /** Month labels above the grid, at the column where the month changes. */
  months: Array<{ column: number; month: number }>;
  weekStartsOn: WeekStart;
};

/**
 * Builds a GitHub-style grid from `from` to `to` (both included). Leading and trailing cells outside the range are
 * null so that the last column always holds the newest day (today).
 */
export function buildHeatmap(values: HeatmapInput, options: { from: string; to: string; weekStartsOn: WeekStart }): HeatmapGrid {
  const { from, to, weekStartsOn } = options;
  if (!isLocalDay(from) || !isLocalDay(to) || dayIndex(from) > dayIndex(to)) return { columns: [], months: [], weekStartsOn };
  const start = weekStartFor(from, weekStartsOn);
  const endIndex = dayIndex(to);
  const columns: HeatmapGrid['columns'] = [];
  const months: HeatmapGrid['months'] = [];
  let lastMonth = -1;
  for (let index = dayIndex(start); index <= endIndex; index += 7) {
    const column: HeatmapGrid['columns'][number] = [];
    let firstInRange: string | undefined;
    for (let row = 0; row < 7; row += 1) {
      const dayIndexValue = index + row;
      if (dayIndexValue > endIndex) { column.push(null); continue; }
      const day = fromIndex(dayIndexValue);
      if (dayIndexValue < dayIndex(from)) { column.push(null); continue; }
      firstInRange ??= day;
      column.push({ day, value: values.get(day) ?? 0 });
    }
    const columnIndex = columns.length;
    if (firstInRange) {
      const month = Number(firstInRange.slice(5, 7)) - 1;
      if (month !== lastMonth) { months.push({ column: columnIndex, month }); lastMonth = month; }
    }
    columns.push(column);
  }
  return { columns, months, weekStartsOn };
}

/** CSS grid row of a cell (1 = first row of the week). */
export function gridRow(day: string, weekStartsOn: WeekStart): number {
  return weekdayOffset(day, weekStartsOn) + 1;
}

/**
 * Month labels above the grid. A leading partial month with fewer than `minSpan` columns is dropped (as GitHub does),
 * and any label that would run into its left neighbour is skipped using measured text widths rather than a guess.
 */
export function visibleMonthLabels(
  months: ReadonlyArray<{ column: number; text: string }>,
  options: { columns: number; pitch: number; widthOf: (text: string) => number; gap?: number; minSpan?: number },
): Array<{ column: number; text: string }> {
  const { columns, pitch, widthOf, gap = 4, minSpan = 3 } = options;
  if (!months.length || !Number.isFinite(pitch) || pitch <= 0) return [];
  const kept: Array<{ column: number; text: string }> = [];
  let right = Number.NEGATIVE_INFINITY;
  months.forEach((month, index) => {
    const span = (months[index + 1]?.column ?? columns) - month.column;
    if (index === 0 && span < minSpan) return;
    const left = month.column * pitch;
    const width = widthOf(month.text);
    if (left < right + gap || left + width > columns * pitch) return;
    kept.push(month);
    right = left + width;
  });
  return kept;
}
