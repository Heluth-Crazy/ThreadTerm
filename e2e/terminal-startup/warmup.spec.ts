import {
  configuredWarmupCase,
  copySnapshotToReport,
  cleanupWritablePtyCase,
  createWritablePty,
  killAndConfirmPty,
  newWarmupReport,
  pollWarmupSnapshot,
  readWarmupSnapshot,
  recordWarmupReport,
  releaseWarmupHold,
  safeWarmupErrorKind,
  writeAndObservePty,
  type WarmupCase,
  type WarmupCreate,
  type WarmupReport,
  type WarmupScenario,
} from "./warmup.helpers";

import { waitForSurface } from "./helpers";

type WarmupConfiguration = { case: WarmupCase; scenario: WarmupScenario };

let configuration: WarmupConfiguration | undefined;
let activePtyId: string | undefined;
let activeCaseToken: string | undefined;

async function createAndWrite(
  report: WarmupReport,
  ptyId: string,
): Promise<WarmupCreate> {
  const createStarted = Date.now();
  activePtyId = ptyId;
  let created: WarmupCreate;
  try {
    created = await createWritablePty(ptyId);
    activeCaseToken = created.caseToken;
  } catch (error) {
    report.create =
      error instanceof Error && error.message === "warmup-create-timeout"
        ? "timedOut"
        : "failed";
    throw error;
  }
  report.createElapsedMs = Date.now() - createStarted;
  report.create = "created";
  report.disposition = created.disposition;
  if (created.disposition !== "created") {
    throw new Error("warmup-outcome-mismatch");
  }
  try {
    report.write = await writeAndObservePty(created.ptyId);
  } catch (error) {
    report.write = "failed";
    throw error;
  }
  return created;
}

async function assertDisabled(report: WarmupReport): Promise<void> {
  const snapshot = await pollWarmupSnapshot(
    (value) => value.status === "disabled" && !value.enabled,
  );
  copySnapshotToReport(report, snapshot);
  const ptyId = `terminal-startup-warmup-off-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await createAndWrite(report, ptyId);
  report.status = "passed";
}

async function assertNormalSuccess(report: WarmupReport): Promise<void> {
  const snapshot = await pollWarmupSnapshot(
    (value) =>
      value.status === "completed" &&
      value.counters.nativeSpawnAttempted === 1 &&
      value.counters.childSpawned === 1 &&
      value.counters.killAttempted === 0 &&
      value.counters.reapConfirmed === 1,
  );
  copySnapshotToReport(report, snapshot);
  const ptyId = `terminal-startup-warmup-success-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await createAndWrite(report, ptyId);
  report.status = "passed";
}

async function assertSpawnFailure(report: WarmupReport): Promise<void> {
  const snapshot = await pollWarmupSnapshot(
    (value) =>
      value.status === "failed" &&
      value.counters.nativeSpawnAttempted === 1 &&
      value.counters.childSpawned === 0,
  );
  copySnapshotToReport(report, snapshot);
  const ptyId = `terminal-startup-warmup-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await createAndWrite(report, ptyId);
  report.status = "passed";
}

async function assertNeverExit(report: WarmupReport): Promise<void> {
  const snapshot = await pollWarmupSnapshot(
    (value) =>
      value.status === "timedOut" &&
      value.counters.nativeSpawnAttempted === 1 &&
      value.counters.childSpawned === 1 &&
      value.counters.killAttempted === 1 &&
      value.counters.reapConfirmed === 1 &&
      value.counters.reapTimedOut === 0,
  );
  copySnapshotToReport(report, snapshot);
  const ptyId = `terminal-startup-warmup-never-exit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await createAndWrite(report, ptyId);
  report.status = "passed";
}

async function assertClickBeforeGrace(report: WarmupReport): Promise<void> {
  const initial = await pollWarmupSnapshot(
    (value) =>
      value.status === "holdBeforeGraceEntered" &&
      value.counters.nativeSpawnAttempted === 0 &&
      value.counters.childSpawned === 0 &&
      !value.realCreateSeen &&
      value.holdBeforeGraceEntered &&
      !value.holdBeforeGraceReleased &&
      !value.holdBeforeGraceTimedOut,
  );
  copySnapshotToReport(report, initial);
  const ptyId = `terminal-startup-warmup-before-grace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await createAndWrite(report, ptyId);
  const released = await releaseWarmupHold();
  if (
    released.status !== "holdBeforeGraceReleased" ||
    !released.holdBeforeGraceEntered ||
    !released.holdBeforeGraceReleased ||
    released.holdBeforeGraceTimedOut
  ) {
    throw new Error("warmup-hold-release-failed");
  }
  copySnapshotToReport(report, released);
  const skipped = await pollWarmupSnapshot(
    (value) =>
      value.status === "skippedForRealCreate" &&
      value.counters.realCreateSeen === 1 &&
      value.counters.skippedForRealCreate === 1 &&
      value.counters.nativeSpawnAttempted === 0 &&
      value.counters.childSpawned === 0 &&
      value.holdBeforeGraceEntered &&
      value.holdBeforeGraceReleased &&
      !value.holdBeforeGraceTimedOut &&
      value.counters.holdBeforeGraceWaitTimedOut === 0,
  );
  copySnapshotToReport(report, skipped);
  report.status = "passed";
}

async function assertClickDuringHold(report: WarmupReport): Promise<void> {
  const held = await pollWarmupSnapshot(
    (value) => value.status === "holdEntered",
  );
  copySnapshotToReport(report, held);
  const ptyId = `terminal-startup-warmup-during-hold-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await createAndWrite(report, ptyId);
  const released = await releaseWarmupHold();
  copySnapshotToReport(report, released);
  const skipped = await pollWarmupSnapshot(
    (value) =>
      value.status === "skippedForRealCreate" &&
      value.counters.realCreateSeen === 1 &&
      value.counters.skippedForRealCreate === 1 &&
      value.counters.nativeSpawnAttempted === 0 &&
      value.counters.childSpawned === 0,
  );
  copySnapshotToReport(report, skipped);
  report.status = "passed";
}

async function runCase(
  report: WarmupReport,
  warmupCase: WarmupCase,
): Promise<void> {
  switch (warmupCase) {
    case "off":
      await assertDisabled(report);
      return;
    case "normalSuccess":
      await assertNormalSuccess(report);
      return;
    case "clickBeforeGrace":
      await assertClickBeforeGrace(report);
      return;
    case "spawnFailure":
      await assertSpawnFailure(report);
      return;
    case "neverExit":
      await assertNeverExit(report);
      return;
    case "clickDuringHold":
      await assertClickDuringHold(report);
      return;
  }
}

describe("harness real ConPTY warmup", () => {
  before(async () => {
    const started = Date.now();
    try {
      configuration = configuredWarmupCase();
    } catch (error) {
      const report = newWarmupReport("unknown", "unknown", started);
      report.status = "unavailable";
      report.errorKind = safeWarmupErrorKind(error);
      recordWarmupReport(report, started);
      throw error;
    }
    await waitForSurface();
  });

  it("executes exactly the configured process-level warmup case", async () => {
    const started = Date.now();
    const selected = configuration;
    if (!selected) throw new Error("warmup-case-missing");
    const report = newWarmupReport(selected.case, selected.scenario, started);
    let primaryError: unknown;
    let cleanupError: Error | undefined;

    try {
      await runCase(report, selected.case);
      if (report.status !== "passed" || report.write !== "observed") {
        throw new Error("warmup-write-not-observed");
      }
    } catch (error) {
      primaryError = error;
      report.status = "failed";
      report.errorKind = safeWarmupErrorKind(error);
    } finally {
      if (activePtyId) {
        const cleaned = await killAndConfirmPty(activePtyId);
        report.cleanup = cleaned ? "killed" : "killNotObserved";
        if (!cleaned) cleanupError = new Error("warmup-cleanup-failed");
        activePtyId = undefined;
      }
      if (activeCaseToken) {
        const cleaned = await cleanupWritablePtyCase(activeCaseToken);
        if (!cleaned) {
          report.cleanup = "killNotObserved";
          cleanupError ??= new Error("warmup-cleanup-failed");
        }
        activeCaseToken = undefined;
      }
      const finalSnapshot = await readWarmupSnapshot();
      if (finalSnapshot) copySnapshotToReport(report, finalSnapshot);
      if (!primaryError && cleanupError) {
        report.status = "failed";
        report.errorKind = safeWarmupErrorKind(cleanupError);
      }
      recordWarmupReport(report, started);
    }

    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  });
});
