import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { waitForSurface, withMatrixEvidence } from "./helpers";
import {
  assertSnapshotReconciles,
  availabilityError,
  cleanupTimingCase,
  createTimingCase,
  driveTimingCase,
  killTimingPty,
  newTimingReport,
  reportShellForScenario,
  safeErrorKind,
  prepareTimingCase,
  timingSentinel,
  timingCaseId,
  waitForMarkerEvidence,
  waitForSentinelExactlyOnce,
  waitForStartupSent,
  type HarnessSnapshot,
  type TimingCase,
  type TimingReport,
  type TimingScenario,
} from "./timing.helpers";

const reportPath = process.env.THREADTERM_WDIO_REPORT;
const scenarios: readonly TimingScenario[] = [
  "holdMarker",
  "manualTimeout",
  "lateMarker",
  "sameTick",
];

function record(report: TimingReport): void {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence(report))}\n`);
}

function updateFromHarness(
  report: TimingReport,
  snapshot: HarnessSnapshot,
): void {
  report.driveCount = snapshot.timing.drive;
  report.readyCount = snapshot.timing.ready;
  report.timeoutCount = snapshot.timing.timeout;
  report.sameTickCount = snapshot.timing.sameTick;
  report.sentObserved = snapshot.timing.sentObserved;
  report.snapshotReads = snapshot.counters.snapshotReads;
}

function expectedTiming(
  scenario: TimingScenario,
): Pick<
  TimingReport,
  | "driveCount"
  | "readyCount"
  | "timeoutCount"
  | "sameTickCount"
  | "sentObserved"
> {
  switch (scenario) {
    case "holdMarker":
      return {
        driveCount: 1,
        readyCount: 1,
        timeoutCount: 0,
        sameTickCount: 0,
        sentObserved: 1,
      };
    case "manualTimeout":
      return {
        driveCount: 1,
        readyCount: 0,
        timeoutCount: 1,
        sameTickCount: 0,
        sentObserved: 1,
      };
    case "lateMarker":
      return {
        driveCount: 2,
        readyCount: 1,
        timeoutCount: 1,
        sameTickCount: 0,
        sentObserved: 1,
      };
    case "sameTick":
      return {
        driveCount: 1,
        readyCount: 0,
        timeoutCount: 0,
        sameTickCount: 1,
        sentObserved: 1,
      };
  }
}

function actionFor(
  scenario: TimingScenario,
): "releaseReady" | "fireTimeout" | "raceReadyTimeout" {
  switch (scenario) {
    case "holdMarker":
    case "lateMarker":
      return "releaseReady";
    case "manualTimeout":
      return "fireTimeout";
    case "sameTick":
      return "raceReadyTimeout";
  }
}

function shellFamilyUsesMarker(
  shellFamily: TimingCase["shellFamily"],
): boolean {
  return shellFamily === "pwsh" || shellFamily === "windowsPowerShell";
}

async function runTimingCase(scenario: TimingScenario): Promise<void> {
  const started = Date.now();
  const availability = availabilityError(scenario);
  const shell = (() => {
    try {
      return reportShellForScenario(scenario);
    } catch {
      return undefined;
    }
  })();
  const report = newTimingReport(scenario, shell, started);
  let caseToken: string | undefined;
  let ptyId: string | undefined;
  let timingCase: TimingCase | undefined;
  let primaryError: unknown;
  let cleanupError: Error | undefined;

  try {
    if (availability) {
      report.availability = "unavailable";
      report.status =
        availability.message === "timing-shell-unavailable"
          ? "unavailable"
          : "failed";
      report.errorKind = safeErrorKind(availability);
      if (report.status === "failed") primaryError = availability;
      return;
    }
    if (!shell) throw new Error("timing-shell-unavailable");
    caseToken = await prepareTimingCase(scenario, shell);
    const sentinel = timingSentinel();
    ptyId = timingCaseId(scenario, shell);
    timingCase = await createTimingCase(
      scenario,
      shell,
      caseToken,
      sentinel,
      ptyId,
    );
    report.disposition = timingCase.disposition;
    report.shellFamily = timingCase.shellFamily;

    const querySnapshot = await assertSnapshotReconciles(
      timingCase,
      timingCase.startup,
    );
    if (querySnapshot.state !== "waiting")
      throw new Error("timing-snapshot-mismatch");

    // The second same-id create observes the same generation and snapshot.
    // This is the public-API reconciliation fallback for a listener that was
    // registered before or after create; it never sends startup input itself.
    if (scenario === "holdMarker") {
      const follower = await createTimingCase(
        scenario,
        shell,
        caseToken,
        sentinel,
        ptyId,
      );
      if (
        follower.disposition !== "attached" ||
        follower.generation !== timingCase.generation
      ) {
        throw new Error("timing-snapshot-mismatch");
      }
    }

    if (shellFamilyUsesMarker(timingCase.shellFamily)) {
      const marker = await waitForMarkerEvidence(caseToken);
      report.markerMatched = marker.markerMatched ? "yes" : "no";
      updateFromHarness(report, marker);
    }

    if (scenario === "lateMarker") {
      const timeoutSnapshot = await driveTimingCase(timingCase, "fireTimeout");
      updateFromHarness(report, timeoutSnapshot);
      const timeoutState = await waitForStartupSent(
        timingCase.ptyId,
        timingCase.generation,
      );
      if (timeoutState.state !== "sent")
        throw new Error("timing-startup-failed");
      const lateSnapshot = await driveTimingCase(timingCase, "releaseReady");
      updateFromHarness(report, lateSnapshot);
    } else {
      const driven = await driveTimingCase(timingCase, actionFor(scenario));
      updateFromHarness(report, driven);
    }

    const evidence = await waitForSentinelExactlyOnce(
      timingCase.ptyId,
      timingCase.generation,
      caseToken,
      timingCase.sentinel,
    );
    report.startup = evidence.startup.state === "sent" ? "sent" : "notObserved";
    report.sentinelMatches = evidence.matches;
    updateFromHarness(report, evidence.harness);
    const expected = expectedTiming(scenario);
    if (report.startup !== "sent") throw new Error("timing-startup-failed");
    if (report.sentinelMatches !== 1)
      throw new Error("timing-sentinel-missing");
    if (
      !Object.entries(expected).every(
        ([key, value]) => report[key as keyof TimingReport] === value,
      )
    ) {
      throw new Error("timing-snapshot-mismatch");
    }
    report.status = "passed";
  } catch (error) {
    primaryError = error;
    report.status = "failed";
    report.errorKind = safeErrorKind(error);
  } finally {
    let killObserved: boolean | undefined;
    if (ptyId) {
      report.cleanup = "notStarted";
      const killed = await killTimingPty(ptyId);
      killObserved = killed;
      report.cleanup = killed ? "killed" : "killNotObserved";
      if (!killed && !primaryError)
        cleanupError = new Error("timing-cleanup-failed");
    } else {
      report.cleanup = "notPrepared";
    }
    if (caseToken) {
      const cleaned = await cleanupTimingCase(caseToken);
      if (cleaned) {
        if (killObserved !== false) report.cleanup = "cleaned";
      } else {
        report.cleanup = "cleanupFailed";
        cleanupError ??= new Error("timing-cleanup-failed");
      }
    }
    if (!primaryError && cleanupError) {
      primaryError = cleanupError;
      report.status = "failed";
      report.errorKind = safeErrorKind(cleanupError);
    }
    report.elapsedMs = Date.now() - started;
    record(report);
  }

  if (primaryError) throw primaryError;
}

describe("harness provider startup timing", () => {
  before(async () => {
    if ((process.env.THREADTERM_WDIO_ARTIFACT ?? "production") !== "harness") {
      throw new Error("timing-requires-harness-artifact");
    }
    if (!process.env.THREADTERM_WDIO_DATA_ROOT)
      throw new Error("timing-data-root-missing");
    await waitForSurface();
  });

  for (const scenario of scenarios) {
    it(`proves ${scenario} dispatches one synthetic command`, async () => {
      await runTimingCase(scenario);
    });
  }
});
