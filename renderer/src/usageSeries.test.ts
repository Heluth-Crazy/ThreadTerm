import test from 'node:test';
import assert from 'node:assert/strict';
import { axisTicks, foldSeries, providerSlots, seriesKeys, stackedColumns, thinLabels, tokenSlots } from './usageSeries.js';

const value = (key: string, tokens: number) => ({ key, tokens, costUsd: tokens / 1000, activeTimeMs: tokens, requests: 1 });

test('providers keep a stable colour slot regardless of the input order', () => {
  const first = providerSlots(['grok', 'codex', 'claude']);
  const second = providerSlots(['claude', 'grok', 'codex']);
  assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());
  assert.equal(first.get('codex'), 1);
  assert.equal(first.get('claude'), 2);
  assert.equal(first.get('grok'), 6);
});

test('an unknown provider gets a deterministic slot after the known ones', () => {
  const slots = providerSlots(['plugin-b', 'plugin-a', 'codex']);
  assert.equal(slots.get('codex'), 1);
  assert.equal(slots.get('plugin-a'), 2);
  assert.equal(slots.get('plugin-b'), 3);
});

test('more than eight providers fold into one Other series', () => {
  const values = ['codex', 'claude', 'opencode', 'pi', 'kimi', 'grok', 'gemini', 'other-a', 'other-b'].map((key, index) => value(key, 100 - index));
  const folded = foldSeries(values);
  assert.equal(folded.length, 8);
  assert.equal(folded.at(-1)!.key, 'other');
  assert.equal(folded.at(-1)!.tokens, 93 + 92);
  assert.equal(foldSeries(values.slice(0, 3)).length, 3);
});

test('stacked columns carry the provider slot and skip empty values', () => {
  const columns = stackedColumns([
    { start: '2026-10-01', end: '2026-10-02', values: [value('codex', 100), value('claude', 50), value('pi', 0)] },
    { start: '2026-10-02', end: '2026-10-03', values: [value('claude', 30)] },
  ], 'tokens');
  assert.deepEqual(columns[0]!.segments.map(segment => segment.key), ['codex', 'claude']);
  assert.equal(columns[0]!.total, 150);
  assert.deepEqual(columns[1]!.segments.map(segment => segment.key), ['claude']);
  assert.equal(columns[1]!.segments[0]!.slot, 2);
});

test('token-type stacks use their own fixed slot order', () => {
  assert.equal(tokenSlots(['input']).get('input'), 1);
  assert.equal(tokenSlots(['cacheWrite5m']).get('cacheWrite5m'), 3);
  assert.equal(tokenSlots(['unknownBucket']).get('unknownBucket'), 8);
});

test('series keys ignore empty series and stay in slot order', () => {
  assert.deepEqual(seriesKeys([
    { values: [value('claude', 5), value('codex', 0)] },
    { values: [value('codex', 7)] },
  ]), ['codex', 'claude']);
});

test('axis ticks are rounded and always cover the tallest column', () => {
  for (const max of [1, 7, 412, 1_240_000_000]) {
    const ticks = axisTicks(max);
    assert.equal(ticks[0], 0);
    assert.ok(ticks.at(-1)! >= max, `${max} covered by ${ticks.at(-1)}`);
    assert.ok(ticks.length >= 2 && ticks.length <= 8, `${max}: ${ticks.length} ticks`);
  }
  assert.deepEqual(axisTicks(0), [0]);
});

test('x-axis labels are thinned until they no longer overlap', () => {
  const weekly = Array.from({ length: 52 }, (_, index) => ({ index, label: 'Sep 28' }));
  assert.equal(thinLabels(weekly, 90, () => 34).length, 52);
  const cramped = thinLabels(weekly, 12, () => 34);
  assert.ok(cramped.length >= 2 && cramped.length < 20, `cramped kept ${cramped.length}`);
  assert.equal(cramped[0]!.index, 0);
  assert.equal(cramped.at(-1)!.index, 51);
  // No two kept labels may touch, whatever the pitch.
  for (const pitch of [6, 12, 20, 33, 90]) {
    const kept = thinLabels(weekly, pitch, () => 34);
    for (let index = 1; index < kept.length; index += 1) {
      const left = kept[index - 1]!.index * pitch + pitch / 2 + 17;
      const right = kept[index]!.index * pitch + pitch / 2 - 17;
      assert.ok(right >= left + 8, `pitch ${pitch}: labels ${kept[index - 1]!.index}/${kept[index]!.index} overlap`);
    }
  }
});

test('the latest period keeps its label and gives up a neighbour instead', () => {
  const dense = Array.from({ length: 12 }, (_, index) => ({ index, label: 'Sep 28' }));
  const kept = thinLabels(dense, 20, () => 34, 8);
  assert.equal(kept.at(-1)!.index, 11);
  assert.ok(kept.every(tick => tick.label === 'Sep 28'));
  assert.deepEqual(thinLabels([], 20, () => 34), []);
  assert.deepEqual(thinLabels(dense, 0, () => 34), []);
});

test('edge ticks align inward so their text stays inside the plot', () => {
  const ticks = thinLabels([
    { index: 0, label: 'Jan 2026' },
    { index: 11, label: 'Oct 2026' },
  ], 24, () => 48);
  assert.equal(ticks[0]!.align, 'start');
  assert.equal(ticks[1]!.align, 'end');
  assert.equal(thinLabels([{ index: 11, label: 'Oct 2026' }], 24, () => 48)[0]!.align, 'end', 'a sole latest tick anchors to the plot end');
});
