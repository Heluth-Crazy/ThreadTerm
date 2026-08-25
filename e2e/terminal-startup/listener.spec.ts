import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { invoke, waitForSurface, withMatrixEvidence } from "./helpers";
import {
  assertListenerHarnessCapabilities,
  assertNoDuplicateSentEvents,
  killAndConfirmSession,
  listenForStartupState,
  readBoundStartupSnapshot,
  waitForBoundStartupState,
  waitForStartupEvent,
  type StartupListener,
} from "./listener.helpers";
import {
  availabilityError,
  createTimingCase,
  driveTimingCase,
  prepareTimingCase,
  reportShellForScenario,
  timingSentinel,
  waitForMarkerEvidence,
  waitForSentinelExactlyOnce,
  type TimingCase,
} from "./timing.helpers";
import type { ProviderShell } from "./provider.helpers";

const reportPath = process.env.THREADTERM_WDIO_REPORT;
const scenarios: readonly ListenerScenario[] = [
  "listenerBeforeCreate",
  "rendererDropQuery",
];

type ListenerScenario = "listenerBeforeCreate" | "rendererDropQuery";

type ListenerErrorKind =
  | "availabilityMissing"
  | "requiredCmdUnavailable"
  | "shellUnavailable"
  | "harnessUnavailable"
  | "listenerRegistrationFailed"
  | "listenerUnlistenFailed"
  | "rendererDropFailed"
  | "createFailed"
  | "identityMismatch"
  | "snapshotMismatch"
  | "eventMissing"
  | "eventDuplicate"
  | "eventInvalid"
  | "startupFailed"
  | "startupTimeout"
  | "sentinelMissing"
  | "sentinelDuplicate"
  | "cleanupFailed"
  | "unexpected";

type ListenerReport = {
  kind: "harness-listener-reconciliation";
  artifact: "harness";
  flow: "listener";
  scenario: ListenerScenario;
  shell: ProviderShell | "unknown";
  availability: "available" | "unavailable";
  status: "passed" | "unavailable" | "failed";
  listenerBeforeCreate: boolean;
  rendererDropped: boolean;
  listenerReestablished: boolean;
  eventObserved: number;
  eventGapReconciled: boolean;
  queryReconciled: boolean;
  generationStable: boolean;
  identityStable: boolean;
  markerHeld: boolean;
  startup: "sent" | "notObserved";
  sentinelMatches: number;
  sentObserved: number;
  attachCount: number;
  queryReads: number;
  cleanup:
    | "notStarted"
    | "killedAndConfirmed"
    | "cleanupFailed"
    | "notPrepared";
  cleanupKillCalls: number;
  elapsedMs: number;
  errorKind?: ListenerErrorKind;
};

function newListenerReport(
  scenario: ListenerScenario,
  shell: ProviderShell | undefined,
): ListenerReport {
  return {
    kind: "harness-listener-reconciliation",
    artifact: "harness",
    flow: "listener",
    scenario,
    shell: shell ?? "unknown",
    availability: shell ? "available" : "unavailable",
    status: "failed",
    listenerBeforeCreate: false,
    rendererDropped: false,
    listenerReestablished: false,
    eventObserved: 0,
    eventGapReconciled: false,
    queryReconciled: false,
    generationStable: false,
    identityStable: false,
    markerHeld: false,
    startup: "notObserved",
    sentinelMatches: 0,
    sentObserved: 0,
    attachCount: 0,
    queryReads: 0,
    cleanup: "notStarted",
    cleanupKillCalls: 0,
    elapsedMs: 0,
  };
}

function listenerErrorKind(error: unknown): ListenerErrorKind {
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "listener-shell-availability-missing":
      return "availabilityMissing";
    case "listener-required-cmd-unavailable":
      return "requiredCmdUnavailable";
    case "timing-shell-unavailable":
      return "shellUnavailable";
    case "listener-harness-capability-unavailable":
      return "harnessUnavailable";
    case "listener-registration-failed":
      return "listenerRegistrationFailed";
    case "listener-unlisten-failed":
      return "listenerUnlistenFailed";
    case "listener-renderer-drop-failed":
      return "rendererDropFailed";
    case "timing-create-failed":
    case "timing-prepare-failed":
      return "createFailed";
    case "listener-identity-mismatch":
    case "timing-create-identity-mismatch":
      return "identityMismatch";
    case "timing-snapshot-mismatch":
    case "listener-marker-not-held":
    case "listener-snapshot-mismatch":
      return "snapshotMismatch";
    case "listener-event-missing":
      return "eventMissing";
    case "listener-event-duplicate":
      return "eventDuplicate";
    case "listener-event-invalid":
    case "listener-event-replayed":
      return "eventInvalid";
    case "listener-startup-failed":
    case "timing-startup-failed":
      return "startupFailed";
    case "timing-poll-timeout":
    case "timing-startup-timeout":
    case "listener-event-settle-timeout":
      return "startupTimeout";
    case "timing-sentinel-missing":
      return "sentinelMissing";
    case "timing-sentinel-duplicate":
      return "sentinelDuplicate";
    case "listener-cleanup-failed":
      return "cleanupFailed";
    default:
      return "unexpected";
  }
}

function selectListenerShell(): ProviderShell | undefined {
  const availability = availabilityError("holdMarker");
  if (availability) {
    if (availability.message === "timing-shell-availability-missing")
      throw new Error("listener-shell-availability-missing");
    if (availability.message === "timing-required-cmd-unavailable")
      throw new Error("listener-required-cmd-unavailable");
    if (availability.message === "timing-shell-unavailable") return undefined;
    throw availability;
  }
  return reportShellForScenario("holdMarker");
}

async function createListenerCase(
  shell: ProviderShell,
  caseToken: string,
  sentinel: string,
  ptyId: string,
): Promise<TimingCase> {
  return createTimingCase("holdMarker", shell, caseToken, sentinel, ptyId);
}

async function waitForMarkerHeld(caseToken: string): Promise<void> {
  const snapshot = await waitForMarkerEvidence(caseToken);
  if (!snapshot.markerMatched) throw new Error("listener-marker-not-held");
}

async function waitForSentinelOnce(timingCase: TimingCase): Promise<{
  matches: number;
  startup: TimingCase["startup"];
  sentObserved: number;
}> {
  const evidence = await waitForSentinelExactlyOnce(
    timingCase.ptyId,
    timingCase.generation,
    timingCase.caseToken,
    timingCase.sentinel,
  );
  return {
    matches: evidence.matches,
    startup: evidence.startup,
    sentObserved: evidence.harness.timing.sentObserved,
  };
}

function record(report: ListenerReport, started: number): void {
  if (!reportPath) return;
  report.elapsedMs = Math.max(0, Date.now() - started);
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence(report))}\n`);
}

function listenerCaseId(
  scenario: ListenerScenario,
  shell: ProviderShell,
): string {
  return `terminal-startup-listener-${scenario}-${shell}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assertAttached(
  original: TimingCase,
  attached: TimingCase,
): void {
  if (
    attached.disposition !== "attached" ||
    attached.ptyId !== original.ptyId ||
    attached.generation !== original.generation ||
    attached.shellFamily !== original.shellFamily
  ) {
    throw new Error("listener-identity-mismatch");
  }
}

async function runListenerBeforeCreate(
  shell: ProviderShell,
  caseToken: string,
  timingCaseIdValue: string,
  sentinel: string,
  report: ListenerReport,
  setListener: (listener: StartupListener | undefined) => void,
): Promise<TimingCase> {
  const listener = await listenForStartupState();
  setListener(listener);
  report.listenerBeforeCreate = true;

  const timingCase = await createListenerCase(
    shell,
    caseToken,
    sentinel,
    timingCaseIdValue,
  );
  report.identityStable = timingCase.ptyId === timingCaseIdValue;
  if (!report.identityStable) throw new Error("listener-identity-mismatch");

  await waitForMarkerHeld(caseToken);
  report.markerHeld = true;

  const waiting = await waitForBoundStartupState(
    timingCase.ptyId,
    timingCase.generation,
    "waiting",
  );
  report.queryReads += waiting.reads;
  if (
    waiting.snapshot.ptyId !== timingCase.ptyId ||
    waiting.snapshot.generation !== timingCase.generation
  ) {
    throw new Error("listener-identity-mismatch");
  }
  report.queryReconciled = true;

  const attachedWhileWaiting = await createListenerCase(
    shell,
    caseToken,
    sentinel,
    timingCase.ptyId,
  );
  assertAttached(timingCase, attachedWhileWaiting);
  report.attachCount += 1;
  report.generationStable = true;

  await driveTimingCase(timingCase, "releaseReady");
  const sentEvent = await waitForStartupEvent(
    listener,
    timingCase.ptyId,
    timingCase.generation,
    "sent",
  );
  report.eventObserved = sentEvent.count;

  const sent = await waitForBoundStartupState(
    timingCase.ptyId,
    timingCase.generation,
    "sent",
    sentEvent.revision,
  );
  report.queryReads += sent.reads;
  report.queryReconciled = true;

  const evidence = await waitForSentinelOnce(timingCase);
  if (evidence.startup.state !== "sent")
    throw new Error("listener-startup-failed");
  report.startup = "sent";
  report.sentinelMatches = evidence.matches;
  report.sentObserved = evidence.sentObserved;
  if (report.sentinelMatches !== 1 || report.sentObserved !== 1) {
    throw new Error("timing-sentinel-missing");
  }

  const attachedAfterSent = await createListenerCase(
    shell,
    caseToken,
    sentinel,
    timingCase.ptyId,
  );
  assertAttached(timingCase, attachedAfterSent);
  report.attachCount += 1;
  const final = await readBoundStartupSnapshot(
    timingCase.ptyId,
    timingCase.generation,
  );
  if (!final || final.state !== "sent")
    throw new Error("listener-snapshot-mismatch");
  report.queryReads += 1;
  if (final.generation !== timingCase.generation) {
    throw new Error("listener-identity-mismatch");
  }
  report.generationStable = true;

  const duplicateEvents = await assertNoDuplicateSentEvents(
    listener,
    timingCase.ptyId,
    timingCase.generation,
  );
  if (duplicateEvents !== 0) throw new Error("listener-event-duplicate");
  return timingCase;
}

async function runRendererDropQuery(
  shell: ProviderShell,
  caseToken: string,
  timingCaseIdValue: string,
  sentinel: string,
  report: ListenerReport,
  setListener: (listener: StartupListener | undefined) => void,
): Promise<TimingCase> {
  const beforeDropListener = await listenForStartupState();
  setListener(beforeDropListener);
  report.listenerBeforeCreate = true;

  const timingCase = await createListenerCase(
    shell,
    caseToken,
    sentinel,
    timingCaseIdValue,
  );
  report.identityStable = timingCase.ptyId === timingCaseIdValue;
  if (!report.identityStable) throw new Error("listener-identity-mismatch");
  await waitForMarkerHeld(caseToken);
  report.markerHeld = true;

  const waiting = await waitForBoundStartupState(
    timingCase.ptyId,
    timingCase.generation,
    "waiting",
  );
  report.queryReads += waiting.reads;
  report.queryReconciled = true;

  const attachedBeforeDrop = await createListenerCase(
    shell,
    caseToken,
    sentinel,
    timingCase.ptyId,
  );
  assertAttached(timingCase, attachedBeforeDrop);
  report.attachCount += 1;
  report.generationStable = true;

  // Dispose observation before dropping the renderer. The PTY and its Rust
  // startup coordinator remain alive throughout the WebView reload.
  setListener(undefined);
  await beforeDropListener.unlisten();
  try {
    await browser.refresh();
    await waitForSurface();
  } catch {
    throw new Error("listener-renderer-drop-failed");
  }
  report.rendererDropped = true;

  // Re-establish a real listener and reconcile the still-waiting snapshot
  // before allowing the marker to release.
  const afterDropListener = await listenForStartupState();
  setListener(afterDropListener);
  report.listenerReestablished = true;
  const waitingAfterDrop = await waitForBoundStartupState(
    timingCase.ptyId,
    timingCase.generation,
    "waiting",
  );
  report.queryReads += waitingAfterDrop.reads;
  if (
    waitingAfterDrop.snapshot.ptyId !== timingCase.ptyId ||
    waitingAfterDrop.snapshot.generation !== timingCase.generation
  ) {
    throw new Error("listener-identity-mismatch");
  }
  report.queryReconciled = true;

  // Deliberately create an event gap: no listener is present when the Rust
  // session emits `sent`. The next WebView must recover through query.
  setListener(undefined);
  await afterDropListener.unlisten();
  await driveTimingCase(timingCase, "releaseReady");

  const evidence = await waitForSentinelOnce(timingCase);
  if (evidence.startup.state !== "sent")
    throw new Error("listener-startup-failed");
  report.startup = "sent";
  report.sentinelMatches = evidence.matches;
  report.sentObserved = evidence.sentObserved;
  if (report.sentinelMatches !== 1 || report.sentObserved !== 1) {
    throw new Error("timing-sentinel-missing");
  }

  // Register after the event, then prove the query—not a replayed event—closed
  // the gap. The generation and PTY identity remain private test assertions.
  const afterEventListener = await listenForStartupState();
  setListener(afterEventListener);
  report.listenerReestablished = true;
  const sentAfterEvent = await waitForBoundStartupState(
    timingCase.ptyId,
    timingCase.generation,
    "sent",
  );
  report.queryReads += sentAfterEvent.reads;
  report.queryReconciled = true;
  report.eventGapReconciled = true;

  const replayedEvents = await assertNoDuplicateSentEvents(
    afterEventListener,
    timingCase.ptyId,
    timingCase.generation,
  );
  if (replayedEvents !== 0) throw new Error("listener-event-replayed");
  report.eventObserved = 0;

  const attachedAfterDrop = await createListenerCase(
    shell,
    caseToken,
    sentinel,
    timingCase.ptyId,
  );
  assertAttached(timingCase, attachedAfterDrop);
  report.attachCount += 1;
  const final = await readBoundStartupSnapshot(
    timingCase.ptyId,
    timingCase.generation,
  );
  if (!final || final.state !== "sent")
    throw new Error("listener-snapshot-mismatch");
  report.queryReads += 1;
  report.generationStable = final.generation === timingCase.generation;
  if (!report.generationStable) throw new Error("listener-identity-mismatch");
  return timingCase;
}

async function runScenario(scenario: ListenerScenario): Promise<void> {
  const started = Date.now();
  let shell: ProviderShell | undefined;
  try {
    shell = selectListenerShell();
  } catch (error) {
    const report = newListenerReport(scenario, undefined);
    report.status = "failed";
    report.errorKind = listenerErrorKind(error);
    record(report, started);
    throw error;
  }
  const report = newListenerReport(scenario, shell);
  if (!shell) {
    report.status = "unavailable";
    report.errorKind = "shellUnavailable";
    record(report, started);
    return;
  }

  let caseToken: string | undefined;
  let ptyId: string | undefined;
  let activeListener: StartupListener | undefined;
  let primaryError: unknown;
  let cleanupError: Error | undefined;
  let caseCleaned = false;

  const setListener = (listener: StartupListener | undefined): void => {
    activeListener = listener;
  };

  const closeActiveListener = async (): Promise<void> => {
    const listener = activeListener;
    activeListener = undefined;
    if (listener) await listener.unlisten();
  };

  try {
    caseToken = await prepareTimingCase("holdMarker", shell);
    const sentinel = timingSentinel();
    ptyId = listenerCaseId(scenario, shell);
    const timingCase =
      scenario === "listenerBeforeCreate"
        ? await runListenerBeforeCreate(
            shell,
            caseToken,
            ptyId,
            sentinel,
            report,
            setListener,
          )
        : await runRendererDropQuery(
            shell,
            caseToken,
            ptyId,
            sentinel,
            report,
            setListener,
          );
    if (
      report.startup !== "sent" ||
      report.sentinelMatches !== 1 ||
      report.sentObserved !== 1 ||
      !report.identityStable ||
      !report.generationStable ||
      !report.queryReconciled
    ) {
      throw new Error("listener-snapshot-mismatch");
    }
    if (
      scenario === "listenerBeforeCreate" &&
      (report.eventObserved !== 1 || report.attachCount !== 2)
    ) {
      throw new Error("listener-event-missing");
    }
    if (
      scenario === "rendererDropQuery" &&
      (!report.rendererDropped ||
        !report.listenerReestablished ||
        !report.eventGapReconciled ||
        report.eventObserved !== 0 ||
        report.attachCount !== 2)
    ) {
      throw new Error("listener-snapshot-mismatch");
    }
    report.status = "passed";
  } catch (error) {
    primaryError = error;
    report.status = "failed";
    report.errorKind = listenerErrorKind(error);
  } finally {
    try {
      await closeActiveListener();
    } catch {
      cleanupError ??= new Error("listener-cleanup-failed");
    }

    let killConfirmed = false;
    if (ptyId) {
      report.cleanupKillCalls = 1;
      try {
        const cleanup = await killAndConfirmSession(ptyId);
        killConfirmed = cleanup.confirmed && cleanup.killCalls === 1;
      } catch {
        killConfirmed = false;
      }
      if (!killConfirmed) cleanupError ??= new Error("listener-cleanup-failed");
    } else {
      report.cleanup = "notPrepared";
    }

    if (caseToken) {
      caseCleaned = (
        await invoke("terminal_startup_harness_cleanup_case", { caseToken })
      ).ok;
      if (!caseCleaned) cleanupError ??= new Error("listener-cleanup-failed");
    }

    if (ptyId) {
      report.cleanup =
        killConfirmed && caseCleaned
          ? "killedAndConfirmed"
          : "cleanupFailed";
    }
    if (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
      report.status = "failed";
      if (!report.errorKind) report.errorKind = "cleanupFailed";
    }
    record(report, started);
  }

  if (primaryError) throw primaryError;
}

describe("harness startup listener timing and renderer drop recovery", () => {
  before(async () => {
    if (!reportPath) throw new Error("listener-report-path-missing");
    if ((process.env.THREADTERM_WDIO_ARTIFACT ?? "production") !== "harness") {
      throw new Error("listener-requires-harness-artifact");
    }
    if (!process.env.THREADTERM_WDIO_DATA_ROOT)
      throw new Error("listener-data-root-missing");
    await waitForSurface();
    await assertListenerHarnessCapabilities();
  });

  for (const scenario of scenarios) {
    it(`proves ${scenario} reconciles one startup dispatch`, async () => {
      await runScenario(scenario);
    });
  }
});
