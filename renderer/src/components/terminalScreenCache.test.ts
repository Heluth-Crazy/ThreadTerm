import assert from 'node:assert/strict';
import test from 'node:test';
import { canResumeTerminalScreen, createTerminalScreenCache } from './terminalScreenCache';

test('parked parsers are transferred once and disposed on eviction, expiry or transport change', async () => {
  let reset: (() => void) | undefined;
  const cache = createTerminalScreenCache<{ dispose(): void }>(listener => {
    reset = listener;
    return () => { reset = undefined; };
  }, 2, 15);
  const disposed: string[] = [];
  const screen = (id: string) => ({ dispose() { disposed.push(id); } });
  cache.park('first', screen('first'));
  cache.park('second', screen('second'));
  cache.park('third', screen('third'));
  assert.deepEqual(disposed, ['first']);
  const second = cache.take('second');
  assert.ok(second);
  assert.equal(cache.take('second'), undefined);
  reset!();
  assert.deepEqual(disposed, ['first', 'third']);
  assert.equal(reset, undefined);
  cache.park('second', second);
  await new Promise(done => setTimeout(done, 35));
  assert.deepEqual(disposed, ['first', 'third', 'second']);
  assert.equal(reset, undefined);
});

test('a cached cursor must belong to the same retained interval', () => {
  assert.ok(canResumeTerminalScreen(1000, 12, 12, 1000));
  assert.ok(canResumeTerminalScreen(1000, 12, 12, 1200));
  assert.equal(canResumeTerminalScreen(1000, 12, 12, 999), false);
  assert.equal(canResumeTerminalScreen(1000, 12, 13, 1500), false);
});
