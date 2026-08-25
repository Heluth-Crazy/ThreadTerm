import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { invoke } from "./helpers";

export type WarmupScenario =
  | "disabled"
  | "normal"
  | "spawnFailure"
  | "neverExit"
  | "holdBeforeGrace"
  | "holdBeforeNativeSpawn";

export type WarmupCase =
  | "off"
  | "normalSuccess"
  | "clickBeforeGrace"
  | "spawnFailure"
  | "neverExit"
  | "clickDuringHold";

export type WarmupStatus = "passed" | "unavailable" | "failed";
export type WarmupRuntimeStatus =
  | "disabled"
  | "waiting"
  | "spawning"
  | "completed"
  | "failed"
  | "timedOut"
  | "skippedForRealCreate"
  | "holdEntered"
  | "holdReleased"
  | "holdBeforeGraceEntered"
  | "holdBeforeGraceReleased";

export type WarmupErrorKind =
  | "artifactMismatch"
  | "flowMismatch"
  | "scenarioMissing"
  | "scenarioMismatch"
  | "caseMissing"
  | "prepareFailed"
  | "caseNotBound"
  | "commandUnavailable"
  | "warmupTimeout"
  | "stageNotObserved"
  | "createFailed"
  | "createTimeout"
  | "writeFailed"
  | "writeNotObserved"
  | "warmupOutcomeMismatch"
  | "reapEvidenceMissing"
  | "holdReleaseFailed"
  | "cleanupFailed"
  | "unexpected";

export type WarmupCounters = {
  starts: number;
  realCreateSeen: number;
  nativeSpawnAttempted: number;
  childSpawned: number;
  skippedForRealCreate: number;
  holdWaitTimedOut: number;
  holdBeforeGraceWaitTimedOut: number;
  killAttempted: number;
  reapConfirmed: number;
  reapTimedOut: number;
};

export type WarmupSnapshot = {
  enabled: boolean;
  scenario: WarmupScenario;
  status: WarmupRuntimeStatus;
  holdEntered: boolean;
  holdReleased: boolean;
  holdTimedOut: boolean;
  holdBeforeGraceEntered: boolean;
  holdBeforeGraceReleased: boolean;
  holdBeforeGraceTimedOut: boolean;
  realCreateSeen: boolean;
  counters: WarmupCounters;
};

export type WarmupReport = {
  kind: "harness-warmup";
  artifact: "harness";
  flow: "warmup";
  case: WarmupCase | "unknown";
  scenario: WarmupScenario | "unknown";
  status: WarmupStatus;
  warmup: WarmupRuntimeStatus | "unknown";
  disposition: "created" | "attached" | "unknown";
  create: "notAttempted" | "created" | "failed" | "timedOut";
  write: "notAttempted" | "observed" | "failed";
  cleanup: "notStarted" | "killed" | "killNotObserved";
  starts: number;
  realCreateSeen: number;
  nativeSpawnAttempted: number;
  childSpawned: number;
  skippedForRealCreate: number;
  holdWaitTimedOut: number;
  holdBeforeGraceWaitTimedOut: number;
  holdBeforeGraceEntered: boolean;
  holdBeforeGraceReleased: boolean;
  holdBeforeGraceTimedOut: boolean;
  killAttempted: number;
  reapConfirmed: number;
  reapTimedOut: number;
  elapsedMs: number;
  createElapsedMs: number;
  errorKind?: WarmupErrorKind;
};

type WarmupMatrixEvidence = {
  correctness: {
    blank: number;
    unwritable: number;
    duplicate: number;
    lostDa1: number;
    orphan: number;
  };
  exclusion: "none";
};

export type WarmupCreate = {
  ptyId: string;
  generation: string;
  disposition: "created" | "attached";
  caseToken: string;
};

const reportPath = process.env.THREADTERM_WDIO_REPORT;
const warmupScenarioEnv = "THREADTERM_TERMINAL_STARTUP_WARMUP_SCENARIO";
const warmupCaseEnv = "THREADTERM_WDIO_WARMUP_CASE";
const warmupCases: readonly WarmupCase[] = [
  "off",
  "normalSuccess",
  "clickBeforeGrace",
  "spawnFailure",
  "neverExit",
  "clickDuringHold",
];

const scenarioForCase: Record<WarmupCase, WarmupScenario> = {
  off: "disabled",
  normalSuccess: "normal",
  clickBeforeGrace: "holdBeforeGrace",
  spawnFailure: "spawnFailure",
  neverExit: "neverExit",
  clickDuringHold: "holdBeforeNativeSpawn",
};

const runtimeStatuses: readonly WarmupRuntimeStatus[] = [
  "disabled",
  "waiting",
  "spawning",
  "completed",
  "failed",
  "timedOut",
  "skippedForRealCreate",
  "holdEntered",
  "holdReleased",
];

const scenarios: readonly WarmupScenario[] = [
  "disabled",
  "normal",
  "spawnFailure",
  "neverExit",
  "holdBeforeGrace",
  "holdBeforeNativeSpawn",
];

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : undefined;
}

function parseCounters(value: unknown): WarmupCounters {
  const source = objectValue(value) ?? {};
  return {
    starts: finiteCounter(source.starts),
    realCreateSeen: finiteCounter(source.realCreateSeen),
    nativeSpawnAttempted: finiteCounter(source.nativeSpawnAttempted),
    childSpawned: finiteCounter(source.childSpawned),
    skippedForRealCreate: finiteCounter(source.skippedForRealCreate),
    holdWaitTimedOut: finiteCounter(source.holdWaitTimedOut),
    holdBeforeGraceWaitTimedOut: finiteCounter(
      source.holdBeforeGraceWaitTimedOut,
    ),
    killAttempted: finiteCounter(source.killAttempted),
    reapConfirmed: finiteCounter(source.reapConfirmed),
    reapTimedOut: finiteCounter(source.reapTimedOut),
  };
}

export function parseWarmupSnapshot(
  value: unknown,
): WarmupSnapshot | undefined {
  const source = objectValue(value);
  const scenario = enumValue(source?.scenario, scenarios);
  const status = enumValue(source?.status, runtimeStatuses);
  if (!source || scenario === undefined || status === undefined)
    return undefined;
  return {
    enabled: source.enabled === true,
    scenario,
    status,
    holdEntered: source.holdEntered === true,
    holdReleased: source.holdReleased === true,
    holdTimedOut: source.holdTimedOut === true,
    holdBeforeGraceEntered: source.holdBeforeGraceEntered === true,
    holdBeforeGraceReleased: source.holdBeforeGraceReleased === true,
    holdBeforeGraceTimedOut: source.holdBeforeGraceTimedOut === true,
    realCreateSeen: source.realCreateSeen === true,
    counters: parseCounters(source.counters),
  };
}

export function configuredWarmupCase(): {
  case: WarmupCase;
  scenario: WarmupScenario;
} {
  if ((process.env.THREADTERM_WDIO_ARTIFACT ?? "production") !== "harness") {
    throw new Error("warmup-artifact-mismatch");
  }
  if ((process.env.THREADTERM_WDIO_FLOW ?? "") !== "warmup") {
    throw new Error("warmup-flow-mismatch");
  }
  const rawCase = process.env[warmupCaseEnv];
  if (!rawCase || !warmupCases.includes(rawCase as WarmupCase)) {
    throw new Error("warmup-case-missing");
  }
  const warmupCase = rawCase as WarmupCase;
  const rawScenario = process.env[warmupScenarioEnv];
  if (!rawScenario) throw new Error("warmup-scenario-missing");
  const scenario = enumValue(rawScenario, scenarios);
  if (!scenario) throw new Error("warmup-scenario-missing");
  if (scenarioForCase[warmupCase] !== scenario)
    throw new Error("warmup-scenario-mismatch");
  return { case: warmupCase, scenario };
}

export function newWarmupReport(
  warmupCase: WarmupCase | "unknown",
  scenario: WarmupScenario | "unknown",
  started: number,
): WarmupReport {
  return {
    kind: "harness-warmup",
    artifact: "harness",
    flow: "warmup",
    case: warmupCase,
    scenario,
    status: "failed",
    warmup: "unknown",
    disposition: "unknown",
    create: "notAttempted",
    write: "notAttempted",
    cleanup: "notStarted",
    starts: 0,
    realCreateSeen: 0,
    nativeSpawnAttempted: 0,
    childSpawned: 0,
    skippedForRealCreate: 0,
    holdWaitTimedOut: 0,
    holdBeforeGraceWaitTimedOut: 0,
    holdBeforeGraceEntered: false,
    holdBeforeGraceReleased: false,
    holdBeforeGraceTimedOut: false,
    killAttempted: 0,
    reapConfirmed: 0,
    reapTimedOut: 0,
    elapsedMs: Date.now() - started,
    createElapsedMs: 0,
  };
}

export function recordWarmupReport(
  report: WarmupReport,
  started: number,
): void {
  if (!reportPath) return;
  report.elapsedMs = Date.now() - started;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(
    reportPath,
    `${JSON.stringify(withWarmupMatrixEvidence(report))}\n`,
  );
}

/**
 * Warmup cases deliberately use the typed plain-shell fixture, so no DA1 is
 * injected and no Provider command is dispatched.  The other correctness
 * counters are derived from the real create/write/cleanup observations rather
 * than being reported as an unconditional all-zero projection.
 */
export function withWarmupMatrixEvidence(
  report: WarmupReport,
): WarmupReport & WarmupMatrixEvidence {
  const created =
    report.create === "created" && report.disposition === "created";
  const writable = report.write === "observed";
  const cleaned = report.cleanup === "killed";
  return {
    ...report,
    correctness: {
      blank: created && writable ? 0 : 1,
      unwritable: created && writable ? 0 : 1,
      duplicate: report.disposition === "attached" ? 1 : 0,
      // The prepare plan fixes `da1Fault: none`; the case sends no DA1 query.
      lostDa1: 0,
      orphan: cleaned ? 0 : 1,
    },
    exclusion: "none",
  };
}

export function safeWarmupErrorKind(error: unknown): WarmupErrorKind {
  const message = error instanceof Error ? error.message : "";
  const known: WarmupErrorKind[] = [
    "artifactMismatch",
    "flowMismatch",
    "scenarioMissing",
    "scenarioMismatch",
    "caseMissing",
    "prepareFailed",
    "caseNotBound",
    "commandUnavailable",
    "warmupTimeout",
    "stageNotObserved",
    "createFailed",
    "createTimeout",
    "writeFailed",
    "writeNotObserved",
    "warmupOutcomeMismatch",
    "reapEvidenceMissing",
    "holdReleaseFailed",
    "cleanupFailed",
  ];
  const mapping: Record<string, WarmupErrorKind> = {
    "warmup-artifact-mismatch": "artifactMismatch",
    "warmup-flow-mismatch": "flowMismatch",
    "warmup-scenario-missing": "scenarioMissing",
    "warmup-case-missing": "caseMissing",
    "warmup-prepare-failed": "prepareFailed",
    "warmup-case-not-bound": "caseNotBound",
    "warmup-scenario-mismatch": "scenarioMismatch",
    "warmup-command-unavailable": "commandUnavailable",
    "warmup-poll-timeout": "warmupTimeout",
    "warmup-stage-not-observed": "stageNotObserved",
    "warmup-create-failed": "createFailed",
    "warmup-create-timeout": "createTimeout",
    "warmup-write-failed": "writeFailed",
    "warmup-write-not-observed": "writeNotObserved",
    "warmup-outcome-mismatch": "warmupOutcomeMismatch",
    "warmup-reap-evidence-missing": "reapEvidenceMissing",
    "warmup-hold-release-failed": "holdReleaseFailed",
    "warmup-cleanup-failed": "cleanupFailed",
  };
  if (message in mapping) return mapping[message];
  if (known.includes(message as WarmupErrorKind))
    return message as WarmupErrorKind;
  return "unexpected";
}

export async function readWarmupSnapshot(): Promise<
  WarmupSnapshot | undefined
> {
  const result = await invoke("terminal_startup_harness_warmup_snapshot", {});
  if (!result.ok) return undefined;
  return parseWarmupSnapshot(result.value);
}

export async function pollWarmupSnapshot(
  accept: (snapshot: WarmupSnapshot) => boolean,
  timeoutMs = 15_000,
  stableReads = 2,
): Promise<WarmupSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const snapshot = await readWarmupSnapshot();
    if (snapshot && accept(snapshot)) {
      stable += 1;
      if (stable >= stableReads) return snapshot;
    } else {
      stable = 0;
    }
    await browser.pause(75);
  }
  throw new Error("warmup-poll-timeout");
}

export async function waitForWarmupStage(
  status: WarmupRuntimeStatus,
  timeoutMs = 15_000,
): Promise<WarmupSnapshot> {
  return pollWarmupSnapshot(
    (snapshot) => snapshot.status === status,
    timeoutMs,
  );
}

export function copySnapshotToReport(
  report: WarmupReport,
  snapshot: WarmupSnapshot,
): void {
  report.scenario = snapshot.scenario;
  report.warmup = snapshot.status;
  report.starts = snapshot.counters.starts;
  report.realCreateSeen = snapshot.counters.realCreateSeen;
  report.nativeSpawnAttempted = snapshot.counters.nativeSpawnAttempted;
  report.childSpawned = snapshot.counters.childSpawned;
  report.skippedForRealCreate = snapshot.counters.skippedForRealCreate;
  report.holdWaitTimedOut = snapshot.counters.holdWaitTimedOut;
  report.holdBeforeGraceWaitTimedOut =
    snapshot.counters.holdBeforeGraceWaitTimedOut;
  report.holdBeforeGraceEntered = snapshot.holdBeforeGraceEntered;
  report.holdBeforeGraceReleased = snapshot.holdBeforeGraceReleased;
  report.holdBeforeGraceTimedOut = snapshot.holdBeforeGraceTimedOut;
  report.killAttempted = snapshot.counters.killAttempted;
  report.reapConfirmed = snapshot.counters.reapConfirmed;
  report.reapTimedOut = snapshot.counters.reapTimedOut;
}

async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutError: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createCaseId(): string {
  return `terminal-startup-warmup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const writablePtyPrepareRequest = {
  shell: "cmd",
  surface: "uiNextCreate",
  timing: "natural",
  da1Fault: "none",
  warmup: "disabled",
  fixture: "plainShell",
} as const;

function prepareCaseToken(value: unknown): string | undefined {
  const source = objectValue(value);
  return typeof source?.caseToken === "string" && source.caseToken.length > 0
    ? source.caseToken
    : undefined;
}

async function prepareWritablePtyCase(): Promise<string> {
  const result = await invoke("terminal_startup_harness_prepare_case", {
    request: writablePtyPrepareRequest,
  });
  const caseToken = result.ok ? prepareCaseToken(result.value) : undefined;
  if (!caseToken) throw new Error("warmup-prepare-failed");
  return caseToken;
}

export async function cleanupWritablePtyCase(caseToken: string): Promise<boolean> {
  return (await invoke("terminal_startup_harness_cleanup_case", { caseToken }))
    .ok;
}

async function assertWritablePtyCaseBound(caseToken: string): Promise<void> {
  const result = await invoke("terminal_startup_harness_snapshot", { caseToken });
  const snapshot = result.ok ? objectValue(result.value) : undefined;
  if (snapshot?.state !== "bound") {
    throw new Error("warmup-case-not-bound");
  }
}

export async function createWritablePty(
  ptyId = createCaseId(),
): Promise<WarmupCreate> {
  const dataRoot = process.env.THREADTERM_WDIO_DATA_ROOT;
  if (!dataRoot) throw new Error("warmup-create-failed");
  let caseToken: string | undefined;
  try {
    caseToken = await prepareWritablePtyCase();
    const result = await withDeadline(
      invoke("pty_create_session_v2", {
        request: {
          id: ptyId,
          workingDir: dataRoot,
          rows: 24,
          cols: 100,
          startup: { kind: "none" },
        },
      }),
      10_000,
      "warmup-create-timeout",
    );
    if (!result.ok || !result.value || typeof result.value !== "object") {
      throw new Error("warmup-create-failed");
    }
    const value = result.value as Record<string, unknown>;
    const generation =
      typeof value.generation === "string" ? value.generation : undefined;
    const returnedId = typeof value.ptyId === "string" ? value.ptyId : undefined;
    const disposition =
      value.disposition === "created" || value.disposition === "attached"
        ? value.disposition
        : undefined;
    if (!generation || returnedId !== ptyId || !disposition)
      throw new Error("warmup-create-failed");
    await assertWritablePtyCaseBound(caseToken);
    return { ptyId, generation, disposition, caseToken };
  } catch (error) {
    if (caseToken && !(await cleanupWritablePtyCase(caseToken))) {
      throw new Error("warmup-cleanup-failed");
    }
    throw error;
  }
}

export async function writeAndObservePty(ptyId: string): Promise<"observed"> {
  const marker = "THREADTERM_WARMUP_WRITE_OK";
  const write = await invoke("pty_input", {
    id: ptyId,
    data: `echo ${marker}\r`,
  });
  if (!write.ok) throw new Error("warmup-write-failed");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const output = await invoke("pty_get_recent_output", { ptyId });
    if (
      output.ok &&
      typeof output.value === "string" &&
      output.value.includes(marker)
    ) {
      return "observed";
    }
    await browser.pause(75);
  }
  throw new Error("warmup-write-not-observed");
}

export async function releaseWarmupHold(): Promise<WarmupSnapshot> {
  const result = await invoke("terminal_startup_harness_warmup_release", {});
  const snapshot = result.ok ? parseWarmupSnapshot(result.value) : undefined;
  if (!snapshot) throw new Error("warmup-hold-release-failed");
  return snapshot;
}

export async function killAndConfirmPty(ptyId: string): Promise<boolean> {
  const killed = await invoke("pty_kill", { id: ptyId });
  if (!killed.ok) return false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const sessions = await invoke("pty_get_all_session_states", {});
    if (
      sessions.ok &&
      sessions.value &&
      typeof sessions.value === "object" &&
      !(ptyId in (sessions.value as Record<string, unknown>))
    )
      return true;
    await browser.pause(75);
  }
  return false;
}
