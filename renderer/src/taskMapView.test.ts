import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRebuildScheduler, taskMapStatusLabel } from './taskMapView';
import type { TaskMapCopy } from './taskMapTypes';

test('status labels are shared and bilingual', () => {
  const zh: TaskMapCopy = (_en, chinese) => chinese;
  assert.equal(taskMapStatusLabel('done', zh), '完成');
  assert.equal(taskMapStatusLabel('waiting', zh), '等待你操作');
  assert.equal(taskMapStatusLabel('running', zh), '运行中');
  assert.equal(taskMapStatusLabel('cancelled', zh), '已取消');
  assert.equal(taskMapStatusLabel('failed', (english) => english), 'Failed');
});

test('scheduler keeps one timer, supports flush and fire, and disposal prevents work', () => {
  const original = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const queued = new Map<number, () => void>();
  let nextId = 0;
  let runs = 0;
  globalThis.setTimeout = ((fn: () => void) => { const id = ++nextId; queued.set(id, fn); return id as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { queued.delete(id as unknown as number); }) as typeof clearTimeout;
  try {
    const scheduler = createRebuildScheduler(250, () => { runs++; });
    scheduler.flush();
    assert.equal(runs, 0, 'flush without pending work is a no-op');
    scheduler.schedule(); scheduler.schedule();
    assert.equal(queued.size, 1);
    scheduler.flush(); assert.equal(runs, 1);
    scheduler.schedule();
    const id = [...queued.keys()][0];
    const fire = queued.get(id)!;
    queued.delete(id);
    fire();
    assert.equal(runs, 2);
    scheduler.schedule();
    assert.equal(queued.size, 1, 'a fired timer clears the pending slot');
    scheduler.dispose(); scheduler.dispose();
    assert.equal(queued.size, 0);
    assert.equal(runs, 2);
  } finally { globalThis.setTimeout = original; globalThis.clearTimeout = originalClear; }
});
