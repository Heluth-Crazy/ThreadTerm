import assert from 'node:assert/strict';
import test from 'node:test';
import { createRefreshQueue } from './workbench/refreshQueue';

/** A run whose completion the test controls, so coalescing can be observed deterministically. */
function harness() {
  const runs: { done: () => void }[] = [];
  let started = 0;
  const queue = createRefreshQueue(() => new Promise<void>(done => { runs.push({ done }); started += 1; }));
  return {
    queue, runs, count: () => started,
    /** Releases every run started so far; a queued run may only appear one tick later. */
    release: async () => { for (const run of runs) run.done(); await new Promise(done => setImmediate(done)); },
  };
}

const settle = () => new Promise(done => setImmediate(done));

test('a queue with no request runs nothing', async () => {
  const probe = harness();
  await settle();
  assert.equal(probe.count(), 0);
  probe.queue.stop();
  await settle();
  assert.equal(probe.count(), 0);
});

test('a burst collapses into one run plus one waiting run', async () => {
  const probe = harness();
  let finished = 0;
  const first = probe.queue.request().then(() => { finished += 1; });
  const second = probe.queue.request().then(() => { finished += 1; });
  await settle();
  assert.equal(probe.count(), 1, 'only one run starts while the first is in flight');
  assert.equal(finished, 0, 'callers wait for their refresh');
  probe.runs[0].done();
  await settle();
  assert.equal(probe.count(), 2, 'the request that arrived mid-run still refreshes once more');
  probe.runs[1].done();
  await Promise.all([first, second]);
  assert.equal(finished, 2);
  assert.equal(probe.count(), 2);
});

test('requests during the waiting run collapse into that run, not a third', async () => {
  const probe = harness();
  const requested = [probe.queue.request()];
  await settle();
  requested.push(probe.queue.request(), probe.queue.request(), probe.queue.request());
  await settle();
  probe.runs[0].done();
  await settle();
  assert.equal(probe.count(), 2);
  probe.runs[1].done();
  await Promise.all(requested);
  await settle();
  assert.equal(probe.count(), 2, 'three queued requests share the one waiting run');
});

test('a settled queue starts a fresh run for the next request', async () => {
  const probe = harness();
  const first = probe.queue.request();
  await settle();
  probe.runs[0].done();
  await first;
  const second = probe.queue.request();
  await settle();
  assert.equal(probe.count(), 2);
  probe.runs[1].done();
  await second;
});

test('a failing run keeps the queue alive and still settles its callers', async () => {
  let runs = 0;
  const queue = createRefreshQueue(async () => { runs += 1; throw Error('git_unavailable'); });
  await queue.request();
  await queue.request();
  assert.equal(runs, 2);
  queue.stop();
});

test('stop ends queued work and releases pending callers', async () => {
  const probe = harness();
  const first = probe.queue.request();
  await settle();
  const queued = probe.queue.request();
  probe.queue.stop();
  await Promise.all([first, queued]);
  probe.runs[0].done();
  await settle();
  assert.equal(probe.count(), 1, 'stop cancels the waiting run');
  await probe.queue.request();
  assert.equal(probe.count(), 1, 'a stopped queue never runs again');
});
