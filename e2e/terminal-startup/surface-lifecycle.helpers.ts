import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  closeShell,
  createShell,
  floatAttachHideRevealReturn,
  invoke,
  waitForSurface,
  withMatrixEvidence,
  type SmokeCounters,
} from "./helpers";
import {
  PROVIDER_SENTINEL,
  PROVIDER_SHELLS,
  shellAvailability,
  syntheticProviderCommand,
  waitForStartupSent,
  type ProviderShell,
} from "./provider.helpers";
import {
  parseStartupSnapshot,
  waitForSentinelExactlyOnce as waitForTimingSentinelExactlyOnce,
  type StartupSnapshot,
} from "./timing.helpers";

export type SurfaceLifecycleShell = ProviderShell | "unknown";
export type SurfaceLifecycleStatus = "passed" | "unavailable" | "failed";

export type SurfaceLifecycleReport = {
  kind: "harness-surface-lifecycle";
  artifact: "harness";
  flow: "surfaceLifecycle";
  shell: SurfaceLifecycleShell;
  availability: "available" | "unavailable";
  status: SurfaceLifecycleStatus;
  create: "created" | "notObserved";
  nonceReadbacks: number;
  identityStable: "yes" | "no" | "notChecked";
  generationStable: "yes" | "no" | "notChecked";
  providerStartup: "sent" | "notObserved";
  providerStartupDispatches: number;
  floatAttach: "observed" | "notObserved";
  hiddenReveal: "observed" | "notObserved";
  recycleToMain: "observed" | "notObserved";
  resize: "observed" | "notObserved";
  writeAfterReveal: "observed" | "notObserved";
  close: "requested" | "notRequested";
  sessionGone: "yes" | "no" | "notChecked";
  ptyCleanupCalls: number;
  harnessCleanupCalls: number;
  orphanSessions: number;
  lruUnload: "notExercised";
  cleanup: "notStarted" | "observed" | "failed";
  elapsedMs: number;
  errorKind?:
    | "artifactMismatch"
    | "reportPathMissing"
    | "harnessCapabilityUnavailable"
    | "dataRootMismatch"
    | "availabilityMissing"
    | "shellUnavailable"
    | "requiredCmdUnavailable"
    | "createFailed"
    | "multipleSessionsCreated"
    | "cardIdentityUnavailable"
    | "attachFailed"
    | "identityMismatch"
    | "generationMismatch"
    | "startupFailed"
    | "startupTimeout"
    | "sentinelMissing"
    | "sentinelDuplicate"
    | "resizeUnavailable"
    | "floatUnavailable"
    | "closeUnavailable"
    | "sessionOrphaned"
    | "cleanupFailed"
    | "unexpected";
};

type RecordValue = Record<string, unknown>;

export type SurfaceSessionSnapshot = {
  ptyId: string;
  rows: number;
  cols: number;
  seq: number;
};

export type SurfaceProviderAttachment = {
  ptyId: string;
  generation: string;
  shellFamily: "pwsh" | "windowsPowerShell" | "cmd" | "posix";
  disposition: "created" | "attached";
  descriptorDisposition:
    "accepted" | "matched" | "legacyClaimed" | "notApplicable";
  startup: StartupSnapshot;
};

export type SurfaceCardIdentity = {
  id: string;
  ptyId: string;
};

const reportPath = process.env.THREADTERM_WDIO_REPORT;
const dataRoot = process.env.THREADTERM_WDIO_DATA_ROOT;

function objectValue(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

function isShellFamily(
  value: unknown,
): value is SurfaceProviderAttachment["shellFamily"] {
  return (
    value === "pwsh" ||
    value === "windowsPowerShell" ||
    value === "cmd" ||
    value === "posix"
  );
}

export function newSurfaceLifecycleReport(
  shell: SurfaceLifecycleShell,
): SurfaceLifecycleReport {
  return {
    kind: "harness-surface-lifecycle",
    artifact: "harness",
    flow: "surfaceLifecycle",
    shell,
    availability: shell === "unknown" ? "unavailable" : "available",
    status: "failed",
    create: "notObserved",
    nonceReadbacks: 0,
    identityStable: "notChecked",
    generationStable: "notChecked",
    providerStartup: "notObserved",
    providerStartupDispatches: 0,
    floatAttach: "notObserved",
    hiddenReveal: "notObserved",
    recycleToMain: "notObserved",
    resize: "notObserved",
    writeAfterReveal: "notObserved",
    close: "notRequested",
    sessionGone: "notChecked",
    ptyCleanupCalls: 0,
    harnessCleanupCalls: 0,
    orphanSessions: 0,
    lruUnload: "notExercised",
    cleanup: "notStarted",
    elapsedMs: 0,
  };
}

export function recordSurfaceLifecycleReport(
  report: SurfaceLifecycleReport,
  started: number,
): void {
  if (!reportPath) throw new Error("surface-report-path-missing");
  report.elapsedMs = Date.now() - started;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence(report))}\n`);
}

export function safeSurfaceErrorKind(
  error: unknown,
): SurfaceLifecycleReport["errorKind"] {
  const message = error instanceof Error ? error.message : "";
  const known: SurfaceLifecycleReport["errorKind"][] = [
    "artifactMismatch",
    "reportPathMissing",
    "harnessCapabilityUnavailable",
    "dataRootMismatch",
    "availabilityMissing",
    "shellUnavailable",
    "requiredCmdUnavailable",
    "createFailed",
    "multipleSessionsCreated",
    "cardIdentityUnavailable",
    "attachFailed",
    "identityMismatch",
    "generationMismatch",
    "startupFailed",
    "startupTimeout",
    "sentinelMissing",
    "sentinelDuplicate",
    "resizeUnavailable",
    "floatUnavailable",
    "closeUnavailable",
    "sessionOrphaned",
    "cleanupFailed",
    "unexpected",
  ];
  const mapping: Record<string, SurfaceLifecycleReport["errorKind"]> = {
    "surface-artifact-mismatch": "artifactMismatch",
    "surface-report-path-missing": "reportPathMissing",
    "surface-harness-capability-unavailable": "harnessCapabilityUnavailable",
    "surface-data-root-mismatch": "dataRootMismatch",
    "surface-shell-availability-missing": "availabilityMissing",
    "surface-shell-unavailable": "shellUnavailable",
    "surface-required-cmd-unavailable": "requiredCmdUnavailable",
    "surface-create-failed": "createFailed",
    "surface-multiple-pty-created": "multipleSessionsCreated",
    "surface-card-identity-unavailable": "cardIdentityUnavailable",
    "surface-attach-failed": "attachFailed",
    "surface-identity-mismatch": "identityMismatch",
    "surface-generation-mismatch": "generationMismatch",
    "surface-startup-failed": "startupFailed",
    "surface-startup-timeout": "startupTimeout",
    "surface-sentinel-missing": "sentinelMissing",
    "surface-sentinel-duplicate": "sentinelDuplicate",
    "surface-resize-unavailable": "resizeUnavailable",
    "surface-float-unavailable": "floatUnavailable",
    "surface-close-unavailable": "closeUnavailable",
    "surface-session-orphaned": "sessionOrphaned",
    "surface-cleanup-failed": "cleanupFailed",
  };
  if (mapping[message]) return mapping[message];
  if (known.includes(message as SurfaceLifecycleReport["errorKind"])) {
    return message as SurfaceLifecycleReport["errorKind"];
  }
  return "unexpected";
}

export function assertSurfaceHarnessEnvironment(): void {
  if ((process.env.THREADTERM_WDIO_ARTIFACT ?? "production") !== "harness") {
    throw new Error("surface-artifact-mismatch");
  }
  if (!reportPath) throw new Error("surface-report-path-missing");
  if (!dataRoot) throw new Error("surface-data-root-mismatch");
}

export async function assertSurfaceHarnessCapabilities(): Promise<void> {
  const status = await invoke("terminal_startup_harness_status", {});
  const value = objectValue(status.value);
  if (
    !status.ok ||
    value?.enabled !== true ||
    value.readOnlyObservation !== "supported"
  ) {
    throw new Error("surface-harness-capability-unavailable");
  }

  const directory = await invoke("data_directory_status", {});
  const root = objectValue(directory.value)?.root;
  if (
    !directory.ok ||
    typeof root !== "string" ||
    normalizeWindowsPath(root) !== normalizeWindowsPath(dataRoot as string)
  ) {
    throw new Error("surface-data-root-mismatch");
  }
}

export function selectSurfaceShell(): ProviderShell {
  for (const shell of PROVIDER_SHELLS) {
    let availability: ReturnType<typeof shellAvailability>;
    try {
      availability = shellAvailability(shell);
    } catch {
      throw new Error("surface-shell-availability-missing");
    }
    if (availability === "available") return shell;
    if (shell === "cmd") throw new Error("surface-required-cmd-unavailable");
  }
  throw new Error("surface-shell-unavailable");
}

export async function readLiveSessionIds(): Promise<Set<string>> {
  const result = await invoke("pty_get_all_session_states", {});
  if (!result.ok || !result.value || typeof result.value !== "object") {
    throw new Error("surface-create-failed");
  }
  return new Set(Object.keys(result.value as Record<string, unknown>));
}

export async function waitForNewSession(
  baseline: Set<string>,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await readLiveSessionIds();
    const created = [...current].filter((id) => !baseline.has(id));
    if (created.length > 1) throw new Error("surface-multiple-pty-created");
    if (created.length === 1) return created[0];
    await browser.pause(75);
  }
  throw new Error("surface-create-failed");
}

export async function readSurfaceCardIdentity(
  label: string,
): Promise<SurfaceCardIdentity | undefined> {
  const value = await browser.execute((cardLabel) => {
    try {
      const raw = window.localStorage.getItem("threadterm-terminal-store");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as {
        state?: { cards?: unknown };
        cards?: unknown;
      };
      const state = parsed.state ?? parsed;
      const cards = Array.isArray(state.cards) ? state.cards : [];
      const card = cards.find(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry as { projectName?: unknown }).projectName === cardLabel,
      ) as { id?: unknown; ptyId?: unknown } | undefined;
      if (typeof card?.id !== "string" || typeof card.ptyId !== "string") {
        return undefined;
      }
      return { id: card.id, ptyId: card.ptyId };
    } catch {
      return undefined;
    }
  }, label);
  const source = objectValue(value);
  const id = stringValue(source?.id);
  const ptyId = stringValue(source?.ptyId);
  return id && ptyId ? { id, ptyId } : undefined;
}

export async function waitForSurfaceCardIdentity(
  label: string,
): Promise<SurfaceCardIdentity> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const identity = await readSurfaceCardIdentity(label);
    if (identity) return identity;
    await browser.pause(100);
  }
  throw new Error("surface-card-identity-unavailable");
}

export async function readSurfaceSessionSnapshot(
  ptyId: string,
): Promise<SurfaceSessionSnapshot | undefined> {
  const result = await invoke("pty_attach_snapshot", { ptyId });
  if (!result.ok || result.value === null || result.value === undefined) {
    return undefined;
  }
  const source = objectValue(result.value);
  const returnedPtyId = stringValue(source?.ptyId);
  const rows = positiveInteger(source?.rows);
  const cols = positiveInteger(source?.cols);
  const seq = nonNegativeInteger(source?.seq);
  if (
    !returnedPtyId ||
    rows === undefined ||
    cols === undefined ||
    seq === undefined
  ) {
    return undefined;
  }
  if (returnedPtyId !== ptyId) throw new Error("surface-identity-mismatch");
  return { ptyId: returnedPtyId, rows, cols, seq };
}

export async function waitForSurfaceSessionSnapshot(
  ptyId: string,
): Promise<SurfaceSessionSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await readSurfaceSessionSnapshot(ptyId);
    if (snapshot) return snapshot;
    await browser.pause(75);
  }
  throw new Error("surface-attach-failed");
}

export async function attachSurfaceProvider(
  ptyId: string,
  cardId: string,
  shell: ProviderShell,
  snapshot: SurfaceSessionSnapshot,
): Promise<SurfaceProviderAttachment> {
  if (!dataRoot) throw new Error("surface-data-root-mismatch");
  // The card is created by the public shell UI first. This additive v2 attach
  // claims the already-live legacy session with a synthetic Provider intent so
  // main/float can be checked against one Rust generation without launching a
  // real Provider or touching credentials/history.
  const command = syntheticProviderCommand(shell);
  const result = await invoke("pty_create_session_v2", {
    request: {
      id: ptyId,
      workingDir: dataRoot,
      rows: snapshot.rows,
      cols: snapshot.cols,
      startup: {
        kind: "provider",
        provider: "codex",
        command,
        cardId,
        action: "start",
        sideEffectPlan: {
          kind: "bind",
          providerSessionId: "surface-harness-session",
        },
      },
    },
  });
  const source = objectValue(result.value);
  const returnedPtyId = stringValue(source?.ptyId);
  const generation = stringValue(source?.generation);
  const shellFamily = source?.shellFamily;
  const disposition = source?.disposition;
  const descriptorDisposition = source?.descriptorDisposition;
  const startup = parseStartupSnapshot(source?.startup);
  if (
    !result.ok ||
    !returnedPtyId ||
    !generation ||
    !isShellFamily(shellFamily) ||
    (disposition !== "created" && disposition !== "attached") ||
    (descriptorDisposition !== "accepted" &&
      descriptorDisposition !== "matched" &&
      descriptorDisposition !== "legacyClaimed" &&
      descriptorDisposition !== "notApplicable") ||
    !startup
  ) {
    throw new Error("surface-attach-failed");
  }
  if (returnedPtyId !== ptyId) throw new Error("surface-identity-mismatch");
  if (startup.generation !== generation)
    throw new Error("surface-generation-mismatch");
  return {
    ptyId: returnedPtyId,
    generation,
    shellFamily,
    disposition,
    descriptorDisposition,
    startup,
  };
}

export async function readSurfaceProviderStartup(
  attachment: SurfaceProviderAttachment,
): Promise<StartupSnapshot | undefined> {
  const result = await invoke("pty_get_startup_state", {
    ptyId: attachment.ptyId,
    generation: attachment.generation,
  });
  if (!result.ok || result.value === null || result.value === undefined) {
    return undefined;
  }
  const snapshot = parseStartupSnapshot(result.value);
  if (!snapshot) throw new Error("surface-attach-failed");
  if (snapshot.generation !== attachment.generation) {
    throw new Error("surface-generation-mismatch");
  }
  return snapshot;
}

export async function waitForSurfaceProviderSent(
  attachment: SurfaceProviderAttachment,
): Promise<void> {
  try {
    await waitForStartupSent(attachment.ptyId, attachment.generation);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "provider-startup-terminal-state") {
      throw new Error("surface-startup-failed");
    }
    throw new Error("surface-startup-timeout");
  }
}

export async function waitForSurfaceSentinel(
  attachment: SurfaceProviderAttachment,
  caseToken: string,
  sentinel: string,
): Promise<number> {
  try {
    const evidence = await waitForTimingSentinelExactlyOnce(
      attachment.ptyId,
      attachment.generation,
      caseToken,
      sentinel,
    );
    if (evidence.matches !== 1) throw new Error("surface-sentinel-missing");
    return evidence.matches;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "timing-startup-failed")
      throw new Error("surface-startup-failed");
    if (message === "timing-sentinel-duplicate") {
      throw new Error("surface-sentinel-duplicate");
    }
    if (message === "timing-sentinel-missing") {
      throw new Error("surface-sentinel-missing");
    }
    throw error;
  }
}

export async function prepareSurfaceCase(
  shell: ProviderShell,
): Promise<{ caseToken: string; sentinel: string }> {
  const result = await invoke("terminal_startup_harness_prepare_case", {
    request: {
      shell,
      surface: "uiNextCreate",
      timing: "natural",
      da1Fault: "none",
      warmup: "disabled",
      fixture: "syntheticProvider",
    },
  });
  const token = stringValue(objectValue(result.value)?.caseToken);
  if (!result.ok || !token) throw new Error("surface-attach-failed");
  return { caseToken: token, sentinel: PROVIDER_SENTINEL };
}

export async function cleanupSurfaceCase(caseToken: string): Promise<boolean> {
  return (await invoke("terminal_startup_harness_cleanup_case", { caseToken }))
    .ok;
}

export async function createSurfaceShell(
  baseline: Set<string>,
): Promise<{ label: string; identity: SurfaceCardIdentity; ptyId: string }> {
  await waitForSurface();
  const label = await createShell();
  const ptyId = await waitForNewSession(baseline);
  const identity = await waitForSurfaceCardIdentity(label);
  if (identity.ptyId !== ptyId) throw new Error("surface-identity-mismatch");
  return { label, identity, ptyId };
}

async function visibleSurfaceHost(): Promise<WebdriverIO.Element> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const host of await $$(".threadterm-xterm-host")) {
      if (await host.isDisplayed().catch(() => false)) return host;
    }
    await browser.pause(100);
  }
  throw new Error("surface-float-unavailable");
}

export async function typeAndReadSurfaceNonce(ptyId: string): Promise<void> {
  const host = await visibleSurfaceHost();
  const textarea = await host.$("textarea");
  await textarea.click().catch(() => undefined);
  const nonce = `TT_SURFACE_READBACK_${Date.now().toString(16)}${Math.random()
    .toString(16)
    .slice(2)}`;
  await browser.keys(`echo ${nonce}`);
  await browser.keys("Enter");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const output = await invoke("pty_get_recent_output", { ptyId });
    if (
      output.ok &&
      typeof output.value === "string" &&
      output.value.includes(nonce)
    ) {
      return;
    }
    await browser.pause(100);
  }
  throw new Error("surface-create-failed");
}

export async function observeSurfaceResize(
  ptyId: string,
  before: SurfaceSessionSnapshot,
): Promise<SurfaceSessionSnapshot> {
  const sizes = [
    { width: 800, height: 520 },
    { width: 1480, height: 900 },
  ];
  for (const size of sizes) {
    await browser.setWindowSize(size.width, size.height);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const after = await readSurfaceSessionSnapshot(ptyId);
      if (after && (after.rows !== before.rows || after.cols !== before.cols)) {
        return after;
      }
      await browser.pause(100);
    }
  }
  throw new Error("surface-resize-unavailable");
}

export async function exerciseSurfaceFloatLifecycle(
  counters: SmokeCounters,
  label: string,
): Promise<void> {
  try {
    await floatAttachHideRevealReturn(counters, label);
  } catch {
    throw new Error("surface-float-unavailable");
  }
  if (
    counters.floatAttach !== 1 ||
    counters.floatHideReveal !== 1 ||
    counters.recycle !== 1
  ) {
    throw new Error("surface-float-unavailable");
  }
}

export async function requestSurfaceClose(
  counters: SmokeCounters,
): Promise<void> {
  try {
    await closeShell(counters);
  } catch {
    throw new Error("surface-close-unavailable");
  }
  if (counters.closed !== 1) throw new Error("surface-close-unavailable");
}

export async function waitForSurfaceSessionGone(ptyId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await invoke("pty_get_session_state", { ptyId });
    if (!state.ok) return;
    await browser.pause(100);
  }
  throw new Error("surface-session-orphaned");
}

export async function countSurfaceOrphans(
  baseline: Set<string>,
): Promise<number> {
  const current = await readLiveSessionIds();
  return [...current].filter((id) => !baseline.has(id)).length;
}
