import {
  assertSurfaceHarnessCapabilities,
  assertSurfaceHarnessEnvironment,
  attachSurfaceProvider,
  cleanupSurfaceCase,
  countSurfaceOrphans,
  createSurfaceShell,
  exerciseSurfaceFloatLifecycle,
  newSurfaceLifecycleReport,
  prepareSurfaceCase,
  readLiveSessionIds,
  readSurfaceProviderStartup,
  readSurfaceSessionSnapshot,
  recordSurfaceLifecycleReport,
  requestSurfaceClose,
  safeSurfaceErrorKind,
  selectSurfaceShell,
  type SurfaceLifecycleReport,
  typeAndReadSurfaceNonce,
  waitForSurfaceProviderSent,
  waitForSurfaceSentinel,
  waitForSurfaceSessionGone,
  observeSurfaceResize,
} from "./surface-lifecycle.helpers";
import { invoke } from "./helpers";

describe("harness real surface lifecycle", () => {
  it("keeps one PTY identity across main/float and proves cleanup", async () => {
    const started = Date.now();
    let report: SurfaceLifecycleReport = newSurfaceLifecycleReport("unknown");
    let primaryError: unknown;
    let cleanupError: Error | undefined;
    let caseToken: string | undefined;
    let ptyId: string | undefined;
    let sessionGoneConfirmed = false;
    let baseline: Set<string> | undefined;

    try {
      assertSurfaceHarnessEnvironment();
      await assertSurfaceHarnessCapabilities();

      const shell = selectSurfaceShell();
      report = newSurfaceLifecycleReport(shell);
      baseline = await readLiveSessionIds();
      const prepared = await prepareSurfaceCase(shell);
      caseToken = prepared.caseToken;

      const created = await createSurfaceShell(baseline);
      ptyId = created.ptyId;
      report.create = "created";
      await typeAndReadSurfaceNonce(ptyId);
      report.nonceReadbacks = 1;

      const initialSnapshot = await readSurfaceSessionSnapshot(ptyId);
      if (!initialSnapshot) throw new Error("surface-attach-failed");

      const firstAttachment = await attachSurfaceProvider(
        ptyId,
        created.identity.id,
        shell,
        initialSnapshot,
      );
      if (firstAttachment.ptyId !== created.identity.ptyId) {
        throw new Error("surface-identity-mismatch");
      }
      if (firstAttachment.shellFamily !== shell) {
        throw new Error("surface-attach-failed");
      }
      report.identityStable = "yes";
      await waitForSurfaceProviderSent(firstAttachment);
      const firstMatches = await waitForSurfaceSentinel(
        firstAttachment,
        caseToken,
        prepared.sentinel,
      );
      if (firstMatches !== 1) throw new Error("surface-sentinel-missing");
      report.providerStartup = "sent";
      report.providerStartupDispatches = 1;

      const resized = await observeSurfaceResize(ptyId, initialSnapshot);
      report.resize = "observed";
      await exerciseSurfaceFloatLifecycle(
        {
          writable: 0,
          resize: 0,
          hiddenReveal: 0,
          closed: 0,
          harnessUnknown: 0,
          floatAttach: 0,
          floatHideReveal: 0,
          recycle: 0,
        },
        created.label,
      );
      report.floatAttach = "observed";
      report.hiddenReveal = "observed";
      report.recycleToMain = "observed";

      const afterFloatSnapshot = await readSurfaceSessionSnapshot(ptyId);
      if (!afterFloatSnapshot) throw new Error("surface-attach-failed");
      if (
        afterFloatSnapshot.ptyId !== resized.ptyId ||
        afterFloatSnapshot.rows <= 0 ||
        afterFloatSnapshot.cols <= 0
      ) {
        throw new Error("surface-identity-mismatch");
      }

      const secondAttachment = await attachSurfaceProvider(
        ptyId,
        created.identity.id,
        shell,
        afterFloatSnapshot,
      );
      if (secondAttachment.ptyId !== firstAttachment.ptyId) {
        report.identityStable = "no";
        throw new Error("surface-identity-mismatch");
      }
      if (secondAttachment.generation !== firstAttachment.generation) {
        report.generationStable = "no";
        throw new Error("surface-generation-mismatch");
      }
      if (
        secondAttachment.shellFamily !== firstAttachment.shellFamily ||
        secondAttachment.shellFamily !== shell
      ) {
        throw new Error("surface-attach-failed");
      }
      report.generationStable = "yes";
      const secondStartup = await readSurfaceProviderStartup(secondAttachment);
      if (!secondStartup || secondStartup.state !== "sent") {
        throw new Error("surface-startup-failed");
      }
      const secondMatches = await waitForSurfaceSentinel(
        secondAttachment,
        caseToken,
        prepared.sentinel,
      );
      if (secondMatches !== 1) throw new Error("surface-sentinel-duplicate");

      await typeAndReadSurfaceNonce(ptyId);
      report.nonceReadbacks = 2;
      report.writeAfterReveal = "observed";

      report.close = "requested";
      await requestSurfaceClose({
        writable: 0,
        resize: 0,
        hiddenReveal: 0,
        closed: 0,
        harnessUnknown: 0,
        floatAttach: 0,
        floatHideReveal: 0,
        recycle: 0,
      });
      await waitForSurfaceSessionGone(ptyId);
      sessionGoneConfirmed = true;
      report.sessionGone = "yes";
      report.orphanSessions = await countSurfaceOrphans(baseline);
      if (report.orphanSessions !== 0)
        throw new Error("surface-session-orphaned");
      report.cleanup = "observed";
      report.status = "passed";
    } catch (error) {
      primaryError = error;
      report.status = "failed";
      report.errorKind = safeSurfaceErrorKind(error);
    } finally {
      if (ptyId && !sessionGoneConfirmed) {
        report.ptyCleanupCalls += 1;
        const result = await invoke("pty_kill", { id: ptyId });
        if (result.ok) {
          try {
            await waitForSurfaceSessionGone(ptyId);
            sessionGoneConfirmed = true;
          } catch {
            cleanupError = new Error("surface-cleanup-failed");
          }
        } else {
          const stillRegistered = await invoke("pty_get_session_state", {
            ptyId,
          });
          if (stillRegistered.ok) {
            cleanupError = new Error("surface-cleanup-failed");
          } else {
            sessionGoneConfirmed = true;
          }
        }
      }
      if (caseToken) {
        report.harnessCleanupCalls += 1;
        if (!(await cleanupSurfaceCase(caseToken))) {
          cleanupError ??= new Error("surface-cleanup-failed");
        }
      }
      if (baseline && report.orphanSessions === 0) {
        try {
          report.orphanSessions = await countSurfaceOrphans(baseline);
        } catch {
          report.orphanSessions = 1;
        }
      }
      if (sessionGoneConfirmed && report.sessionGone === "notChecked") {
        report.sessionGone = "yes";
      }
      if (
        sessionGoneConfirmed &&
        !cleanupError &&
        report.cleanup === "notStarted"
      ) {
        report.cleanup = "observed";
      }
      if (cleanupError) {
        report.status = "failed";
        report.cleanup = "failed";
        report.errorKind ??= safeSurfaceErrorKind(cleanupError);
      }
      recordSurfaceLifecycleReport(report, started);
    }

    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  });
});
