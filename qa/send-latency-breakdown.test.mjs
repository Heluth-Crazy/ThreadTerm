import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTrace, assertCheckpointTargets, checkpointTargetReport, distribution, parseTrace, summarizeRuns } from './lib/send-latency-breakdown.mjs';

const row = (source, stage, monotonicUs, extra = {}) => ({ kind: 'threadterm.sendTrace', source, stage,
  monotonicUs, operationId: 'send-1', requestId: 'request-1', ...extra });
test('aggregation correlates IDs, never subtracts clock domains, and retains missing stages', () => {
  const rows = [row('desktop', 'desktop.request.begin', 9_000_000), row('desktop', 'desktop.request.write', 9_002_000),
    row('desktop', 'desktop.request.end', 9_080_000), row('runtime', 'transport.ordered.enqueue', 2),
    row('runtime', 'transport.ordered.dequeue', 4002, { queueWaitUs: 4000 }),
    row('runtime', 'transport.dispatch.begin', 5000), row('runtime', 'transport.dispatch.end', 75000),
    row('runtime', 'provider.handoff.end', 70000, { durationUs: 20000 }),
    row('runtime', 'persistence.complete.end', 72000, { durationUs: 1000 }),
    row('runtime', 'review.git.exit', 30000, { step: 'status', durationUs: 16000, outcome: 'ok' }),
    row('runtime', 'provider.handoff.end', 123, { operationId: 'other', requestId: 'other', durationUs: 999999 })];
  const result = aggregateTrace(rows, { operationId: 'send-1' });
  assert.equal(result.metrics.desktopTotalMs, 80);
  assert.equal(result.metrics.desktopRoundTripMs, 78);
  assert.equal(result.metrics.runtimeDispatchMs, 70);
  assert.equal(result.metrics.orderedQueueMs, 4);
  assert.equal(result.metrics.handoffMs, 20);
  assert.equal(result.metrics.checkpointMs, null);
  assert.equal(result.metrics.runtimeOtherMs, null);
  assert.equal(result.git[0].ms, 16);
  assert.deepEqual(result.missing, []);
  const strict = aggregateTrace(rows, { operationId: 'send-1', strictSend: true, expectStdin: true });
  assert.ok(strict.missing.includes('runtime:review.checkpoint.end'));
  assert.ok(strict.missing.includes('runtime:native.stdin_write.end'));
  assert.throws(() => aggregateTrace(rows), /correlation/);
  assert.throws(() => aggregateTrace([...rows, row('desktop', 'desktop.request.begin', 1, { requestId: 'replay' })],
    { operationId: 'send-1' }), /Expected one request/);
});
test('runtime remainder counts the checkpoint only inside its enclosing record span', () => {
  const rows = [row('runtime', 'transport.dispatch.begin', 0), row('runtime', 'transport.dispatch.end', 100000),
    row('runtime', 'provider.worker_lock.end', 10000, { durationUs: 10000 }),
    row('runtime', 'review.checkpoint.end', 40000, { durationUs: 30000 }),
    row('runtime', 'persistence.record.end', 50000, { durationUs: 40000 }),
    row('runtime', 'provider.handoff.end', 70000, { durationUs: 20000 }),
    row('runtime', 'persistence.complete.end', 75000, { durationUs: 5000 })];
  const { metrics } = aggregateTrace(rows, { operationId: 'send-1' });
  assert.equal(metrics.checkpointMs, 30);
  assert.equal(metrics.recordMs, 40);
  assert.equal(metrics.runtimeOtherMs, 25);
  const missingCheckpoint = aggregateTrace(rows.filter(value => value.stage !== 'review.checkpoint.end'),
    { operationId: 'send-1', strictSend: true });
  assert.equal(missingCheckpoint.metrics.checkpointMs, null);
  assert.equal(missingCheckpoint.metrics.runtimeOtherMs, 25, 'record still covers the missing nested checkpoint');
  assert.ok(missingCheckpoint.missing.includes('runtime:review.checkpoint.end'));
  const missingRecord = aggregateTrace(rows.filter(value => value.stage !== 'persistence.record.end'),
    { operationId: 'send-1' });
  assert.equal(missingRecord.metrics.runtimeOtherMs, null, 'a nested checkpoint cannot replace the record span');
});
test('missing, malformed and reversed spans are unknown rather than zero', () => {
  const rows = parseTrace('bad\n' + JSON.stringify(row('desktop', 'desktop.request.begin', 1000)) + '\n'
    + JSON.stringify(row('desktop', 'desktop.request.end', 1)) + '\n{"kind":"somethingElse"}\n');
  const result = aggregateTrace(rows, { requestId: 'request-1' });
  assert.equal(result.metrics.desktopTotalMs, null);
  assert.ok(result.missing.includes('runtime:provider.handoff.end'));
});
test('nearest-rank p90, conventional median, null exclusion and absent UI samples', () => {
  assert.deepEqual(distribution([null, NaN, undefined]), { n: 0, median: null, p90: null, max: null });
  assert.deepEqual(distribution([8, 1, 4, 2]), { n: 4, median: 3, p90: 8, max: 8 });
  const summaries = summarizeRuns([1, 2, 3].map((n, i) => ({ provider: 'codex', project: 'small',
    trace: { metrics: { handoffMs: n } }, ui: { submitToLabelSwitchMs: i ? n : null,
      submitToSettledMs: n + 1, sendingObserved: Boolean(i) } })));
  assert.equal(summaries[0].metrics.handoffMs.median, 2);
  assert.equal(summaries[0].ui.n, 2);
  assert.equal(summaries[0].ui.median, 2.5);
  assert.equal(summaries[0].sendingNotObserved, 1);
});

test('checkpoint assertion excludes one warm-up and checks repeated median plus p90 tolerance', () => {
  const run = (project, index, checkpointMs) => ({ provider: 'codex', project, index,
    trace: { metrics: { checkpointMs } }, ui: {}, checkpoint: { status: 'ready' } });
  const passing = [run('small', 0, 900), run('small', 1, 120), run('small', 2, 150),
    run('user-shaped', 0, 3000), run('user-shaped', 1, 540), run('user-shaped', 2, 660)];
  const report = checkpointTargetReport(passing, { toleranceMs: 75 });
  assert.equal(report.passed, true);
  assert.equal(report.checks.find(check => check.project === 'small').samples.median, 135);
  assert.equal(report.checks.find(check => check.project === 'user-shaped').samples.p90, 660);
  assert.throws(() => assertCheckpointTargets([...passing, run('small', 3, 226)], { toleranceMs: 75 }), /small:.*p90 226\.0 ms exceeds 225\.0 ms limit/);
  assert.throws(() => assertCheckpointTargets([run('small', 0, 500), run('small', 1, 100)], { toleranceMs: 0 }), /missing\/user-shaped/);
  const failedWarmup = passing.map((value, index) => index === 0 ? { ...value, checkpoint: { status: 'failed' } } : value);
  assert.throws(() => assertCheckpointTargets(failedWarmup, { toleranceMs: 75, requireReadyCheckpoints: true }), /small:.*lacked a ready review checkpoint/);
  const wrongTurn = passing.map((value, index) => index === 0 ? { ...value, checkpoint: { status: 'ready', turnIdMatchesExpected: false } } : value);
  assert.throws(() => assertCheckpointTargets(wrongTurn, { toleranceMs: 75, requireReadyCheckpoints: true }), /small:.*belong to another turn/);
});
