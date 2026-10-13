import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem } from '@threadterm/protocol';
import { compactTokens, createTurnChangesCache, turnFooterSegments, turnReview } from './turnFooter';

const row = (extra: Partial<ChatItem> = {}): ChatItem => ({ id: 'a', role: 'assistant', parts: [], createdAt: '2026-10-13T00:00:00Z', ...extra });
test('footer uses the frozen start model and turn usage, preserves measured zero, and formats cache', () => {
  const item = row({ turnModel: 'model-at-start', turnUsage: { inputTokens: 12_300, outputTokens: 2_100, cacheReadTokens: 39_000, cacheWriteTokens: 1_000 } });
  assert.deepEqual(turnFooterSegments([item], 130_000, false).map(segment => segment.text), ['Worked for 2m 10s', 'model-at-start', '12.3k in', '2.1k out', '40k cache']);
  assert.deepEqual(turnFooterSegments([row({ turnUsage: { inputTokens: 0 } })], 0, true).map(segment => segment.text), ['用时 0s', '0 输入']);
  assert.equal(compactTokens(999), '999');
});
test('legacy usage parts work and unknown metadata never invents model or tokens', () => {
  assert.deepEqual(turnFooterSegments([row()], undefined, false), []);
  const item = row({ parts: [{ type: 'usage', data: { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 100 } }] });
  assert.deepEqual(turnFooterSegments([item], undefined, true).map(segment => segment.text), ['1.2k 输入', '400 输出', '100 缓存']);
  assert.deepEqual(turnFooterSegments([row({ turnUsage: { inputTokens: NaN, outputTokens: -1 } })], undefined, false), []);
});
test('turn review keeps a frozen pair and does not query to discover it', () => {
  const review = { from: 'before', to: 'after', fileCount: 3 };
  assert.deepEqual(turnReview([row(), row({ turnReview: review })]), review);
  assert.equal(turnReview([row()]), undefined);
});
test('lazy changes cache makes no eager request, shares pending expansion, and caches a successful turn', async () => {
  const cache = createTurnChangesCache<string[]>();
  let calls = 0;
  const fetch = async () => { calls += 1; return ['one', 'two', 'three']; };
  assert.equal(calls, 0);
  const first = cache.load('session:before:after', fetch), second = cache.load('session:before:after', fetch);
  assert.equal(first, second);
  assert.deepEqual(await first, ['one', 'two', 'three']);
  assert.deepEqual(await cache.load('session:before:after', fetch), ['one', 'two', 'three']);
  assert.equal(calls, 1);
  await cache.load('other:before:after', fetch);
  assert.equal(calls, 2);
});
test('failed expansion can retry without poisoning other turns', async () => {
  const cache = createTurnChangesCache<number>();
  await assert.rejects(cache.load('turn', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.load('turn', async () => 3), 3);
});
