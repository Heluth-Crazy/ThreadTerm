import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResizeScheduler, type PtySize } from './terminalResize';

/** A manual clock and a send whose promises the test settles. */
function harness(options: { quietMs?: number; minIntervalMs?: number; maxWaitMs?: number } = {}) {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 0;
  const clock = {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => { const id = ++nextId; timers.push({ at: now + ms, callback, id }); return id; },
    clearTimer: (id: unknown) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
  };
  const sends: Array<{ size: PtySize; resolve: () => void; reject: (error: Error) => void }> = [];
  const scheduler = createResizeScheduler(size => new Promise<void>((resolve, reject) => { sends.push({ size, resolve, reject }); }), { ...options, clock });
  const flush = () => new Promise<void>(done => setImmediate(done));
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.callback();
      await flush();
    }
    now = end;
  };
  return { scheduler, sends, advance, flush, size: (cols: number, rows = 30, epoch = 1): PtySize => ({ cols, rows, epoch }) };
}

test('a drag becomes one resize with the last size, once requests have been quiet', async () => {
  const { scheduler, sends, advance, size } = harness({ quietMs: 150 });
  for (const cols of [120, 110, 100, 90, 80]) { scheduler.request(size(cols)); await advance(40); }
  assert.equal(sends.length, 0, 'nothing is sent while the drag goes on');
  await advance(150);
  assert.deepEqual(sends.map(send => send.size.cols), [80]);
});

test('at most one resize is in flight and the latest size follows it', async () => {
  const { scheduler, sends, advance, flush, size } = harness({ minIntervalMs: 0 });
  scheduler.request(size(100));
  await advance(0);
  scheduler.request(size(90));
  scheduler.request(size(80));
  await advance(10);
  assert.deepEqual(sends.map(send => send.size.cols), [100], 'waits for the request in flight');
  sends[0].resolve();
  await flush();
  await advance(0);
  assert.deepEqual(sends.map(send => send.size.cols), [100, 80], '90 was superseded before it was sent');
});

test('an unchanged size is not sent again, and reset forgets a stale pending size', async () => {
  const { scheduler, sends, advance, flush, size } = harness({ quietMs: 50 });
  scheduler.request(size(100));
  await advance(50);
  sends[0].resolve();
  await flush();
  scheduler.request(size(100));
  await advance(100);
  assert.equal(sends.length, 1, 'same size, same lease: nothing to do');
  scheduler.request(size(90));
  scheduler.reset(); // lease released before 90 went out
  await advance(100);
  assert.equal(sends.length, 1, 'a size for the old lease is never sent after reset');
  scheduler.request(size(100, 30, 2));
  await advance(50);
  assert.deepEqual(sends.map(send => [send.size.cols, send.size.epoch]), [[100, 1], [100, 2]], 'a new lease resends the size');
});

test('a failed resize is not retried by the scheduler, so a persistent failure cannot loop', async () => {
  const { scheduler, sends, advance, flush, size } = harness({ minIntervalMs: 0 });
  scheduler.request(size(100));
  await advance(0);
  sends[0].reject(new Error('lease lost'));
  await flush();
  await advance(1000);
  assert.equal(sends.length, 1);
  scheduler.reset();
  scheduler.request(size(100));
  await advance(0);
  assert.equal(sends.length, 2, 'the caller retries explicitly with reset + request');
});

test('maxWaitMs bounds the delay during a long drag, and dispose cancels what is pending', async () => {
  const { scheduler, sends, advance, size } = harness({ quietMs: 150, maxWaitMs: 300 });
  for (let cols = 120; cols > 100; cols--) { scheduler.request(size(cols)); await advance(40); }
  assert.ok(sends.length >= 1 && sends.length <= 3, `bounded sends during an 800 ms drag (${sends.length})`);
  const before = sends.length;
  scheduler.request(size(70));
  scheduler.dispose();
  await advance(1000);
  assert.equal(sends.length, before);
});
