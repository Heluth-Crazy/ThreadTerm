import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { invoke, waitForSurface, withMatrixEvidence } from './helpers';
import {
  DA1_FAULTS,
  DA1_EXPECTED_QUERIES,
  da1AvailabilityFromEnvironment,
  da1HarnessShellValue,
  da1ShellFromEnvironment,
  deviceAttributesCommand,
  newDa1Report,
  runPriorityInputs,
  safeDa1ErrorKind,
  waitForDa1CaseBound,
  waitForDa1Counters,
  waitForDa1Output,
  type Da1Counters,
  type Da1Fault,
  type Da1Report,
} from './da1.helpers';

const reportPath = process.env.THREADTERM_WDIO_REPORT;
const dataRoot = process.env.THREADTERM_WDIO_DATA_ROOT;

function record(report: Da1Report): void {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence(report))}\n`);
}

function updateCounters(report: Da1Report, counters: Da1Counters): void {
  report.queries = counters.queries;
  report.committed = counters.committed;
  report.rejected = counters.rejected;
  report.zero = counters.zero;
  report.partial = counters.partial;
  report.unknown = counters.unknown;
  report.fatal = counters.fatal;
}

function assertCounters(fault: Da1Fault, counters: Da1Counters): void {
  if (fault === 'none') {
    if (counters.queries !== DA1_EXPECTED_QUERIES
      || counters.committed !== DA1_EXPECTED_QUERIES
      || counters.rejected !== 0
      || counters.zero !== 0
      || counters.partial !== 0
      || counters.unknown !== 0
      || counters.fatal !== 0) {
      throw new Error('da1-counter-mismatch');
    }
    return;
  }
  if (fault === 'reject') {
    if (counters.queries !== DA1_EXPECTED_QUERIES
      || counters.rejected !== 1
      || counters.committed !== DA1_EXPECTED_QUERIES - 1
      || counters.zero !== 0
      || counters.partial !== 0
      || counters.unknown !== 0
      || counters.fatal !== 0) {
      throw new Error('da1-counter-mismatch');
    }
    return;
  }
  if (fault === 'zero') {
    if (counters.queries !== DA1_EXPECTED_QUERIES
      || counters.zero !== 1
      || counters.committed !== DA1_EXPECTED_QUERIES - 1
      || counters.rejected !== 0
      || counters.partial !== 0
      || counters.unknown !== 0
      || counters.fatal !== 0) {
      throw new Error('da1-counter-mismatch');
    }
    return;
  }
  if (counters.queries !== 1
    || counters.committed !== 0
    || counters.rejected !== 0
    || counters.zero !== 0
    || (fault === 'partial' && (counters.partial !== 1 || counters.unknown !== 0))
    || (fault === 'unknown' && (counters.unknown !== 1 || counters.partial !== 0))
    || counters.fatal !== 1) {
    throw new Error('da1-counter-mismatch');
  }
}

function assertVisibleOutput(
  fault: Da1Fault,
  report: Da1Report,
): void {
  if (fault === 'partial' || fault === 'unknown') return;
  if (report.visibleMarkers !== 'preserved' || report.fakeSequences !== 'preserved') {
    throw new Error('da1-visible-output-mismatch');
  }
  if ((fault === 'reject' || fault === 'zero') && report.fallback !== 'observed') {
    throw new Error('da1-visible-output-mismatch');
  }
}

async function runDa1Case(fault: Da1Fault, withPriority = false): Promise<void> {
  const shell = da1ShellFromEnvironment();
  const started = Date.now();
  const report = newDa1Report(fault, shell);
  const ptyId = `terminal-startup-da1-${fault}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let caseToken: string | undefined;
  let createAttempted = false;
  let primaryError: unknown;
  let cleanupError: Error | undefined;

  try {
    const availability = da1AvailabilityFromEnvironment();
    report.availability = availability;
    if (availability === 'unavailable') {
      report.status = 'unavailable';
      report.errorKind = 'shellUnavailable';
      return;
    }
    if (process.env.THREADTERM_DA1_AUTHORITY !== '1') throw new Error('da1-authority-not-enabled');
    if (!dataRoot) throw new Error('da1-data-root-missing');

    const prepared = await invoke('terminal_startup_harness_prepare_case', {
      request: {
        shell: da1HarnessShellValue(shell),
        surface: 'uiNextCreate',
        timing: 'natural',
        da1Fault: fault,
        warmup: 'disabled',
        fixture: 'deviceAttributes',
      },
    });
    const preparedValue = prepared.ok && prepared.value && typeof prepared.value === 'object'
      ? prepared.value as Record<string, unknown>
      : undefined;
    caseToken = typeof preparedValue?.caseToken === 'string' ? preparedValue.caseToken : undefined;
    if (!caseToken) throw new Error('da1-prepare-failed');

    // Use an explicit `none` startup intent: the harness still binds the case
    // to this real create, while no renderer or Provider startup command is
    // involved before the protocol output is observed.
    createAttempted = true;
    const created = await invoke('pty_create_session_v2', {
      request: {
        id: ptyId,
        workingDir: dataRoot,
        rows: 24,
        cols: 100,
        startup: { kind: 'none' },
      },
    });
    const createdValue = created.value && typeof created.value === 'object'
      ? created.value as Record<string, unknown>
      : undefined;
    const returnedPtyId = typeof createdValue?.ptyId === 'string' ? createdValue.ptyId : undefined;
    const returnedShell = createdValue?.shellFamily;
    if (!created.ok) throw new Error('da1-create-failed');
    if (returnedPtyId !== ptyId) throw new Error('da1-create-identity-mismatch');
    if (returnedShell !== shell) throw new Error('da1-create-shell-mismatch');
    if (createdValue?.disposition !== 'created') throw new Error('da1-create-failed');

    await waitForDa1CaseBound(caseToken);

    const command = deviceAttributesCommand();
    let counters: Da1Counters;
    if (withPriority) {
      // The first user request executes the fixture before its filler reaches
      // the shell. The remaining 15 bounded requests keep the user lane busy
      // while the real reader enqueues the protocol replies, proving lane
      // priority without fabricating a writer completion.
      const priorityStarted = Date.now();
      const priorityWrites = runPriorityInputs(ptyId, command);
      const counterObservation = waitForDa1Counters(caseToken, fault);
      counters = await counterObservation;
      report.priority = 'completed';
      report.priorityElapsedMs = Date.now() - priorityStarted;
      if (report.priorityElapsedMs > 500) throw new Error('da1-priority-timeout');
      await priorityWrites;
      report.submittedBytes = 64 * 1024 * 16;
    } else {
      const input = `${command}\r`;
      const submitted = await invoke('pty_input', { id: ptyId, data: input });
      if (!submitted.ok) throw new Error('da1-priority-write-failed');
      report.submittedBytes = input.length;
      counters = await waitForDa1Counters(caseToken, fault);
    }

    updateCounters(report, counters);
    assertCounters(fault, counters);

    const observed = await waitForDa1Output(ptyId, fault);
    report.visibleMarkers = observed.visibleMarkers;
    report.fakeSequences = observed.fakeSequences;
    report.fallback = observed.fallback;
    if (!withPriority) assertVisibleOutput(fault, report);
    report.status = 'passed';
  } catch (error) {
    primaryError = error;
    report.errorKind = safeDa1ErrorKind(error);
    report.status = report.errorKind === 'availabilityMissing' || report.errorKind === 'shellUnavailable'
      ? 'unavailable'
      : 'failed';
    if (report.errorKind === 'availabilityMissing' || report.errorKind === 'shellUnavailable') {
      report.availability = 'unavailable';
    }
  } finally {
    if (createAttempted) {
      const killed = await invoke('pty_kill', { id: ptyId });
      report.cleanup = killed.ok ? 'killed' : 'alreadyGone';
      if (!killed.ok && fault !== 'partial' && fault !== 'unknown') {
        cleanupError = new Error('da1-kill-failed');
      }
    }
    if (caseToken) {
      const cleaned = await invoke('terminal_startup_harness_cleanup_case', { caseToken });
      if (!cleaned.ok) {
        report.cleanup = 'cleanupFailed';
        cleanupError ??= new Error('da1-cleanup-failed');
      }
    } else if (!createAttempted) {
      report.cleanup = 'notPrepared';
    }
    if (!primaryError && cleanupError) {
      primaryError = cleanupError;
      report.status = 'failed';
      report.errorKind = safeDa1ErrorKind(cleanupError);
    }
    report.elapsedMs = Date.now() - started;
    record(report);
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

describe('harness real ConPTY DA1 authority', () => {
  before(async () => {
    await waitForSurface();
  });

  for (const fault of DA1_FAULTS) {
    it(`keeps DA1 ${fault} semantics on the real PTY before renderer mount`, async () => {
      await runDa1Case(fault);
    });
  }

  it('preempts a queued 1 MiB user lane with a real DA1 reply', async () => {
    await runDa1Case('none', true);
  });
});
