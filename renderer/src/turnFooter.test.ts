import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem } from '@threadterm/protocol';
import { liveTurnSpeed, turnSpeedText } from './turnSpeed';
import { compactTokens, createTurnChangesCache, turnFooterSegmentProps, turnFooterSegments, turnReview } from './turnFooter';

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
test('footer renders exact or estimated saved token speed after output', () => {
  const exact = turnFooterSegments([row({ turnUsage: { outputTokens: 52, generationMs: 1_000, firstTokenMs: 1_400 } })], undefined, false);
  assert.deepEqual(exact.map(segment => segment.text), ['52 out', '52 tok/s']);
  assert.equal(exact[1]!.title, 'Output tokens per second while the model was generating (tool runs and waits excluded). First token after 1.4 s.');
  assert.deepEqual(turnFooterSegments([row({ turnUsage: { outputTokens: 52, generationMs: 1_000, outputTokensEstimated: true } })], undefined, true).map(segment => segment.text), ['≈ 52 输出', '≈ 52 tok/s']);
  assert.deepEqual(turnFooterSegments([row({ turnUsage: { outputTokens: 1, generationMs: 249 } })], undefined, false).map(segment => segment.text), ['1 out']);
});
test('speed footer exposes the required DOM hooks and tooltip', () => {
  const item = row({ turnUsage: { outputTokens: 52, generationMs: 1_000, outputTokensEstimated: true } });
  const segments = turnFooterSegments([item], undefined, false);
  const speed = segments.find(segment => segment.kind === 'speed')!;
  assert.deepEqual(turnFooterSegmentProps(speed), {
    'data-separator': 'none', 'data-testid': 'turn-speed', 'data-estimated': 'true', 'data-tokens-per-second': '52',
    title: 'Output tokens per second while the model was generating (tool runs and waits excluded). This provider reports no token count; estimated from the streamed text.',
  });
  assert.deepEqual(turnFooterSegmentProps(segments[0]!), { 'data-separator': 'none' }, 'the first span carries neither a separator nor speed hooks');
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

test('footer separators follow preceding visible segments across responsive hiding', () => {
  const outputAndSpeed = turnFooterSegments([row({ turnUsage: { outputTokens: 88, generationMs: 4_200, outputTokensEstimated: true } })], undefined, false);
  assert.deepEqual(outputAndSpeed.map((segment, index) => turnFooterSegmentProps(segment, outputAndSpeed.slice(0, index))['data-separator']), ['none', 'out'], 'hiding out also hides its separator before speed');
  const withInput = turnFooterSegments([row({ turnUsage: { inputTokens: 100, outputTokens: 88, generationMs: 4_200 } })], undefined, false);
  assert.equal(turnFooterSegmentProps(withInput[2]!, withInput.slice(0, 2))['data-separator'], 'in', 'the separator survives out hiding while input remains visible');
  const withDuration = turnFooterSegments([row({ turnUsage: { inputTokens: 100, outputTokens: 88, generationMs: 4_200 } })], 4_200, false);
  assert.equal(turnFooterSegmentProps(withDuration[3]!, withDuration.slice(0, 3))['data-separator'], 'always', 'a visible duration keeps the separator even when input and output hide');
  const onlySpeed = withInput[2]!;
  assert.equal(turnFooterSegmentProps(onlySpeed)['data-separator'], 'none', 'a speed-only footer has no leading or trailing separator');
});

test('estimated output and saved/live speed share the spaced marker in English and Chinese', () => {
  const usage = { outputTokens: 88, generationMs: 4_200, outputTokensEstimated: true };
  for (const zh of [false, true]) {
    const segments = turnFooterSegments([row({ turnUsage: usage })], undefined, zh);
    assert.deepEqual(segments.map(segment => segment.text), [`≈ 88 ${zh ? '输出' : 'out'}`, '≈ 21 tok/s']);
    assert.equal(turnSpeedText(liveTurnSpeed('turn', { turnId: 'turn', usage })!), '≈ 21 tok/s');
  }
});
