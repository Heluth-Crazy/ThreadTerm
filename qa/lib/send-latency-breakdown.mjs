// Durations are calculated within one process only. IDs join the clock domains.
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, median: null, p90: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90: sorted[Math.ceil(sorted.length * .9) - 1], max: sorted.at(-1) };
}

export function parseTrace(text) {
  return text.split(/\r?\n/u).flatMap(line => {
    try { const row = JSON.parse(line); return row.kind === 'threadterm.sendTrace' ? [row] : []; }
    catch { return []; }
  });
}

export function aggregateTrace(allRows, { operationId, requestId, strictSend = false, expectStdin = false } = {}) {
  if (!operationId && !requestId) throw Error('A send correlation ID is required');
  const rows = allRows.filter(row => (!operationId || row.operationId === operationId)
    && (!requestId || row.requestId === requestId));
  const requests = [...new Set(rows.map(row => row.requestId).filter(Boolean))];
  if (requests.length !== 1) throw Error(`Expected one request for ${operationId ?? requestId}; got ${requests.length}`);
  const selected = (source, stage) => rows.filter(row => row.source === source && row.stage === stage);
  const first = (source, stage) => selected(source, stage).sort((a, b) => a.monotonicUs - b.monotonicUs)[0];
  const span = (source, begin, end) => {
    const a = first(source, begin), b = first(source, end);
    return a && b && Number.isFinite(a.monotonicUs) && b.monotonicUs >= a.monotonicUs
      ? (b.monotonicUs - a.monotonicUs) / 1000 : null;
  };
  const elapsed = (source, stage, field = 'durationUs') => {
    const value = first(source, stage)?.[field];
    return Number.isFinite(value) && value >= 0 ? value / 1000 : null;
  };
  const metrics = {
    desktopTotalMs: span('desktop', 'desktop.request.begin', 'desktop.request.end'),
    desktopBeforeWriteMs: span('desktop', 'desktop.request.begin', 'desktop.request.write'),
    desktopRoundTripMs: span('desktop', 'desktop.request.write', 'desktop.request.end'),
    orderedQueueMs: elapsed('runtime', 'transport.ordered.dequeue', 'queueWaitUs'),
    runtimeDispatchMs: span('runtime', 'transport.dispatch.begin', 'transport.dispatch.end'),
    serviceMs: span('runtime', 'service.chat_send.begin', 'service.chat_send.end'),
    checkpointMs: elapsed('runtime', 'review.checkpoint.end'),
    workerLockMs: elapsed('runtime', 'provider.worker_lock.end'),
    recordMs: elapsed('runtime', 'persistence.record.end'),
    handoffMs: elapsed('runtime', 'provider.handoff.end'),
    stdinWriteMs: elapsed('runtime', 'native.stdin_write.end'),
    completeMs: elapsed('runtime', 'persistence.complete.end'),
  };
  // Handoff includes adapter code and native acceptance, NOT necessarily model time.
  // Checkpoint capture runs inside persistence.record; subtract that enclosing span only.
  const covered = ['workerLockMs', 'recordMs', 'handoffMs', 'completeMs'].map(key => metrics[key]);
  metrics.runtimeOtherMs = Number.isFinite(metrics.runtimeDispatchMs) && covered.every(Number.isFinite)
    ? Math.max(0, metrics.runtimeDispatchMs - covered.reduce((a, b) => a + b, 0)) : null;
  const git = rows.filter(row => row.source === 'runtime' && row.stage === 'review.git.exit')
    .map(row => ({ step: row.step, outcome: row.outcome, ms: row.durationUs / 1000 }));
  const required = [['desktop', 'desktop.request.begin'], ['desktop', 'desktop.request.end'],
    ['runtime', 'transport.ordered.enqueue'], ['runtime', 'transport.ordered.dequeue'],
    ['runtime', 'transport.dispatch.begin'], ['runtime', 'transport.dispatch.end'],
    ['runtime', 'provider.handoff.end'], ['runtime', 'persistence.complete.end']];
  if (strictSend) {
    required.push(['desktop', 'desktop.request.write']);
    for (const prefix of ['service.chat_send', 'review.checkpoint', 'provider.worker_lock', 'persistence.record',
      'provider.handoff', 'persistence.complete', ...(expectStdin ? ['native.stdin_write'] : [])]) {
      for (const suffix of ['begin', 'end']) required.push(['runtime', `${prefix}.${suffix}`]);
    }
  }
  return { operationId: operationId ?? rows[0]?.operationId, requestId: requests[0], metrics, git,
    missing: [...new Set(required.filter(([source, stage]) => !first(source, stage)).map(([source, stage]) => `${source}:${stage}`))],
    activeAhead: first('runtime', 'transport.ordered.enqueue')?.activeMethod ?? null, rows };
}

export function summarizeRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.provider}/${run.project}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups].map(([group, values]) => {
    const metricNames = [...new Set(values.flatMap(value => Object.keys(value.trace.metrics)))];
    return { group, n: values.length, metrics: Object.fromEntries(metricNames.map(name =>
      [name, distribution(values.map(value => value.trace.metrics[name]))])),
    ui: distribution(values.map(value => value.ui.submitToLabelSwitchMs)),
    button: distribution(values.map(value => value.ui.submitToButtonSwitchMs)),
    submitToSettled: distribution(values.map(value => value.ui.submitToSettledMs)),
    sendingNotObserved: values.filter(value => !value.ui.sendingObserved).length };
  });
}

const DEFAULT_CHECKPOINT_TARGETS = Object.freeze({ small: 150, 'user-shaped': 600 });

// The first checkpoint warms a newly created worktree/private index. Subsequent
// sends must use the reusable checkpoint path, so assertions intentionally omit it.
export function checkpointTargetReport(runs, { warmup = 1, minimumSamples = 2, toleranceMs = 75,
  targets = DEFAULT_CHECKPOINT_TARGETS, requireReadyCheckpoints = false } = {}) {
  if (!Number.isInteger(warmup) || warmup < 0) throw Error('warmup must be a non-negative integer');
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1) throw Error('minimumSamples must be a positive integer');
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) throw Error('toleranceMs must be non-negative');
  const groups = new Map();
  for (const run of runs) {
    if (!Object.hasOwn(targets, run.project)) continue;
    const key = `${run.provider}/${run.project}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const checks = [...groups].map(([group, values]) => {
    const repeated = values.filter((run, position) => (run.index ?? position) >= warmup);
    const samples = repeated.map(run => run.trace.metrics.checkpointMs).filter(Number.isFinite);
    const targetMs = targets[values[0].project];
    const stats = distribution(samples);
    const p90LimitMs = targetMs + toleranceMs;
    const invalidCheckpoints = values.filter(run => run.checkpoint?.status !== 'ready');
    const turnIdMismatches = values.filter(run => run.checkpoint?.turnIdMatchesExpected === false);
    const failures = [];
    // Checkpoint validity is independent of timing: a failed warm-up is still
    // a failed pre-turn baseline and must never become a passing fast sample.
    if (requireReadyCheckpoints && invalidCheckpoints.length) failures.push(`${invalidCheckpoints.length} sample(s) lacked a ready review checkpoint`);
    if (requireReadyCheckpoints && turnIdMismatches.length) failures.push(`${turnIdMismatches.length} checkpoint(s) belong to another turn`);
    if (stats.n < minimumSamples) failures.push(`need ${minimumSamples} repeated samples; got ${stats.n}`);
    if (stats.median !== null && stats.median > targetMs) failures.push(`median ${stats.median.toFixed(1)} ms exceeds ${targetMs} ms target`);
    // With the usual five sends, excluding the warm-up leaves four samples and
    // nearest-rank p90 is their maximum: this catches a slow repeated send.
    if (stats.p90 !== null && stats.p90 > p90LimitMs) failures.push(`p90 ${stats.p90.toFixed(1)} ms exceeds ${p90LimitMs.toFixed(1)} ms limit`);
    return { group, project: values[0].project, excludedWarmup: values.length - repeated.length,
      targetMs, toleranceMs, p90LimitMs, samples: stats, checkpoints: { required: requireReadyCheckpoints,
        ready: values.length - invalidCheckpoints.length, invalid: invalidCheckpoints.length,
        turnIdMismatches: turnIdMismatches.length }, passed: failures.length === 0, failures };
  });
  const expected = new Set(Object.keys(targets));
  for (const value of groups.values()) expected.delete(value[0].project);
  for (const project of expected) checks.push({ group: `missing/${project}`, project, excludedWarmup: 0,
    targetMs: targets[project], toleranceMs, p90LimitMs: targets[project] + toleranceMs,
    samples: distribution([]), checkpoints: { required: requireReadyCheckpoints, ready: 0, invalid: 0, turnIdMismatches: 0 }, passed: false, failures: ['no provider runs'] });
  return { warmup, minimumSamples, toleranceMs, checks, passed: checks.every(check => check.passed) };
}

export function assertCheckpointTargets(runs, options) {
  const report = checkpointTargetReport(runs, options);
  if (!report.passed) {
    const detail = report.checks.filter(check => !check.passed)
      .map(check => `${check.group}: ${check.failures.join('; ')}`).join(' | ');
    throw Error(`Repeated checkpoint targets failed: ${detail}`);
  }
  return report;
}
