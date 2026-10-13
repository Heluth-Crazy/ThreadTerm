import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatContextUsage, RuntimeEvent } from '@threadterm/protocol';
import {
  connectionChipLabel,
  connectionTone,
  contextCacheHitRate,
  contextPercent,
  contextRows,
  contextTier,
  formatPercent,
  hasContextUsage,
  observeContextUsage,
  statusModelReserve,
} from './contextUsage';
import { foldExtraChips } from './composerOptions';

const copy = (en: string) => en;

test('status controls use flexible model width before folding any previously fitting C2 option', () => {
  const legacyBudget = 898 - 150 - 32 - 200 - 6 - 8 - 2;
  const statusFootprint = 64;
  const currentBudget = 898 - 150 - (32 + statusFootprint)
    - statusModelReserve(200, statusFootprint, 72) - 6 - 8 - 2;
  const fold = (available: number) => foldExtraChips({ available, gap: 6, widths: [100, 120, 110, 145], cogWidth: 26 });
  assert.equal(currentBudget, legacyBudget);
  assert.equal(fold(legacyBudget).visibleCount, 4);
  assert.equal(fold(legacyBudget - statusFootprint).visibleCount, 3);
  assert.deepEqual(fold(currentBudget), fold(legacyBudget));
  assert.equal(statusModelReserve(200, 32, 72), 168);
  assert.equal(statusModelReserve(100, 64, 72), 72);
  assert.equal(statusModelReserve(200, 0, 72), 200);
});

test('contextTier follows the 70/90 thresholds and stays neutral for unknown', () => {
  assert.equal(contextTier(undefined), 'neutral');
  assert.equal(contextTier(0), 'neutral');
  assert.equal(contextTier(69.9), 'neutral');
  assert.equal(contextTier(70), 'warn');
  assert.equal(contextTier(89.9), 'warn');
  assert.equal(contextTier(90), 'danger');
  assert.equal(contextTier(140), 'danger');
});

test('contextPercent prefers the provider value and derives it from used/window', () => {
  assert.equal(contextPercent({ percent: 42, windowTokens: 200 }), 42);
  assert.equal(contextPercent({ usedTokens: 60, windowTokens: 200 }), 30);
  assert.equal(contextPercent({ percent: -5, windowTokens: 200 }), 0);
  assert.equal(contextPercent({ usedTokens: 60 }), undefined);
  assert.equal(contextPercent(null), undefined);
});

test('hasContextUsage renders nothing when every counter is missing or zero', () => {
  assert.equal(hasContextUsage(undefined), false);
  assert.equal(hasContextUsage(null), false);
  assert.equal(hasContextUsage({}), false);
  assert.equal(hasContextUsage({ inputTokens: 0, outputTokens: 0 }), false);
  assert.equal(hasContextUsage({ inputTokens: 1 }), true);
  assert.equal(hasContextUsage({ windowTokens: 200000 }), true);
});

test('contextRows hides unknown and zero values and keeps the popover order', () => {
  const rows = contextRows({ usedTokens: 60, windowTokens: 200, inputTokens: 50, outputTokens: 0, cacheReadTokens: 40, cacheWriteTokens: 5, totalTokens: 95 });
  assert.deepEqual(rows, [
    { key: 'input', value: 50 },
    { key: 'cacheRead', value: 40 },
    { key: 'cacheWrite', value: 5 },
    { key: 'total', value: 95 },
  ]);
  assert.deepEqual(contextRows({}), []);
});

test('contextCacheHitRate divides cache reads by input plus cache reads', () => {
  assert.equal(contextCacheHitRate({ inputTokens: 60, cacheReadTokens: 40 }), 0.4);
  assert.equal(contextCacheHitRate({ cacheReadTokens: 40 }), undefined);
  assert.equal(contextCacheHitRate({ inputTokens: 10 }), undefined);
  assert.equal(contextCacheHitRate({}), undefined);
});

test('formatPercent rounds and hides an unknown value', () => {
  assert.equal(formatPercent(36.7), '37%');
  assert.equal(formatPercent(undefined), undefined);
});

test('the connection label and tone cover every phase without relying on colour', () => {
  assert.equal(connectionChipLabel('ready', copy), 'Connected');
  assert.equal(connectionChipLabel('connecting', copy), 'Connecting');
  assert.equal(connectionChipLabel('failed', copy), 'Error');
  assert.equal(connectionChipLabel('disconnected', copy), 'Disconnected');
  assert.equal(connectionChipLabel('unavailable', copy), 'Unavailable');
  assert.equal(connectionTone('ready'), 'ok');
  assert.equal(connectionTone('connecting'), 'busy');
  assert.equal(connectionTone('failed'), 'error');
  assert.equal(connectionTone('disconnected'), 'idle');
  assert.equal(connectionTone('unavailable'), 'muted');
  assert.equal(connectionTone('ready', true), 'error');
});

test('a usage snapshot with only a window still exposes a tier and no percent', () => {
  const usage: ChatContextUsage = { windowTokens: 200000 };
  assert.equal(contextPercent(usage), undefined);
  assert.equal(contextTier(contextPercent(usage)), 'neutral');
  assert.equal(hasContextUsage(usage), true);
});

test('known zero usage yields 0%, while a percentage without a window stays tokens-only', () => {
  assert.equal(contextPercent({ usedTokens: 0, windowTokens: 200000 }), 0);
  assert.equal(contextPercent({ percent: 95, inputTokens: 100 }), undefined);
  assert.equal(contextTier(contextPercent({ percent: 95, inputTokens: 100 })), 'neutral');
  assert.equal(contextPercent({ usedTokens: NaN, windowTokens: 200 }), undefined);
  assert.equal(contextPercent({ usedTokens: -1, windowTokens: 200 }), undefined);
  assert.equal(contextCacheHitRate({ inputTokens: 0, cacheReadTokens: 10 }), 1);
  assert.equal(contextCacheHitRate({ inputTokens: -1, cacheReadTokens: 10 }), undefined);
  assert.deepEqual(contextRows({ inputTokens: NaN, outputTokens: -1, totalTokens: Infinity }), []);
});

function observerHarness() {
  const pending: ((usage: ChatContextUsage | null) => void)[] = [];
  const values: (ChatContextUsage | undefined)[] = [];
  let listener: (event: RuntimeEvent) => void = () => {};
  let unsubscribed = false;
  const dispose = observeContextUsage('one', () => new Promise(resolve => pending.push(resolve)),
    next => { listener = next; return () => { unsubscribed = true; }; }, usage => values.push(usage));
  const emit = (event: string, data: unknown) => listener({ v: 1, event, data, seq: 1, epoch: 'epoch' });
  return { pending, values, emit, dispose, unsubscribed: () => unsubscribed };
}

test('context events and clears beat a pending hydration; other sessions do not affect it', async () => {
  const h = observerHarness();
  h.emit('chat.context', { sessionId: 'other', usage: { usedTokens: 99 } });
  h.emit('chat.context', { sessionId: 'one', usage: { usedTokens: 45 } });
  h.pending[0]({ usedTokens: 10 });
  await Promise.resolve();
  assert.deepEqual(h.values, [undefined, { usedTokens: 45 }]);
  h.emit('chat.context', { sessionId: 'one', usage: null });
  assert.equal(h.values.at(-1), undefined);
  assert.equal(h.pending.length, 1);
  h.dispose();
  assert.equal(h.unsubscribed(), true);
});

test('reconnection reads once and fences earlier reads and disposed session callbacks', async () => {
  const h = observerHarness();
  h.emit('runtime.transport', { state: 'disconnected' });
  h.pending[0]({ usedTokens: 10 });
  await Promise.resolve();
  assert.deepEqual(h.values, [undefined]);
  h.emit('runtime.transport', { state: 'reconnected' });
  assert.equal(h.pending.length, 2);
  h.pending[1]({ usedTokens: 75 });
  await Promise.resolve();
  assert.deepEqual(h.values.at(-1), { usedTokens: 75 });
  h.emit('runtime.transport', { state: 'reconnected' });
  h.dispose();
  const count = h.values.length;
  h.pending[2]({ usedTokens: 95 });
  h.emit('chat.context', { sessionId: 'one', usage: { usedTokens: 95 } });
  await Promise.resolve();
  assert.equal(h.values.length, count);
});

test('reopening hydrates the saved usage independently of the old observer', async () => {
  const old = observerHarness();
  old.dispose();
  const reopened = observerHarness();
  reopened.pending[0]({ usedTokens: 90, windowTokens: 100 });
  old.pending[0]({ usedTokens: 1 });
  await Promise.resolve();
  assert.deepEqual(reopened.values.at(-1), { usedTokens: 90, windowTokens: 100 });
  assert.deepEqual(old.values, [undefined]);
  reopened.dispose();
});
