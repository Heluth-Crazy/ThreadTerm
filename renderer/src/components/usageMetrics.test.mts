import test from 'node:test';
import assert from 'node:assert/strict';
import { endOfUtcDay, estimatedCost, knownTokenTrend, parsePrices, validatePrices } from './usageMetrics.js';
const prices = validatePrices({ 'codex/gpt': { input: 1, output: 2 } });
test('mixed known and unknown costs stay separate', () => {
  assert.equal(estimatedCost({ sessionId: 'a', provider: 'codex', recordedAt: 'x', model: 'gpt', inputTokens: 1_000_000, outputTokens: 0 }, prices), 1);
  assert.equal(estimatedCost({ sessionId: 'b', provider: 'codex', recordedAt: 'x', model: 'unknown', inputTokens: 1 }, prices), undefined);
});
test('missing priced token count stays unknown', () => assert.equal(estimatedCost({ sessionId: 'a', provider: 'codex', recordedAt: 'x', model: 'gpt', outputTokens: 1 }, prices), undefined));

test('partial pricing cannot make nonzero output free', () => {
  const row = { sessionId: 'a', provider: 'codex' as const, recordedAt: 'x', model: 'gpt', inputTokens: 1_000_000, outputTokens: 1 };
  const partial = { 'codex/gpt': { input: 1 } };
  assert.equal(estimatedCost(row, partial), undefined);
  assert.equal(estimatedCost({ ...row, outputTokens: 0 }, partial), 1);
  assert.equal(estimatedCost({ ...row, outputTokens: undefined }, partial), undefined);
});

test('unknown-only days do not masquerade as zero token measurements', () => {
  assert.deepEqual(knownTokenTrend([{ sessionId: 'a', provider: 'codex', recordedAt: '2026-09-10T00:00:00Z' }]), []);
});
test('price JSON is parsed before validation', () => { assert.deepEqual(parsePrices('{"codex/gpt":{"input":1}}'), { 'codex/gpt': { input: 1 } }); assert.throws(() => parsePrices('{')); });
test('malformed prices reject', () => { assert.throws(() => validatePrices({ 'codex/gpt': { extra: 1 } })); assert.throws(() => validatePrices({ 'codex/gpt': { input: -1 } })); });
test('end date is an inclusive UTC day boundary', () => { assert.equal(endOfUtcDay('2026-09-10'), '2026-09-10T23:59:59.999Z'); assert.equal(endOfUtcDay('not-a-date'), undefined); });
test('known token trend is chronological even when records arrive newest first', () => {
  assert.deepEqual(knownTokenTrend([
    { sessionId: 'a', provider: 'codex', recordedAt: '2026-09-11T00:00:00Z', inputTokens: 2 },
    { sessionId: 'b', provider: 'codex', recordedAt: '2026-09-10T00:00:00Z', outputTokens: 3 },
  ]), [['2026-09-10', 3], ['2026-09-11', 2]]);
});
