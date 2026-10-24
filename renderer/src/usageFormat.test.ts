import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTimeText, compactTokens, costCoverage, costText, dayHasUsage, evidenceLine, percentText, reportedCostText, tilesState, tokenShares } from './usageFormat.js';

const tokens = (partial: Partial<Record<string, number | null>>) => ({
  total: 0, input: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null, cacheWriteUnknown: null, output: null, reasoning: null,
  ...partial,
});

test('compact token totals keep two significant decimals', () => {
  assert.equal(compactTokens(1_240_000_000, 'en'), '1.24B');
  assert.equal(compactTokens(820_000_000, 'en'), '820M');
  assert.equal(compactTokens(12_400, 'en'), '12.4K');
  assert.equal(compactTokens(999, 'en'), '999');
  assert.equal(compactTokens(0, 'en'), '0');
  assert.match(compactTokens(1_240_000_000, 'zh-CN'), /亿|B/);
});

test('an API-equivalent amount always reads as an estimate and never as a zero bill', () => {
  assert.equal(costText(412.34, 'en'), '≈ $412');
  assert.equal(costText(0.42, 'en'), '≈ $0.42');
  assert.equal(costText(0, 'en'), '≈ $0.00');
  assert.equal(costText(null, 'en'), '—');
  assert.equal(costText(undefined, 'en'), '—');
  assert.equal(costText(Number.NaN, 'en'), '—');
});

test('provider-recorded money is only shown when reported', () => {
  assert.equal(reportedCostText(0, 'en'), null);
  assert.equal(reportedCostText(0.42, 'en'), '$0.42');
  assert.equal(reportedCostText(undefined, 'en'), null);
});

test('estimated active time is rounded to a readable unit', () => {
  assert.equal(activeTimeText(46 * 3_600_000, 'en'), '46 h');
  assert.equal(activeTimeText(12 * 60_000, 'en'), '12 min');
  assert.equal(activeTimeText(0, 'en'), '0 min');
  assert.equal(activeTimeText(-1, 'en'), '—');
});

test('percentages keep one decimal, two below one percent', () => {
  assert.equal(percentText(0.992, 'en'), '99.2%');
  assert.equal(percentText(0.008, 'en'), '0.8%');
  assert.equal(percentText(1, 'en'), '100%');
  assert.equal(percentText(null, 'en'), '—');
});

test('bucket shares use the known subtotal and never add reasoning again', () => {
  const shares = tokenShares(tokens({ total: 100, input: 6, cacheRead: 88, cacheWrite5m: 1, output: 5, reasoning: 2 }));
  assert.deepEqual(shares.map(item => item.key), ['input', 'cacheRead', 'cacheWrite5m', 'output']);
  assert.equal(Math.round(shares.reduce((sum, item) => sum + item.share, 0) * 100), 100);
  assert.ok(!shares.some(item => item.key === 'reasoning'));
  assert.deepEqual(tokenShares(tokens({ total: 0 })), []);
});

test('unknown buckets are not invented as zero-share rows', () => {
  const shares = tokenShares(tokens({ total: 10, input: 10 }));
  assert.deepEqual(shares.map(item => item.key), ['input']);
});

test('cost coverage reports priced and unpriced tokens separately', () => {
  const coverage = costCoverage({ reportedUsd: null, apiEquivalentUsd: 412, pricedTokens: 960, unpricedTokens: 40, reportedRequests: 0, pricedRequests: 9, coverage: 0.96 });
  assert.deepEqual(coverage, { priced: 0.96, unpricedTokens: 40, pricedTokens: 960 });
});

test('evidence shares stay separate kinds of evidence', () => {
  assert.deepEqual(evidenceLine({ exactRequests: 9, derivedRequests: 1, estimatedRequests: 0, exactTokens: 99, derivedTokens: 1, estimatedTokens: 0, exactShare: 0.99, derivedShare: 0.01, estimatedShare: 0 }), { exact: 0.99, derived: 0.01, estimated: 0 });
});

test('tiles read history before they claim a range was empty', () => {
  assert.equal(tilesState({ requests: 0, loading: true, scanning: false }), 'reading');
  assert.equal(tilesState({ requests: 0, loading: false, scanning: true }), 'reading');
  assert.equal(tilesState({ requests: 0, loading: false, scanning: false }), 'empty');
  // Once there is usage the numbers stay put while a refresh runs.
  assert.equal(tilesState({ requests: 12, loading: true, scanning: true }), 'ready');
});

test('a zero day has no usage, whatever metric is on screen', () => {
  const point = (tokens: number, requests: number, activeTimeMs: number, apiEquivalentUsd: number | null) => ({
    tokens: { total: tokens }, requests, activeTimeMs, cost: { apiEquivalentUsd },
  });
  assert.equal(dayHasUsage(point(0, 0, 0, 0)), false);
  assert.equal(dayHasUsage(point(0, 0, 0, null)), false);
  assert.equal(dayHasUsage(point(1, 0, 0, 0)), true);
  assert.equal(dayHasUsage(point(0, 0, 60_000, null)), true);
  assert.equal(dayHasUsage(point(0, 0, 0, 0.01)), true);
});
