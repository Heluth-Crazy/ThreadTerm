import { invoke } from "./helpers";
import {
  countExactOccurrences,
  canonicalCmdReceipt,
  harnessShellValue,
  shellAvailability,
  type ProviderShell,
} from "./provider.helpers";

const TIMING_SENTINEL_PREFIX = "THREADTERM_TIMING_";

export type TimingScenario =
  "holdMarker" | "manualTimeout" | "lateMarker" | "sameTick";
export type TimingStatus = "passed" | "unavailable" | "failed";
export type TimingErrorKind =
  | "availabilityMissing"
  | "requiredCmdUnavailable"
  | "shellUnavailable"
  | "prepareFailed"
  | "createFailed"
  | "createIdentityMismatch"
  | "createShellMismatch"
  | "caseNotBound"
  | "markerNotObserved"
  | "snapshotMismatch"
  | "driveFailed"
  | "startupFailed"
  | "startupTimeout"
  | "sentinelMissing"
  | "sentinelDuplicate"
  | "cleanupFailed"
  | "unexpected";

export type TimingReport = {
  kind: "harness-provider-timing";
  artifact: "harness";
  flow: "timing";
  scenario: TimingScenario;
  shell: ProviderShell | "unknown";
  availability: "available" | "unavailable";
  status: TimingStatus;
  startup: "sent" | "notObserved";
  disposition: "created" | "attached" | "unknown";
  shellFamily: "pwsh" | "windowsPowerShell" | "cmd" | "posix" | "unknown";
  markerMatched: "yes" | "no" | "notChecked";
  sentinelMatches: number;
  driveCount: number;
  readyCount: number;
  timeoutCount: number;
  sameTickCount: number;
  sentObserved: number;
  snapshotReads: number;
  cleanup:
    | "notStarted"
    | "killed"
    | "killNotObserved"
    | "cleaned"
    | "cleanupFailed"
    | "notPrepared";
  elapsedMs: number;
  errorKind?: TimingErrorKind;
};

type RecordValue = Record<string, unknown>;

export type StartupSnapshot = {
  generation: string;
  revision: number;
  state: string;
  trigger?: string;
};

export type HarnessSnapshot = {
  state: string;
  markerMatched: boolean;
  firstOutputObserved: boolean;
  timing: {
    drive: number;
    ready: number;
    timeout: number;
    sameTick: number;
    sentObserved: number;
  };
  counters: { snapshotReads: number };
};

export type TimingCase = {
  scenario: TimingScenario;
  shell: ProviderShell;
  ptyId: string;
  caseToken: string;
  generation: string;
  shellFamily: TimingReport["shellFamily"];
  disposition: "created" | "attached";
  startup: StartupSnapshot;
  sentinel: string;
};

export function objectValue(value: unknown): RecordValue | undefined {
  return value && typeof value === "object"
    ? (value as RecordValue)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function shellFamilyValue(
  value: unknown,
): TimingReport["shellFamily"] | undefined {
  return value === "pwsh" ||
    value === "windowsPowerShell" ||
    value === "cmd" ||
    value === "posix"
    ? value
    : undefined;
}

function timingRecord(value: unknown): HarnessSnapshot["timing"] {
  const source = objectValue(value) ?? {};
  return {
    drive: finiteNumber(source.drive) ?? 0,
    ready: finiteNumber(source.ready) ?? 0,
    timeout: finiteNumber(source.timeout) ?? 0,
    sameTick: finiteNumber(source.sameTick) ?? 0,
    sentObserved: finiteNumber(source.sentObserved) ?? 0,
  };
}

export function parseHarnessSnapshot(
  value: unknown,
): HarnessSnapshot | undefined {
  const source = objectValue(value);
  const timing = timingRecord(source?.timing);
  const counters = objectValue(source?.counters) ?? {};
  if (!source || typeof source.state !== "string") return undefined;
  return {
    state: source.state,
    markerMatched: booleanValue(source.markerMatched),
    firstOutputObserved: booleanValue(source.firstOutputObserved),
    timing,
    counters: { snapshotReads: finiteNumber(counters.snapshotReads) ?? 0 },
  };
}

export function parseStartupSnapshot(
  value: unknown,
): StartupSnapshot | undefined {
  const source = objectValue(value);
  const generation = stringValue(source?.generation);
  const revision = finiteNumber(source?.revision);
  if (
    !source ||
    !generation ||
    revision === undefined ||
    typeof source.state !== "string"
  ) {
    return undefined;
  }
  return {
    generation,
    revision,
    state: source.state,
    trigger: typeof source.trigger === "string" ? source.trigger : undefined,
  };
}

export function safeErrorKind(error: unknown): TimingErrorKind {
  const message = error instanceof Error ? error.message : "";
  if (message === "timing-shell-availability-missing")
    return "availabilityMissing";
  if (message === "timing-required-cmd-unavailable")
    return "requiredCmdUnavailable";
  if (message === "timing-shell-unavailable") return "shellUnavailable";
  if (message === "timing-prepare-failed") return "prepareFailed";
  if (message === "timing-create-failed") return "createFailed";
  if (message === "timing-create-identity-mismatch")
    return "createIdentityMismatch";
  if (message === "timing-create-shell-mismatch") return "createShellMismatch";
  if (message === "timing-case-not-bound") return "caseNotBound";
  if (message === "timing-marker-not-observed") return "markerNotObserved";
  if (message === "timing-snapshot-mismatch") return "snapshotMismatch";
  if (message === "timing-drive-failed") return "driveFailed";
  if (message === "timing-startup-failed") return "startupFailed";
  if (message === "timing-startup-timeout") return "startupTimeout";
  if (message === "timing-sentinel-missing") return "sentinelMissing";
  if (message === "timing-sentinel-duplicate") return "sentinelDuplicate";
  if (message === "timing-cleanup-failed") return "cleanupFailed";
  return "unexpected";
}

export function reportShellForScenario(
  scenario: TimingScenario,
): ProviderShell | undefined {
  const markerShells: ProviderShell[] = ["pwsh", "windowsPowerShell"];
  if (scenario === "holdMarker" || scenario === "lateMarker") {
    for (const shell of markerShells) {
      if (shellAvailability(shell) === "available") return shell;
    }
    return undefined;
  }
  for (const shell of [...markerShells, "cmd" as const]) {
    if (shellAvailability(shell) === "available") return shell;
  }
  return undefined;
}

export function availabilityError(scenario: TimingScenario): Error | undefined {
  let cmdAvailability: ReturnType<typeof shellAvailability>;
  try {
    cmdAvailability = shellAvailability("cmd");
  } catch {
    return new Error("timing-shell-availability-missing");
  }
  if (cmdAvailability === "unavailable")
    return new Error("timing-required-cmd-unavailable");
  try {
    const shell = reportShellForScenario(scenario);
    if (!shell) return new Error("timing-shell-unavailable");
  } catch {
    return new Error("timing-shell-availability-missing");
  }
  return undefined;
}

export function newTimingReport(
  scenario: TimingScenario,
  shell: ProviderShell | undefined,
  started: number,
): TimingReport {
  return {
    kind: "harness-provider-timing",
    artifact: "harness",
    flow: "timing",
    scenario,
    shell: shell ?? "unknown",
    availability: shell ? "available" : "unavailable",
    status: "failed",
    startup: "notObserved",
    disposition: "unknown",
    shellFamily: "unknown",
    markerMatched: "notChecked",
    sentinelMatches: 0,
    driveCount: 0,
    readyCount: 0,
    timeoutCount: 0,
    sameTickCount: 0,
    sentObserved: 0,
    snapshotReads: 0,
    cleanup: "notStarted",
    elapsedMs: Date.now() - started,
  };
}

export function timingSentinel(): string {
  return `${TIMING_SENTINEL_PREFIX}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

export function syntheticTimingCommand(
  shell: ProviderShell,
  sentinel: string,
): string {
  if (!sentinel.startsWith(TIMING_SENTINEL_PREFIX)) {
    throw new Error("timing-sentinel-invalid");
  }
  const suffix = sentinel.slice(TIMING_SENTINEL_PREFIX.length);
  if (shell === "pwsh" || shell === "windowsPowerShell") {
    return `Write-Output ('${TIMING_SENTINEL_PREFIX}' + '${suffix}')`;
  }
  return `"${canonicalCmdReceipt()}" /d /q /V:ON /C "set tt_prefix=${TIMING_SENTINEL_PREFIX}&echo !tt_prefix!${suffix}"`;
}

export function timingShellValue(shell: ProviderShell): ProviderShell {
  return harnessShellValue(shell);
}

export function timingCaseId(
  scenario: TimingScenario,
  shell: ProviderShell,
): string {
  return `terminal-startup-timing-${scenario}-${shell}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function pollUntil<T>(
  read: () => Promise<T | undefined>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
  stableReads = 1,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && accept(value)) {
      stable += 1;
      if (stable >= stableReads) return value;
    } else {
      stable = 0;
    }
    await browser.pause(75);
  }
  throw new Error("timing-poll-timeout");
}

export async function readHarnessSnapshot(
  caseToken: string,
): Promise<HarnessSnapshot | undefined> {
  const result = await invoke("terminal_startup_harness_snapshot", {
    caseToken,
  });
  return result.ok ? parseHarnessSnapshot(result.value) : undefined;
}

export async function readStartupSnapshot(
  ptyId: string,
  generation: string,
): Promise<StartupSnapshot | undefined> {
  const result = await invoke("pty_get_startup_state", { ptyId, generation });
  if (!result.ok || !result.value) return undefined;
  return parseStartupSnapshot(result.value);
}

export async function waitForHarnessBound(
  caseToken: string,
): Promise<HarnessSnapshot> {
  return pollUntil(
    () => readHarnessSnapshot(caseToken),
    (snapshot) => snapshot.state === "bound",
  );
}

export async function waitForMarkerEvidence(
  caseToken: string,
): Promise<HarnessSnapshot> {
  return pollUntil(
    () => readHarnessSnapshot(caseToken),
    (snapshot) => snapshot.markerMatched,
  );
}

export async function waitForStartupSent(
  ptyId: string,
  generation: string,
): Promise<StartupSnapshot> {
  return pollUntil(
    async () => {
      const snapshot = await readStartupSnapshot(ptyId, generation);
      if (
        snapshot &&
        (snapshot.state === "failed" || snapshot.state === "cancelled")
      ) {
        throw new Error("timing-startup-failed");
      }
      return snapshot;
    },
    (snapshot) => snapshot.state === "sent",
  );
}

export async function waitForSentinelExactlyOnce(
  ptyId: string,
  generation: string,
  caseToken: string,
  sentinel: string,
): Promise<{
  matches: number;
  startup: StartupSnapshot;
  harness: HarnessSnapshot;
}> {
  let stableReads = 0;
  return pollUntil(
    async () => {
      const [startup, output, harness] = await Promise.all([
        readStartupSnapshot(ptyId, generation),
        invoke("pty_get_recent_output", { ptyId }),
        readHarnessSnapshot(caseToken),
      ]);
      if (
        !startup ||
        !harness ||
        !output.ok ||
        typeof output.value !== "string"
      )
        return undefined;
      if (startup.state === "failed" || startup.state === "cancelled") {
        throw new Error("timing-startup-failed");
      }
      const matches = countExactOccurrences(output.value, sentinel);
      if (matches > 1) throw new Error("timing-sentinel-duplicate");
      if (
        startup.state === "sent" &&
        matches === 1 &&
        harness.timing.sentObserved === 1
      ) {
        stableReads += 1;
      } else {
        stableReads = 0;
      }
      return { matches, startup, harness };
    },
    (value) =>
      value.matches === 1 &&
      value.startup.state === "sent" &&
      value.harness.timing.sentObserved === 1 &&
      stableReads >= 3,
    20_000,
    1,
  );
}

export async function prepareTimingCase(
  scenario: TimingScenario,
  shell: ProviderShell,
): Promise<string> {
  const result = await invoke("terminal_startup_harness_prepare_case", {
    request: {
      shell: timingShellValue(shell),
      surface: "uiNextCreate",
      timing: scenario,
      da1Fault: "none",
      warmup: "disabled",
      fixture: "syntheticProvider",
    },
  });
  const token = result.ok
    ? stringValue(objectValue(result.value)?.caseToken)
    : undefined;
  if (!token) throw new Error("timing-prepare-failed");
  return token;
}

export async function createTimingCase(
  scenario: TimingScenario,
  shell: ProviderShell,
  caseToken: string,
  sentinel: string,
  ptyId = timingCaseId(scenario, shell),
): Promise<TimingCase> {
  const dataRoot = process.env.THREADTERM_WDIO_DATA_ROOT;
  if (!dataRoot) throw new Error("timing-create-failed");
  const command = syntheticTimingCommand(shell, sentinel);
  if (command.includes(sentinel)) throw new Error("timing-sentinel-in-command");
  const result = await invoke("pty_create_session_v2", {
    request: {
      id: ptyId,
      workingDir: dataRoot,
      rows: 24,
      cols: 100,
      startup: {
        kind: "provider",
        provider: "codex",
        command,
        cardId: "terminal-startup-timing-card",
        action: "start",
        sideEffectPlan: {
          kind: "bind",
          providerSessionId: "terminal-startup-timing-session",
        },
      },
    },
  });
  const value = objectValue(result.value);
  const generation = stringValue(value?.generation);
  const returnedPtyId = stringValue(value?.ptyId);
  const shellFamily = shellFamilyValue(value?.shellFamily);
  const disposition = value?.disposition;
  const typedDisposition =
    disposition === "created" || disposition === "attached"
      ? disposition
      : undefined;
  const startup = parseStartupSnapshot(value?.startup);
  if (
    !result.ok ||
    !generation ||
    !shellFamily ||
    !startup ||
    !typedDisposition
  ) {
    throw new Error("timing-create-failed");
  }
  if (returnedPtyId !== ptyId)
    throw new Error("timing-create-identity-mismatch");
  if (shellFamily !== shell) throw new Error("timing-create-shell-mismatch");
  const bound = await waitForHarnessBound(caseToken);
  if (bound.state !== "bound") throw new Error("timing-case-not-bound");
  return {
    scenario,
    shell,
    ptyId,
    caseToken,
    generation,
    shellFamily,
    disposition: typedDisposition,
    startup,
    sentinel,
  };
}

export async function driveTimingCase(
  timingCase: TimingCase,
  action: "releaseReady" | "fireTimeout" | "raceReadyTimeout",
): Promise<HarnessSnapshot> {
  const result = await invoke("terminal_startup_harness_drive_case", {
    caseToken: timingCase.caseToken,
    action,
  });
  const snapshot = result.ok ? parseHarnessSnapshot(result.value) : undefined;
  if (!snapshot) throw new Error("timing-drive-failed");
  return snapshot;
}

export async function assertSnapshotReconciles(
  timingCase: TimingCase,
  createSnapshot: StartupSnapshot,
): Promise<StartupSnapshot> {
  const queried = await pollUntil(
    () => readStartupSnapshot(timingCase.ptyId, timingCase.generation),
    (snapshot) => snapshot.revision >= createSnapshot.revision,
  );
  if (queried.generation !== createSnapshot.generation)
    throw new Error("timing-snapshot-mismatch");
  return queried;
}

export async function killTimingPty(ptyId: string): Promise<boolean> {
  const result = await invoke("pty_kill", { id: ptyId });
  return result.ok;
}

export async function cleanupTimingCase(caseToken: string): Promise<boolean> {
  return (await invoke("terminal_startup_harness_cleanup_case", { caseToken }))
    .ok;
}
