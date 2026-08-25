import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { invoke, waitForSurface, withMatrixEvidence } from './helpers';
import {
  ENCODING_MODES,
  ENCODING_SHELLS,
  PROBE_NAMES,
  assertPrivateMarkerAbsent,
  createEncodingCase,
  encodingCaseId,
  newEncodingReport,
  prepareEncodingCase,
  requireEncodingEnvironment,
  runProbe,
  safeEncodingErrorKind,
  sendCommand,
  syntheticEncodingProviderCommand,
  syntheticRoundTripCommand,
  waitForCaseBound,
  waitForMarkerEvidence,
  waitForRoundTrip,
  waitForSentinelExactlyOnce,
  type EncodingEnvironment,
  type EncodingMode,
  type EncodingReport,
  type EncodingShell,
  type ProbeName,
  type ProbeStatus,
} from './encoding.helpers';
import { waitForStartupSent } from './provider.helpers';

const reportPath = process.env.THREADTERM_WDIO_REPORT;
let environment: EncodingEnvironment | undefined;

function record(report: EncodingReport): void {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence(report))}\n`);
}

function setProbeStatus(report: EncodingReport, name: ProbeName, status: ProbeStatus): void {
  report[name] = status;
  if (status === 'passed') report.probePassed += 1;
  if (status === 'unavailable') report.probeUnavailable += 1;
  if (status === 'failed') report.probeFailed += 1;
}

function updateElapsed(report: EncodingReport, started: number): void {
  report.elapsedMs = Date.now() - started;
}

function modeNeedsProviderSentinel(mode: EncodingMode): boolean {
  return mode === 'syntheticProvider';
}

async function runEncodingCase(shell: EncodingShell, mode: EncodingMode): Promise<void> {
  const started = Date.now();
  const currentEnvironment = environment;
  if (!currentEnvironment) throw new Error('encoding-environment-missing');
  const report = newEncodingReport(shell, mode, currentEnvironment, started);
  let caseToken: string | undefined;
  let ptyId: string | undefined;
  let primaryError: unknown;
  let cleanupError: Error | undefined;
  const markerLeaks = { value: 0 };

  try {
    if (currentEnvironment.shellAvailability[shell] === 'unavailable') {
      report.status = 'unavailable';
      return;
    }

    caseToken = await prepareEncodingCase(shell, mode);
    ptyId = encodingCaseId(shell, mode);
    const createdCase = await createEncodingCase(
      shell,
      mode,
      currentEnvironment,
      ptyId,
    );
    ({ ptyId } = createdCase);
    report.shellFamily = createdCase.shellFamily;
    await waitForCaseBound(caseToken);
    if (mode === 'syntheticProvider') await waitForStartupSent(ptyId, createdCase.generation);

    if (modeNeedsProviderSentinel(mode)) {
      if (currentEnvironment.providerReady) {
        await waitForMarkerEvidence(caseToken);
        report.markerMatched = 'yes';
      } else {
        report.markerMatched = 'no';
      }
    }

    await assertPrivateMarkerAbsent(ptyId, markerLeaks);

    if (mode === 'plain') {
      await sendCommand(ptyId, syntheticEncodingProviderCommand(shell));
    }
    report.sentinelMatches = await waitForSentinelExactlyOnce(ptyId, markerLeaks);
    if (report.sentinelMatches !== 1) throw new Error('encoding-sentinel-missing');

    await sendCommand(ptyId, syntheticRoundTripCommand(currentEnvironment.utf8Enabled));
    report.roundTripMatches = await waitForRoundTrip(
      ptyId,
      currentEnvironment.utf8Enabled,
      markerLeaks,
    );
    if (currentEnvironment.utf8Enabled) {
      report.roundTrip = 'passed';
    }

    for (const probe of PROBE_NAMES) {
      const status = await runProbe(ptyId, probe, markerLeaks);
      setProbeStatus(report, probe, status);
      if (status === 'failed') throw new Error('encoding-probe-failed');
    }
    if (report.probeFailed !== 0) throw new Error('encoding-probe-failed');
    report.markerLeaks = markerLeaks.value;
    report.status = 'passed';
  } catch (error) {
    primaryError = error;
    report.markerLeaks = markerLeaks.value;
    report.status = 'failed';
    report.errorKind = safeEncodingErrorKind(error);
  } finally {
    if (ptyId) {
      const killed = await invoke('pty_kill', { id: ptyId });
      report.cleanup = killed.ok ? 'killed' : 'killNotObserved';
      if (!killed.ok && !primaryError) cleanupError = new Error('encoding-kill-failed');
    } else {
      report.cleanup = 'notPrepared';
    }
    if (caseToken) {
      const cleaned = await invoke('terminal_startup_harness_cleanup_case', { caseToken });
      if (!cleaned.ok) {
        report.cleanup = 'cleanupFailed';
        cleanupError ??= new Error('encoding-cleanup-failed');
      }
    }
    if (!primaryError && cleanupError) {
      primaryError = cleanupError;
      report.status = 'failed';
      report.errorKind = safeEncodingErrorKind(cleanupError);
    }
    updateElapsed(report, started);
    record(report);
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

describe('harness real ConPTY PowerShell encoding', () => {
  before(async () => {
    // The runner must set every process-scoped flag explicitly.  An absent or
    // malformed value is a harness configuration error, never an implicit
    // rollback or a passing compatibility result.
    environment = requireEncodingEnvironment();
    await waitForSurface();
  });

  for (const shell of ENCODING_SHELLS) {
    for (const mode of ENCODING_MODES) {
      it(`round-trips UTF-8 and fixed tool probes for ${shell}/${mode}`, async () => {
        await runEncodingCase(shell, mode);
      });
    }
  }
});
