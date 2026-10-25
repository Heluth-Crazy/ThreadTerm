// The project overview deliberately uses the same inclusive/exclusive local-day range and all-usage scope as UsagePage.
// Keeping this projection pure makes the overview's compact tiles testable against the ledger fixture.
import type { UsageLedgerSeries, UsageLedgerSummary } from '@threadterm/protocol';
import { filtersOf, localDay, rangeFor, type UsageQuery } from './usageLedger';

export function overviewUsageQuery(projectId: string, today = localDay()): UsageQuery {
  return { ...rangeFor('7d', today), scope: 'all', projectId, includeOutside: true };
}

export function overviewUsageRequests(projectId: string, today = localDay()) {
  const filters = filtersOf(overviewUsageQuery(projectId, today));
  return {
    summary: { filters },
    series: { filters, granularity: 'day' as const, stack: 'tokens' as const },
  };
}

export type OverviewUsageMetrics = {
  todayTokens: number;
  todayCost: UsageLedgerSummary['cost'];
  weekTokens: number;
  weekCost: UsageLedgerSummary['cost'];
  series: number[];
};

/** The daily ledger series is zero-filled, so its matching local-day point is the source for today's compact tile. */
export function overviewUsageMetrics(summary: UsageLedgerSummary | undefined, series: UsageLedgerSeries | undefined, today = localDay()): OverviewUsageMetrics | undefined {
  if (!summary || !series) return undefined;
  const todayPoint = series.points.find(point => point.start === today);
  return {
    todayTokens: todayPoint?.tokens.total ?? 0,
    todayCost: todayPoint?.cost ?? { ...summary.cost, reportedUsd: null, apiEquivalentUsd: null, pricedTokens: 0, unpricedTokens: 0, reportedRequests: 0, pricedRequests: 0, coverage: 0 },
    weekTokens: summary.tokens.total,
    weekCost: summary.cost,
    series: series.points.map(point => point.tokens.total),
  };
}
