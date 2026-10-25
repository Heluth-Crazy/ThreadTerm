import assert from 'node:assert/strict';
import test from 'node:test';
import type { UsageLedgerSeries, UsageLedgerSummary } from '@threadterm/protocol';
import { overviewUsageMetrics, overviewUsageQuery, overviewUsageRequests } from './usageOverview';

const cost = { reportedUsd: null, apiEquivalentUsd: 4.5, pricedTokens: 450, unpricedTokens: 50, reportedRequests: 3, pricedRequests: 3, coverage: 0.9 };
const tokens = (total: number) => ({ total, input: total, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, output: 0, reasoning: 0 });
const aggregate = { tokens: tokens(0), cost, requests: 0, sessions: 0, activeTimeMs: 0, activeTimeEstimated: false, quality: { exactRequests: 0, derivedRequests: 0, estimatedRequests: 0, exactTokens: 0, derivedTokens: 0, estimatedTokens: 0, exactShare: 0, derivedShare: 0, estimatedShare: 0 }, bucketCoverage: { input: { reportedRequests: 0, requests: 0 }, cacheRead: { reportedRequests: 0, requests: 0 }, cacheWrite5m: { reportedRequests: 0, requests: 0 }, cacheWrite1h: { reportedRequests: 0, requests: 0 }, cacheWriteUnknown: { reportedRequests: 0, requests: 0 }, output: { reportedRequests: 0, requests: 0 }, reasoning: { reportedRequests: 0, requests: 0 } }, pricingPending: false };

test('overview asks the ledger for the same all-scope, project-filtered local seven-day window as UsagePage', () => {
  assert.deepEqual(overviewUsageQuery('project-fixture', '2026-10-25'), { from: '2026-10-19', to: '2026-10-26', scope: 'all', projectId: 'project-fixture', includeOutside: true });
  assert.deepEqual(overviewUsageRequests('project-fixture', '2026-10-25'), {
    summary: { filters: { from: '2026-10-19', to: '2026-10-26', scope: 'all', includeOutside: true, projectId: 'project-fixture' } },
    series: { filters: { from: '2026-10-19', to: '2026-10-26', scope: 'all', includeOutside: true, projectId: 'project-fixture' }, granularity: 'day', stack: 'tokens' },
  });
});

test('overview metrics agree with the ledger summary and its zero-filled daily fixture', () => {
  const summary = { ...aggregate, tokens: tokens(500), from: '2026-10-19', to: '2026-10-26', scope: 'all', sessionsWithoutUsage: 0 } satisfies UsageLedgerSummary;
  const series = { from: '2026-10-19', to: '2026-10-26', granularity: 'day', stack: 'tokens', points: [
    { ...aggregate, tokens: tokens(100), start: '2026-10-23', end: '2026-10-24', values: [] },
    { ...aggregate, tokens: tokens(0), start: '2026-10-24', end: '2026-10-25', values: [] },
    { ...aggregate, tokens: tokens(400), start: '2026-10-25', end: '2026-10-26', values: [] },
  ] } satisfies UsageLedgerSeries;
  assert.deepEqual(overviewUsageMetrics(summary, series, '2026-10-25'), { todayTokens: 400, todayCost: cost, weekTokens: 500, weekCost: cost, series: [100, 0, 400] });
});
