// Number, money and coverage formatting for the Usage page. Rendering rules come from design.md §4: an estimated
// value carries `≈`, an unknown value is `—` with a reason, and an unpriced amount is never shown as $0.
import type { UsageLedgerCost, UsageLedgerQuality, UsageLedgerTokens } from '@threadterm/protocol';

export type UsageLocale = 'en' | 'zh-CN';

export const numberLocale = (locale: UsageLocale) => locale === 'zh-CN' ? 'zh-CN' : 'en-US';

/** Compact token totals: 1.24B, 820M, 12.4k. Values below 1000 stay exact. */
export function compactTokens(value: number, locale: UsageLocale): string {
  if (!Number.isFinite(value)) return '—';
  const format = new Intl.NumberFormat(numberLocale(locale), { notation: 'compact', maximumFractionDigits: value < 1000 ? 0 : 2 });
  return format.format(value);
}

export function fullNumber(value: number, locale: UsageLocale): string {
  return Number.isFinite(value) ? new Intl.NumberFormat(numberLocale(locale)).format(Math.round(value)) : '—';
}

/** API-equivalent money always reads as an estimate: `≈ $412`, `≈ $0.42`. */
export function costText(usd: number | null | undefined, locale: UsageLocale): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return '—';
  const format = new Intl.NumberFormat(numberLocale(locale), { style: 'currency', currency: 'USD', minimumFractionDigits: usd >= 100 ? 0 : 2, maximumFractionDigits: usd >= 100 ? 0 : 2 });
  return `≈ ${format.format(usd)}`;
}

/** A provider-recorded amount is never dressed up as an API-equivalent estimate. */
export function reportedCostText(usd: number | null | undefined, locale: UsageLocale): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) return null;
  return new Intl.NumberFormat(numberLocale(locale), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd);
}

/** Active time is a union of intervals, so it rounds to the unit that is still meaningful. */
export function activeTimeText(ms: number, locale: UsageLocale): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return locale === 'zh-CN' ? `${minutes} 分钟` : `${minutes} min`;
  const hours = ms / 3600000;
  const text = new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: hours < 10 ? 1 : 0 }).format(hours);
  return locale === 'zh-CN' ? `${text} 小时` : `${text} h`;
}

export function percentText(share: number | null | undefined, locale: UsageLocale): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return '—';
  const text = new Intl.NumberFormat(numberLocale(locale), { style: 'percent', maximumFractionDigits: share < 0.01 ? 2 : 1 }).format(share);
  return text;
}

export type TokenShare = { key: keyof UsageLedgerTokens; share: number };

/** Bucket shares of the known subtotal; reasoning is a subset of output and is never added again. */
export function tokenShares(tokens: UsageLedgerTokens): TokenShare[] {
  const total = tokens.total;
  const buckets: Array<keyof UsageLedgerTokens> = ['input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown', 'output'];
  if (total <= 0) return [];
  return buckets
    .map(key => ({ key, share: (tokens[key] ?? 0) / total }))
    .filter(item => item.share > 0);
}

/** `Exact 99.2% · ≈ 0.8%` — evidence shares, never a claim that every request reports every bucket. */
export function evidenceLine(quality: UsageLedgerQuality): { exact: number; derived: number; estimated: number } {
  return { exact: quality.exactShare, derived: quality.derivedShare, estimated: quality.estimatedShare };
}

export type CostCoverage = { priced: number; unpricedTokens: number; pricedTokens: number };

export function costCoverage(cost: UsageLedgerCost): CostCoverage {
  return { priced: cost.coverage, unpricedTokens: cost.unpricedTokens, pricedTokens: cost.pricedTokens };
}

/** Tunable thresholds behind the heatmap legend. */
export type HeatmapLevels = { thresholds: number[] };

/**
 * What the summary tiles may claim: while the first history read is still running they hold a placeholder, and only a
 * finished read with no usage in range is allowed to say "No usage".
 */
export type TilesState = 'reading' | 'empty' | 'ready';

export function tilesState(options: { requests: number; loading: boolean; scanning: boolean }): TilesState {
  if (options.requests > 0) return 'ready';
  return options.loading || options.scanning ? 'reading' : 'empty';
}

/** A day counts as used only when something was actually recorded; a zero fact is not a priced zero. */
export function dayHasUsage(point: {
  tokens: { total: number };
  requests: number;
  activeTimeMs: number;
  cost: { apiEquivalentUsd: number | null };
}): boolean {
  return point.tokens.total > 0 || point.requests > 0 || point.activeTimeMs > 0 || (point.cost.apiEquivalentUsd ?? 0) > 0;
}
