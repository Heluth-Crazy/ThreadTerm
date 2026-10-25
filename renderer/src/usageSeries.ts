// Series shaping for the Usage trend: stable colour slots per provider and folding the tail into "Other".
// Colour follows the entity, never its rank (dataviz rule), so a provider keeps its slot across filters.

export const PROVIDER_SLOT_ORDER = ['codex', 'claude', 'opencode', 'pi', 'kimi', 'grok', 'gemini'] as const;

/** Slot 1..8 from the fixed provider order; unknown providers fill the free slots in id order, so a filter never
 *  recolours a provider that is still visible. */
export function providerSlots(keys: readonly string[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const key of keys) {
    const known = PROVIDER_SLOT_ORDER.indexOf(key as typeof PROVIDER_SLOT_ORDER[number]);
    if (known >= 0) slots.set(key, known + 1);
  }
  const used = new Set(slots.values());
  const unknown = [...new Set(keys.filter(key => !slots.has(key)))].sort((left, right) => left.localeCompare(right, 'en'));
  let next = 1;
  for (const key of unknown) {
    while (used.has(next) && next < 8) next += 1;
    slots.set(key, next);
    used.add(next);
  }
  return slots;
}

export type TrendValue = { key: string; tokens: number; costUsd: number | null; activeTimeMs: number; requests: number };

/** Keeps at most `max` series (largest first) and sums the rest into one `other` value. */
export function foldSeries(values: readonly TrendValue[], max = 8): TrendValue[] {
  if (values.length <= max) return [...values];
  const ranked = [...values].sort((left, right) => right.tokens - left.tokens);
  const kept = ranked.slice(0, max - 1);
  const rest = ranked.slice(max - 1);
  const other: TrendValue = {
    key: 'other',
    tokens: rest.reduce((sum, value) => sum + value.tokens, 0),
    costUsd: rest.every(value => value.costUsd === null) ? null : rest.reduce((sum, value) => sum + (value.costUsd ?? 0), 0),
    activeTimeMs: rest.reduce((sum, value) => sum + value.activeTimeMs, 0),
    requests: rest.reduce((sum, value) => sum + value.requests, 0),
  };
  return [...kept, other];
}

/** Unique keys in a stable order so the legend does not reorder when a filter hides one provider. */
export function seriesKeys(points: ReadonlyArray<{ values: readonly TrendValue[] }>): string[] {
  const seen = new Set<string>();
  for (const point of points) for (const value of point.values) if (value.tokens > 0 || value.requests > 0) seen.add(value.key);
  return [...seen].sort((left, right) => {
    const leftRank = PROVIDER_SLOT_ORDER.indexOf(left as typeof PROVIDER_SLOT_ORDER[number]);
    const rightRank = PROVIDER_SLOT_ORDER.indexOf(right as typeof PROVIDER_SLOT_ORDER[number]);
    const leftKnown = leftRank >= 0, rightKnown = rightRank >= 0;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown) return leftRank - rightRank;
    return left.localeCompare(right, 'en');
  });
}

export type StackSegment = { key: string; slot: number; value: number };

/** Column heights as shares of one y-axis; values are already in the chosen metric. */
export type TrendColumn = { start: string; end: string; total: number; segments: StackSegment[] };

export function stackedColumns(
  points: ReadonlyArray<{ start: string; end: string; values: readonly TrendValue[] }>,
  metric: 'tokens' | 'cost' | 'active',
  max = 8,
): TrendColumn[] {
  const pick = (value: TrendValue) => metric === 'tokens' ? value.tokens : metric === 'cost' ? (value.costUsd ?? 0) : value.activeTimeMs;
  const slots = providerSlots(seriesKeys(points));
  return points.map(point => {
    const values = point.values.filter(value => pick(value) > 0);
    const folded = foldSeries(values.map(value => ({ ...value, tokens: pick(value) })), max);
    const segments = folded
      .filter(value => value.tokens > 0)
      .map(value => ({ key: value.key, slot: value.key === 'other' ? 8 : (slots.get(value.key) ?? 8), value: value.tokens }))
      .sort((left, right) => left.slot - right.slot);
    return { start: point.start, end: point.end, total: segments.reduce((sum, segment) => sum + segment.value, 0), segments };
  });
}

export type AxisLabel = { index: number; label: string; align?: 'start' | 'end' };

/**
 * Keeps x-axis labels from colliding: walks the candidates left to right, drops any whose measured text would touch the
 * previous one, and always reserves room for the last candidate (the latest period). `pitch` is the width of one band.
 */
export function thinLabels(
  candidates: readonly AxisLabel[],
  pitch: number,
  widthOf: (label: string) => number,
  gap = 8,
): AxisLabel[] {
  if (!candidates.length || !Number.isFinite(pitch) || pitch <= 0) return [];
  const last = candidates.at(-1)!;
  const rect = (candidate: AxisLabel, first: boolean) => {
    const width = widthOf(candidate.label);
    const left = candidate === last && candidate.index > 0 ? (candidate.index + 1) * pitch - width
      : first ? candidate.index * pitch : candidate.index * pitch + pitch / 2 - width / 2;
    return { left, right: left + width };
  };
  const lastLeft = rect(last, false).left;
  const kept: AxisLabel[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const box = rect(candidate, kept.length === 0);
    if (box.left < right + gap) continue;
    if (candidate !== last && box.right + gap > lastLeft) continue;
    kept.push(candidate);
    right = box.right;
  }
  if (kept.at(-1) !== last) {
    while (kept.length && rect(kept.at(-1)!, kept.length === 1).right + gap > lastLeft) kept.pop();
    kept.push(last);
  }
  return kept.map((tick, index) => index === kept.length - 1 && tick.index > 0 ? { ...tick, align: 'end' } : index === 0 ? { ...tick, align: 'start' } : tick);
}

/** Rounded axis ticks: 0 up to the first rounded step at or above the tallest column. */
export function axisTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(multiplier => multiplier * magnitude).find(candidate => candidate >= rough) ?? rough;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step * 0.001; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return ticks;
}

/** Token-type stacks keep the same fixed colour order as the provider slots. */
export const TOKEN_SLOT_ORDER = ["input", "cacheRead", "cacheWrite5m", "cacheWrite1h", "cacheWriteUnknown", "output"] as const;

export function tokenSlots(keys: readonly string[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const key of keys) {
    const index = TOKEN_SLOT_ORDER.indexOf(key as typeof TOKEN_SLOT_ORDER[number]);
    slots.set(key, index >= 0 ? index + 1 : 8);
  }
  return slots;
}
