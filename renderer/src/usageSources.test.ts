import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketLabel, fileLine, humanizeProblem, problemCounts, problemLabel, reportedBuckets, sourceState, sourceTotals,
} from './usageSources.js';
import { usageCopy } from './usageCopy.js';

const stats = (partial: Partial<{ filesFound: number; filesRead: number; bytesRead: number; facts: number; problems: Record<string, number>; cancelled: boolean }>) => ({
  filesFound: 0, filesRead: 0, bytesRead: 0, facts: 0, problems: {}, cancelled: false, ...partial,
});

const source = (partial: Partial<Parameters<typeof sourceTotals>[0][number]>) => ({
  provider: 'codex', root: '', status: 'ready' as const, missingSources: 0, historyReadEnabled: true, historyReadLabelKey: null,
  lastRead: null, stats: stats({}), bucketsReported: [], ...partial,
});

test('every provider status has one readable state', () => {
  assert.equal(sourceState('ready'), 'found');
  assert.equal(sourceState('partial'), 'partial');
  assert.equal(sourceState('not_installed'), 'notInstalled');
  assert.equal(sourceState('not_supported_yet'), 'unsupported');
  assert.equal(sourceState('cancelled'), 'cancelled');
  assert.equal(sourceState('failed'), 'failed');
  assert.equal(sourceState('history_not_read'), 'notRead');
  assert.equal(sourceState('something_new'), 'notRead', 'an unknown state is not dressed up as a failure');
});

test('problem kinds map onto labels, including families with a suffix', () => {
  assert.equal(problemLabel('not_supported_yet'), 'not_supported_yet');
  assert.equal(problemLabel('unsupported_format_kimi_python'), 'unsupported_format');
  assert.equal(problemLabel('database_error_778'), 'database_error');
  assert.equal(problemLabel('io_error_unexpected_eof'), 'io_error');
  assert.equal(problemLabel('unsupported_zstd_window'), 'unsupported_zstd');
  assert.equal(problemLabel('something_else'), null);
  assert.equal(humanizeProblem('record_too_large'), 'record too large');
});

test('problem counts are ordered by size and never hide an unknown kind', () => {
  const counts = problemCounts({ invalid_json: 2, not_supported_yet: 1108, unreadable: 2, brand_new_kind: 3 });
  assert.deepEqual(counts.map(item => item.kind), ['not_supported_yet', 'brand_new_kind', 'invalid_json', 'unreadable']);
  assert.equal(counts[0]!.count, 1108);
  assert.equal(counts[1]!.label, null, 'an unknown kind keeps its key so the row can still be shown');
  assert.deepEqual(problemCounts(undefined), []);
  assert.deepEqual(problemCounts({ ignored: 0 }), [], 'a zero count is not a problem');
});

test('source totals only count what was actually read', () => {
  const totals = sourceTotals([
    source({ provider: 'claude', stats: stats({ filesFound: 10, filesRead: 10, facts: 100, problems: { invalid_json: 1 } }) }),
    source({ provider: 'codex', status: 'partial', missingSources: 2, stats: stats({ filesFound: 20, filesRead: 18, facts: 50, problems: { not_supported_yet: 3 } }) }),
    source({ provider: 'kimi', status: 'not_installed' }),
  ]);
  assert.deepEqual(totals, { providers: 3, readProviders: 2, filesRead: 28, filesFound: 30, facts: 150, missingSources: 2, problems: 4 });
});

test('reported buckets keep one fixed order and unknown buckets are dropped', () => {
  assert.deepEqual(reportedBuckets(['output', 'input', 'reasoning', 'nope']), ['input', 'output', 'reasoning']);
  assert.deepEqual(reportedBuckets([]), []);
  assert.deepEqual(reportedBuckets(undefined), []);
});

test('bucket labels use the localized reasoning word instead of a raw key', () => {
  assert.equal(bucketLabel('reasoning', usageCopy('en')), 'Reasoning');
  assert.equal(bucketLabel('reasoning', usageCopy('zh-CN')), '推理');
});

test('a provider with no files stays quiet instead of printing zeros', () => {
  assert.equal(fileLine(stats({})), null);
  assert.deepEqual(fileLine(stats({ filesFound: 391, filesRead: 120 })), { read: 120, found: 391 });
  assert.deepEqual(fileLine(undefined), null);
});
