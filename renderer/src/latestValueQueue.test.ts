import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLatestValueQueue } from './latestValueQueue';

test('quiet edits coalesce and only the newest patch follows an in-flight save', () => {
  const queue = createLatestValueQueue<{ rangeMinutes: number; threshold: number }>();
  queue.stage({ rangeMinutes: 20 }); queue.stage({ rangeMinutes: 25 });
  assert.deepEqual(queue.take(), { rangeMinutes: 25 });
  queue.stage({ rangeMinutes: 30 }); queue.stage({ rangeMinutes: 60 });
  queue.stage({ threshold: 4 }); queue.stage({ threshold: 6 });
  assert.equal(queue.take(), undefined);
  assert.equal(queue.has('rangeMinutes'), true); assert.equal(queue.has('threshold'), true);
  queue.finish();
  assert.deepEqual(queue.take(), { rangeMinutes: 60, threshold: 6 });
  queue.finish(); assert.equal(queue.take(), undefined);
  assert.equal(queue.has('rangeMinutes'), false); assert.equal(queue.has('threshold'), false);
});

test('an edit returning to the original value is retained, and failure completion permits new edits', () => {
  const queue = createLatestValueQueue<{ threshold: number }>();
  queue.stage({ threshold: 4 }); assert.deepEqual(queue.take(), { threshold: 4 });
  queue.stage({ threshold: 5 }); queue.stage({ threshold: 3 });
  queue.finish(); assert.deepEqual(queue.take(), { threshold: 3 });
  queue.finish(); assert.equal(queue.take(), undefined);
  queue.stage({ threshold: 8 }); assert.deepEqual(queue.take(), { threshold: 8 });
});
