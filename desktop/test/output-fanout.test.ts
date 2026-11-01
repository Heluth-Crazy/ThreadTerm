import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputFanout } from '../src/output-fanout.js';

const chunk = { sessionId: 's', cursor: 0, data: new Uint8Array([1]) };

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a view which never acknowledges output delays neither other views nor the publisher', async () => {
  const fanout = new OutputFanout();
  const fast: number[] = [];
  fanout.add('fast', (value) => { fast.push(value.data[0]!); });
  fanout.add('slow', () => new Promise<void>(() => undefined));
  // publish only enqueues, so upstream credit can be paid for both chunks
  // although the first one has not been rendered by the stalled view.
  fanout.publish(chunk);
  fanout.publish({ ...chunk, cursor: 1, data: new Uint8Array([2]) });
  await settle();
  assert.deepEqual(fast, [1, 2]);
  assert.equal(fanout.size, 2);
  fanout.dispose();
});

test('every view keeps its own chunk order and receives each chunk once', async () => {
  const fanout = new OutputFanout();
  const slow: number[] = [];
  const fast: number[] = [];
  const gate = deferred();
  fanout.add('slow', async (value) => { await gate.promise; slow.push(value.cursor); });
  fanout.add('fast', (value) => { fast.push(value.cursor); });
  for (let cursor = 0; cursor < 4; cursor++) fanout.publish({ sessionId: 's', cursor, data: Uint8Array.of(cursor) });
  await settle();
  assert.deepEqual(fast, [0, 1, 2, 3], 'the healthy view does not wait for the stalled one');
  gate.resolve();
  await settle();
  assert.deepEqual(slow, [0, 1, 2, 3], 'the stalled view catches its own order back');
  fanout.dispose();
});

test('a view over its byte cap drops its backlog and catches up before rejoining live delivery', async () => {
  const fanout = new OutputFanout();
  const received: number[] = [];
  const gate = deferred();
  let catchUps = 0;
  let catchUpSawQueuedBytes = -1;
  fanout.add('view', async (value) => { await gate.promise; received.push(value.cursor); }, {
    limit: 2,
    catchUp: async () => {
      catchUps++;
      catchUpSawQueuedBytes = fanout.pendingBytes;
      // The view re-reads the range it missed from durable history.
      received.push(1, 2, 3);
    },
  });
  for (let cursor = 0; cursor < 4; cursor++) fanout.publish({ sessionId: 's', cursor, data: Uint8Array.of(cursor) });
  await settle();
  assert.deepEqual(received, [], 'nothing is delivered while the first chunk is still in flight');
  assert.equal(catchUps, 0, 'catch-up waits for the in-flight delivery to settle');
  gate.resolve();
  await settle();
  assert.deepEqual(received, [0, 1, 2, 3], 'catch-up continues after the delivered byte without duplicates');
  assert.equal(catchUps, 1);
  assert.equal(catchUpSawQueuedBytes, 0, 'the lagging view holds no backlog');
  fanout.publish({ sessionId: 's', cursor: 4, data: Uint8Array.of(4) });
  await settle();
  assert.deepEqual(received, [0, 1, 2, 3, 4], 'the view rejoins live delivery after catching up');
  fanout.dispose();
});

test('a failed catch-up is reported and retried after the in-flight delivery, not by a timer', async () => {
  const fanout = new OutputFanout();
  const errors: string[] = [];
  const received: number[] = [];
  const gate = deferred();
  let attempts = 0;
  fanout.add('view', async (value) => { await gate.promise; received.push(value.cursor); }, {
    limit: 1,
    catchUp: async () => {
      attempts++;
      if (attempts === 1) throw new Error('history unavailable');
      received.push(1, 2);
    },
    onError: (error) => { errors.push(error.message); },
  });
  for (let cursor = 0; cursor < 3; cursor++) fanout.publish({ sessionId: 's', cursor, data: Uint8Array.of(cursor) });
  gate.resolve();
  await settle();
  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['history unavailable']);
  assert.deepEqual(received, [0, 1, 2], 'the retry re-reads the skipped range before live delivery resumes');
  fanout.publish({ sessionId: 's', cursor: 3, data: Uint8Array.of(3) });
  await settle();
  assert.deepEqual(received, [0, 1, 2, 3], 'live bytes continue after the caught-up range');
  fanout.dispose();
});

test('a delivery failure is reported to the frame publisher and later frames continue', async () => {
  const fanout = new OutputFanout();
  const errors: string[] = [];
  const received: number[] = [];
  let fail = true;
  fanout.add('view', (value) => {
    if (fail) { fail = false; throw new Error('view failed'); }
    received.push(value.cursor);
  });
  fanout.publish(chunk, (error) => { errors.push(error.message); });
  fanout.publish({ ...chunk, cursor: 1, data: new Uint8Array([2]) }, (error) => { errors.push(error.message); });
  await settle();
  assert.deepEqual(errors, ['view failed']);
  assert.deepEqual(received, [1]);
  fanout.dispose();
});

test('unsubscribing a stalled view frees its queue and other views remain', async () => {
  const fanout = new OutputFanout();
  const other: number[] = [];
  const remove = fanout.add('stalled', () => new Promise<void>(() => undefined));
  fanout.add('other', (value) => { other.push(value.cursor); });
  fanout.publish(chunk);
  fanout.publish({ ...chunk, cursor: 1, data: new Uint8Array([2]) });
  await settle();
  assert.equal(fanout.size, 2);
  remove();
  assert.equal(fanout.size, 1);
  assert.equal(fanout.pendingBytes, 0, 'the stalled view holds no queued bytes after unsubscribe');
  fanout.publish({ ...chunk, cursor: 2, data: new Uint8Array([3]) });
  await settle();
  assert.deepEqual(other, [0, 1, 2]);
  fanout.dispose();
});

test('dispose drops every view and its queue', async () => {
  const fanout = new OutputFanout();
  fanout.add('stalled', () => new Promise<void>(() => undefined));
  fanout.publish(chunk);
  fanout.publish({ ...chunk, cursor: 1, data: new Uint8Array([2]) });
  await settle();
  fanout.dispose();
  assert.equal(fanout.size, 0);
  assert.equal(fanout.pendingBytes, 0);
  fanout.publish(chunk);
  await settle();
  assert.equal(fanout.size, 0);
});
