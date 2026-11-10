import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ResourceUsage } from './resourceUsage.js';

test('resource usage deduplicates processes and ignores exited or reused identities', () => {
  const usage = new ResourceUsage();
  const reading = (pid: number, started: string, cpuSeconds: number, memoryBytes: number) =>
    ({ pid, started, cpuSeconds, memoryBytes });
  assert.deepEqual(usage.measure([reading(1, 'a', 1, 20), reading(2, 'b', 9, 10)], 0, 4), {
    cpuPercent: undefined, memoryBytes: 30,
  });
  assert.deepEqual(usage.measure([
    reading(1, 'a', 2, 21), reading(2, 'c', 40, 11), reading(2, 'c', 40, 11),
  ], 1000, 4), { cpuPercent: 25, memoryBytes: 32 });
  assert.deepEqual(usage.measure([reading(1, 'a', 3, 23)], 2000, 4), {
    cpuPercent: 25, memoryBytes: 23,
  });
  assert.deepEqual(usage.measure([reading(1, 'a', 5, 26)], 30_000, 4), {
    cpuPercent: undefined, memoryBytes: 26,
  });
});
