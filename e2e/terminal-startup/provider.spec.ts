import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { invoke, waitForSurface, withMatrixEvidence } from './helpers';
import {
  assertProviderSessionWritable,
  harnessShellValue,
  killProviderSessionAndConfirm,
  ProviderConcurrencyBarrier,
  PROVIDER_SHELLS,
  PROVIDER_SENTINEL,
  shellAvailability,
  syntheticProviderCommand,
  providerUnavailableSamplePlan,
  waitForSentinelExactlyOnce,
  waitForStartupSent,
  type ProviderShell,
} from './provider.helpers';

const reportPath = process.env.THREADTERM_WDIO_REPORT;
const dataRoot = process.env.THREADTERM_WDIO_DATA_ROOT;

// Pure seam guard: this executes while the spec is loaded and does not touch
// browser/Tauri state.  Unavailable N=5 must still describe five distinct
// planned slots rather than collapsing into a slot-zero aggregate.
const unavailableContract = providerUnavailableSamplePlan(5, 1);
if (
  unavailableContract.length !== 5
  || new Set(unavailableContract.map((sample) => sample.slot)).size !== 5
  || unavailableContract.some((sample, index) => sample.slot !== index + 1 || sample.repetition !== 1)
) {
  throw new Error('provider-unavailable-sample-plan-contract-failed');
}
const evidenceProjectionContract = withMatrixEvidence({
  status: 'unavailable',
  errorKind: 'shellUnavailable',
});
const inferredShellProjectionContract = withMatrixEvidence({
  status: 'unavailable',
});
const toolProjectionContract = withMatrixEvidence({
  status: 'passed',
  probeUnavailable: 1,
});
if (
  Object.keys(evidenceProjectionContract.correctness).sort().join(',') !== 'blank,duplicate,lostDa1,orphan,unwritable'
  || Object.values(evidenceProjectionContract.correctness).some((value) => value !== 0)
  || evidenceProjectionContract.exclusion !== 'shellUnavailable'
  || inferredShellProjectionContract.exclusion !== 'shellUnavailable'
  || toolProjectionContract.exclusion !== 'toolUnavailable'
) {
  throw new Error('matrix-evidence-projection-contract-failed');
}

type ProviderReport = {
  kind: 'harness-provider';
  artifact: 'harness';
  flow: 'provider';
  shell: ProviderShell;
  availability: 'available' | 'unavailable';
  status: 'passed' | 'unavailable' | 'failed';
  startup: 'sent' | 'notObserved';
  disposition: 'created' | 'attached' | 'unknown';
  shellFamily: 'pwsh' | 'windowsPowerShell' | 'cmd' | 'posix' | 'unknown';
  sentinelMatches: number;
  expectedConcurrency: number;
  peakConcurrentAlive: number;
  barrierReleased: boolean;
  sessionDisappeared: boolean;
  slot: number;
  repetition: number;
  cleanup: 'notStarted' | 'killed' | 'killNotObserved' | 'cleaned' | 'cleanupFailed' | 'notPrepared';
  elapsedMs: number;
  errorKind?:
    | 'shellUnavailable'
    | 'requiredCmdUnavailable'
    | 'availabilityMissing'
    | 'prepareFailed'
    | 'createFailed'
    | 'createIdentityMismatch'
    | 'createShellMismatch'
    | 'caseNotBound'
    | 'unexpectedDisposition'
    | 'startupFailed'
    | 'startupTimeout'
    | 'sentinelMissing'
    | 'sentinelDuplicate'
    | 'killFailed'
    | 'cleanupFailed'
    | 'concurrencyBarrierTimeout'
    | 'concurrencyBarrierFailed'
    | 'concurrencyBarrierOverflow'
    | 'duplicateSessionIdentity'
    | 'sessionNotAlive'
    | 'sessionDisappearanceTimeout'
    | 'unexpected';
};

function record(report: ProviderReport): void {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence(report))}\n`);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeErrorKind(error: unknown): ProviderReport['errorKind'] {
  const message = error instanceof Error ? error.message : '';
  if (message === 'provider-shell-availability-missing') return 'availabilityMissing';
  if (message === 'required-cmd-shell-unavailable') return 'requiredCmdUnavailable';
  if (message === 'provider-prepare-failed') return 'prepareFailed';
  if (message === 'provider-create-failed') return 'createFailed';
  if (message === 'provider-create-identity-mismatch') return 'createIdentityMismatch';
  if (message === 'provider-create-shell-mismatch') return 'createShellMismatch';
  if (message === 'provider-case-not-bound') return 'caseNotBound';
  if (message === 'provider-unexpected-disposition') return 'unexpectedDisposition';
  if (message === 'provider-startup-terminal-state') return 'startupFailed';
  if (message === 'provider-startup-sent-timeout') return 'startupTimeout';
  if (message === 'provider-sentinel-missing') return 'sentinelMissing';
  if (message === 'provider-sentinel-duplicate') return 'sentinelDuplicate';
  if (message === 'provider-kill-failed') return 'killFailed';
  if (message === 'provider-cleanup-failed') return 'cleanupFailed';
  if (message === 'provider-concurrency-barrier-timeout') return 'concurrencyBarrierTimeout';
  if (message === 'provider-concurrency-barrier-failed') return 'concurrencyBarrierFailed';
  if (message === 'provider-concurrency-barrier-overflow') return 'concurrencyBarrierOverflow';
  if (message === 'provider-duplicate-session-identity') return 'duplicateSessionIdentity';
  if (message === 'provider-session-not-alive') return 'sessionNotAlive';
  if (message === 'provider-session-disappearance-timeout') return 'sessionDisappearanceTimeout';
  if (message === 'provider-command-contains-sentinel') return 'unexpected';
  return 'unexpected';
}

function newReport(
  shell: ProviderShell,
  started: number,
  slot = 0,
  repetition = 0,
  expectedConcurrency = 1,
): ProviderReport {
  return {
    kind: 'harness-provider',
    artifact: 'harness',
    flow: 'provider',
    shell,
    availability: 'available',
    status: 'failed',
    startup: 'notObserved',
    disposition: 'unknown',
    shellFamily: 'unknown',
    sentinelMatches: 0,
    expectedConcurrency,
    peakConcurrentAlive: 0,
    barrierReleased: false,
    sessionDisappeared: false,
    slot,
    repetition,
    cleanup: 'notStarted',
    elapsedMs: Date.now() - started,
  };
}

function updateElapsed(report: ProviderReport, started: number): void {
  report.elapsedMs = Date.now() - started;
}

async function runProviderCase(
  shell: ProviderShell,
  slot: number,
  repetition: number,
  barrier: ProviderConcurrencyBarrier,
): Promise<void> {
  const started = Date.now();
  const report = newReport(shell, started, slot, repetition, barrier.snapshot().expectedConcurrency);
  const ptyId = `terminal-startup-provider-${shell}-${slot}-${repetition}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let caseToken: string | undefined;
  let createAttempted = false;
  let primaryError: unknown;
  let cleanupError: Error | undefined;

  try {
    const command = syntheticProviderCommand(shell);
    if (command.includes(PROVIDER_SENTINEL)) throw new Error('provider-command-contains-sentinel');

    const prepared = await invoke('terminal_startup_harness_prepare_case', {
      request: {
        shell: harnessShellValue(shell),
        surface: 'uiNextCreate',
        timing: 'natural',
        da1Fault: 'none',
        warmup: 'disabled',
        fixture: 'syntheticProvider',
      },
    });
    const preparedValue = objectValue(prepared.value);
    caseToken = prepared.ok ? stringValue(preparedValue?.caseToken) : undefined;
    if (!caseToken) throw new Error('provider-prepare-failed');

    // This is the only supported working directory for the provider flow.
    if (!dataRoot) throw new Error('provider-create-failed');

    // Call the production v2 command directly. No renderer output consumer or
    // frontend startup callback participates in this assertion.
    createAttempted = true;
    const createdResult = await invoke('pty_create_session_v2', {
      request: {
        id: ptyId,
        workingDir: dataRoot,
        rows: 24,
        cols: 100,
        startup: {
          kind: 'provider',
          provider: 'codex',
          command,
          cardId: `terminal-startup-harness-card-${slot}-${repetition}`,
          action: 'start',
          sideEffectPlan: {
            kind: 'bind',
            providerSessionId: `terminal-startup-harness-session-${slot}-${repetition}`,
          },
        },
      },
    });
    const createdValue = objectValue(createdResult.value);
    const generation = stringValue(createdValue?.generation);
    const returnedPtyId = stringValue(createdValue?.ptyId);
    report.disposition = createdValue?.disposition === 'created' || createdValue?.disposition === 'attached'
      ? createdValue.disposition
      : 'unknown';
    report.shellFamily = createdValue?.shellFamily === 'pwsh'
      || createdValue?.shellFamily === 'windowsPowerShell'
      || createdValue?.shellFamily === 'cmd'
      || createdValue?.shellFamily === 'posix'
      ? createdValue.shellFamily
      : 'unknown';
    if (!createdResult.ok || !generation) throw new Error('provider-create-failed');
    if (returnedPtyId !== ptyId) throw new Error('provider-create-identity-mismatch');
    if (report.shellFamily !== shell) throw new Error('provider-create-shell-mismatch');
    if (report.disposition !== 'created') throw new Error('provider-unexpected-disposition');
    const boundSnapshot = await invoke('terminal_startup_harness_snapshot', { caseToken });
    const boundState = objectValue(boundSnapshot.value)?.state;
    if (!boundSnapshot.ok || boundState !== 'bound') throw new Error('provider-case-not-bound');

    await waitForStartupSent(ptyId, generation);
    report.startup = 'sent';
    report.sentinelMatches = await waitForSentinelExactlyOnce(ptyId);
    if (report.sentinelMatches !== 1) throw new Error('provider-sentinel-missing');
    // The startup sentinel is the fixed synthetic write/readback proof.  The
    // barrier adds a live-session check and only releases once every distinct
    // case in this round is concurrently registered and still writable.
    await assertProviderSessionWritable(ptyId);
    const barrierSnapshot = await barrier.arriveAndWait(ptyId);
    report.expectedConcurrency = barrierSnapshot.expectedConcurrency;
    report.peakConcurrentAlive = barrierSnapshot.peakConcurrentAlive;
    report.barrierReleased = barrierSnapshot.barrierReleased;
    report.status = 'passed';
  } catch (error) {
    primaryError = error;
    barrier.abort(error);
    report.status = 'failed';
    report.errorKind = safeErrorKind(error);
  } finally {
    // Cleanup order is intentional: terminate the real PTY before retiring
    // the opaque harness binding, even when creation or observation failed.
    const barrierSnapshot = barrier.snapshot();
    report.expectedConcurrency = barrierSnapshot.expectedConcurrency;
    report.peakConcurrentAlive = barrierSnapshot.peakConcurrentAlive;
    report.barrierReleased = barrierSnapshot.barrierReleased;
    if (createAttempted) {
      const killed = await killProviderSessionAndConfirm(ptyId);
      report.sessionDisappeared = killed.disappeared;
      report.cleanup = killed.disappeared ? 'killed' : 'killNotObserved';
      if (!killed.killRequested) cleanupError = new Error('provider-kill-failed');
      else if (!killed.disappeared) cleanupError = new Error('provider-session-disappearance-timeout');
    } else {
      report.sessionDisappeared = true;
      report.cleanup = 'notPrepared';
    }

    if (caseToken) {
      const cleaned = await invoke('terminal_startup_harness_cleanup_case', { caseToken });
      if (cleaned.ok && report.sessionDisappeared) {
        report.cleanup = 'cleaned';
      } else if (!cleaned.ok) {
        report.cleanup = 'cleanupFailed';
        cleanupError ??= new Error('provider-cleanup-failed');
      }
    }
    if (!primaryError && cleanupError) {
      report.status = 'failed';
      report.errorKind = safeErrorKind(cleanupError);
    }
    updateElapsed(report, started);
    record(report);
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

describe('harness synthetic provider startup', () => {
  before(async () => {
    await waitForSurface();
    if (!dataRoot) throw new Error('provider-data-root-missing');
  });

  const requestedConcurrency = Number.parseInt(process.env.THREADTERM_WDIO_CONCURRENCY ?? '1', 10);
  if (![1, 5, 20].includes(requestedConcurrency)) throw new Error('provider-concurrency-invalid');
  const requestedRepeats = Number.parseInt(process.env.THREADTERM_WDIO_PROVIDER_REPEATS ?? '1', 10);
  if (!Number.isSafeInteger(requestedRepeats) || requestedRepeats < 1 || requestedRepeats > 100) throw new Error('provider-repeats-invalid');
  const requestedShell = process.env.THREADTERM_WDIO_PROVIDER_SHELL;
  if (requestedShell !== undefined && !PROVIDER_SHELLS.includes(requestedShell as ProviderShell)) throw new Error('provider-shell-invalid');
  const selectedShells = requestedShell === undefined ? PROVIDER_SHELLS : [requestedShell as ProviderShell];
  const unavailableSamples = providerUnavailableSamplePlan(requestedConcurrency, requestedRepeats);
  const recordUnavailable = (
    shell: ProviderShell,
    status: 'unavailable' | 'failed',
    errorKind: NonNullable<ProviderReport['errorKind']>,
  ): void => {
    for (const sample of unavailableSamples) {
      const report = newReport(
        shell,
        Date.now(),
        sample.slot,
        sample.repetition,
        requestedConcurrency,
      );
      report.status = status;
      report.errorKind = errorKind;
      report.availability = 'unavailable';
      report.cleanup = 'notStarted';
      report.sessionDisappeared = true;
      record(report);
    }
  };

  for (const shell of selectedShells) {
    it(`dispatches one synthetic provider command for ${shell}`, async () => {
      let availability: ReturnType<typeof shellAvailability>;
      try {
        availability = shellAvailability(shell);
      } catch (error) {
        recordUnavailable(shell, 'failed', safeErrorKind(error) ?? 'unexpected');
        throw error;
      }
      if (availability === 'unavailable') {
        const isRequiredShell = shell === 'cmd';
        recordUnavailable(
          shell,
          isRequiredShell ? 'failed' : 'unavailable',
          isRequiredShell ? 'requiredCmdUnavailable' : 'shellUnavailable',
        );
        if (shell === 'cmd') throw new Error('required-cmd-shell-unavailable');
        return;
      }
      for (let repetition = 1; repetition <= requestedRepeats; repetition += 1) {
        const barrier = new ProviderConcurrencyBarrier(requestedConcurrency);
        const results = await Promise.allSettled(
          Array.from(
            { length: requestedConcurrency },
            (_, slot) => runProviderCase(shell, slot + 1, repetition, barrier),
          ),
        );
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (rejected) throw rejected.reason;
      }
    });
  }
});
