import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SAFE_INHERITED_ENV_NAMES = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMPUTERNAME",
  "COMSPEC",
  "DRIVERDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "LOCALAPPDATA",
  "LOGONSERVER",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PSMODULEPATH",
  "PUBLIC",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

const RUNNER_OWNED_ENV_NAMES = new Set([
  "THREADTERM_WDIO_ARTIFACT",
  "THREADTERM_WDIO_EXPECT_HARNESS",
  "THREADTERM_WDIO_FLOW",
  "THREADTERM_WDIO_UDF",
  "THREADTERM_WDIO_DATA_ROOT",
  "THREADTERM_WDIO_APP",
  "THREADTERM_WDIO_REPORT",
  "THREADTERM_WDIO_RUNTIME_ISOLATION_MARKER",
  "THREADTERM_WDIO_PROVIDER_PWSH_AVAILABLE",
  "THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_AVAILABLE",
  "THREADTERM_WDIO_PROVIDER_CMD_AVAILABLE",
  "THREADTERM_WDIO_PROVIDER_PWSH_PATH",
  "THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_PATH",
  "THREADTERM_WDIO_PROVIDER_CMD_PATH",
  "THREADTERM_WDIO_ENCODING_GIT_PATH",
  "THREADTERM_WDIO_ENCODING_NODE_PATH",
  "THREADTERM_WDIO_ENCODING_PYTHON_PATH",
  "THREADTERM_WDIO_DA1_SHELL",
  "THREADTERM_WDIO_DA1_AVAILABLE",
  "THREADTERM_WDIO_WARMUP_CMD_AVAILABLE",
  "THREADTERM_WDIO_ENCODING_CASE",
  "THREADTERM_WDIO_EXPECT_POWERSHELL_UTF8",
  "THREADTERM_WDIO_WARMUP_CASE",
  "THREADTERM_WDIO_CONCURRENCY",
  "THREADTERM_WDIO_PROVIDER_REPEATS",
  "THREADTERM_WDIO_PROVIDER_SHELL",
  "THREADTERM_WDIO_MATRIX_REPORT",
  "THREADTERM_PROVIDER_SHELL_READY",
  "THREADTERM_DA1_AUTHORITY",
  "THREADTERM_POWERSHELL_UTF8",
  "THREADTERM_CONPTY_WARMUP",
  "THREADTERM_TERMINAL_STARTUP_HARNESS_ROOT",
  "THREADTERM_TERMINAL_STARTUP_WARMUP_SCENARIO",
  "THREADTERM_TERMINAL_STARTUP_HARNESS_OFFLINE",
  "THREADTERM_WDIO_EXPECT_OFFLINE_CSP",
  "THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS",
  "PATH",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "POWERSHELL_TELEMETRY_OPTOUT",
  "POWERSHELL_UPDATECHECK",
  "PSMODULEANALYSISCACHEPATH",
  "PSDISABLEMODULEANALYSISCACHECLEANUP",
  "TEMP",
  "TMP",
  "PSMODULEPATH",
]);

const FORBIDDEN_CHILD_ENV_NAMES = new Set([
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "KIMI_CODE_HOME",
  "OPENCODE_DB",
  "XDG_DATA_HOME",
]);

const OFFLINE_HOST_RESOLVER_RULE =
  "MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE asset.localhost,EXCLUDE tauri.localhost,EXCLUDE 127.0.0.1,EXCLUDE ::1";
const OFFLINE_WEBVIEW2_ARGUMENTS = Object.freeze([
  "disable-background-networking",
  `host-resolver-rules=${OFFLINE_HOST_RESOLVER_RULE}`,
]);
const OFFLINE_WEBVIEW2_ARGUMENTS_JSON = JSON.stringify(
  OFFLINE_WEBVIEW2_ARGUMENTS,
);
const WEBVIEW2_PROCESS_NAME = "MSEDGEWEBVIEW2.EXE";
const PROCESS_OBSERVATION_TIMEOUT_MS = 10_000;
const PRODUCTION_APPLICATION_IDENTIFIER = "com.Heluth-Crazy.threadterm";
const HARNESS_APPLICATION_IDENTIFIER =
  "com.Heluth-Crazy.threadterm.terminal-startup-harness";
const PRODUCTION_DISPOSABLE_PROFILE_MARKER_NAME =
  ".threadterm-terminal-startup-disposable-profile-v1";
const PRODUCTION_DISPOSABLE_PROFILE_MARKER_VALUE =
  "THREADTERM_TERMINAL_STARTUP_DISPOSABLE_PROFILE_V1\n";
const WDIO_HARD_DEADLINE_MS = 120_000;
const ISOLATION_DRIVER_UDF_WAIT_CAP_MS = 30_000;
const ISOLATION_RUNTIME_UDF_WAIT_CAP_MS = 30_000;
const ISOLATION_WDIO_SESSION_WAIT_CAP_MS = 90_000;
const RUN_TOTAL_BUDGET_MS = 210_000;
const CLEANUP_RESERVE_MS = 60_000;
const WORK_PHASE_BUDGET_MS = RUN_TOTAL_BUDGET_MS - CLEANUP_RESERVE_MS;
const SUPERVISOR_READY_CAP_MS = 20_000;
const SUPERVISOR_OUTPUT_LIMIT_BYTES = 64;
const SUPERVISOR_READY_LINE = "THREADTERM_JOB_READY_V1";
const SUPERVISOR_CLEANUP_GRACE_CAP_MS = 30_000;
const SUPERVISOR_CLEANUP_FORCE_RESERVE_MS = 5_000;
const RUNNER_STAGES = new Set([
  "preflight",
  "driverIdentity",
  "driverHandshake",
  "driverSupervisorIdentity",
  "driverPort",
  "driverReady",
  "driverStatus",
  "wdioIdentity",
  "wdioSession",
  "wdioWorker",
  "webdriverSession",
  "driverUdf",
  "runtimeUdf",
  "appIdentity",
  "wdio",
  "cleanup",
  "complete",
]);
const PRE_WDIO_RUNNER_STAGES = new Set([
  "preflight",
  "driverIdentity",
  "driverHandshake",
  "driverSupervisorIdentity",
  "driverPort",
  "driverReady",
  "driverStatus",
]);
const RUNNER_OUTCOMES = new Set([
  "failed",
  "timeout",
  "cleanupUnverified",
  "cleanupFailed",
  "success",
]);

const FORBIDDEN_HARNESS_CSP_TOKENS = Object.freeze([
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https:",
  "http://localhost:",
  "https://localhost:",
  "http://127.0.0.1:",
  "https://127.0.0.1:",
  "ws://localhost:",
  "wss://localhost:",
  "ws://127.0.0.1:",
  "wss://127.0.0.1:",
]);

const RUNNER_CLEANUP_EVIDENCE = Object.freeze({
  runnerCleanup: "verified",
  driverSupervisor: "exited",
  wdioSupervisor: "exited",
  appTree: "gone",
  tauriDriverPort: "refused",
  nativeDriverPort: "refused",
  sandbox: "removed",
});
const RUNNER_CLEANUP_APP_TREE_VALUES = new Set(["gone", "notRequested"]);
let processObservationEnvironmentSource = process.env;

function normalizeEnvName(name) {
  return String(name).toUpperCase();
}

function readEnv(source, name) {
  const normalizedName = normalizeEnvName(name);
  for (const [key, value] of Object.entries(source ?? {})) {
    if (normalizeEnvName(key) === normalizedName) return value;
  }
  return undefined;
}

function observationSystemRoot(source = process.env) {
  const systemRoot = readEnv(source, "SystemRoot");
  const windir = readEnv(source, "WINDIR");
  if (
    systemRoot !== undefined &&
    windir !== undefined &&
    comparableWindowsPath(systemRoot) !== comparableWindowsPath(windir)
  ) {
    return undefined;
  }
  const value = systemRoot ?? windir;
  return typeof value === "string" && isAbsolute(value) ? value : undefined;
}

function canonicalExistingFile(pathValue) {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) return undefined;
  try {
    const canonical = realpathSync.native(pathValue);
    return lstatSync(canonical).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalLocalWindowsExecutable(pathValue, basename) {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) return undefined;
  if (/^(?:\\\\|\\\\\?\\|\\\\\.\\)/.test(pathValue)) return undefined;
  if (pathValue.includes("/")) return undefined;
  try {
    const original = lstatSync(pathValue);
    if (!original.isFile() || original.isSymbolicLink()) return undefined;
    const canonical = realpathSync.native(pathValue);
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (!isSafeLocalExecutableReceipt(canonical, basename)) return undefined;
    const observedBasename = canonical.slice(canonical.lastIndexOf("\\") + 1);
    if (observedBasename.toLowerCase() !== basename.toLowerCase()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

function safeLocalPathDirectory(value) {
  if (typeof value !== "string") return undefined;
  let candidate = value.trim();
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"'))
    candidate = candidate.slice(1, -1);
  if (
    !/^[A-Za-z]:\\/.test(candidate)
    || candidate.includes("/")
    || candidate.includes("%")
    || candidate.includes("$")
    || candidate.includes('"')
    || candidate.toLowerCase().includes("\\windowsapps")
  ) return undefined;
  return candidate;
}

function safeLocalPathDirectories(source = process.env) {
  const pathValue = readEnv(source, "PATH");
  if (typeof pathValue !== "string") return [];
  return pathValue
    .split(";")
    .map(safeLocalPathDirectory)
    .filter((value) => typeof value === "string");
}

function resolveSafeLocalPathExecutable(
  basename,
  source = process.env,
  probe = canonicalExistingWindowsExecutable,
) {
  if (typeof basename !== "string" || !/^[A-Za-z0-9_.-]+\.exe$/i.test(basename))
    return undefined;
  for (const directory of safeLocalPathDirectories(source)) {
    const candidate = join(directory, basename);
    const receipt = probe(candidate, basename);
    if (isSafeLocalExecutableReceipt(receipt, basename)) return receipt;
  }
  return undefined;
}

function isSafeLocalExecutableReceipt(value, basename) {
  if (typeof value !== "string" || typeof basename !== "string") return false;
  const diskPath = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  return (
    /^[A-Za-z]:\\/.test(diskPath) &&
    !value.includes("/") &&
    !value.startsWith("\\\\.\\") &&
    !value.toLowerCase().startsWith("\\\\?\\unc\\") &&
    !value.toLowerCase().includes("\\windowsapps") &&
    value.slice(value.lastIndexOf("\\") + 1).toLowerCase() === basename.toLowerCase()
  );
}

function canonicalSystem32Executable(source, relativeParts, basename) {
  const systemRoot = observationSystemRoot(source);
  if (!systemRoot) return undefined;
  return isCanonicalLocalWindowsExecutable(
    join(systemRoot, "System32", ...relativeParts, basename),
    basename,
  );
}

function canonicalPwshExecutable(
  source,
  probe = canonicalExistingWindowsExecutable,
) {
  const programFiles = readEnv(source, "ProgramW6432") ?? readEnv(source, "ProgramFiles");
  const fixed =
    typeof programFiles === "string" && isAbsolute(programFiles)
      ? probe(join(programFiles, "PowerShell", "7", "pwsh.exe"), "pwsh.exe")
      : undefined;
  return isSafeLocalExecutableReceipt(fixed, "pwsh.exe")
    ? fixed
    : resolveSafeLocalPathExecutable("pwsh.exe", source, probe);
}

function canonicalEncodingToolReceipts(source = process.env) {
  const programFiles = readEnv(source, "ProgramW6432") ?? readEnv(source, "ProgramFiles");
  const localAppData = readEnv(source, "LocalAppData");
  const local = (root, parts, basename) =>
    typeof root === "string" && isAbsolute(root)
      ? canonicalExistingWindowsExecutable(join(root, ...parts, basename), basename)
      : undefined;
  return Object.freeze({
    git:
      local(programFiles, ["Git", "cmd"], "git.exe") ??
      local(programFiles, ["Git", "bin"], "git.exe") ??
      resolveSafeLocalPathExecutable("git.exe", source),
    node:
      canonicalExistingWindowsExecutable(process.execPath, "node.exe") ??
      local(programFiles, ["nodejs"], "node.exe"),
    // Versioned Python roots cannot be inferred safely without a registry
    // read. Only the prefiltered local PATH resolver may provide a fallback;
    // aliases and every unsafe PATH entry remain unavailable.
    python:
      local(localAppData, ["Programs", "Python", "Python311"], "python.exe") ??
      resolveSafeLocalPathExecutable("python.exe", source),
  });
}

// A runner receipt is intentionally process-private: it is passed only in
// the child environment so the feature-only Rust seam can spawn this exact
// file. Reports expose availability booleans, never a path.
function canonicalExistingWindowsExecutable(pathValue, basename) {
  return isCanonicalLocalWindowsExecutable(pathValue, basename);
}

function shellDiscoveryPlan(
  candidateArtifact = artifact,
  candidateFlow = flow,
  requestedShell = providerShell,
) {
  if (candidateArtifact !== "harness")
    return Object.freeze({ cmd: false, pwsh: false, windowsPowerShell: false, encoding: false });
  const plan = { cmd: true, pwsh: false, windowsPowerShell: false, encoding: false };
  if (candidateFlow === "provider") {
    if (!requestedShell) {
      plan.pwsh = true;
      plan.windowsPowerShell = true;
    } else if (requestedShell === "pwsh") plan.pwsh = true;
    else if (requestedShell === "windowsPowerShell") plan.windowsPowerShell = true;
  } else if (candidateFlow === "timing" || candidateFlow === "listener" || candidateFlow === "surface") {
    plan.pwsh = true;
    plan.windowsPowerShell = true;
  } else if (candidateFlow === "da1") {
    plan.pwsh = true;
    plan.windowsPowerShell = true;
  } else if (candidateFlow === "encoding") {
    plan.pwsh = true;
    plan.windowsPowerShell = true;
    plan.encoding = true;
  }
  return Object.freeze(plan);
}

function discoverCanonicalShellReceipts(
  source = process.env,
  plan = shellDiscoveryPlan(),
  resolvers = {},
) {
  const resolveCmd = resolvers.cmd ?? ((value) => canonicalSystem32Executable(value, [], "cmd.exe"));
  const resolvePwsh = resolvers.pwsh ?? canonicalPwshExecutable;
  const resolveWindowsPowerShell = resolvers.windowsPowerShell ?? ((value) =>
    canonicalSystem32Executable(value, ["WindowsPowerShell", "v1.0"], "powershell.exe"));
  return Object.freeze({
    pwsh: plan.pwsh ? resolvePwsh(source) : undefined,
    windowsPowerShell: plan.windowsPowerShell ? resolveWindowsPowerShell(source) : undefined,
    cmd: plan.cmd ? resolveCmd(source) : undefined,
  });
}

function discoverCanonicalEncodingToolReceipts(
  source = process.env,
  plan = shellDiscoveryPlan(),
  resolver = canonicalEncodingToolReceipts,
) {
  return plan.encoding ? resolver(source) : Object.freeze({});
}

function resolveObservationPowerShellExecutable(source = process.env) {
  const systemRoot = observationSystemRoot(source);
  if (!systemRoot) return undefined;
  return canonicalExistingFile(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
}

function buildProcessObservationEnvironment(source = process.env) {
  const executable = resolveObservationPowerShellExecutable(source);
  const systemRoot = observationSystemRoot(source);
  if (!executable || !systemRoot) return undefined;
  const canonicalRoot = (() => {
    try {
      return realpathSync.native(systemRoot);
    } catch {
      return undefined;
    }
  })();
  if (!canonicalRoot || !isAbsolute(canonicalRoot)) return undefined;
  const environment = {
    SystemRoot: canonicalRoot,
    WINDIR: canonicalRoot,
    PSModulePath: join(
      canonicalRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    ),
    PSModuleAnalysisCachePath: "NUL",
    PSDisableModuleAnalysisCacheCleanup: "1",
  };
  const sandbox = readEnv(source, "THREADTERM_TERMINAL_STARTUP_HARNESS_ROOT");
  const temp = readEnv(source, "TEMP");
  const tmp = readEnv(source, "TMP");
  if (
    typeof sandbox === "string" &&
    isAbsolute(sandbox) &&
    typeof temp === "string" &&
    typeof tmp === "string" &&
    isAbsolute(temp) &&
    isAbsolute(tmp) &&
    resolve(temp) === resolve(tmp)
  ) {
    const contained = relative(resolve(sandbox), resolve(temp));
    if (
      contained &&
      contained !== ".." &&
      !contained.startsWith(`..${sep}`) &&
      !isAbsolute(contained)
    ) {
      environment.TEMP = temp;
      environment.TMP = tmp;
    }
  }
  return Object.freeze(environment);
}

function isSuccessfulSpawnResult(result) {
  return Boolean(result && !result.error && result.status === 0);
}

function isDeadlineExpired(now, deadline) {
  return !Number.isFinite(now) || !Number.isFinite(deadline) || now >= deadline;
}

function remainingBudget(deadline, now = Date.now()) {
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return 0;
  return Math.max(0, deadline - now);
}

function boundedTimeout(localCap, deadline, now = Date.now()) {
  if (!Number.isFinite(localCap) || localCap <= 0) return 0;
  const remaining = remainingBudget(deadline, now);
  return Math.max(0, Math.min(localCap, remaining));
}

function boundedDeadline(localCap, deadline, now = Date.now()) {
  const cap = Number.isFinite(localCap) && localCap > 0 ? localCap : 0;
  const candidate = now + cap;
  return Number.isFinite(deadline) ? Math.min(candidate, deadline) : candidate;
}

function createRunnerEvidence(runnerStage, outcome) {
  if (!RUNNER_STAGES.has(runnerStage) || !RUNNER_OUTCOMES.has(outcome))
    return undefined;
  return Object.freeze({ runnerStage, outcome });
}

function appendRunnerEvidence(reportPath, runnerStage, outcome) {
  const record = createRunnerEvidence(runnerStage, outcome);
  if (!record || typeof reportPath !== "string" || reportPath.length === 0)
    return false;
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    appendFileSync(reportPath, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

const ISOLATION_LIFECYCLE_EVENTS = new Set([
  "classicConfirmed",
  "driverUdfConfirmed",
  "driverUdfMissing",
  "driverUdfInvalid",
  "driverUdfMismatch",
  "runtimeUdfConfirmed",
  "runtimeUdfMismatch",
  "runtimeUdfUnavailable",
  "runtimeUdfInvalid",
  "frameworkPassed",
  "frameworkFailed",
  "sessionEnded",
  "evidenceStopRequested",
]);
const ISOLATION_WDIO_STAGES = Object.freeze([
  "configLoaded",
  "workerStarted",
  "beforeSession",
  "workerEnded",
]);
const ISOLATION_WDIO_STAGE_SET = new Set(ISOLATION_WDIO_STAGES);
const SESSION_CREATION_VALUES = new Set([
  "success",
  "invalidArgument",
  "sessionNotCreated",
  "unknownError",
  "http4xx",
  "http5xx",
  "malformed",
  "noResponse",
]);
const NATIVE_DRIVER_STATUS_VALUES = new Set([
  "ready",
  "notReady",
  "malformed",
  "transportFailed",
]);
const APP_OBSERVATION_VALUES = new Set([
  "appNotObserved",
  "appObservedAlive",
  "appObservedExited",
  "processTableUnavailable",
  "appIdentityMismatch",
  "observationFailed",
]);
const NATIVE_DRIVER_STATUS_BODY_LIMIT_BYTES = 8 * 1024;
const NATIVE_DRIVER_STATUS_HEADER_LIMIT_BYTES = 4 * 1024;
const NATIVE_DRIVER_STATUS_TIMEOUT_MS = 2_000;
const ISOLATION_DRIVER_UDF_FAILURE_EVENTS = new Set([
  "driverUdfInvalid",
  "driverUdfMismatch",
]);
const ISOLATION_RUNTIME_UDF_FAILURE_EVENTS = new Set([
  "runtimeUdfMismatch",
  "runtimeUdfUnavailable",
  "runtimeUdfInvalid",
]);
const DRIVER_UDF_RUNTIME_STATUSES = Object.freeze({
  driverUdfMissing: "driver-udf-missing",
  driverUdfInvalid: "driver-udf-invalid",
  driverUdfMismatch: "driver-udf-mismatch",
});
const RUNTIME_ISOLATION_STATUSES = new Set([
  "matched",
  "invalid",
  "observation-failed",
  "webview-not-observed",
  "commandline-observation-failed",
  "commandline-missing",
  "browser-host-missing",
  "browser-host-ambiguous",
  "offline-host-resolver-rule-conflict",
  "offline-host-resolver-rule-missing",
  "offline-background-networking-conflict",
  "offline-background-networking-missing",
  "driver-udf-missing",
  "driver-udf-invalid",
  "driver-udf-mismatch",
  "runtime-udf-mismatch",
  "runtime-udf-unavailable",
  "runtime-udf-invalid",
]);
const ISOLATION_CAPABILITIES = [
  "shellForcing",
  "timingInjection",
  "faultInjection",
  "readOnlyObservation",
];
const ISOLATION_COUNTERS = [
  "activeCases",
  "queuedUiCreateCases",
  "preparedCases",
  "claimedCases",
  "boundCases",
  "failedCases",
  "snapshotReads",
  "cleanups",
  "duplicateTokens",
  "unknownTokens",
  "rejectedRequests",
];

function isIsolationProjection(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return false;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 5 ||
    keys.join(",") !== "capabilities,counters,csp,enabled,isolation"
  )
    return false;
  if (
    record.isolation !== "isolated" ||
    record.csp !== "isolated" ||
    record.enabled !== true ||
    !record.capabilities ||
    typeof record.capabilities !== "object" ||
    Array.isArray(record.capabilities) ||
    !record.counters ||
    typeof record.counters !== "object" ||
    Array.isArray(record.counters)
  )
    return false;
  const capabilityKeys = Object.keys(record.capabilities).sort();
  const counterKeys = Object.keys(record.counters).sort();
  return (
    capabilityKeys.length === ISOLATION_CAPABILITIES.length &&
    capabilityKeys.join(",") ===
      ISOLATION_CAPABILITIES.slice().sort().join(",") &&
    ISOLATION_CAPABILITIES.every(
      (capability) => record.capabilities[capability] === "supported",
    ) &&
    counterKeys.length === ISOLATION_COUNTERS.length &&
    counterKeys.join(",") === ISOLATION_COUNTERS.slice().sort().join(",") &&
    ISOLATION_COUNTERS.every(
      (counter) =>
        Number.isSafeInteger(record.counters[counter]) &&
        record.counters[counter] >= 0,
    )
  );
}

function isRunnerEvidence(record) {
  return (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 2 &&
    createRunnerEvidence(record.runnerStage, record.outcome) !== undefined
  );
}

function isRunnerCleanupEvidence(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return false;
  const keys = Object.keys(record).sort();
  return (
    keys.length === Object.keys(RUNNER_CLEANUP_EVIDENCE).length &&
    keys.join(",") === Object.keys(RUNNER_CLEANUP_EVIDENCE).sort().join(",") &&
    RUNNER_CLEANUP_APP_TREE_VALUES.has(record.appTree) &&
    Object.entries(RUNNER_CLEANUP_EVIDENCE).every(
      ([key, value]) => key === "appTree" || record[key] === value,
    )
  );
}

function runnerCleanupEvidence(appTree = "gone") {
  if (!RUNNER_CLEANUP_APP_TREE_VALUES.has(appTree)) return undefined;
  return Object.freeze({ ...RUNNER_CLEANUP_EVIDENCE, appTree });
}

function appendRunnerCleanupEvidence(reportPath, appTree = "gone") {
  const evidence = runnerCleanupEvidence(appTree);
  if (
    typeof reportPath !== "string" ||
    reportPath.length === 0 ||
    evidence === undefined
  )
    return false;
  try {
    appendFileSync(reportPath, `${JSON.stringify(evidence)}\n`);
    return true;
  } catch {
    return false;
  }
}

function isRuntimeIsolationDiagnostic(record) {
  return (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 2 &&
    typeof record.runtimeIsolationStatus === "string" &&
    RUNTIME_ISOLATION_STATUSES.has(record.runtimeIsolationStatus) &&
    typeof record.markerPublished === "boolean"
  );
}

function isSurfaceUnavailableDiagnostic(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return false;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 6 ||
    keys.join(",") !==
      "bodyStatus,event,handleStatus,readyState,rootStatus,urlKind" ||
    record.event !== "surfaceUnavailable"
  )
    return false;
  return (
    new Set(["none", "single", "multiple"]).has(record.handleStatus) &&
    new Set(["aboutBlank", "tauriLocal", "other", "unavailable", "mixed"]).has(
      record.urlKind,
    ) &&
    new Set(["loading", "interactive", "complete", "unavailable", "mixed"]).has(
      record.readyState,
    ) &&
    new Set(["present", "missing", "unavailable", "mixed"]).has(
      record.rootStatus,
    ) &&
    new Set(["empty", "nonempty", "unavailable", "mixed"]).has(
      record.bodyStatus,
    )
  );
}

function isNativeDriverStatusDiagnostic(record) {
  return (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 1 &&
    NATIVE_DRIVER_STATUS_VALUES.has(record.nativeDriverStatus)
  );
}

function isAppObservationDiagnostic(record) {
  return (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 1 &&
    APP_OBSERVATION_VALUES.has(record.appObservation)
  );
}

function isSessionCreationDiagnostic(record) {
  return (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 1 &&
    SESSION_CREATION_VALUES.has(record.sessionCreation)
  );
}

function appendNativeDriverStatusDiagnostic(reportPath, nativeDriverStatus) {
  if (
    typeof reportPath !== "string" ||
    !NATIVE_DRIVER_STATUS_VALUES.has(nativeDriverStatus)
  )
    return false;
  try {
    appendFileSync(reportPath, `${JSON.stringify({ nativeDriverStatus })}\n`);
    return true;
  } catch {
    return false;
  }
}

function shouldAppendNativeDriverStatusDiagnostic(currentFlow) {
  return currentFlow === "isolation";
}

function nativeDriverStatusAllowsWdio(nativeDriverStatus) {
  return nativeDriverStatus === "ready";
}

function appendAppObservationDiagnostic(reportPath, appObservation) {
  if (
    typeof reportPath !== "string" ||
    !APP_OBSERVATION_VALUES.has(appObservation)
  )
    return false;
  try {
    appendFileSync(reportPath, `${JSON.stringify({ appObservation })}\n`);
    return true;
  } catch {
    return false;
  }
}

function stripIsolationWdioStageDiagnostics(report) {
  if (typeof report !== "string") return undefined;
  const records = [];
  const stages = [];
  let lastProgressStage;
  let businessRecordSeen = false;
  let terminal = false;
  let nativeDriverStatus;
  let appObservation;
  let sessionCreation;
  let runnerEvidenceSeen = false;
  let cleanupEvidenceSeen = false;
  let cleanupAppTree;
  let completeEvidenceSeen = false;
  let preWdioFailureEvidenceSeen = false;
  for (const line of report.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!record || typeof record !== "object" || Array.isArray(record))
      return undefined;
    if (
      Object.prototype.hasOwnProperty.call(record, "nativeDriverStatus") &&
      !isNativeDriverStatusDiagnostic(record)
    )
      return undefined;
    if (
      Object.prototype.hasOwnProperty.call(record, "appObservation") &&
      !isAppObservationDiagnostic(record)
    )
      return undefined;
    if (
      Object.prototype.hasOwnProperty.call(record, "sessionCreation") &&
      !isSessionCreationDiagnostic(record)
    )
      return undefined;
    if (isNativeDriverStatusDiagnostic(record)) {
      if (
        nativeDriverStatus !== undefined ||
        stages.length !== 0 ||
        businessRecordSeen ||
        terminal ||
        records.length !== 0
      )
        return undefined;
      nativeDriverStatus = record.nativeDriverStatus;
      continue;
    }
    if (isAppObservationDiagnostic(record)) {
      if (
        appObservation !== undefined ||
        stages.length === 0 ||
        (!terminal && !runnerEvidenceSeen) ||
        (terminal && (cleanupEvidenceSeen || completeEvidenceSeen))
      )
        return undefined;
      appObservation = record.appObservation;
      continue;
    }
    if (isSessionCreationDiagnostic(record)) {
      if (
        nativeDriverStatus === undefined ||
        sessionCreation !== undefined ||
        terminal ||
        businessRecordSeen ||
        lastProgressStage !== "beforeSession"
      )
        return undefined;
      sessionCreation = record.sessionCreation;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(record, "wdioStage")) {
      if (
        terminal ||
        Object.keys(record).length !== 1 ||
        typeof record.wdioStage !== "string" ||
        !ISOLATION_WDIO_STAGE_SET.has(record.wdioStage) ||
        (record.wdioStage !== "workerEnded" && businessRecordSeen)
      )
        return undefined;
      const previousStage = stages.at(-1);
      const stageIsOrdered =
        (record.wdioStage === "configLoaded" && stages.length === 0) ||
        (record.wdioStage === "workerStarted" &&
          previousStage === "configLoaded") ||
        (record.wdioStage === "beforeSession" &&
          previousStage === "workerStarted") ||
        (record.wdioStage === "workerEnded" &&
          (previousStage === "workerStarted" ||
            previousStage === "beforeSession"));
      if (!stageIsOrdered) return undefined;
      if (
        record.wdioStage === "workerEnded" &&
        nativeDriverStatus !== undefined &&
        previousStage === "beforeSession" &&
        sessionCreation === undefined
      )
        return undefined;
      stages.push(record.wdioStage);
      if (record.wdioStage !== "workerEnded")
        lastProgressStage = record.wdioStage;
      else terminal = true;
      continue;
    }
    if (
      sessionCreation !== undefined &&
      sessionCreation !== "success" &&
      !isRunnerEvidence(record) &&
      !isRunnerCleanupEvidence(record)
    )
      return undefined;
    if (terminal) {
      if (isRunnerCleanupEvidence(record)) {
        if (cleanupEvidenceSeen || completeEvidenceSeen) return undefined;
      } else if (isRunnerEvidence(record)) {
        if (record.runnerStage === "complete") {
          if (!cleanupEvidenceSeen || completeEvidenceSeen) return undefined;
        } else if (
          record.outcome !== "failed" ||
          runnerEvidenceSeen ||
          appObservation !== undefined ||
          cleanupEvidenceSeen ||
          completeEvidenceSeen
        ) {
          return undefined;
        }
      } else {
        return undefined;
      }
    } else if (isRunnerCleanupEvidence(record)) {
      if (record.appTree === "notRequested") {
        if (
          stages.length !== 0 ||
          !preWdioFailureEvidenceSeen ||
          cleanupEvidenceSeen ||
          completeEvidenceSeen
        )
          return undefined;
      } else if (cleanupEvidenceSeen || completeEvidenceSeen) return undefined;
    } else if (isRunnerEvidence(record)) {
      if (
        record.runnerStage === "complete" &&
        cleanupEvidenceSeen &&
        cleanupAppTree === "notRequested"
      ) {
        if (
          cleanupAppTree !== "notRequested" ||
          record.outcome !== "failed" ||
          !preWdioFailureEvidenceSeen ||
          completeEvidenceSeen
        )
          return undefined;
      } else if (record.runnerStage !== "complete" && stages.length === 0) {
        if (
          record.outcome !== "failed" ||
          !PRE_WDIO_RUNNER_STAGES.has(record.runnerStage) ||
          runnerEvidenceSeen ||
          cleanupEvidenceSeen ||
          completeEvidenceSeen
        )
          return undefined;
        preWdioFailureEvidenceSeen = true;
      }
    }
    if (isRunnerCleanupEvidence(record)) {
      cleanupEvidenceSeen = true;
      cleanupAppTree = record.appTree;
    }
    if (isRunnerEvidence(record)) {
      runnerEvidenceSeen = true;
      if (record.runnerStage === "complete") completeEvidenceSeen = true;
    }
    businessRecordSeen = true;
    records.push(line);
  }
  return Object.freeze({
    report: records.join("\n"),
    lastStage: stages.at(-1),
    lastProgressStage,
    terminal,
    ...(nativeDriverStatus === undefined ? {} : { nativeDriverStatus }),
    ...(appObservation === undefined ? {} : { appObservation }),
    ...(sessionCreation === undefined ? {} : { sessionCreation }),
  });
}

function classifyIsolationLifecycleEvents(
  events,
  projections = 0,
  diagnostic,
  surfaceDiagnostic = false,
) {
  if (!Array.isArray(events)) return "invalid";
  if (events.length === 0)
    return projections === 0 && diagnostic === undefined
      ? "pending"
      : "invalid";
  if (events[0] !== "classicConfirmed") return "invalid";
  if (events.length === 1) return "pending";

  const driverUdfEvent = events[1];
  if (ISOLATION_DRIVER_UDF_FAILURE_EVENTS.has(driverUdfEvent)) {
    if (events.length === 2) return "failed";
    if (events[2] !== "frameworkFailed") return "invalid";
    if (events.length === 3) return "failed";
    return events.length === 4 && events[3] === "sessionEnded"
      ? "failed"
      : "invalid";
  }
  if (
    driverUdfEvent !== "driverUdfConfirmed" &&
    driverUdfEvent !== "driverUdfMissing"
  )
    return "invalid";
  if (events.length === 2) return "pending";

  if (surfaceDiagnostic) {
    if (
      projections !== 0 ||
      (diagnostic !== undefined && diagnostic.markerPublished !== false)
    )
      return "invalid";
    if (events[2] !== "frameworkFailed") return "invalid";
    if (events.length === 3) return "failed";
    return events.length === 4 && events[3] === "sessionEnded"
      ? "failed"
      : "invalid";
  }

  const runtimeUdfEvent = events[2];
  if (ISOLATION_RUNTIME_UDF_FAILURE_EVENTS.has(runtimeUdfEvent)) {
    if (events.length === 3) return "failed";
    if (events[3] !== "frameworkFailed") return "invalid";
    if (events.length === 4) return "failed";
    return events.length === 5 && events[4] === "sessionEnded"
      ? "failed"
      : "invalid";
  }
  if (runtimeUdfEvent !== "runtimeUdfConfirmed") return "invalid";
  if (events.length === 3) return "pending";
  if (events[3] === "frameworkFailed") {
    if (events.length === 4) return "failed";
    return events.length === 5 && events[4] === "sessionEnded"
      ? "failed"
      : "invalid";
  }
  if (events[3] !== "frameworkPassed") return "invalid";
  if (events.length === 4) return "pending";
  if (events[4] !== "sessionEnded") return "invalid";
  if (events.length === 6 && events[5] === "evidenceStopRequested") {
    if (
      projections !== 1 ||
      !diagnostic ||
      diagnostic.runtimeIsolationStatus !== "matched" ||
      diagnostic.markerPublished !== true
    )
      return "invalid";
    return "stopped";
  }
  if (events.length !== 5) return "invalid";
  if (
    projections !== 1 ||
    !diagnostic ||
    diagnostic.runtimeIsolationStatus !== "matched" ||
    diagnostic.markerPublished !== true
  )
    return "invalid";
  return "natural";
}

function classifyIsolationBusinessLifecycleEvidence(report, workerEnded = false) {
  if (typeof report !== "string") return "invalid";
  const events = [];
  let projections = 0;
  let diagnostic;
  let surfaceDiagnostic = false;
  let cleanupEvidenceCount = 0;
  let notRequestedCleanupEvidenceSeen = false;
  let preWdioFailureEvidenceSeen = false;
  let completeSuccessSeen = false;
  let terminalFailureEvidenceSeen = false;
  let completeFailureSeen = false;
  for (const line of report.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return "invalid";
    }
    if (!record || typeof record !== "object" || Array.isArray(record))
      return "invalid";
    if (isSurfaceUnavailableDiagnostic(record)) {
      if (
        surfaceDiagnostic ||
        projections !== 0 ||
        diagnostic !== undefined ||
        events.length !== 2 ||
        (events[1] !== "driverUdfConfirmed" && events[1] !== "driverUdfMissing")
      )
        return "invalid";
      surfaceDiagnostic = true;
    } else if (isRunnerCleanupEvidence(record)) {
      if (record.appTree === "notRequested") {
        if (
          cleanupEvidenceCount !== 0 ||
          completeSuccessSeen ||
          completeFailureSeen ||
          terminalFailureEvidenceSeen ||
          !preWdioFailureEvidenceSeen ||
          events.length !== 0
        )
          return "invalid";
        notRequestedCleanupEvidenceSeen = true;
      } else if (
        cleanupEvidenceCount !== 0 ||
        completeSuccessSeen ||
        completeFailureSeen ||
        (events.length < 5 && !terminalFailureEvidenceSeen)
      )
        return "invalid";
      cleanupEvidenceCount = 1;
    } else if (Object.prototype.hasOwnProperty.call(record, "event")) {
      if (
        Object.keys(record).length !== 1 ||
        typeof record.event !== "string" ||
        !ISOLATION_LIFECYCLE_EVENTS.has(record.event)
      )
        return "invalid";
      events.push(record.event);
    } else if (isIsolationProjection(record)) {
      if (events.length < 3 || events[2] !== "runtimeUdfConfirmed")
        return "invalid";
      projections += 1;
    } else if (isRuntimeIsolationDiagnostic(record)) {
      if (
        surfaceDiagnostic &&
        events.length === 3 &&
        events[2] === "frameworkFailed" &&
        record.markerPublished === false
      ) {
        if (diagnostic !== undefined) return "invalid";
        diagnostic = record;
        continue;
      }
      if (!(
        (events.length >= 2 &&
          ISOLATION_DRIVER_UDF_FAILURE_EVENTS.has(events[1])) ||
        (events.length >= 3 &&
          (events[2] === "runtimeUdfConfirmed" ||
            ISOLATION_RUNTIME_UDF_FAILURE_EVENTS.has(events[2])))
      ))
        return "invalid";
      if (diagnostic !== undefined) return "invalid";
      diagnostic = record;
    } else if (isRunnerEvidence(record)) {
      if (
        !workerEnded &&
        record.runnerStage !== "complete" &&
        record.outcome === "failed" &&
        PRE_WDIO_RUNNER_STAGES.has(record.runnerStage) &&
        events.length === 0 &&
        !preWdioFailureEvidenceSeen &&
        cleanupEvidenceCount === 0
      ) {
        preWdioFailureEvidenceSeen = true;
      } else if (
        !workerEnded &&
        record.runnerStage === "complete" &&
        record.outcome === "failed" &&
        notRequestedCleanupEvidenceSeen &&
        !completeFailureSeen
      ) {
        completeFailureSeen = true;
      } else if (record.runnerStage === "complete" && record.outcome === "success") {
        if (completeSuccessSeen || cleanupEvidenceCount !== 1) return "invalid";
        completeSuccessSeen = true;
      } else if (
        workerEnded &&
        record.runnerStage === "complete" &&
        record.outcome === "failed"
      ) {
        if (
          !terminalFailureEvidenceSeen ||
          completeFailureSeen ||
          cleanupEvidenceCount !== 1
        )
          return "invalid";
        completeFailureSeen = true;
      } else if (workerEnded) {
        if (
          record.outcome !== "failed" ||
          terminalFailureEvidenceSeen ||
          cleanupEvidenceCount !== 0
        )
          return "invalid";
        terminalFailureEvidenceSeen = true;
      }
    } else {
      return "invalid";
    }
  }
  if (projections > 1) return "invalid";
  if (notRequestedCleanupEvidenceSeen)
    return preWdioFailureEvidenceSeen && completeFailureSeen
      ? "failed"
      : "invalid";
  if (completeSuccessSeen && cleanupEvidenceCount !== 1) return "invalid";
  const lifecycle = classifyIsolationLifecycleEvents(
    events,
    projections,
    diagnostic,
    surfaceDiagnostic,
  );
  if (terminalFailureEvidenceSeen)
    return lifecycle === "pending" ? "failed" : "invalid";
  return lifecycle;
}

function reduceIsolationLifecycleSnapshot(report) {
  const wdioDiagnostics = stripIsolationWdioStageDiagnostics(report);
  if (!wdioDiagnostics)
    return Object.freeze({
      publicStatus: "invalid",
      preterminalLifecycle: "invalid",
      stopRequested: false,
      terminal: false,
    });
  const preterminalLifecycle = classifyIsolationBusinessLifecycleEvidence(
    wdioDiagnostics.report,
    wdioDiagnostics.terminal,
  );
  const hasWdioStages = wdioDiagnostics.lastStage !== undefined;
  const stopRequested = preterminalLifecycle === "stopped";
  let publicStatus = preterminalLifecycle;
  if (hasWdioStages) {
    if (wdioDiagnostics.terminal && preterminalLifecycle === "pending") {
      // A worker cannot publish further business lifecycle records after its
      // terminal diagnostic. Treat every unfinished prefix as a closed
      // failure instead of spending the remaining session budget polling it.
      publicStatus = "failed";
    } else if (
      preterminalLifecycle === "natural" ||
      preterminalLifecycle === "stopped"
    ) {
      publicStatus = wdioDiagnostics.terminal
        ? preterminalLifecycle === "stopped"
          ? "stopped"
          : "natural"
        : "pending";
    }
  }
  return Object.freeze({
    publicStatus,
    preterminalLifecycle,
    stopRequested,
    terminal: wdioDiagnostics.terminal,
  });
}

function classifyIsolationLifecycleEvidence(report) {
  return reduceIsolationLifecycleSnapshot(report).publicStatus;
}

function readIsolationLifecycleEvidence(reportPath) {
  try {
    return classifyIsolationLifecycleEvidence(readFileSync(reportPath, "utf8"));
  } catch {
    return "pending";
  }
}

function readIsolationLifecycleSnapshot(reportPath) {
  try {
    return reduceIsolationLifecycleSnapshot(readFileSync(reportPath, "utf8"));
  } catch {
    return reduceIsolationLifecycleSnapshot("");
  }
}

function classifyIsolationDriverUdfEvidence(report) {
  const wdioDiagnostics = stripIsolationWdioStageDiagnostics(report);
  if (!wdioDiagnostics) return "invalid";
  report = wdioDiagnostics.report;
  const events = [];
  let projections = 0;
  let diagnostics = 0;
  let diagnostic;
  let surfaceDiagnostic = false;
  let cleanupEvidenceCount = 0;
  let cleanupAppTree;
  let completeSuccessSeen = false;
  for (const line of report.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return "invalid";
    }
    if (record && typeof record === "object" && !Array.isArray(record)) {
      if (isSurfaceUnavailableDiagnostic(record)) {
        if (
          surfaceDiagnostic ||
          projections !== 0 ||
          diagnostics !== 0 ||
          events.length !== 2 ||
          (events[1] !== "driverUdfConfirmed" &&
            events[1] !== "driverUdfMissing")
        )
          return "invalid";
        surfaceDiagnostic = true;
      } else if (isRunnerCleanupEvidence(record)) {
        if (
          cleanupEvidenceCount !== 0 ||
          completeSuccessSeen ||
          events.length < 5
        )
          return "invalid";
        cleanupEvidenceCount = 1;
        cleanupAppTree = record.appTree;
      } else if (Object.prototype.hasOwnProperty.call(record, "event")) {
        if (
          Object.keys(record).length !== 1 ||
          typeof record.event !== "string" ||
          !ISOLATION_LIFECYCLE_EVENTS.has(record.event)
        )
          return "invalid";
        events.push(record.event);
      } else if (isIsolationProjection(record)) {
        if (events.length < 3 || events[2] !== "runtimeUdfConfirmed")
          return "invalid";
        projections += 1;
        if (projections > 1) return "invalid";
      } else if (isRuntimeIsolationDiagnostic(record)) {
        if (
          surfaceDiagnostic &&
          events.length === 3 &&
          events[2] === "frameworkFailed" &&
          record.markerPublished === false
        ) {
          diagnostics += 1;
          if (diagnostics > 1) return "invalid";
          diagnostic = record;
          continue;
        }
        if (!(
          (events.length >= 2 &&
            ISOLATION_DRIVER_UDF_FAILURE_EVENTS.has(events[1])) ||
          (events.length >= 3 &&
            (events[2] === "runtimeUdfConfirmed" ||
              ISOLATION_RUNTIME_UDF_FAILURE_EVENTS.has(events[2])))
        ))
          return "invalid";
        diagnostics += 1;
        if (diagnostics > 1) return "invalid";
      } else if (isRunnerEvidence(record)) {
        if (record.runnerStage === "complete" && record.outcome === "success") {
          if (
            completeSuccessSeen ||
            cleanupEvidenceCount !== 1 ||
            cleanupAppTree !== "gone"
          )
            return "invalid";
          completeSuccessSeen = true;
        }
      } else {
        return "invalid";
      }
      continue;
    }
    return "invalid";
  }
  if (completeSuccessSeen && cleanupEvidenceCount !== 1) return "invalid";
  if (events.length === 0) return "pending";
  if (events.length === 1 && events[0] === "classicConfirmed") return "pending";
  if (events[0] !== "classicConfirmed") return "invalid";
  const driverUdfEvent = events[1];
  if (ISOLATION_DRIVER_UDF_FAILURE_EVENTS.has(driverUdfEvent)) {
    if (events.length === 2) return "failed";
    if (events[2] !== "frameworkFailed") return "invalid";
    if (events.length === 3) return "failed";
    return events.length === 4 && events[3] === "sessionEnded"
      ? "failed"
      : "invalid";
  }
  if (
    driverUdfEvent !== "driverUdfConfirmed" &&
    driverUdfEvent !== "driverUdfMissing"
  )
    return "invalid";
  // The driver capability only determines whether it is safe to continue.
  // The runner must wait for the runtime CoreWebView2 attestation before it
  // observes WebView descendants or publishes the isolation marker.
  if (events.length === 2) return "pending";
  if (surfaceDiagnostic) {
    if (
      projections !== 0 ||
      (diagnostic !== undefined && diagnostic.markerPublished !== false)
    )
      return "invalid";
    if (events[2] !== "frameworkFailed") return "invalid";
    if (events.length === 3) return "failed";
    return events.length === 4 && events[3] === "sessionEnded"
      ? "failed"
      : "invalid";
  }
  const runtimeUdfEvent = events[2];
  if (ISOLATION_RUNTIME_UDF_FAILURE_EVENTS.has(runtimeUdfEvent)) {
    if (events.length === 3) return "failed";
    if (events[3] !== "frameworkFailed") return "invalid";
    if (events.length === 4) return "failed";
    return events.length === 5 && events[4] === "sessionEnded"
      ? "failed"
      : "invalid";
  }
  if (runtimeUdfEvent !== "runtimeUdfConfirmed") return "invalid";
  if (events.length === 3) return "confirmed";
  if (events[3] === "frameworkFailed") {
    if (events.length === 4) return "failed";
    return events.length === 5 && events[4] === "sessionEnded"
      ? "failed"
      : "invalid";
  }
  if (events[3] !== "frameworkPassed") return "invalid";
  if (events.length === 4) return "confirmed";
  if (events[4] !== "sessionEnded") return "invalid";
  if (events.length === 5) return "confirmed";
  return events.length === 6 && events[5] === "evidenceStopRequested"
    ? "confirmed"
    : "invalid";
}

function driverUdfRuntimeIsolationStatus(
  report,
  fallback = "driver-udf-invalid",
) {
  if (typeof report === "string") {
    let driverStatus;
    for (const line of report.split(/\r?\n/)) {
      try {
        const record = JSON.parse(line);
        const event =
          record &&
          typeof record === "object" &&
          !Array.isArray(record) &&
          typeof record.event === "string"
            ? record.event
            : undefined;
        // Runtime attestation is authoritative once it has happened. In
        // particular, a permitted earlier driverUdfMissing must not obscure a
        // later runtimeUdfMismatch/Unavailable/Invalid failure in the runner
        // diagnostic.
        if (event === "runtimeUdfMismatch") return "runtime-udf-mismatch";
        if (event === "runtimeUdfUnavailable") return "runtime-udf-unavailable";
        if (event === "runtimeUdfInvalid") return "runtime-udf-invalid";
        const status = event && DRIVER_UDF_RUNTIME_STATUSES[event];
        if (status && driverStatus === undefined) driverStatus = status;
      } catch {
        // The lifecycle classifier remains authoritative for malformed input.
      }
    }
    if (driverStatus !== undefined) return driverStatus;
  }
  return RUNTIME_ISOLATION_STATUSES.has(fallback)
    ? fallback
    : "driver-udf-invalid";
}

function appendRuntimeIsolationDiagnostic(
  reportPath,
  runtimeIsolationStatus,
  markerPublished,
) {
  if (
    !RUNTIME_ISOLATION_STATUSES.has(runtimeIsolationStatus) ||
    typeof markerPublished !== "boolean"
  )
    return false;
  try {
    appendFileSync(
      reportPath,
      `${JSON.stringify({ runtimeIsolationStatus, markerPublished })}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

function classifyIsolationDriverEligibility(report) {
  const wdioDiagnostics = stripIsolationWdioStageDiagnostics(report);
  if (!wdioDiagnostics) return "invalid";
  report = wdioDiagnostics.report;
  let eventIndex = 0;
  for (const line of report.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return "invalid";
    }
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 1 ||
      typeof record.event !== "string" ||
      !ISOLATION_LIFECYCLE_EVENTS.has(record.event)
    )
      return "invalid";
    if (eventIndex === 0) {
      if (record.event !== "classicConfirmed") return "invalid";
    } else if (eventIndex === 1) {
      if (record.event === "driverUdfConfirmed" || record.event === "driverUdfMissing")
        return "eligible";
      if (ISOLATION_DRIVER_UDF_FAILURE_EVENTS.has(record.event)) return "failed";
      return "invalid";
    } else {
      return "invalid";
    }
    eventIndex += 1;
  }
  return "pending";
}

function classifyIsolationRuntimeUdfAttestation(report) {
  const wdioDiagnostics = stripIsolationWdioStageDiagnostics(report);
  if (!wdioDiagnostics) return "invalid";
  report = wdioDiagnostics.report;
  let eventIndex = 0;
  for (const line of report.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return "invalid";
    }
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 1 ||
      typeof record.event !== "string" ||
      !ISOLATION_LIFECYCLE_EVENTS.has(record.event)
    )
      return "invalid";
    if (eventIndex === 0) {
      if (record.event !== "classicConfirmed") return "invalid";
    } else if (eventIndex === 1) {
      if (ISOLATION_DRIVER_UDF_FAILURE_EVENTS.has(record.event)) return "failed";
      if (record.event !== "driverUdfConfirmed" && record.event !== "driverUdfMissing")
        return "invalid";
    } else if (eventIndex === 2) {
      if (record.event === "runtimeUdfConfirmed") return "confirmed";
      if (ISOLATION_RUNTIME_UDF_FAILURE_EVENTS.has(record.event)) return "failed";
      return "invalid";
    } else {
      return "invalid";
    }
    eventIndex += 1;
  }
  return "pending";
}

function isolationWaitEvidence(runnerStage, evidence) {
  if (evidence === "timeout") return createRunnerEvidence(runnerStage, "timeout");
  if (evidence === "failed" || evidence === "invalid")
    return createRunnerEvidence(runnerStage, "failed");
  return undefined;
}

function isolationTimeoutStage(report) {
  const wdioDiagnostics = stripIsolationWdioStageDiagnostics(report);
  if (!wdioDiagnostics) return "wdioSession";
  report = wdioDiagnostics.report;
  const events = [];
  for (const line of report.split(/\r?\n/)) {
    if (line.length === 0) continue;
    try {
      const record = JSON.parse(line);
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        Object.keys(record).length !== 1 ||
        typeof record.event !== "string" ||
        !ISOLATION_LIFECYCLE_EVENTS.has(record.event)
      )
        return "wdioSession";
      events.push(record.event);
    } catch {
      return "wdioSession";
    }
  }
  if (events.length === 0) {
    if (wdioDiagnostics.lastProgressStage === "configLoaded")
      return "wdioWorker";
    if (wdioDiagnostics.lastProgressStage === "workerStarted")
      return "wdioWorker";
    if (wdioDiagnostics.lastProgressStage === "beforeSession")
      return "webdriverSession";
    return "wdioSession";
  }
  if (events.length === 1 && events[0] === "classicConfirmed") return "driverUdf";
  if (
    events[0] === "classicConfirmed" &&
    (events[1] === "driverUdfConfirmed" || events[1] === "driverUdfMissing")
  ) {
    if (events[2] === "runtimeUdfConfirmed") return "wdioSession";
    return "runtimeUdf";
  }
  return "wdioSession";
}

function isolationIncompleteWorkerFailureEvidence(report) {
  const snapshot = reduceIsolationLifecycleSnapshot(report);
  if (!snapshot.terminal || snapshot.preterminalLifecycle !== "pending")
    return undefined;
  return createRunnerEvidence(isolationTimeoutStage(report), "failed");
}

function shouldWaitForIsolationWdioSession(gateOutcome) {
  return gateOutcome === "none";
}

function wdioSessionDeadline(flowName, workDeadline, now = Date.now()) {
  return boundedDeadline(
    flowName === "isolation"
      ? ISOLATION_WDIO_SESSION_WAIT_CAP_MS
      : WDIO_HARD_DEADLINE_MS,
    workDeadline,
    now,
  );
}

function shouldObserveRuntimeIsolation(driverEligibility, runtimeAttestation, appIdentity) {
  return (
    driverEligibility === "eligible" &&
    runtimeAttestation === "confirmed" &&
    Number.isInteger(appIdentity?.pid) &&
    appIdentity.pid > 0
  );
}

function shouldPublishRuntimeIsolationMarker(runtimeAttestation, isolation) {
  return runtimeAttestation === "confirmed" && isolation?.ok === true;
}

function runtimeIsolationRequirements(artifactName, flowName) {
  return Object.freeze({
    observeHarnessIsolation: artifactName === "harness",
    requireRuntimeUdfAttestation:
      artifactName === "harness" && flowName === "isolation",
  });
}

function retainOwnedThreadTermIdentity(capturedIdentity, candidateIdentity) {
  return capturedIdentity ?? candidateIdentity;
}

async function waitForIsolationDriverUdfEvidence(
  supervisor,
  reportPath,
  deadline,
) {
  while (!isDeadlineExpired(Date.now(), deadline)) {
    const report = (() => {
      try {
        return readFileSync(reportPath, "utf8");
      } catch {
        return "";
      }
    })();
    if (isolationIncompleteWorkerFailureEvidence(report)) return "failed";
    const evidence = classifyIsolationDriverEligibility(report);
    if (evidence === "eligible" || evidence === "failed") return evidence;
    if (evidence === "invalid" || childHasExited(supervisor)) return "failed";
    const pause = boundedTimeout(50, deadline);
    if (pause <= 0) break;
    await new Promise((done) => setTimeout(done, pause));
  }
  return "timeout";
}

async function waitForIsolationRuntimeUdfEvidence(supervisor, reportPath, deadline) {
  while (!isDeadlineExpired(Date.now(), deadline)) {
    const report = (() => {
      try {
        return readFileSync(reportPath, "utf8");
      } catch {
        return "";
      }
    })();
    if (isolationIncompleteWorkerFailureEvidence(report)) return "failed";
    const evidence = classifyIsolationRuntimeUdfAttestation(report);
    if (evidence === "confirmed" || evidence === "failed") return evidence;
    if (evidence === "invalid" || childHasExited(supervisor)) return "failed";
    const pause = boundedTimeout(50, deadline);
    if (pause <= 0) break;
    await new Promise((done) => setTimeout(done, pause));
  }
  return "timeout";
}

function reduceIsolationWdioPollDecision(snapshot, childExited) {
  if (!snapshot || typeof snapshot !== "object") return "failed";
  if (
    snapshot.publicStatus === "failed" ||
    snapshot.publicStatus === "invalid"
  )
    return "failed";
  if (childExited) {
    if (snapshot.publicStatus === "stopped") return "stoppedExit";
    return snapshot.stopRequested ? "waitForTerminal" : "naturalExit";
  }
  if (snapshot.publicStatus === "stopped") return "stopSupervisor";
  if (snapshot.publicStatus === "natural") return "naturalComplete";
  return "wait";
}

function waitForIsolationWdioOutcome(
  supervisor,
  reportPath,
  deadline,
) {
  return new Promise((resolveOutcome) => {
    let settled = false;
    let stopping = false;
    let interval;
    let timeout;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
      supervisor.removeListener("exit", onExit);
      supervisor.removeListener("error", onError);
      resolveOutcome(outcome);
    };
    const exitResult = (code = supervisor.exitCode) => ({
      code:
        typeof code === "number" && supervisor.signalCode === null ? code : 1,
      timedOut: false,
    });
    const finishExited = (code) => {
      if (settled || stopping) return;
      const decision = reduceIsolationWdioPollDecision(
        readIsolationLifecycleSnapshot(reportPath),
        true,
      );
      if (decision === "stoppedExit")
        return finish({ result: exitResult(code), stopped: true });
      if (decision === "waitForTerminal") return;
      return finish({ result: exitResult(code), stopped: false });
    };
    const onExit = (code) => finishExited(code);
    const onError = () =>
      finish({ result: { code: 1, timedOut: false }, stopped: false });
    const poll = async () => {
      if (settled || stopping) return;
      const snapshot = readIsolationLifecycleSnapshot(reportPath);
      const decision = reduceIsolationWdioPollDecision(
        snapshot,
        childHasExited(supervisor),
      );
      if (decision === "failed")
        return finish({ result: { code: 1, timedOut: false }, stopped: false });
      if (decision === "naturalExit")
        return finish({ result: exitResult(), stopped: false });
      if (decision === "stoppedExit")
        return finish({ result: exitResult(), stopped: true });
      if (decision === "naturalComplete")
        return finish({ result: { code: 0, timedOut: false }, stopped: false });
      if (decision !== "stopSupervisor") return;
      stopping = true;
      const stopped = await stopSupervisorJob(supervisor, deadline);
      finish({
        result: {
          code:
            typeof supervisor.exitCode === "number" ? supervisor.exitCode : 1,
          timedOut: false,
        },
        stopped,
      });
    };
    const remaining = remainingBudget(deadline);
    if (remaining <= 0)
      return finish({ result: { code: 1, timedOut: true }, stopped: false });
    timeout = setTimeout(
      () => finish({ result: { code: 1, timedOut: true }, stopped: false }),
      remaining,
    );
    interval = setInterval(() => void poll(), 50);
    supervisor.once("exit", onExit);
    supervisor.once("error", onError);
    if (childHasExited(supervisor)) return finishExited();
    void poll();
  });
}

function resolveSystemUtilityExecutable(name, source = process.env) {
  const environment = buildProcessObservationEnvironment(source);
  if (!environment || typeof name !== "string" || name.length === 0)
    return undefined;
  return canonicalExistingFile(join(environment.SystemRoot, "System32", name));
}

function runTaskkill(pid) {
  const executable = resolveSystemUtilityExecutable(
    "taskkill.exe",
    processObservationEnvironmentSource,
  );
  const environment = buildProcessObservationEnvironment(
    processObservationEnvironmentSource,
  );
  if (!executable || !environment) return undefined;
  return spawnSync(executable, ["/T", "/F", "/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true,
    env: environment,
    timeout: PROCESS_OBSERVATION_TIMEOUT_MS,
  });
}

function runPowerShellObservation(
  command,
  deadline = Number.POSITIVE_INFINITY,
  localCap = PROCESS_OBSERVATION_TIMEOUT_MS,
) {
  const executable = resolveObservationPowerShellExecutable(
    processObservationEnvironmentSource,
  );
  const env = buildProcessObservationEnvironment(
    processObservationEnvironmentSource,
  );
  if (!executable || !env) return undefined;
  const timeout = boundedTimeout(localCap, deadline);
  if (timeout <= 0) return undefined;
  return spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env,
      timeout,
    },
  );
}

function classifyProductionSingleInstanceObservation(result) {
  if (!isSuccessfulSpawnResult(result) || typeof result.stdout !== "string")
    return "invalid";
  const observation = result.stdout.trim();
  if (observation === "absent" || observation === "present") return observation;
  return "invalid";
}

function classifyProductionDisposableProfileObservation(result) {
  if (!isSuccessfulSpawnResult(result) || typeof result.stdout !== "string")
    return "invalid";
  return result.stdout.trim() === "valid" ? "valid" : "invalid";
}

function observeProductionDisposableProfile() {
  const result = runPowerShellObservation(
    `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ThreadTermProfileObservation {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHGetKnownFolderPath(ref Guid rfid, uint flags, IntPtr token, out IntPtr path);
}
'@
$profilePointer = [IntPtr]::Zero
$status = 'invalid'
try {
  $profileId = [Guid]::Parse('5E6C858F-0E22-4760-9AFE-EA3317B67173')
  $resultCode = [ThreadTermProfileObservation]::SHGetKnownFolderPath([ref]$profileId, 0, [IntPtr]::Zero, [ref]$profilePointer)
  if ($resultCode -eq 0 -and $profilePointer -ne [IntPtr]::Zero) {
    $profileRoot = [Runtime.InteropServices.Marshal]::PtrToStringUni($profilePointer)
    $markerPath = [IO.Path]::Combine($profileRoot, '${PRODUCTION_DISPOSABLE_PROFILE_MARKER_NAME}')
    $item = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    $reparsePoint = [IO.FileAttributes]::ReparsePoint
    if (-not $item.PSIsContainer -and [string]::IsNullOrEmpty($item.LinkType) -and (($item.Attributes -band $reparsePoint) -eq 0)) {
      $actual = [IO.File]::ReadAllBytes($markerPath)
      $expected = [Text.Encoding]::UTF8.GetBytes('${PRODUCTION_DISPOSABLE_PROFILE_MARKER_VALUE}')
      $bytesMatch = $actual.Length -eq $expected.Length
      if ($bytesMatch) {
        for ($index = 0; $index -lt $actual.Length; $index++) {
          if ($actual[$index] -ne $expected[$index]) {
            $bytesMatch = $false
            break
          }
        }
      }
      if ($bytesMatch) { $status = 'valid' }
    }
  }
} catch {
  $status = 'invalid'
} finally {
  if ($profilePointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::FreeCoTaskMem($profilePointer)
  }
}
[Console]::Out.Write($status)`,
    Date.now() + PROCESS_OBSERVATION_TIMEOUT_MS,
  );
  return classifyProductionDisposableProfileObservation(result);
}

function observeProductionSingleInstanceWindow(productionId) {
  if (typeof productionId !== "string" || productionId.length === 0)
    return "invalid";
  const className = Buffer.from(`${productionId}-sic`, "utf8").toString(
    "base64",
  );
  const windowTitle = Buffer.from(`${productionId}-siw`, "utf8").toString(
    "base64",
  );
  const result = runPowerShellObservation(
    `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ThreadTermSingleInstanceObservation {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "FindWindowW")]
  public static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);
}
'@
$className = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${className}'))
$windowTitle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${windowTitle}'))
$handle = [ThreadTermSingleInstanceObservation]::FindWindowW($className, $windowTitle)
if ($handle -eq [IntPtr]::Zero) { [Console]::Out.Write('absent') } else { [Console]::Out.Write('present') }`,
    Date.now() + PROCESS_OBSERVATION_TIMEOUT_MS,
  );
  return classifyProductionSingleInstanceObservation(result);
}

function runAfterProductionSingleInstancePreflight(
  artifactValue,
  observe,
  performSideEffects,
) {
  if (
    typeof observe !== "function" ||
    typeof performSideEffects !== "function"
  )
    throw new Error("production-single-instance-preflight-input-invalid");
  if (artifactValue === "production") {
    let observation;
    try {
      observation = observe();
    } catch {
      throw new Error("production-single-instance-observation-failed");
    }
    if (observation === "present")
      throw new Error("production-single-instance-already-running");
    if (observation !== "absent")
      throw new Error("production-single-instance-observation-failed");
  }
  return performSideEffects();
}

function runAfterProductionPreflight(
  artifactValue,
  observeDisposableProfile,
  observeSingleInstance,
  performSideEffects,
) {
  if (
    typeof observeDisposableProfile !== "function" ||
    typeof observeSingleInstance !== "function" ||
    typeof performSideEffects !== "function"
  )
    throw new Error("production-preflight-input-invalid");
  if (artifactValue === "production") {
    let profileObservation;
    try {
      profileObservation = observeDisposableProfile();
    } catch {
      throw new Error("production-disposable-profile-required");
    }
    if (profileObservation !== "valid")
      throw new Error("production-disposable-profile-required");
  }
  return runAfterProductionSingleInstancePreflight(
    artifactValue,
    observeSingleInstance,
    performSideEffects,
  );
}

function isScrubbedEnvName(name) {
  const normalizedName = normalizeEnvName(name);
  if (normalizedName.startsWith("THREADTERM_")) return true;
  if (
    normalizedName === "NODE_OPTIONS" ||
    normalizedName === "NODE_DEBUG" ||
    normalizedName === "DEBUG"
  ) {
    return true;
  }
  return /(?:API|AUTH|SECRET|TOKEN|PASSWORD|BASE_URL|ENDPOINT|PROXY|DEBUG|TEST|HOOK)/.test(
    normalizedName,
  );
}

/**
 * Keep this list deliberately boring. HOME and USERPROFILE are copied as-is
 * when present; neither is rewritten to point at the run sandbox. CODEX_HOME
 * is intentionally omitted so provider history/config roots cannot enter the
 * harness child. The sandbox is conveyed through the runner-owned
 * THREADTERM_* contract.
 */
function filterInheritedEnvironment(source = process.env) {
  const result = {};
  const seenNames = new Set();
  for (const [name, value] of Object.entries(source ?? {})) {
    const normalizedName = normalizeEnvName(name);
    if (
      !SAFE_INHERITED_ENV_NAMES.has(normalizedName) ||
      isScrubbedEnvName(normalizedName) ||
      typeof value !== "string"
    ) {
      continue;
    }
    // Windows environment names are case-insensitive. Keep only the first
    // spelling so a synthetic case-variant cannot reintroduce a second value.
    if (!seenNames.has(normalizedName)) {
      result[name] = value;
      seenNames.add(normalizedName);
    }
  }
  return result;
}

function setRunnerEnvironmentValue(target, name, value) {
  const normalizedName = normalizeEnvName(name);
  if (!RUNNER_OWNED_ENV_NAMES.has(normalizedName))
    throw new Error("runner-environment-name-not-owned");
  for (const key of Object.keys(target)) {
    if (normalizeEnvName(key) === normalizedName) delete target[key];
  }
  target[name] = String(value);
}

function assertChildEnvironmentClosedSet(environment) {
  for (const name of FORBIDDEN_CHILD_ENV_NAMES) {
    if (readEnv(environment, name) !== undefined)
      throw new Error("child-environment-contains-forbidden-provider-root");
  }
  for (const name of Object.keys(environment ?? {})) {
    const normalizedName = normalizeEnvName(name);
    if (
      !SAFE_INHERITED_ENV_NAMES.has(normalizedName) &&
      !RUNNER_OWNED_ENV_NAMES.has(normalizedName)
    ) {
      throw new Error("child-environment-contains-unowned-value");
    }
  }
}

function assertHarnessOfflineInput(source, artifact) {
  const offlineValue = readEnv(
    source,
    "THREADTERM_TERMINAL_STARTUP_HARNESS_OFFLINE",
  );
  if (offlineValue === undefined) return;
  if (artifact !== "harness")
    throw new Error("harness-only-environment-requires-harness-artifact");
  if (offlineValue !== "1")
    throw new Error("terminal-startup-harness-offline-value-invalid");
}

function assertOfflineChildEnvironment(
  environment,
  artifact,
  expectedUdf,
  expectedOfflineCsp,
) {
  const offline = readEnv(
    environment,
    "THREADTERM_TERMINAL_STARTUP_HARNESS_OFFLINE",
  );
  const browserArguments = readEnv(
    environment,
    "THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS",
  );
  const nativeBrowserArguments = readEnv(
    environment,
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
  );
  const nativeUserDataFolder = readEnv(
    environment,
    "WEBVIEW2_USER_DATA_FOLDER",
  );
  const expectedCsp = readEnv(
    environment,
    "THREADTERM_WDIO_EXPECT_OFFLINE_CSP",
  );
  if (artifact === "harness") {
    if (
      offline !== "1" ||
      browserArguments !== OFFLINE_WEBVIEW2_ARGUMENTS_JSON ||
      typeof expectedUdf !== "string" ||
      nativeBrowserArguments !== undefined ||
      nativeUserDataFolder !== undefined ||
      typeof expectedOfflineCsp !== "string" ||
      expectedOfflineCsp.length === 0 ||
      expectedCsp !== expectedOfflineCsp
    )
      throw new Error("harness-offline-child-environment-invalid");
    return;
  }
  if (
    offline !== undefined ||
    browserArguments !== undefined ||
    nativeBrowserArguments !== undefined ||
    nativeUserDataFolder !== undefined ||
    expectedCsp !== undefined
  )
    throw new Error("production-child-environment-contains-harness-controls");
}

function parseHarnessCspConfig(configText) {
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch {
    throw new Error("harness-csp-config-invalid");
  }
  const csp = parsed?.app?.security?.csp;
  if (typeof csp !== "string" || csp.length === 0)
    throw new Error("harness-csp-config-missing");
  const normalized = csp.toLowerCase();
  if (
    FORBIDDEN_HARNESS_CSP_TOKENS.some((token) =>
      normalized.includes(token.toLowerCase()),
    )
  ) {
    throw new Error("harness-csp-config-external-token");
  }
  return csp;
}

function parseApplicationIdentifierConfig(configText, errorPrefix) {
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch {
    throw new Error(`${errorPrefix}-identifier-config-invalid`);
  }
  const identifier = parsed?.identifier;
  if (typeof identifier !== "string" || identifier.length === 0)
    throw new Error(`${errorPrefix}-identifier-config-missing`);
  return identifier;
}

function parseProductionIdentifierConfig(configText) {
  const productionId = parseApplicationIdentifierConfig(
    configText,
    "production",
  );
  if (productionId !== PRODUCTION_APPLICATION_IDENTIFIER)
    throw new Error("production-identifier-config-unexpected");
  return productionId;
}

function parseHarnessIdentifiersConfig(baseConfigText, harnessConfigText) {
  const productionId = parseProductionIdentifierConfig(baseConfigText);
  const harnessId = parseApplicationIdentifierConfig(
    harnessConfigText,
    "harness",
  );
  if (harnessId !== HARNESS_APPLICATION_IDENTIFIER)
    throw new Error("harness-identifier-config-unexpected");
  if (harnessId === productionId)
    throw new Error("harness-identifier-collides-with-production");
  return Object.freeze({ productionId, harnessId });
}

function attestHarnessBinaryCsp(binaryBuffer, expectedCsp) {
  if (!Buffer.isBuffer(binaryBuffer) || typeof expectedCsp !== "string")
    throw new Error("harness-csp-attestation-input-invalid");
  if (!binaryBuffer.includes(Buffer.from(expectedCsp, "utf8")))
    throw new Error("harness-csp-not-embedded");
}

function attestHarnessBinaryIdentity(binaryBuffer, expectedIdentifier) {
  if (
    !Buffer.isBuffer(binaryBuffer) ||
    typeof expectedIdentifier !== "string"
  )
    throw new Error("harness-identifier-attestation-input-invalid");
  if (!binaryBuffer.includes(Buffer.from(expectedIdentifier, "utf8")))
    throw new Error("harness-identifier-not-embedded");
}

const root = resolve(import.meta.dirname, "../..");
const cache = join(root, ".cache", "windows-terminal-startup");
const matrixRawReports = join(cache, "matrix-v2", "raw");
const baseTauriConfig = join(root, "src-tauri", "tauri.conf.json");
const harnessCspConfig = join(root, "src-tauri", "tauri.webdriver.conf.json");
const supervisorScript = join(
  root,
  "tools",
  "windows-terminal-startup",
  "job-supervisor.ps1",
);
const runsRoot = join(cache, "runs");
const driver = join(cache, "msedgedriver.exe");
const tauriDriver =
  readEnv(process.env, "TAURI_DRIVER") ??
  join(
    readEnv(process.env, "USERPROFILE") ?? "",
    ".cargo",
    "bin",
    "tauri-driver.exe",
  );
const toolEnv = filterInheritedEnvironment(process.env);
const shippingBinary = join(cache, "target", "release", "threadterm.exe");
const harnessBinary = join(
  cache,
  "harness-target",
  "release",
  "threadterm.exe",
);
const reports = join(root, "e2e", "terminal-startup", "reports");
const requestedArtifact =
  readEnv(process.env, "THREADTERM_WDIO_ARTIFACT") ?? "production";
const artifact = requestedArtifact;
const flow =
  readEnv(process.env, "THREADTERM_WDIO_FLOW") ??
  (artifact === "harness" ? "isolation" : "production");
const app =
  readEnv(process.env, "THREADTERM_WDIO_APP") ??
  (artifact === "harness" ? harnessBinary : shippingBinary);
const coldRepeats = Math.max(
  1,
  Number.parseInt(
    readEnv(process.env, "THREADTERM_WDIO_COLD_REPEATS") ?? "1",
    10,
  ) || 1,
);
const flowSpecs = Object.freeze({
  production: "release-smoke.spec.ts",
  float: "float-attach.spec.ts",
  isolation: "isolation.spec.ts",
  provider: "provider.spec.ts",
  timing: "timing.spec.ts",
  listener: "listener.spec.ts",
  surface: "surface-lifecycle.spec.ts",
  da1: "da1.spec.ts",
  warmup: "warmup.spec.ts",
  encoding: "encoding.spec.ts",
});
const productionFlows = new Set(["production", "float"]);
const harnessFlows = new Set(
  Object.keys(flowSpecs).filter((name) => !productionFlows.has(name)),
);
const warmupScenarios = Object.freeze({
  off: "disabled",
  normalSuccess: "normal",
  clickBeforeGrace: "holdBeforeGrace",
  spawnFailure: "spawnFailure",
  neverExit: "neverExit",
  clickDuringHold: "holdBeforeNativeSpawn",
});
const warmupCase = readEnv(process.env, "THREADTERM_WDIO_WARMUP_CASE");
const encodingCase = readEnv(process.env, "THREADTERM_WDIO_ENCODING_CASE");
const concurrency = readEnv(process.env, "THREADTERM_WDIO_CONCURRENCY");
const providerRepeats = readEnv(process.env, "THREADTERM_WDIO_PROVIDER_REPEATS");
const providerShell = readEnv(process.env, "THREADTERM_WDIO_PROVIDER_SHELL");
const matrixReportPath = readEnv(process.env, "THREADTERM_WDIO_MATRIX_REPORT");

function flowRequiresShellAvailability(candidateFlow) {
  return new Set([
    "provider",
    "timing",
    "listener",
    "surface",
    "da1",
    "warmup",
    "encoding",
  ]).has(
    candidateFlow,
  );
}

function emptyProviderShellAvailability() {
  return Object.freeze({ pwsh: false, windowsPowerShell: false, cmd: false });
}

function discoverProviderShellAvailability(
  candidateFlow,
  receipts = discoverCanonicalShellReceipts(),
) {
  if (!flowRequiresShellAvailability(candidateFlow))
    return emptyProviderShellAvailability();
  return Object.freeze({
    pwsh: typeof receipts.pwsh === "string",
    windowsPowerShell: typeof receipts.windowsPowerShell === "string",
    cmd: typeof receipts.cmd === "string",
  });
}

function readProcessProperty(row, name) {
  if (!row || typeof row !== "object") return undefined;
  const expected = normalizeEnvName(name);
  for (const [key, value] of Object.entries(row)) {
    if (normalizeEnvName(key) === expected) return value;
  }
  return undefined;
}

function normalizeProcessRecord(row) {
  const pid = Number(readProcessProperty(row, "ProcessId"));
  const parentProcessId = Number(readProcessProperty(row, "ParentProcessId"));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (!Number.isInteger(parentProcessId) || parentProcessId < 0)
    return undefined;
  const executablePath = readProcessProperty(row, "ExecutablePath");
  const creationDate = readProcessProperty(row, "CreationDate");
  return {
    pid,
    parentProcessId,
    executablePath:
      typeof executablePath === "string" && executablePath.length > 0
        ? executablePath
        : undefined,
    creationDate:
      typeof creationDate === "string" && creationDate.length > 0
        ? creationDate
        : undefined,
  };
}

function normalizeProcessTable(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : undefined;
  if (!rows) return undefined;
  const records = rows.map(normalizeProcessRecord);
  if (records.some((record) => record === undefined)) return undefined;
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.pid)) return undefined;
    seen.add(record.pid);
  }
  return records;
}

function readProcessTable(deadline = Number.POSITIVE_INFINITY) {
  const result = runPowerShellObservation(
    "$ErrorActionPreference = 'Stop'; @((Get-CimInstance Win32_Process -Filter \"ProcessId > 0\" -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate)) | ConvertTo-Json -Compress",
    deadline,
  );
  if (!isSuccessfulSpawnResult(result) || typeof result.stdout !== "string")
    return undefined;
  try {
    return normalizeProcessTable(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

function normalizeProcessNameRecord(row) {
  const pid = Number(readProcessProperty(row, "ProcessId"));
  const parentProcessId = Number(readProcessProperty(row, "ParentProcessId"));
  const name = readProcessProperty(row, "Name");
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (!Number.isInteger(parentProcessId) || parentProcessId < 0)
    return undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  return { pid, parentProcessId, name };
}

function normalizeProcessNameTable(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : undefined;
  if (!rows) return undefined;
  const records = rows.map(normalizeProcessNameRecord);
  if (records.some((record) => record === undefined)) return undefined;
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.pid)) return undefined;
    seen.add(record.pid);
  }
  return records;
}

function selectDescendantProcessRecords(records, rootPid) {
  if (!Array.isArray(records) || !Number.isInteger(rootPid) || rootPid <= 0)
    return { status: "invalid", records: [] };
  const root = records.find((record) => record.pid === rootPid);
  if (!root) return { status: "invalid", records: [] };
  const childrenByParent = new Map();
  for (const record of records) {
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0)
      return { status: "invalid", records: [] };
    const children = childrenByParent.get(record.parentProcessId) ?? [];
    children.push(record);
    childrenByParent.set(record.parentProcessId, children);
  }
  const descendants = [];
  const queue = [rootPid];
  const visited = new Set([rootPid]);
  while (queue.length > 0) {
    const parentPid = queue.shift();
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      descendants.push(child);
      queue.push(child.pid);
    }
  }
  return { status: "ok", records: descendants };
}

function readProcessNameTable(deadline = Number.POSITIVE_INFINITY) {
  const result = runPowerShellObservation(
    "$ErrorActionPreference = 'Stop'; @((Get-CimInstance Win32_Process -Filter \"ProcessId > 0\" -Property ProcessId,ParentProcessId,Name | Select-Object ProcessId,ParentProcessId,Name)) | ConvertTo-Json -Compress",
    deadline,
  );
  if (!isSuccessfulSpawnResult(result) || typeof result.stdout !== "string")
    return undefined;
  try {
    return normalizeProcessNameTable(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

function normalizeCommandLineRecord(row) {
  const processId =
    readProcessProperty(row, "ProcessId") ?? readProcessProperty(row, "pid");
  const pid = Number(processId);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const commandLine =
    readProcessProperty(row, "CommandLine") ??
    readProcessProperty(row, "commandLine");
  return {
    pid,
    commandLine: typeof commandLine === "string" ? commandLine : undefined,
  };
}

function normalizeCommandLineTable(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : undefined;
  if (!rows) return undefined;
  const records = rows.map(normalizeCommandLineRecord);
  if (records.some((record) => record === undefined)) return undefined;
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.pid)) return undefined;
    seen.add(record.pid);
  }
  return records;
}

function readDescendantWebViewCommandLines(
  pids,
  deadline = Number.POSITIVE_INFINITY,
) {
  const ids = [...new Set(pids)].filter(
    (pid) => Number.isInteger(pid) && pid > 0,
  );
  if (ids.length === 0) return [];
  const clauses = ids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  const filter = `Name = 'msedgewebview2.exe' AND (${clauses})`;
  const result = runPowerShellObservation(
    `$ErrorActionPreference = 'Stop'; @((Get-CimInstance Win32_Process -Filter "${filter}" -Property ProcessId,CommandLine | Select-Object ProcessId,CommandLine)) | ConvertTo-Json -Compress`,
    deadline,
  );
  if (!isSuccessfulSpawnResult(result) || typeof result.stdout !== "string")
    return undefined;
  try {
    const records = normalizeCommandLineTable(JSON.parse(result.stdout));
    if (!records) return undefined;
    if (records.some((record) => !ids.includes(record.pid))) return undefined;
    return records;
  } catch {
    return undefined;
  }
}

function extractHostResolverRules(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return [];
  const rules = [];
  const pattern =
    /(?:^|\s)--host-resolver-rules=(?:"([^"]*)"|'([^']*)'|([^\s]*))/gi;
  for (const match of commandLine.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) rules.push(value);
  }
  return rules;
}

function countChromiumSwitch(commandLine, switchName) {
  if (
    typeof commandLine !== "string" ||
    commandLine.length === 0 ||
    typeof switchName !== "string" ||
    !/^[a-z0-9-]+$/i.test(switchName)
  )
    return 0;
  const escapedName = switchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\s)--${escapedName}(?=(?:=|\\s|$))`, "gi");
  return [...commandLine.matchAll(pattern)].length;
}

function countBareChromiumSwitch(commandLine, switchName) {
  if (
    typeof commandLine !== "string" ||
    commandLine.length === 0 ||
    typeof switchName !== "string" ||
    !/^[a-z0-9-]+$/i.test(switchName)
  )
    return 0;
  const escapedName = switchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\s)--${escapedName}(?=\\s|$)`, "gi");
  return [...commandLine.matchAll(pattern)].length;
}

function hasChromiumTypeSwitch(commandLine) {
  return countChromiumSwitch(commandLine, "type") > 0;
}

function normalizeHostResolverRule(rule) {
  return typeof rule === "string"
    ? rule.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

function isolationObservation(
  status,
  webviewCount,
  _ignoredFirstEvidence = false,
  _ignoredSecondEvidence = false,
  hasOfflineHostResolverRule,
  hasConflictingHostResolverRule = false,
) {
  return Object.freeze({
    ok: status === "matched",
    status,
    webviewCount,
    hasOfflineHostResolverRule,
    hasConflictingHostResolverRule,
  });
}

function evaluateOfflineWebViewIsolation(processRows, commandRows, rootPid) {
  const descendants = selectDescendantProcessRecords(processRows, rootPid);
  if (descendants.status !== "ok")
    return isolationObservation("observation-failed", 0, false, false, false);
  const webviews = descendants.records.filter(
    (record) => normalizeEnvName(record.name) === WEBVIEW2_PROCESS_NAME,
  );
  if (webviews.length === 0)
    return isolationObservation("webview-not-observed", 0, false, false, false);
  const commandTable = normalizeCommandLineTable(commandRows);
  if (!commandTable)
    return isolationObservation(
      "commandline-observation-failed",
      webviews.length,
      false,
      false,
      false,
    );
  const commandsByPid = new Map(
    commandTable.map((record) => [record.pid, record]),
  );
  const commandByWebView = new Map();
  for (const webview of webviews) {
    const command = commandsByPid.get(webview.pid);
    if (
      !command ||
      typeof command.commandLine !== "string" ||
      command.commandLine.length === 0
    )
      return isolationObservation(
        "commandline-missing",
        webviews.length,
        false,
        false,
        false,
      );
    commandByWebView.set(webview.pid, command.commandLine);
  }
  const browserHosts = webviews.filter(
    (webview) => !hasChromiumTypeSwitch(commandByWebView.get(webview.pid)),
  );
  if (browserHosts.length === 0)
    return isolationObservation(
      "browser-host-missing",
      webviews.length,
      false,
      false,
      false,
    );
  if (browserHosts.length !== 1)
    return isolationObservation(
      "browser-host-ambiguous",
      webviews.length,
      false,
      false,
      false,
    );
  const browserCommand = commandByWebView.get(browserHosts[0].pid);
  let hasOfflineHostResolverRule = false;
  let hasConflictingHostResolverRule = false;
  const hostResolverRules = extractHostResolverRules(browserCommand);
  if (hostResolverRules.length !== 1) {
    hasConflictingHostResolverRule = hostResolverRules.length > 1;
    return isolationObservation(
      hostResolverRules.length === 0
        ? "offline-host-resolver-rule-missing"
        : "offline-host-resolver-rule-conflict",
      webviews.length,
      false,
      false,
      false,
      hasConflictingHostResolverRule,
    );
  }
  if (
    normalizeHostResolverRule(hostResolverRules[0]) !==
    normalizeHostResolverRule(OFFLINE_HOST_RESOLVER_RULE)
  )
    hasConflictingHostResolverRule = true;
  if (hasConflictingHostResolverRule)
    return isolationObservation(
      "offline-host-resolver-rule-conflict",
      webviews.length,
      false,
      false,
      false,
      true,
    );
  const backgroundNetworkingCount = countChromiumSwitch(
    browserCommand,
    "disable-background-networking",
  );
  const bareBackgroundNetworkingCount = countBareChromiumSwitch(
    browserCommand,
    "disable-background-networking",
  );
  if (backgroundNetworkingCount !== 1 || bareBackgroundNetworkingCount !== 1)
    return isolationObservation(
      backgroundNetworkingCount === 0
        ? "offline-background-networking-missing"
        : "offline-background-networking-conflict",
      webviews.length,
      true,
      false,
      true,
      false,
    );
  hasOfflineHostResolverRule = true;
  return isolationObservation(
    "matched",
    webviews.length,
    true,
    false,
    true,
    false,
  );
}

async function observeOfflineWebViewIsolation(
  appIdentity,
  {
    timeoutMs = 20_000,
    pollMs = 100,
    deadline = Number.POSITIVE_INFINITY,
  } = {},
) {
  if (
    !appIdentity ||
    !Number.isInteger(appIdentity.pid) ||
    appIdentity.pid <= 0
  )
    return isolationObservation("invalid", 0, false, false, false);
  const timeout = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(timeoutMs, 20_000))
    : 20_000;
  const poll = Number.isFinite(pollMs)
    ? Math.max(1, Math.min(pollMs, 1_000))
    : 100;
  const observationDeadline = boundedDeadline(timeout, deadline);
  while (!isDeadlineExpired(Date.now(), observationDeadline)) {
    const processRows = readProcessNameTable(observationDeadline);
    if (!processRows)
      return isolationObservation("observation-failed", 0, false, false, false);
    const descendants = selectDescendantProcessRecords(
      processRows,
      appIdentity.pid,
    );
    if (descendants.status !== "ok")
      return isolationObservation("observation-failed", 0, false, false, false);
    const webviewPids = descendants.records
      .filter(
        (record) => normalizeEnvName(record.name) === WEBVIEW2_PROCESS_NAME,
      )
      .map((record) => record.pid);
    if (webviewPids.length > 0) {
      const commandRows = readDescendantWebViewCommandLines(
        webviewPids,
        observationDeadline,
      );
      if (!commandRows)
        return isolationObservation(
          "commandline-observation-failed",
          webviewPids.length,
          false,
          false,
          false,
        );
      return evaluateOfflineWebViewIsolation(
        processRows,
        commandRows,
        appIdentity.pid,
      );
    }
    const pause = boundedTimeout(poll, observationDeadline);
    if (pause <= 0) break;
    await new Promise((done) => setTimeout(done, pause));
  }
  return isolationObservation("webview-not-observed", 0, false, false, false);
}

function comparableWindowsPath(pathValue) {
  if (typeof pathValue !== "string" || pathValue.length === 0) return undefined;
  let value = pathValue.trim().replaceAll("/", "\\");
  if (value.toLowerCase().startsWith("\\\\?\\unc\\"))
    value = `\\\\${value.slice(8)}`;
  else if (value.startsWith("\\\\?\\")) value = value.slice(4);
  value = value.replace(/[\\]+$/, "");
  return value.toLowerCase();
}

function hasExpectedAncestry(records, pid, ancestorPid) {
  const byPid = new Map(records.map((record) => [record.pid, record]));
  if (!byPid.has(ancestorPid)) return false;
  const visited = new Set([pid]);
  let current = byPid.get(pid);
  while (current && current.parentProcessId !== 0) {
    const parentPid = current.parentProcessId;
    if (parentPid === ancestorPid) return true;
    if (visited.has(parentPid)) return false;
    visited.add(parentPid);
    current = byPid.get(parentPid);
  }
  return false;
}

function selectOwnedProcessIdentity(records, selectedBinary, driverPid) {
  if (!Array.isArray(records) || !Number.isInteger(driverPid) || driverPid <= 0)
    return { status: "invalid" };
  const seenPids = new Set();
  for (const record of records) {
    if (
      !record ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      !Number.isInteger(record.parentProcessId) ||
      record.parentProcessId < 0 ||
      seenPids.has(record.pid)
    ) {
      return { status: "invalid" };
    }
    seenPids.add(record.pid);
  }
  const selectedPath = comparableWindowsPath(selectedBinary);
  if (!selectedPath) return { status: "invalid" };
  const candidates = records.filter(
    (record) =>
      record.pid !== driverPid &&
      comparableWindowsPath(record.executablePath) === selectedPath &&
      typeof record.creationDate === "string" &&
      hasExpectedAncestry(records, record.pid, driverPid),
  );
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length !== 1) return { status: "ambiguous" };
  return {
    status: "owned",
    identity: {
      pid: candidates[0].pid,
      executablePath: candidates[0].executablePath,
      creationDate: candidates[0].creationDate,
    },
  };
}

function sameProcessIdentity(actual, expected) {
  return Boolean(
    actual &&
    expected &&
    actual.pid === expected.pid &&
    actual.creationDate === expected.creationDate &&
    comparableWindowsPath(actual.executablePath) ===
      comparableWindowsPath(expected.executablePath),
  );
}

function processIdentityAtPid(records, pid) {
  if (!Array.isArray(records) || !Number.isInteger(pid) || pid <= 0)
    return undefined;
  const matches = records.filter((record) => record.pid === pid);
  if (
    matches.length !== 1 ||
    typeof matches[0].executablePath !== "string" ||
    typeof matches[0].creationDate !== "string"
  ) {
    return undefined;
  }
  return {
    pid: matches[0].pid,
    executablePath: matches[0].executablePath,
    creationDate: matches[0].creationDate,
  };
}

function canTerminateProcessIdentity(records, expected) {
  return sameProcessIdentity(
    processIdentityAtPid(records, expected?.pid),
    expected,
  );
}

function processIdentityDisposition(records, expected) {
  if (!Array.isArray(records)) return "observationFailed";
  const actual = processIdentityAtPid(records, expected?.pid);
  if (!actual) return "gone";
  return sameProcessIdentity(actual, expected) ? "owned" : "mismatch";
}

function isOwnedProcessTreeGone(records, expected) {
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    !expected ||
    !Number.isInteger(expected.pid) ||
    expected.pid <= 0 ||
    typeof expected.executablePath !== "string" ||
    typeof expected.creationDate !== "string"
  )
    return false;
  const byPid = new Map();
  for (const record of records) {
    if (
      !record ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      !Number.isInteger(record.parentProcessId) ||
      record.parentProcessId < 0 ||
      byPid.has(record.pid)
    )
      return false;
    byPid.set(record.pid, record);
  }
  const root = byPid.get(expected.pid);
  if (root !== undefined) return false;
  for (const record of records) {
    const visited = new Set([record.pid]);
    let current = record;
    while (current.parentProcessId !== 0) {
      if (current.parentProcessId === expected.pid) return false;
      if (visited.has(current.parentProcessId)) return false;
      visited.add(current.parentProcessId);
      current = byPid.get(current.parentProcessId);
      if (!current) return false;
    }
  }
  return true;
}

function classifyPortProbeError(error) {
  return error && typeof error === "object" && error.code === "ECONNREFUSED"
    ? "refused"
    : "failed";
}

function observePortRefused(
  port,
  runDeadline = Number.POSITIVE_INFINITY,
  localCap = 1_000,
) {
  return new Promise((resolveProbe) => {
    let settled = false;
    const deadline = boundedDeadline(localCap, runDeadline);
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) =>
      finish(classifyPortProbeError(error) === "refused"),
    );
    const timeout = remainingBudget(deadline);
    if (timeout <= 0) {
      finish(false);
      return;
    }
    socket.setTimeout(timeout, () => finish(false));
  });
}

async function waitForOwnedProcessTreeGone(
  expected,
  runDeadline = Number.POSITIVE_INFINITY,
) {
  while (!isDeadlineExpired(Date.now(), runDeadline)) {
    const records = readProcessTable(runDeadline);
    if (isOwnedProcessTreeGone(records, expected)) return true;
    const pause = boundedTimeout(100, runDeadline);
    if (pause <= 0) break;
    await new Promise((done) => setTimeout(done, pause));
  }
  return false;
}

async function captureDirectProcessIdentity(
  child,
  expectedExecutable,
  runDeadline = Number.POSITIVE_INFINITY,
) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0)
    throw new Error("direct-process-identity-invalid");
  const expectedPath = comparableWindowsPath(expectedExecutable);
  if (!expectedPath) throw new Error("direct-process-path-invalid");
  const deadline = boundedDeadline(20_000, runDeadline);
  while (!isDeadlineExpired(Date.now(), deadline)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("direct-process-exited-before-identity");
    const processTable = readProcessTable(deadline);
    if (!processTable) {
      await new Promise((done) => setTimeout(done, 100));
      continue;
    }
    const identity = processIdentityAtPid(processTable, child.pid);
    if (identity) {
      if (comparableWindowsPath(identity.executablePath) !== expectedPath)
        throw new Error("direct-process-identity-mismatch");
      return identity;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("direct-process-identity-timeout");
}

async function captureOwnedThreadTermIdentity(
  child,
  selectedBinary,
  expectedSupervisorIdentity,
  runDeadline = Number.POSITIVE_INFINITY,
) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0)
    throw new Error("tauri-driver-process-identity-invalid");
  const supervisorIdentity = expectedSupervisorIdentity;
  const deadline = boundedDeadline(20_000, runDeadline);
  while (!isDeadlineExpired(Date.now(), deadline)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("threadterm-process-not-observed");
    const processTable = readProcessTable(deadline);
    if (!processTable) {
      await new Promise((done) => setTimeout(done, 100));
      continue;
    }
    if (
      supervisorIdentity !== undefined &&
      !canTerminateProcessIdentity(processTable, supervisorIdentity)
    )
      throw new Error("supervisor-identity-mismatch");
    const selected = selectOwnedProcessIdentity(
      processTable,
      selectedBinary,
      child.pid,
    );
    if (selected.status === "ambiguous")
      throw new Error("threadterm-process-observation-ambiguous");
    if (selected.status === "invalid")
      throw new Error("threadterm-process-observation-invalid");
    if (selected.status === "owned")
      return { app: selected.identity, supervisor: supervisorIdentity };
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("threadterm-process-not-observed");
}

async function stopCapturedThreadTermIdentity(owner) {
  const identity = owner?.app;
  const driverIdentity = owner?.driver;
  const driverPid = driverIdentity?.pid;
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0)
    return false;
  if (!Number.isInteger(driverPid) || driverPid <= 0) return false;
  const observed = readProcessTable();
  if (!observed) return false;
  const currentDriver = processIdentityAtPid(observed, driverPid);
  if (!sameProcessIdentity(currentDriver, driverIdentity)) return false;
  const matchingPid = observed.filter((record) => record.pid === identity.pid);
  if (matchingPid.length === 0) return true;
  const selected = selectOwnedProcessIdentity(
    observed,
    identity.executablePath,
    driverPid,
  );
  if (
    selected.status !== "owned" ||
    !sameProcessIdentity(selected.identity, identity) ||
    matchingPid.length !== 1 ||
    !sameProcessIdentity(matchingPid[0], identity) ||
    !hasExpectedAncestry(observed, identity.pid, driverPid)
  ) {
    return false;
  }
  const killed = runTaskkill(identity.pid);
  if (!isSuccessfulSpawnResult(killed)) return false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readProcessTable();
    if (!current) return false;
    const currentDriver = processIdentityAtPid(current, driverPid);
    if (!sameProcessIdentity(currentDriver, driverIdentity)) return false;
    const currentPid = current.filter((record) => record.pid === identity.pid);
    if (currentPid.length === 0) {
      return current.some((record) => record.pid === driverPid)
        ? selectOwnedProcessIdentity(
            current,
            identity.executablePath,
            driverPid,
          ).status === "none"
        : false;
    }
    const currentSelection = selectOwnedProcessIdentity(
      current,
      identity.executablePath,
      driverPid,
    );
    if (
      currentSelection.status !== "owned" ||
      !sameProcessIdentity(currentSelection.identity, identity) ||
      currentPid.length !== 1 ||
      !sameProcessIdentity(currentPid[0], identity) ||
      !hasExpectedAncestry(current, identity.pid, driverPid)
    )
      return false;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

const nativePort = "4445";

const marker = Buffer.from("threadterm-terminal-startup-harness-v1\n", "utf8");
const RUNTIME_ISOLATION_MARKER_NAME = ".threadterm-runtime-isolation-v1";
const RUNTIME_ISOLATION_MARKER_VALUE =
  "THREADTERM_RUNTIME_ISOLATION_MATCHED_V1\n";

function createRunLayout(index) {
  const runName = `run-${Date.now()}-${process.pid}-${index}-${randomUUID()}`;
  const runDir = join(runsRoot, runName);
  const sandbox = join(runDir, "sandbox");
  const appData = join(sandbox, "app-data");
  const profile = join(sandbox, "profile");
  mkdirSync(runDir);
  for (const child of ["database", "state", "webview", "migration"]) {
    mkdirSync(join(appData, child), { recursive: true });
  }
  mkdirSync(join(sandbox, "bootstrap"), { recursive: true });
  mkdirSync(join(sandbox, "temp"), { recursive: true });
  for (const child of ["home", "roaming", "local"]) {
    mkdirSync(join(profile, child), { recursive: true });
  }
  writeFileSync(join(sandbox, ".threadterm-terminal-startup-harness"), marker);
  writeFileSync(
    join(appData, "manifest.json"),
    JSON.stringify({ appId: "com.Heluth-Crazy.threadterm", formatVersion: 1 }),
  );

  const canonicalSandbox = realpathSync.native(sandbox);
  const canonicalAppData = realpathSync.native(appData);
  const canonicalTemp = realpathSync.native(join(sandbox, "temp"));
  const canonicalProfile = realpathSync.native(profile);
  const runtimeIsolationMarker = resolve(
    canonicalTemp,
    RUNTIME_ISOLATION_MARKER_NAME,
  );
  const runtimeIsolationMarkerTemp = resolve(
    canonicalTemp,
    `${RUNTIME_ISOLATION_MARKER_NAME}.tmp`,
  );
  if (
    existsSync(runtimeIsolationMarker) ||
    existsSync(runtimeIsolationMarkerTemp)
  )
    throw new Error("runtime-isolation-marker-preexisting");
  return {
    runName,
    runDir,
    sandbox: canonicalSandbox,
    dataRoot: canonicalAppData,
    temp: canonicalTemp,
    runtimeIsolationMarker,
    runtimeIsolationMarkerTemp,
    udf: realpathSync.native(join(canonicalAppData, "webview")),
    profileHome: realpathSync.native(join(canonicalProfile, "home")),
    profileAppData: realpathSync.native(join(canonicalProfile, "roaming")),
    profileLocalAppData: realpathSync.native(join(canonicalProfile, "local")),
  };
}

function hasContainedRuntimeIsolationMarker(layout) {
  if (!layout || typeof layout.temp !== "string") return false;
  let canonicalTemp;
  try {
    canonicalTemp = realpathSync.native(layout.temp);
  } catch {
    return false;
  }
  const expectedMarker = resolve(canonicalTemp, RUNTIME_ISOLATION_MARKER_NAME);
  const expectedTemp = resolve(
    canonicalTemp,
    `${RUNTIME_ISOLATION_MARKER_NAME}.tmp`,
  );
  return (
    layout.runtimeIsolationMarker === expectedMarker &&
    layout.runtimeIsolationMarkerTemp === expectedTemp &&
    dirname(expectedMarker) === canonicalTemp &&
    dirname(expectedTemp) === canonicalTemp &&
    relative(canonicalTemp, expectedMarker) === RUNTIME_ISOLATION_MARKER_NAME &&
    relative(canonicalTemp, expectedTemp) ===
      `${RUNTIME_ISOLATION_MARKER_NAME}.tmp`
  );
}

function publishRuntimeIsolationMarker(layout) {
  if (
    !hasContainedRuntimeIsolationMarker(layout) ||
    existsSync(layout.runtimeIsolationMarker) ||
    existsSync(layout.runtimeIsolationMarkerTemp)
  )
    return false;
  let descriptor;
  try {
    descriptor = openSync(layout.runtimeIsolationMarkerTemp, "wx", 0o600);
    writeFileSync(descriptor, RUNTIME_ISOLATION_MARKER_VALUE, "ascii");
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(layout.runtimeIsolationMarker)) return false;
    renameSync(
      layout.runtimeIsolationMarkerTemp,
      layout.runtimeIsolationMarker,
    );
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Publication has already failed; cleanup owns the sandbox.
      }
    }
  }
}

function buildRunEnv(
  layout,
  providerShellAvailability = {
    pwsh: false,
    windowsPowerShell: false,
    cmd: false,
  },
  source = process.env,
  expectedOfflineCsp,
  providerShellReceipts = emptyProviderShellAvailability(),
  encodingToolReceipts = {},
) {
  const runEnv = filterInheritedEnvironment(source);
  const set = (name, value) => setRunnerEnvironmentValue(runEnv, name, value);
  set("THREADTERM_WDIO_ARTIFACT", artifact);
  set("THREADTERM_WDIO_EXPECT_HARNESS", artifact === "harness" ? "1" : "0");
  set("THREADTERM_WDIO_FLOW", flow);
  set("THREADTERM_WDIO_UDF", layout.udf);
  set("THREADTERM_WDIO_DATA_ROOT", layout.dataRoot);
  set("THREADTERM_WDIO_APP", app);
  set(
    "THREADTERM_WDIO_RUNTIME_ISOLATION_MARKER",
    layout.runtimeIsolationMarker,
  );
  set("PSModuleAnalysisCachePath", "NUL");
  set("PSDisableModuleAnalysisCacheCleanup", "1");
  // Every flow starts from the shipping-safe rollback baseline. The provider
  // slice opts into readiness below; the other capabilities stay explicit
  // and cannot inherit a developer-machine environment.
  set("THREADTERM_PROVIDER_SHELL_READY", "0");
  set("THREADTERM_DA1_AUTHORITY", "0");
  set("THREADTERM_POWERSHELL_UTF8", "0");
  set("THREADTERM_CONPTY_WARMUP", "0");
  for (const name of [
    "THREADTERM_WDIO_PROVIDER_PWSH_AVAILABLE",
    "THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_AVAILABLE",
    "THREADTERM_WDIO_PROVIDER_CMD_AVAILABLE",
    "THREADTERM_WDIO_PROVIDER_PWSH_PATH",
    "THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_PATH",
    "THREADTERM_WDIO_PROVIDER_CMD_PATH",
    "THREADTERM_WDIO_ENCODING_GIT_PATH",
    "THREADTERM_WDIO_ENCODING_NODE_PATH",
    "THREADTERM_WDIO_ENCODING_PYTHON_PATH",
    "THREADTERM_WDIO_DA1_SHELL",
    "THREADTERM_WDIO_DA1_AVAILABLE",
    "THREADTERM_WDIO_WARMUP_CMD_AVAILABLE",
    "THREADTERM_WDIO_ENCODING_CASE",
    "THREADTERM_WDIO_EXPECT_POWERSHELL_UTF8",
    "THREADTERM_WDIO_WARMUP_CASE",
    "THREADTERM_WDIO_CONCURRENCY",
    "THREADTERM_WDIO_PROVIDER_REPEATS",
    "THREADTERM_WDIO_PROVIDER_SHELL",
  ]) {
    for (const key of Object.keys(runEnv)) {
      if (normalizeEnvName(key) === normalizeEnvName(name)) delete runEnv[key];
    }
  }
  const setProviderShellAvailability = () => {
    set(
      "THREADTERM_WDIO_PROVIDER_PWSH_AVAILABLE",
      providerShellAvailability.pwsh ? "1" : "0",
    );
    set(
      "THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_AVAILABLE",
      providerShellAvailability.windowsPowerShell ? "1" : "0",
    );
    set(
      "THREADTERM_WDIO_PROVIDER_CMD_AVAILABLE",
      providerShellAvailability.cmd ? "1" : "0",
    );
    if (artifact !== "harness") return;
    const receiptNames = [
      ["pwsh", "THREADTERM_WDIO_PROVIDER_PWSH_PATH"],
      ["windowsPowerShell", "THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_PATH"],
      ["cmd", "THREADTERM_WDIO_PROVIDER_CMD_PATH"],
    ];
    for (const [shell, name] of receiptNames) {
      const receipt = providerShellReceipts[shell];
      if (providerShellAvailability[shell] && typeof receipt === "string")
        set(name, receipt);
    }
  };
  if (flowRequiresShellAvailability(flow)) {
    setProviderShellAvailability();
  }
  if (flow === "da1") {
    const shell = providerShellAvailability.pwsh ? "pwsh" : "windowsPowerShell";
    set("THREADTERM_WDIO_DA1_SHELL", shell);
    set(
      "THREADTERM_WDIO_DA1_AVAILABLE",
      providerShellAvailability[shell] ? "1" : "0",
    );
  }
  if (flow === "warmup") {
    set(
      "THREADTERM_WDIO_WARMUP_CMD_AVAILABLE",
      providerShellAvailability.cmd ? "1" : "0",
    );
    if (!providerShellAvailability.cmd)
      throw new Error("required-cmd-unavailable");
    set("THREADTERM_WDIO_WARMUP_CASE", warmupCase);
    set(
      "THREADTERM_TERMINAL_STARTUP_WARMUP_SCENARIO",
      warmupScenarios[warmupCase],
    );
    set("THREADTERM_CONPTY_WARMUP", warmupCase === "off" ? "0" : "1");
  }
  if (flow === "provider" || flow === "timing" || flow === "listener" || flow === "surface") {
    set("THREADTERM_PROVIDER_SHELL_READY", "1");
  }
  if (flow === "provider" && concurrency !== undefined)
    set("THREADTERM_WDIO_CONCURRENCY", concurrency);
  if (flow === "provider" && providerRepeats !== undefined)
    set("THREADTERM_WDIO_PROVIDER_REPEATS", providerRepeats);
  if (flow === "provider" && providerShell !== undefined)
    set("THREADTERM_WDIO_PROVIDER_SHELL", providerShell);
  if (flow === "encoding") {
    for (const [tool, name] of [
      ["git", "THREADTERM_WDIO_ENCODING_GIT_PATH"],
      ["node", "THREADTERM_WDIO_ENCODING_NODE_PATH"],
      ["python", "THREADTERM_WDIO_ENCODING_PYTHON_PATH"],
    ]) {
      const receipt = encodingToolReceipts[tool];
      if (artifact === "harness" && typeof receipt === "string") set(name, receipt);
    }
    set("THREADTERM_WDIO_ENCODING_CASE", encodingCase);
    const powershellUtf8 = encodingCase === "enabled" ? "1" : "0";
    set("THREADTERM_POWERSHELL_UTF8", powershellUtf8);
    set("THREADTERM_WDIO_EXPECT_POWERSHELL_UTF8", powershellUtf8);
  }
  if (flow === "da1") {
    set("THREADTERM_DA1_AUTHORITY", "1");
  }
  if (artifact === "harness") {
    if (
      typeof expectedOfflineCsp !== "string" ||
      expectedOfflineCsp.length === 0
    )
      throw new Error("harness-offline-csp-expectation-missing");
    set("THREADTERM_TERMINAL_STARTUP_HARNESS_ROOT", layout.sandbox);
    set("THREADTERM_TERMINAL_STARTUP_HARNESS_OFFLINE", "1");
    set("THREADTERM_WDIO_EXPECT_OFFLINE_CSP", expectedOfflineCsp);
    const systemRoot = observationSystemRoot(runEnv);
    if (!systemRoot) throw new Error("harness-system-root-missing");
    const harnessCmdReceipt = providerShellReceipts.cmd;
    if (typeof harnessCmdReceipt !== "string")
      throw new Error("harness-system-cmd-receipt-missing");
    set("PATH", join(systemRoot, "System32"));
    set("ComSpec", harnessCmdReceipt);
    const profileHome = layout.profileHome ?? join(layout.sandbox, "profile", "home");
    const profileAppData = layout.profileAppData ?? join(layout.sandbox, "profile", "roaming");
    const profileLocalAppData = layout.profileLocalAppData ?? join(layout.sandbox, "profile", "local");
    if (!/^[A-Za-z]:\\/.test(profileHome))
      throw new Error("harness-profile-layout-invalid");
    set("HOME", profileHome);
    set("USERPROFILE", profileHome);
    set("APPDATA", profileAppData);
    set("LOCALAPPDATA", profileLocalAppData);
    set("HOMEDRIVE", profileHome.slice(0, 2));
    set("HOMEPATH", profileHome.slice(2));
    set("POWERSHELL_TELEMETRY_OPTOUT", "1");
    set("POWERSHELL_UPDATECHECK", "Off");
    set("TEMP", layout.temp);
    set("TMP", layout.temp);
    set(
      "PSMODULEPATH",
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    );
    set(
      "THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS",
      OFFLINE_WEBVIEW2_ARGUMENTS_JSON,
    );
    if (flow !== "warmup")
      set("THREADTERM_TERMINAL_STARTUP_WARMUP_SCENARIO", "disabled");
  } else {
    for (const name of [
      "THREADTERM_TERMINAL_STARTUP_HARNESS_ROOT",
      "THREADTERM_TERMINAL_STARTUP_WARMUP_SCENARIO",
      "THREADTERM_TERMINAL_STARTUP_HARNESS_OFFLINE",
      "THREADTERM_WDIO_EXPECT_OFFLINE_CSP",
      "THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS",
      "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
      "WEBVIEW2_USER_DATA_FOLDER",
    ]) {
      for (const key of Object.keys(runEnv)) {
        if (normalizeEnvName(key) === normalizeEnvName(name))
          delete runEnv[key];
      }
    }
  }
  assertChildEnvironmentClosedSet(runEnv);
  assertOfflineChildEnvironment(
    runEnv,
    artifact,
    layout.udf,
    expectedOfflineCsp,
  );
  return runEnv;
}

function classifySupervisorReadyBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length > SUPERVISOR_OUTPUT_LIMIT_BYTES)
    return "invalid";
  const forms = [
    Buffer.from(SUPERVISOR_READY_LINE, "utf8"),
    Buffer.from(`${SUPERVISOR_READY_LINE}\n`, "utf8"),
    Buffer.from(`${SUPERVISOR_READY_LINE}\r\n`, "utf8"),
  ];
  if (forms.some((form) => form.equals(value))) return "ready";
  if (
    forms.some(
      (form) =>
        value.length < form.length &&
        form.subarray(0, value.length).equals(value),
    )
  )
    return "pending";
  return "invalid";
}

function normalizeSupervisorEnvironment(environment) {
  assertChildEnvironmentClosedSet(environment);
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  )
    throw new Error("supervisor-environment-invalid");
  const seenNames = new Set();
  const entries = Object.entries(environment).map(([name, value]) => {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.includes("=") ||
      name.includes("\0") ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      throw new Error("supervisor-environment-invalid");
    const normalizedName = normalizeEnvName(name);
    if (seenNames.has(normalizedName))
      throw new Error("supervisor-environment-duplicate");
    seenNames.add(normalizedName);
    return { name, normalizedName, value };
  });
  entries.sort((left, right) => {
    if (left.normalizedName < right.normalizedName) return -1;
    if (left.normalizedName > right.normalizedName) return 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return Object.freeze(
    Object.fromEntries(entries.map(({ name, value }) => [name, value])),
  );
}

function encodeSupervisorLaunchSpec(
  executable,
  workingDirectory,
  argumentsList,
  environment,
) {
  const canonicalExecutable = canonicalExistingFile(executable);
  let canonicalWorkingDirectory;
  try {
    canonicalWorkingDirectory = realpathSync.native(workingDirectory);
  } catch {
    canonicalWorkingDirectory = undefined;
  }
  if (
    !canonicalExecutable ||
    !canonicalWorkingDirectory ||
    !isAbsolute(canonicalWorkingDirectory) ||
    !Array.isArray(argumentsList) ||
    argumentsList.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    )
  )
    throw new Error("supervisor-launch-spec-invalid");
  const exactEnvironment = normalizeSupervisorEnvironment(environment);
  return Buffer.from(
    JSON.stringify({
      executable: canonicalExecutable,
      workingDirectory: canonicalWorkingDirectory,
      arguments: argumentsList,
      environment: exactEnvironment,
    }),
    "utf8",
  ).toString("base64");
}

const supervisorMonitorKey = Symbol("threadtermSupervisorMonitor");

function spawnSupervisor(targetExecutable, targetArguments, env) {
  const powershell = resolveObservationPowerShellExecutable(env);
  const script = canonicalExistingFile(supervisorScript);
  if (!powershell || !script) throw new Error("supervisor-executable-missing");
  const exactEnvironment = normalizeSupervisorEnvironment(env);
  const launchSpec = encodeSupervisorLaunchSpec(
    targetExecutable,
    root,
    targetArguments,
    exactEnvironment,
  );
  return spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-LaunchSpecBase64",
      launchSpec,
    ],
    {
      cwd: root,
      env: exactEnvironment,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
}

function supervisorOutputIsValid(child) {
  const monitor = child?.[supervisorMonitorKey];
  return Boolean(monitor?.ready && monitor.valid);
}

function detachSupervisorMonitor(child) {
  const monitor = child?.[supervisorMonitorKey];
  monitor?.detach?.();
}

function waitForSupervisorReady(
  child,
  runDeadline = Number.POSITIVE_INFINITY,
  localCap = SUPERVISOR_READY_CAP_MS,
) {
  const stream = child?.stdout;
  if (!stream) return Promise.reject(new Error("supervisor-stdout-missing"));
  const deadline = boundedDeadline(localCap, runDeadline);
  const monitor = {
    buffer: Buffer.alloc(0),
    ready: false,
    valid: true,
    detach: undefined,
  };
  child[supervisorMonitorKey] = monitor;
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("error", onChildError);
      child.removeListener("exit", onChildExit);
      if (error) monitor.detach?.();
      error ? rejectReady(error) : resolveReady();
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      monitor.buffer = Buffer.concat([monitor.buffer, bytes]);
      const status = classifySupervisorReadyBuffer(monitor.buffer);
      if (status === "invalid") {
        monitor.valid = false;
        finish(new Error("supervisor-ready-output-invalid"));
        return;
      }
      if (status === "ready") {
        monitor.ready = true;
        finish();
      }
    };
    const onChildError = () => finish(new Error("supervisor-spawn-failed"));
    const onChildExit = () => {
      if (!monitor.ready) finish(new Error("supervisor-exited-before-ready"));
    };
    monitor.detach = () => {
      stream.removeListener("data", onData);
      child.removeListener("error", onChildError);
      child.removeListener("exit", onChildExit);
      if (timer) clearTimeout(timer);
    };
    const rejectIfExited = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(new Error("supervisor-exited-before-ready"));
        return true;
      }
      return false;
    };
    stream.on("data", onData);
    child.once("error", onChildError);
    child.once("exit", onChildExit);
    const timeout = remainingBudget(deadline);
    if (timeout <= 0) {
      finish(new Error("supervisor-ready-timeout"));
      return;
    }
    timer = setTimeout(
      () => finish(new Error("supervisor-ready-timeout")),
      timeout,
    );
    rejectIfExited();
  });
}

function assertPortAvailable(
  port,
  runDeadline = Number.POSITIVE_INFINITY,
  localCap = 1_000,
) {
  return new Promise((resolveAvailable, rejectUnavailable) => {
    let settled = false;
    const deadline = boundedDeadline(localCap, runDeadline);
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? rejectUnavailable(error) : resolveAvailable();
    };
    socket.once("connect", () =>
      finish(new Error("webdriver-port-already-in-use")),
    );
    socket.once("error", (error) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ECONNREFUSED"
      ) {
        finish();
      } else {
        finish(new Error("webdriver-port-probe-failed"));
      }
    });
    socket.setTimeout(Math.max(1, remainingBudget(deadline)), () =>
      finish(new Error("webdriver-port-probe-timeout")),
    );
  });
}

async function assertDriverPortsAvailable(
  runDeadline = Number.POSITIVE_INFINITY,
  probePort = assertPortAvailable,
) {
  const probes = await Promise.allSettled(
    [4444, Number(nativePort)].map((port) => probePort(port, runDeadline)),
  );
  if (probes.some(({ status }) => status !== "fulfilled"))
    throw new Error("webdriver-port-preflight-failed");
}

function ready(
  child,
  runDeadline = Number.POSITIVE_INFINITY,
  localCap = 20_000,
  port = 4444,
) {
  return new Promise((resolveReady, reject) => {
    const deadline = boundedDeadline(localCap, runDeadline);
    let settled = false;
    let retryTimer;
    let activeSocket;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (activeSocket) {
        activeSocket.destroy();
        activeSocket = undefined;
      }
      child.removeListener("exit", onChildExit);
      child.removeListener("error", onChildError);
      error ? reject(error) : resolveReady();
    };
    const failIfExited = () =>
      child.exitCode !== null || child.signalCode !== null;
    const onChildExit = () =>
      finish(new Error("tauri-driver-exited-before-ready"));
    const onChildError = () => finish(new Error("tauri-driver-spawn-failed"));
    child.once("exit", onChildExit);
    child.once("error", onChildError);
    const retry = () => {
      if (settled) return;
      if (failIfExited())
        return finish(new Error("tauri-driver-exited-before-ready"));
      if (Date.now() >= deadline)
        return finish(new Error("tauri-driver-did-not-become-ready"));
      const delay = boundedTimeout(200, deadline);
      if (delay <= 0)
        return finish(new Error("tauri-driver-did-not-become-ready"));
      retryTimer = setTimeout(attempt, delay);
    };
    const attempt = () => {
      if (settled) return;
      if (failIfExited())
        return finish(new Error("tauri-driver-exited-before-ready"));
      const socket = createConnection({ host: "127.0.0.1", port });
      activeSocket = socket;
      socket.once("connect", () => {
        socket.destroy();
        if (activeSocket === socket) activeSocket = undefined;
        if (failIfExited())
          finish(new Error("tauri-driver-exited-before-ready"));
        else finish();
      });
      socket.once("error", () => {
        socket.destroy();
        if (activeSocket === socket) activeSocket = undefined;
        retry();
      });
      const timeout = boundedTimeout(500, deadline);
      if (timeout <= 0) {
        socket.destroy();
        if (activeSocket === socket) activeSocket = undefined;
        finish(new Error("tauri-driver-did-not-become-ready"));
        return;
      }
      socket.setTimeout(timeout, () => {
        socket.destroy();
        if (activeSocket === socket) activeSocket = undefined;
        retry();
      });
    };
    attempt();
  });
}

async function waitForDriverPortsReady(
  child,
  runDeadline = Number.POSITIVE_INFINITY,
  { waitForPort, onProxyReady, onReady } = {},
) {
  const deadline = boundedDeadline(20_000, runDeadline);
  const wait =
    waitForPort ??
    ((port, sharedDeadline) => ready(child, sharedDeadline, 20_000, port));
  await wait(4444, deadline);
  if (typeof onProxyReady === "function") onProxyReady();
  await wait(Number(nativePort), deadline);
  return typeof onReady === "function" ? onReady() : undefined;
}

function classifyNativeDriverStatusResponse(response) {
  if (!Buffer.isBuffer(response)) return "malformed";
  const headerEnd = response.indexOf("\r\n\r\n");
  if (
    headerEnd < 0 ||
    headerEnd > NATIVE_DRIVER_STATUS_HEADER_LIMIT_BYTES
  )
    return "malformed";
  const header = response.subarray(0, headerEnd).toString("ascii");
  const [statusLine, ...headerLines] = header.split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] (\d{3}) [^\r\n]+$/.exec(statusLine);
  if (!statusMatch) return "malformed";
  let contentLength;
  for (const line of headerLines) {
    const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
    if (!match) continue;
    if (contentLength !== undefined) return "malformed";
    contentLength = Number(match[1]);
  }
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > NATIVE_DRIVER_STATUS_BODY_LIMIT_BYTES
  )
    return "malformed";
  const body = response.subarray(headerEnd + 4);
  if (body.length !== contentLength) return "malformed";
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return "malformed";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return "malformed";
  if (
    !parsed.value ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value) ||
    typeof parsed.value.ready !== "boolean"
  )
    return "malformed";
  return Number(statusMatch[1]) >= 200 && Number(statusMatch[1]) < 300 &&
    parsed.value.ready
    ? "ready"
    : "notReady";
}

function nativeDriverStatusResponseLength(response) {
  if (!Buffer.isBuffer(response)) return -1;
  const headerEnd = response.indexOf("\r\n\r\n");
  if (headerEnd < 0)
    return response.length > NATIVE_DRIVER_STATUS_HEADER_LIMIT_BYTES
      ? -1
      : undefined;
  if (headerEnd > NATIVE_DRIVER_STATUS_HEADER_LIMIT_BYTES) return -1;
  const header = response.subarray(0, headerEnd).toString("ascii");
  const [statusLine, ...headerLines] = header.split("\r\n");
  if (!/^HTTP\/1\.[01] (\d{3}) [^\r\n]+$/.test(statusLine)) return -1;
  let contentLength;
  for (const line of headerLines) {
    const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
    if (!match) continue;
    if (contentLength !== undefined) return -1;
    contentLength = Number(match[1]);
  }
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > NATIVE_DRIVER_STATUS_BODY_LIMIT_BYTES
  )
    return -1;
  return headerEnd + 4 + contentLength;
}

function probeNativeDriverStatus(
  runDeadline = Number.POSITIVE_INFINITY,
  { port = Number(nativePort), connect = createConnection } = {},
) {
  return new Promise((resolveStatus) => {
    const deadline = boundedDeadline(NATIVE_DRIVER_STATUS_TIMEOUT_MS, runDeadline);
    const timeout = remainingBudget(deadline);
    if (timeout <= 0) return resolveStatus("transportFailed");
    let settled = false;
    let timer;
    let socket;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket?.destroy();
      resolveStatus(status);
    };
    try {
      socket = connect({ host: "127.0.0.1", port });
    } catch {
      finish("transportFailed");
      return;
    }
    let response = Buffer.alloc(0);
    socket.once("connect", () => {
      try {
        socket.write(
          "GET /status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
      } catch {
        finish("transportFailed");
      }
    });
    socket.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      response = Buffer.concat([response, bytes]);
      const expectedLength = nativeDriverStatusResponseLength(response);
      if (expectedLength === -1 || response.length > expectedLength)
        return finish("malformed");
      if (response.length === expectedLength)
        finish(classifyNativeDriverStatusResponse(response));
    });
    socket.once("end", () => finish(classifyNativeDriverStatusResponse(response)));
    socket.once("error", () => finish("transportFailed"));
    socket.setTimeout(timeout, () => finish("transportFailed"));
    timer = setTimeout(() => finish("transportFailed"), timeout);
  });
}

function projectOwnedAppObservation(
  owner,
  processTable,
  readTable = readProcessTable,
) {
  if (!owner?.app) return "appNotObserved";
  let observed = processTable;
  if (observed === undefined) {
    try {
      observed = readTable();
    } catch {
      return "processTableUnavailable";
    }
  }
  if (!Array.isArray(observed)) return "processTableUnavailable";
  const current = processIdentityAtPid(observed, owner.app.pid);
  if (!current) return "appObservedExited";
  return sameProcessIdentity(current, owner.app)
    ? "appObservedAlive"
    : "appIdentityMismatch";
}

async function stopOwnedTree(identity) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0)
    return false;
  const observed = readProcessTable();
  if (!observed) return false;
  const disposition = processIdentityDisposition(observed, identity);
  if (disposition === "gone") return true;
  if (disposition !== "owned") return false;
  const killed = runTaskkill(identity.pid);
  if (!isSuccessfulSpawnResult(killed)) return false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readProcessTable();
    if (!current) return false;
    const currentIdentity = processIdentityAtPid(current, identity.pid);
    if (!currentIdentity) return true;
    if (!sameProcessIdentity(currentIdentity, identity)) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

function abandonUnverifiedChild(child) {
  if (!child) return;
  child.removeAllListeners("error");
  child.removeAllListeners("exit");
  child.unref?.();
}

function waitForChildExit(
  child,
  timeoutMs,
  runDeadline = Number.POSITIVE_INFINITY,
) {
  if (!child) return Promise.resolve({ code: 1, timedOut: false });
  const localCap = Number.isFinite(timeoutMs)
    ? Math.max(1, timeoutMs)
    : WDIO_HARD_DEADLINE_MS;
  const deadline = boundedDeadline(localCap, runDeadline);
  const timeout = remainingBudget(deadline);
  if (timeout <= 0) return Promise.resolve({ code: 1, timedOut: true });
  return new Promise((resolveExit) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolveExit(result);
    };
    const onError = () => finish({ code: 1, timedOut: false });
    const onExit = (code) =>
      finish({ code: typeof code === "number" ? code : 1, timedOut: false });
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({
        code: typeof child.exitCode === "number" ? child.exitCode : 1,
        timedOut: false,
      });
      return;
    }
    timer = setTimeout(() => finish({ code: 1, timedOut: true }), timeout);
  });
}

function strictRunChild(runDir) {
  const lexicalRoot = resolve(runsRoot);
  const lexicalTarget = resolve(runDir);
  const lexicalRelative = relative(lexicalRoot, lexicalTarget);
  if (
    !lexicalRelative ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative) ||
    lexicalRelative.includes(sep)
  ) {
    throw new Error("refusing to remove non-run directory");
  }
  if (!existsSync(lexicalTarget)) return undefined;
  const targetStat = lstatSync(lexicalTarget);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory())
    throw new Error("refusing to remove non-directory run target");
  const canonicalRoot = realpathSync.native(lexicalRoot);
  const canonicalTarget = realpathSync.native(lexicalTarget);
  const canonicalRelative = relative(canonicalRoot, canonicalTarget);
  if (
    !canonicalRelative ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative) ||
    canonicalRelative.includes(sep)
  ) {
    throw new Error("refusing to remove outside run root");
  }
  return lexicalTarget;
}

async function cleanupRunDirectory(runDir) {
  const attempts = 8;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const target = strictRunChild(runDir);
    if (!target) return;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      lastError = error;
    }
    if (!existsSync(target)) return;
    await new Promise((done) => setTimeout(done, 150));
  }
  const code =
    lastError && typeof lastError === "object" && "code" in lastError
      ? lastError.code
      : "unknown";
  throw new Error(`terminal-startup-run-cleanup-failed:${code}`);
}

function childHasExited(child) {
  return child?.exitCode !== null || child?.signalCode !== null;
}

async function stopSupervisorJob(supervisor, runDeadline) {
  if (!supervisor) return true;
  let stopRequested = false;
  let exited = childHasExited(supervisor);
  const hardDeadline = Number.isFinite(runDeadline) ? runDeadline : Date.now();
  const forceReserve = Math.min(
    SUPERVISOR_CLEANUP_FORCE_RESERVE_MS,
    remainingBudget(hardDeadline),
  );
  const graceDeadline = Math.min(
    hardDeadline - forceReserve,
    Date.now() + SUPERVISOR_CLEANUP_GRACE_CAP_MS,
  );
  try {
    if (!exited) {
      if (supervisor.stdin && !supervisor.stdin.destroyed) {
        supervisor.stdin.end("STOP\n");
        stopRequested = true;
      }
      if (!stopRequested && childHasExited(supervisor)) stopRequested = true;
    } else {
      stopRequested = true;
    }
    if (!exited) {
      await waitForChildExit(
        supervisor,
        remainingBudget(graceDeadline),
        graceDeadline,
      );
      exited = childHasExited(supervisor);
    }
    if (!exited) {
      try {
        supervisor.kill?.();
      } catch {
        // The hard wait below still provides the bounded final observation.
      }
      await waitForChildExit(
        supervisor,
        remainingBudget(hardDeadline),
        hardDeadline,
      );
      exited = childHasExited(supervisor);
    }
  } catch {
    try {
      supervisor.kill?.();
    } catch {
      // Cleanup must still close pipes and detach observers below.
    }
    try {
      await waitForChildExit(
        supervisor,
        remainingBudget(hardDeadline),
        hardDeadline,
      );
    } catch {
      // The hard deadline result remains a failed cleanup.
    }
    exited = childHasExited(supervisor);
  } finally {
    detachSupervisorMonitor(supervisor);
    try {
      supervisor.stdin?.destroy?.();
    } catch {
      // Best-effort pipe closure.
    }
    try {
      supervisor.stdout?.destroy?.();
    } catch {
      // Best-effort pipe closure.
    }
    if (!exited) supervisor.unref?.();
  }
  return stopRequested && exited;
}

async function runOne(
  index,
  providerShellAvailability,
  providerShellReceipts,
  encodingToolReceipts,
  selectedBinary,
  expectedOfflineCsp,
) {
  const layout = createRunLayout(index);
  const reportPath = matrixReportPath ?? join(reports, `${layout.runName}.jsonl`);
  let evidenceAppendFailed = false;
  const recordRunner = (runnerStage, outcome) => {
    const appended = appendRunnerEvidence(reportPath, runnerStage, outcome);
    if (!appended) evidenceAppendFailed = true;
    return appended;
  };
  const runStartedAt = Date.now();
  const runDeadline = runStartedAt + RUN_TOTAL_BUDGET_MS;
  const workDeadline = runStartedAt + WORK_PHASE_BUDGET_MS;
  let env;
  let tauriSupervisor;
  let wdioSupervisor;
  let ownedThreadTermIdentity;
  let ownedSupervisorIdentity;
  let appLaunchBoundaryCrossed = false;
  let specPassed = false;
  let isolationWdioStarted = false;
  let lifecycleEvidencePassed = true;
  const isolationRequirements = runtimeIsolationRequirements(artifact, flow);
  let runtimeIsolationPassed = !isolationRequirements.observeHarnessIsolation;
  let workPassed = false;
  let driverCleanupPassed = false;
  let wdioCleanupPassed = false;
  let sandboxCleanupPassed = false;
  let cleanupEvidencePassed = false;
  let exitCode = 1;
  let failureEvidenceRecorded = false;
  let isolationGateOutcome = "none";
  let appObservationRecorded = false;
  const recordAppObservation = () => {
    if (appObservationRecorded) return true;
    appObservationRecorded = true;
    const appended = appendAppObservationDiagnostic(
      reportPath,
      projectOwnedAppObservation(ownedThreadTermIdentity),
    );
    if (!appended) evidenceAppendFailed = true;
    return appended;
  };
  const previousProcessObservationEnvironmentSource =
    processObservationEnvironmentSource;
  let stage = "preflight";
  try {
    env = buildRunEnv(
      layout,
      providerShellAvailability,
      process.env,
      expectedOfflineCsp,
      providerShellReceipts,
      encodingToolReceipts,
    );
    processObservationEnvironmentSource = env;
    setRunnerEnvironmentValue(env, "THREADTERM_WDIO_REPORT", reportPath);
    await assertDriverPortsAvailable(workDeadline);
    const canonicalTauriDriver = canonicalExistingFile(tauriDriver);
    const canonicalNode = canonicalExistingFile(process.execPath);
    if (!canonicalTauriDriver || !canonicalNode)
      throw new Error("supervisor-target-missing");
    stage = "driverIdentity";
    tauriSupervisor = spawnSupervisor(
      canonicalTauriDriver,
      [
        "--port",
        "4444",
        "--native-port",
        nativePort,
        "--native-driver",
        driver,
      ],
      env,
    );
    stage = "driverHandshake";
    await waitForSupervisorReady(tauriSupervisor, workDeadline);
    stage = "driverSupervisorIdentity";
    const observationPowerShell = resolveObservationPowerShellExecutable(env);
    if (!observationPowerShell)
      throw new Error("supervisor-observation-executable-missing");
    ownedSupervisorIdentity = await captureDirectProcessIdentity(
      tauriSupervisor,
      observationPowerShell,
      workDeadline,
    );
    stage = "driverPort";
    await waitForDriverPortsReady(tauriSupervisor, workDeadline, {
      onProxyReady: () => {
        stage = "driverReady";
      },
    });
    if (
      tauriSupervisor.exitCode !== null ||
      tauriSupervisor.signalCode !== null
    )
      throw new Error("tauri-driver-exited-before-wdio");
    stage = "driverStatus";
    const nativeDriverStatus = await probeNativeDriverStatus(workDeadline);
    if (
      shouldAppendNativeDriverStatusDiagnostic(flow) &&
      !appendNativeDriverStatusDiagnostic(reportPath, nativeDriverStatus)
    )
      throw new Error("native-driver-status-evidence-append-failed");
    if (!nativeDriverStatusAllowsWdio(nativeDriverStatus))
      throw new Error("native-driver-status-not-ready");
    stage = "wdioIdentity";
    // From this point WDIO may request a WebDriver session, which may launch
    // the application. Cleanup must then retain an owned process identity.
    appLaunchBoundaryCrossed = true;
    wdioSupervisor = spawnSupervisor(
      canonicalNode,
      [
        join(root, "node_modules", "@wdio", "cli", "bin", "wdio.js"),
        "run",
        "e2e/terminal-startup/wdio.conf.ts",
      ],
      env,
    );
    await waitForSupervisorReady(wdioSupervisor, workDeadline);
    isolationWdioStarted = flow === "isolation";
    stage = "appIdentity";
    const driverEligibilityDeadline = boundedDeadline(
      ISOLATION_DRIVER_UDF_WAIT_CAP_MS,
      workDeadline,
    );
    const ownedIdentityPromise = captureOwnedThreadTermIdentity(
      tauriSupervisor,
      selectedBinary,
      ownedSupervisorIdentity,
      driverEligibilityDeadline,
    ).then(
      (identity) => identity,
      () => undefined,
    );
    try {
      let driverEligibility = "eligible";
      if (flow === "isolation") {
        stage = "driverUdf";
        driverEligibility = await waitForIsolationDriverUdfEvidence(
          wdioSupervisor,
          reportPath,
          driverEligibilityDeadline,
        );
        if (driverEligibility !== "eligible") {
          // Identity capture ran concurrently and may already have succeeded;
          // preserve it so cleanup can still prove the owned app tree is gone.
          ownedThreadTermIdentity = retainOwnedThreadTermIdentity(
            ownedThreadTermIdentity,
            await ownedIdentityPromise,
          );
          runtimeIsolationPassed = false;
          const report = (() => {
            try {
              return readFileSync(reportPath, "utf8");
            } catch {
              return "";
            }
          })();
          const incompleteWorkerEvidence =
            isolationIncompleteWorkerFailureEvidence(report);
          const timeoutStage =
            driverEligibility === "timeout"
              ? isolationTimeoutStage(report)
              : "driverUdf";
          const evidence =
            incompleteWorkerEvidence ??
            isolationWaitEvidence(timeoutStage, driverEligibility);
          if (evidence)
            failureEvidenceRecorded = recordRunner(
              evidence.runnerStage,
              evidence.outcome,
            );
          isolationGateOutcome = "driver";
          recordAppObservation();
          throw new Error("driver-udf-evidence-unconfirmed");
        }
      }
      stage = "appIdentity";
      // This promise started alongside driver eligibility. Retain its result
      // for cleanup even if runtime attestation or observation fails later.
      ownedThreadTermIdentity = retainOwnedThreadTermIdentity(
        ownedThreadTermIdentity,
        await ownedIdentityPromise,
      );
      if (!ownedThreadTermIdentity) throw new Error("threadterm-process-not-observed");
      if (isolationRequirements.observeHarnessIsolation) {
        let runtimeAttestation = "confirmed";
        if (isolationRequirements.requireRuntimeUdfAttestation) {
          stage = "runtimeUdf";
          runtimeAttestation = await waitForIsolationRuntimeUdfEvidence(
            wdioSupervisor,
            reportPath,
            boundedDeadline(ISOLATION_RUNTIME_UDF_WAIT_CAP_MS, workDeadline),
          );
          if (runtimeAttestation !== "confirmed") {
            runtimeIsolationPassed = false;
            const report = (() => {
              try {
                return readFileSync(reportPath, "utf8");
              } catch {
                return "";
              }
            })();
            const evidence =
              isolationIncompleteWorkerFailureEvidence(report) ??
              isolationWaitEvidence("runtimeUdf", runtimeAttestation);
            if (evidence)
              failureEvidenceRecorded = recordRunner(
                evidence.runnerStage,
                evidence.outcome,
              );
            isolationGateOutcome = "runtime";
            recordAppObservation();
            throw new Error("runtime-udf-evidence-unconfirmed");
          }
        }
        if (
          !shouldObserveRuntimeIsolation(
            driverEligibility,
            runtimeAttestation,
            ownedThreadTermIdentity.app,
          )
        )
          throw new Error("runtime-isolation-observation-not-authorized");
        const isolation = await observeOfflineWebViewIsolation(
          ownedThreadTermIdentity.app,
          { deadline: boundedDeadline(20_000, workDeadline) },
        );
        const markerPublished =
          shouldPublishRuntimeIsolationMarker(runtimeAttestation, isolation) &&
          publishRuntimeIsolationMarker(layout);
        runtimeIsolationPassed = markerPublished;
        if (flow === "isolation") {
          if (
            !appendRuntimeIsolationDiagnostic(
              reportPath,
              isolation.status,
              markerPublished,
            )
          ) {
            evidenceAppendFailed = true;
            runtimeIsolationPassed = false;
          }
        }
      }
    } catch {
      if (stage === "appIdentity") recordRunner("appIdentity", "failed");
      runtimeIsolationPassed = false;
    }
    if (!shouldWaitForIsolationWdioSession(isolationGateOutcome)) {
      lifecycleEvidencePassed = false;
    } else {
      stage = isolationWdioStarted ? "wdioSession" : "wdio";
      const sessionDeadline = wdioSessionDeadline(flow, workDeadline);
      const wdioOutcome = isolationWdioStarted
        ? await waitForIsolationWdioOutcome(
            wdioSupervisor,
            reportPath,
            sessionDeadline,
          )
        : {
            result: await waitForChildExit(
              wdioSupervisor,
              boundedTimeout(WDIO_HARD_DEADLINE_MS, sessionDeadline),
              sessionDeadline,
            ),
            stopped: false,
          };
      const wdioResult = wdioOutcome.result;
      const isolationEvidence = isolationWdioStarted
        ? readIsolationLifecycleEvidence(reportPath)
        : "natural";
      lifecycleEvidencePassed =
        !isolationWdioStarted ||
        (wdioOutcome.stopped
          ? isolationEvidence === "stopped"
          : isolationEvidence === "natural");
      if (
        isolationWdioStarted &&
        readIsolationLifecycleSnapshot(reportPath).terminal
      )
        recordAppObservation();
      if (wdioResult.timedOut) {
        recordRunner(stage, "timeout");
      } else if (wdioResult.code !== 0 && !wdioOutcome.stopped) {
        recordRunner(stage, "failed");
      } else if (lifecycleEvidencePassed) {
        specPassed = true;
      }
    }
    workPassed =
      specPassed &&
      lifecycleEvidencePassed &&
      ownedThreadTermIdentity !== undefined &&
      runtimeIsolationPassed &&
      supervisorOutputIsValid(tauriSupervisor) &&
      supervisorOutputIsValid(wdioSupervisor) &&
      !isDeadlineExpired(Date.now(), workDeadline);
  } catch {
    if (!failureEvidenceRecorded) recordRunner(stage, "failed");
  } finally {
    stage = "cleanup";
    const supervisorProtocolPassed =
      supervisorOutputIsValid(tauriSupervisor) &&
      supervisorOutputIsValid(wdioSupervisor);
    const cleanupResults = await Promise.all([
      stopSupervisorJob(tauriSupervisor, runDeadline).catch(() => false),
      stopSupervisorJob(wdioSupervisor, runDeadline).catch(() => false),
    ]);
    [driverCleanupPassed, wdioCleanupPassed] = cleanupResults;
    if (!driverCleanupPassed || !wdioCleanupPassed)
      recordRunner("cleanup", "cleanupFailed");
    try {
      await cleanupRunDirectory(layout.runDir);
      sandboxCleanupPassed = true;
    } catch {
      recordRunner("cleanup", "cleanupFailed");
    }
    const appTree = !appLaunchBoundaryCrossed
      ? "notRequested"
      : ownedThreadTermIdentity?.app &&
          (await waitForOwnedProcessTreeGone(
            ownedThreadTermIdentity.app,
            runDeadline,
          ))
        ? "gone"
        : undefined;
    const appTreePassed = appTree !== undefined;
    const [tauriDriverPortRefused, nativeDriverPortRefused] =
      await Promise.all([
        observePortRefused(4444, runDeadline),
        observePortRefused(Number(nativePort), runDeadline),
      ]);
    const cleanupProofPassed =
      driverCleanupPassed &&
      wdioCleanupPassed &&
      appTreePassed &&
      tauriDriverPortRefused &&
      nativeDriverPortRefused &&
      sandboxCleanupPassed;
    if (cleanupProofPassed) {
      cleanupEvidencePassed = appendRunnerCleanupEvidence(reportPath, appTree);
      if (!cleanupEvidencePassed) evidenceAppendFailed = true;
    }
    const terminalSuccess =
      workPassed &&
      lifecycleEvidencePassed &&
      supervisorProtocolPassed &&
      driverCleanupPassed &&
      wdioCleanupPassed &&
      sandboxCleanupPassed &&
      appTree === "gone" &&
      cleanupEvidencePassed &&
      !evidenceAppendFailed;
    const cleanupPassed =
      driverCleanupPassed && wdioCleanupPassed && sandboxCleanupPassed;
    const terminalOutcome = terminalSuccess
      ? "success"
      : cleanupPassed && cleanupEvidencePassed
        ? "failed"
        : "cleanupFailed";
    if (!recordRunner("complete", terminalOutcome)) exitCode = 1;
    else exitCode = terminalSuccess ? 0 : 1;
    processObservationEnvironmentSource = previousProcessObservationEnvironmentSource;
  }
  return exitCode;
}

function validateRunnerConfiguration() {
  assertHarnessOfflineInput(process.env, artifact);
  if (process.platform !== "win32")
    throw new Error("Windows WebDriver gate requires Windows");
  if (!Object.prototype.hasOwnProperty.call(flowSpecs, flow))
    throw new Error("unsupported terminal-startup flow");
  if (productionFlows.has(flow)) {
    if (artifact !== "production")
      throw new Error("production-flow-requires-shipping-artifact");
    if (resolve(app) !== resolve(shippingBinary))
      throw new Error("production-flow-requires-shipping-binary");
  } else {
    if (!harnessFlows.has(flow) || artifact !== "harness")
      throw new Error(
        "terminal-startup-harness-flow-requires-harness-artifact",
      );
    if (resolve(app) !== resolve(harnessBinary))
      throw new Error("terminal-startup-harness-flow-requires-harness-binary");
  }
  if (flow === "warmup") {
    if (
      !warmupCase ||
      !Object.prototype.hasOwnProperty.call(warmupScenarios, warmupCase)
    )
      throw new Error("warmup-case-invalid");
  }
  if (
    flow === "encoding" &&
    encodingCase !== "enabled" &&
    encodingCase !== "disabled"
  ) {
    throw new Error("encoding-case-invalid");
  }
  if (
    flow === "provider" &&
    concurrency !== undefined &&
    !["1", "5", "20"].includes(concurrency)
  ) {
    throw new Error("provider-concurrency-invalid");
  }
  if (flow === "provider" && providerRepeats !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(providerRepeats))
    throw new Error("provider-repeats-invalid");
  if (flow === "provider" && providerShell !== undefined && !["pwsh", "windowsPowerShell", "cmd"].includes(providerShell))
    throw new Error("provider-shell-invalid");
  if (matrixReportPath !== undefined) validateMatrixReportPath(matrixReportPath);
  if (readEnv(process.env, "THREADTERM_WDIO_ATTACH")?.trim())
    throw new Error("attach-mode-disabled-for-isolated-runner");
}

function validateMatrixReportPath(candidate, rawReportsRoot = matrixRawReports) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || !candidate.endsWith(".jsonl"))
    throw new Error("matrix-report-path-invalid");
  mkdirSync(rawReportsRoot, { recursive: true });
  const rootStat = lstatSync(rawReportsRoot);
  if (!isMatrixRawReportsDirectory(rootStat)) throw new Error("matrix-report-path-invalid");
  const canonicalRoot = realpathSync.native(rawReportsRoot);
  const resolved = resolve(candidate);
  const contained = relative(canonicalRoot, resolved);
  if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained) || contained.includes(sep))
    throw new Error("matrix-report-path-invalid");
  if (existsSync(resolved)) throw new Error("matrix-report-path-stale");
  return resolved;
}

function isMatrixRawReportsDirectory(stat) {
  return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory());
}

async function main() {
  const productionId =
    artifact === "production"
      ? parseProductionIdentifierConfig(readFileSync(baseTauriConfig, "utf8"))
      : undefined;
  return runAfterProductionPreflight(
    artifact,
    () => observeProductionDisposableProfile(),
    () => observeProductionSingleInstanceWindow(productionId),
    async () => {
      validateRunnerConfiguration();
      if (!existsSync(driver))
        throw new Error(
          "missing cached msedgedriver; run the documented official bootstrap once",
        );
      if (!existsSync(tauriDriver))
        throw new Error(
          "missing tauri-driver; install with cargo install tauri-driver",
        );
      if (!existsSync(app))
        throw new Error(
          `missing ${artifact} binary for terminal-startup runner`,
        );
      mkdirSync(runsRoot, { recursive: true });
      const runsRootStat = lstatSync(runsRoot);
      if (runsRootStat.isSymbolicLink() || !runsRootStat.isDirectory())
        throw new Error("invalid terminal-startup runs root");
      mkdirSync(reports, { recursive: true });
      const selectedBinary = realpathSync.native(app);
      let expectedOfflineCsp;
      if (artifact === "harness") {
        const baseConfigText = readFileSync(baseTauriConfig, "utf8");
        const harnessConfigText = readFileSync(harnessCspConfig, "utf8");
        const identifiers = parseHarnessIdentifiersConfig(
          baseConfigText,
          harnessConfigText,
        );
        expectedOfflineCsp = parseHarnessCspConfig(harnessConfigText);
        const selectedBinaryBuffer = readFileSync(selectedBinary);
        attestHarnessBinaryCsp(selectedBinaryBuffer, expectedOfflineCsp);
        attestHarnessBinaryIdentity(
          selectedBinaryBuffer,
          identifiers.harnessId,
        );
      }
      const discoveryPlan = shellDiscoveryPlan();
      const providerShellReceipts = discoverCanonicalShellReceipts(
        process.env,
        discoveryPlan,
      );
      const encodingToolReceipts = discoverCanonicalEncodingToolReceipts(
        process.env,
        discoveryPlan,
      );
      const providerShellAvailability = discoverProviderShellAvailability(
        flow,
        providerShellReceipts,
      );
      for (let index = 0; index < coldRepeats; index += 1) {
        const code = await runOne(
          index,
          providerShellAvailability,
          providerShellReceipts,
          encodingToolReceipts,
          selectedBinary,
          expectedOfflineCsp,
        );
        if (code !== 0) {
          process.exitCode = code;
          break;
        }
      }
    },
  );
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedScript === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message =
      error && error.message === "production-disposable-profile-required"
        ? error.message
        : "terminal-startup-runner-failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export {
  assertDriverPortsAvailable,
  assertHarnessOfflineInput,
  appendAppObservationDiagnostic,
  appendNativeDriverStatusDiagnostic,
  appendRuntimeIsolationDiagnostic,
  assertChildEnvironmentClosedSet,
  assertOfflineChildEnvironment,
  attestHarnessBinaryCsp,
  attestHarnessBinaryIdentity,
  boundedDeadline,
  boundedTimeout,
  buildRunEnv,
  buildProcessObservationEnvironment,
  canTerminateProcessIdentity,
  childHasExited,
  classifySupervisorReadyBuffer,
  classifyProductionSingleInstanceObservation,
  comparableWindowsPath,
  createRunnerEvidence,
  canonicalEncodingToolReceipts,
  discoverCanonicalEncodingToolReceipts,
  canonicalExistingWindowsExecutable,
  canonicalPwshExecutable,
  isSafeLocalExecutableReceipt,
  resolveSafeLocalPathExecutable,
  safeLocalPathDirectories,
  discoverCanonicalShellReceipts,
  shellDiscoveryPlan,
  discoverProviderShellAvailability,
  emptyProviderShellAvailability,
  evaluateOfflineWebViewIsolation,
  filterInheritedEnvironment,
  flowRequiresShellAvailability,
  hasExpectedAncestry,
  hasContainedRuntimeIsolationMarker,
  classifyIsolationDriverUdfEvidence,
  classifyIsolationDriverEligibility,
  classifyIsolationLifecycleEvents,
  classifyIsolationLifecycleEvidence,
  classifyIsolationRuntimeUdfAttestation,
  classifyPortProbeError,
  classifyNativeDriverStatusResponse,
  classifyProductionDisposableProfileObservation,
  countChromiumSwitch,
  driverUdfRuntimeIsolationStatus,
  hasChromiumTypeSwitch,
  isDeadlineExpired,
  isOwnedProcessTreeGone,
  isSuccessfulSpawnResult,
  nativeDriverStatusAllowsWdio,
  isolationWaitEvidence,
  isolationIncompleteWorkerFailureEvidence,
  isolationTimeoutStage,
  stripIsolationWdioStageDiagnostics,
  shouldAppendNativeDriverStatusDiagnostic,
  shouldWaitForIsolationWdioSession,
  wdioSessionDeadline,
  observePortRefused,
  observeProductionDisposableProfile,
  appendRunnerCleanupEvidence,
  readIsolationLifecycleEvidence,
  readIsolationLifecycleSnapshot,
  reduceIsolationLifecycleSnapshot,
  reduceIsolationWdioPollDecision,
  retainOwnedThreadTermIdentity,
  runtimeIsolationRequirements,
  normalizeCommandLineTable,
  normalizeProcessNameTable,
  normalizeProcessTable,
  normalizeSupervisorEnvironment,
  publishRuntimeIsolationMarker,
  shouldObserveRuntimeIsolation,
  shouldPublishRuntimeIsolationMarker,
  encodeSupervisorLaunchSpec,
  parseHarnessCspConfig,
  parseHarnessIdentifiersConfig,
  parseProductionIdentifierConfig,
  probeNativeDriverStatus,
  projectOwnedAppObservation,
  processIdentityDisposition,
  resolveObservationPowerShellExecutable,
  runAfterProductionSingleInstancePreflight,
  runAfterProductionPreflight,
  sameProcessIdentity,
  selectDescendantProcessRecords,
  selectOwnedProcessIdentity,
  stopSupervisorJob,
  waitForOwnedProcessTreeGone,
  waitForIsolationDriverUdfEvidence,
  waitForIsolationRuntimeUdfEvidence,
  waitForIsolationWdioOutcome,
  waitForDriverPortsReady,
  waitForSupervisorReady,
  waitForChildExit,
  validateMatrixReportPath,
  isMatrixRawReportsDirectory,
};
