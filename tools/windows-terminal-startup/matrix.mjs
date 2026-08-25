import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createConnection } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalEncodingToolReceipts,
  classifyIsolationLifecycleEvidence,
} from "./run.mjs";

const root = resolve(import.meta.dirname, "../..");
// The automatic plan no longer runs the unsafe production float case; keep a
// separate resumable state namespace so an old float-containing plan cannot be
// mistaken for this surface-lifecycle plan.
const toolCacheRoot = join(root, ".cache", "windows-terminal-startup");
const cacheRoot = join(toolCacheRoot, "matrix-v2");
const statePath = join(cacheRoot, "state.json");
const reportsRoot = join(cacheRoot, "raw");
const shippingBinaryPath = join(
  root,
  ".cache", "windows-terminal-startup",
  "target",
  "release",
  "threadterm.exe",
);
const harnessBinaryPath = join(
  root,
  ".cache", "windows-terminal-startup",
  "harness-target",
  "release",
  "threadterm.exe",
);
const RUNNER_CONFIG_PATHS = Object.freeze([
  join(root, "tools", "windows-terminal-startup", "run.mjs"),
  join(root, "tools", "windows-terminal-startup", "matrix.mjs"),
  join(root, "e2e", "terminal-startup", "wdio.conf.ts"),
  join(root, "tools", "windows-terminal-startup", "job-supervisor.ps1"),
  join(root, "src-tauri", "tauri.conf.json"),
  join(root, "src-tauri", "tauri.webdriver.conf.json"),
  join(root, "package.json"),
  join(root, "package-lock.json"),
]);
export const DEFAULT_BINDING_ARTIFACT_PATHS = Object.freeze({
  productionBinary: shippingBinaryPath,
  harnessBinary: harnessBinaryPath,
  edgeDriver: join(toolCacheRoot, "msedgedriver.exe"),
});
const finalJsonPath = join(
  root,
  "e2e",
  "terminal-startup",
  "reports",
  "windows-startup-matrix.json",
);
const finalMarkdownPath = join(
  root,
  "e2e",
  "terminal-startup",
  "reports",
  "windows-startup-matrix.md",
);
const DEADLINE_MS = 300_000;
const CLEANUP_MS = 30_000;
const TERMINAL = new Set(["passed", "failed", "timeout", "unavailable"]);
const FAILURES = new Set([
  "runnerFailed",
  "deadlineExceeded",
  "evidenceInvalid",
  "cleanupFailed",
  "unavailable",
]);
export const SHIPPING_HARNESS_COMMAND_COUNT = 8;
export const DEFAULT_FLAGS_PLAN = Object.freeze({
  da1Authority: "off",
  providerShellReady: "off",
  powershellUtf8: "off",
  conptyWarmup: "off",
});
const BINDING_KEYS = [
  "artifactMode",
  "releaseMode",
  "osFamily",
  "osBuild",
  "webview2Version",
  "tauriDriverVersion",
  "tauriDriverDigest",
  "edgeDriverVersion",
  "edgeDriverDigest",
  "nodeVersion",
  "gitHead",
  "gitDirty",
  "gitDirtyDigest",
  "productionBinaryDigest",
  "harnessBinaryDigest",
  "runnerConfigDigest",
  "flagsPlanDigest",
  "bindingId",
];
const CORRECTNESS_KEYS = [
  "blank",
  "unwritable",
  "duplicate",
  "lostDa1",
  "orphan",
];
const EXCLUDED_KEYS = ["shellUnavailable", "toolUnavailable"];
const CLEANUP_KEYS = [
  "appTree",
  "driverSupervisor",
  "nativeDriverPort",
  "runnerCleanup",
  "sandbox",
  "tauriDriverPort",
  "wdioSupervisor",
];
const CLEANUP_ROW = Object.freeze({
  runnerCleanup: "verified",
  driverSupervisor: "exited",
  wdioSupervisor: "exited",
  appTree: "gone",
  tauriDriverPort: "refused",
  nativeDriverPort: "refused",
  sandbox: "removed",
});
const MATRIX_GROUPS = new Set([
  "cold",
  "concurrency",
  "da1",
  "encoding",
  "isolation",
  "listener",
  "productionSmoke",
  "sameId",
  "surface",
  "warm",
  "warmup",
]);

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const isVersion = (value) =>
  typeof value === "string" && /^\d+(?:\.\d+)+$/.test(value);
const isDigest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isGitHead = (value) =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

const validCorrectness = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === CORRECTNESS_KEYS.slice().sort().join(",") &&
  Object.values(value).every(
    (count) => Number.isSafeInteger(count) && count >= 0,
  );

const zeroCorrectness = () =>
  Object.fromEntries(CORRECTNESS_KEYS.map((key) => [key, 0]));

const validBinding = (binding) => {
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join(",") !== BINDING_KEYS.slice().sort().join(",")
  )
    return false;
  if (
    binding.artifactMode !== "productionAndHarness" ||
    binding.releaseMode !== "release" ||
    binding.osFamily !== "windows" ||
    !isVersion(binding.osBuild) ||
    !isVersion(binding.webview2Version) ||
    !isVersion(binding.tauriDriverVersion) ||
    !isDigest(binding.tauriDriverDigest) ||
    !isVersion(binding.edgeDriverVersion) ||
    !isDigest(binding.edgeDriverDigest) ||
    !isVersion(binding.nodeVersion) ||
    !isGitHead(binding.gitHead) ||
    typeof binding.gitDirty !== "boolean" ||
    !isDigest(binding.gitDirtyDigest) ||
    !isDigest(binding.productionBinaryDigest) ||
    !isDigest(binding.harnessBinaryDigest) ||
    !isDigest(binding.runnerConfigDigest) ||
    !isDigest(binding.flagsPlanDigest) ||
    !isDigest(binding.bindingId)
  )
    return false;
  const withoutId = { ...binding };
  delete withoutId.bindingId;
  return binding.bindingId === sha256(canonicalJson(withoutId));
};

export const isValidReleaseBinding = (binding) => validBinding(binding);

export function createReleaseBinding(fields) {
  const binding = {
    artifactMode: "productionAndHarness",
    releaseMode: "release",
    osFamily: "windows",
    ...fields,
  };
  delete binding.bindingId;
  binding.bindingId = sha256(canonicalJson(binding));
  if (!validBinding(binding)) throw new Error("matrix-binding-unavailable");
  return binding;
}

const BINDING_COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_PATH_KEYS = [
  "cmd",
  "edgeDriver",
  "git",
  "node",
  "reg",
  "tauriDriver",
];

function rejectUnsafePath(pathValue) {
  if (
    typeof pathValue !== "string" ||
    !isAbsolute(pathValue) ||
    /^(?:\\\\|\\\\\?\\|\\\\\.\\)/.test(pathValue) ||
    /(?:^|[\\/])windowsapps(?:[\\/]|$)/i.test(pathValue) ||
    pathValue.includes("/")
  )
    throw new Error("matrix-binding-unavailable");
}

function trustedLocalFile(pathValue, basename) {
  rejectUnsafePath(pathValue);
  let original;
  let canonical;
  try {
    original = lstatSync(pathValue);
    if (!original.isFile() || original.isSymbolicLink())
      throw new Error("unsafe");
    canonical = realpathSync.native(pathValue);
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
  } catch {
    throw new Error("matrix-binding-unavailable");
  }
  rejectUnsafePath(canonical);
  if (
    basename &&
    canonical.slice(canonical.lastIndexOf("\\") + 1).toLowerCase() !==
      basename.toLowerCase()
  )
    throw new Error("matrix-binding-unavailable");
  return canonical;
}

function trustedDirectory(pathValue) {
  rejectUnsafePath(pathValue);
  try {
    if (lstatSync(pathValue).isSymbolicLink()) throw new Error("unsafe");
    const canonical = realpathSync.native(pathValue);
    rejectUnsafePath(canonical);
    if (!lstatSync(canonical).isDirectory()) throw new Error("unsafe");
    return canonical;
  } catch {
    throw new Error("matrix-binding-unavailable");
  }
}

function bindingTempDirectory() {
  try {
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    const canonicalCache = trustedDirectory(cacheRoot);
    const tempPath = join(canonicalCache, "binding-tmp");
    mkdirSync(tempPath, { recursive: true, mode: 0o700 });
    const canonicalTemp = trustedDirectory(tempPath);
    const contained = relative(canonicalCache, canonicalTemp);
    if (
      !contained ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    )
      throw new Error("unsafe");
    return canonicalTemp;
  } catch {
    throw new Error("matrix-binding-unavailable");
  }
}

function defaultSystemRoot(source = process.env) {
  const systemRoot = source.SystemRoot ?? source.WINDIR;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot))
    throw new Error("matrix-binding-unavailable");
  return trustedDirectory(systemRoot);
}

export function selectTrustedGitExecutable(candidates, encodingReceipt) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    try {
      return trustedLocalFile(candidate, "git.exe");
    } catch {
      // Continue to the next fixed candidate or the approved encoding receipt.
    }
  }
  if (typeof encodingReceipt === "string") {
    try {
      return trustedLocalFile(encodingReceipt, "git.exe");
    } catch {
      // Fall through to the same fail-closed error as missing Git.
    }
  }
  throw new Error("matrix-binding-unavailable");
}

function resolveTrustedCommandPaths(source = process.env) {
  const systemRoot = defaultSystemRoot(source);
  const programFiles = [source.ProgramW6432, source.ProgramFiles].filter(
    (value) => typeof value === "string" && isAbsolute(value),
  );
  const userProfile = source.USERPROFILE;
  const tauriCandidate = source.TAURI_DRIVER
    ? source.TAURI_DRIVER
    : typeof userProfile === "string" && isAbsolute(userProfile)
      ? join(userProfile, ".cargo", "bin", "tauri-driver.exe")
      : undefined;
  if (!tauriCandidate) throw new Error("matrix-binding-unavailable");
  const gitCandidates = programFiles.flatMap((base) => [
    join(base, "Git", "cmd", "git.exe"),
    join(base, "Git", "bin", "git.exe"),
  ]);
  let git;
  try {
    git = selectTrustedGitExecutable(gitCandidates);
  } catch {
    let encodingReceipt;
    try {
      encodingReceipt = canonicalEncodingToolReceipts(source)?.git;
    } catch {
      encodingReceipt = undefined;
    }
    git = selectTrustedGitExecutable([], encodingReceipt);
  }
  return {
    cmd: trustedLocalFile(join(systemRoot, "System32", "cmd.exe"), "cmd.exe"),
    reg: trustedLocalFile(join(systemRoot, "System32", "reg.exe"), "reg.exe"),
    node: trustedLocalFile(process.execPath, "node.exe"),
    git,
    edgeDriver: trustedLocalFile(
      DEFAULT_BINDING_ARTIFACT_PATHS.edgeDriver,
      "msedgedriver.exe",
    ),
    tauriDriver: trustedLocalFile(tauriCandidate, "tauri-driver.exe"),
  };
}

function bindingEnvironment(source = process.env) {
  const systemRoot = defaultSystemRoot(source);
  const tempDirectory = bindingTempDirectory();
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: join(systemRoot, "System32"),
    TEMP: tempDirectory,
    TMP: tempDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_CONFIG_SYSTEM: "NUL",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

const defaultRunCommand = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
    timeout: BINDING_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });

const firstVersion = (value) => {
  const match = String(value).match(/\d+(?:\.\d+)+/);
  if (!match || !isVersion(match[0])) throw new Error("matrix-binding-unavailable");
  return match[0];
};

const TAURI_DRIVER_INSTALL_KEY =
  /^tauri-driver (\d+\.\d+\.\d+) \(([^()\r\n]+)\)$/;

function parseTauriDriverMetadata(value) {
  let metadata = value;
  if (typeof metadata === "string" || Buffer.isBuffer(metadata)) {
    try {
      metadata = JSON.parse(String(metadata));
    } catch {
      throw new Error("matrix-binding-unavailable");
    }
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !== "installs"
  )
    throw new Error("matrix-binding-unavailable");
  const installs = metadata.installs;
  if (!installs || typeof installs !== "object" || Array.isArray(installs))
    throw new Error("matrix-binding-unavailable");
  const tauriKeys = Object.keys(installs).filter((key) =>
    key.startsWith("tauri-driver "),
  );
  if (tauriKeys.length !== 1) throw new Error("matrix-binding-unavailable");
  const match = tauriKeys[0].match(TAURI_DRIVER_INSTALL_KEY);
  if (!match || !isVersion(match[1]))
    throw new Error("matrix-binding-unavailable");
  const install = installs[tauriKeys[0]];
  if (!install || typeof install !== "object" || Array.isArray(install))
    throw new Error("matrix-binding-unavailable");
  if (
    !Array.isArray(install.bins) ||
    install.bins.some((bin) => typeof bin !== "string") ||
    !install.bins.some((bin) =>
      ["tauri-driver", "tauri-driver.exe"].includes(bin.toLowerCase()),
    ) ||
    (Object.prototype.hasOwnProperty.call(install, "profile") &&
      install.profile !== "release")
  )
    throw new Error("matrix-binding-unavailable");
  return match[1];
}

function tauriDriverMetadataPath(executablePath) {
  const executable = trustedLocalFile(executablePath, "tauri-driver.exe");
  const binDirectory = trustedDirectory(dirname(executable));
  if (basename(binDirectory).toLowerCase() !== "bin")
    throw new Error("matrix-binding-unavailable");
  const cargoHome = trustedDirectory(dirname(binDirectory));
  if (basename(cargoHome).toLowerCase() !== ".cargo")
    throw new Error("matrix-binding-unavailable");
  return trustedLocalFile(join(cargoHome, ".crates2.json"), ".crates2.json");
}

export function readTauriDriverVersion({
  executablePath,
  metadata,
  readFile = readFileSync,
} = {}) {
  let source = metadata;
  if (source === undefined) {
    const metadataPath = tauriDriverMetadataPath(executablePath);
    try {
      source = readFile(metadataPath);
    } catch {
      throw new Error("matrix-binding-unavailable");
    }
  }
  return parseTauriDriverMetadata(source);
}

const readDigest = (readFile, path) => {
  let bytes;
  try {
    bytes = readFile(path);
  } catch {
    throw new Error("matrix-binding-unavailable");
  }
  if (!bytes || (typeof bytes !== "string" && !Buffer.isBuffer(bytes)))
    throw new Error("matrix-binding-unavailable");
  return sha256(bytes);
};

function digestFiles(readFile, paths, trusted) {
  const digests = paths.map((path) => {
    const checked = trusted ? trustedLocalFile(path) : path;
    return readDigest(readFile, checked);
  });
  return sha256(canonicalJson(digests));
}

const commandVersion = (runCommand, command, args) => {
  let output;
  try {
    output = runCommand(command, args);
  } catch {
    throw new Error("matrix-binding-unavailable");
  }
  return firstVersion(output);
};

const WEBVIEW2_PRODUCT_KEY =
  "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_REGISTRY_KEYS = Object.freeze([
  `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_PRODUCT_KEY}`,
  `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_PRODUCT_KEY}`,
]);

export function parseWebView2RegistryOutput(output) {
  if (typeof output !== "string" && !Buffer.isBuffer(output))
    throw new Error("matrix-binding-unavailable");
  const rows = String(output).split(/\r?\n/);
  const versions = [];
  for (const row of rows) {
    const fields = row.trim().split(/\s+/);
    if (!fields[0] || fields[0].toLowerCase() !== "pv") continue;
    if (
      fields.length !== 3 ||
      fields[1].toUpperCase() !== "REG_SZ" ||
      !isVersion(fields[2])
    )
      throw new Error("matrix-binding-unavailable");
    versions.push(fields[2]);
  }
  if (versions.length !== 1) throw new Error("matrix-binding-unavailable");
  return versions[0];
}

export function readWebView2Version(runCommand) {
  if (typeof runCommand !== "function")
    throw new Error("matrix-binding-unavailable");
  const query = (registryKey) => {
    try {
      return { ok: true, output: runCommand("reg", ["query", registryKey, "/v", "pv"]) };
    } catch {
      return { ok: false };
    }
  };
  const hklm = query(WEBVIEW2_REGISTRY_KEYS[0]);
  if (hklm.ok) return parseWebView2RegistryOutput(hklm.output);
  const hkcu = query(WEBVIEW2_REGISTRY_KEYS[1]);
  if (!hkcu.ok) throw new Error("matrix-binding-unavailable");
  return parseWebView2RegistryOutput(hkcu.output);
}

const gitArgs = (args) => [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.preloadIndex=false",
  ...args,
];

function gitSnapshot({ runCommand, git, env, readFile }) {
  const runGit = (args) => runCommand(git, gitArgs(args), { env });
  let head;
  let status;
  let unstaged;
  let staged;
  try {
    head = String(runGit(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    status = String(
      runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"]),
    );
    unstaged = String(runGit(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--"]));
    staged = String(runGit(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--"]));
  } catch {
    throw new Error("matrix-binding-unavailable");
  }
  if (!isGitHead(head)) throw new Error("matrix-binding-unavailable");
  const untrackedHashes = [];
  const fields = status.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry.startsWith("?? ")) continue;
    const relativePath = entry.slice(3);
    const contained = resolve(root, relativePath);
    const relativeContained = relative(root, contained);
    if (
      !relativePath ||
      !relativeContained ||
      relativeContained.startsWith(`..${sep}`) ||
      isAbsolute(relativeContained)
    )
      throw new Error("matrix-binding-unavailable");
    const canonical = trustedLocalFile(contained);
    const normalizedPath = relativeContained.split(sep).join("/").toLowerCase();
    untrackedHashes.push(
      sha256(
        canonicalJson({
          content: readDigest(readFile, canonical),
          path: normalizedPath,
        }),
      ),
    );
  }
  untrackedHashes.sort();
  return {
    gitHead: head,
    gitDirty: status.length > 0,
    gitDirtyDigest: sha256(
      canonicalJson({
        status: sha256(status),
        unstaged: sha256(unstaged),
        staged: sha256(staged),
        untracked: untrackedHashes,
      }),
    ),
  };
}

export function captureReleaseBinding({
  platform = process.platform,
  readFile = readFileSync,
  runCommand = defaultRunCommand,
  source = process.env,
  commandPaths,
  productionBinary = shippingBinaryPath,
  harnessBinary = harnessBinaryPath,
  runnerConfig,
  tauriDriverMetadata,
  runnerConfigPaths = RUNNER_CONFIG_PATHS,
  flagsPlan = DEFAULT_FLAGS_PLAN,
} = {}) {
  if (platform !== "win32") throw new Error("matrix-binding-unavailable");
  const injected = runCommand !== defaultRunCommand;
  const paths = commandPaths
    ? Object.keys(commandPaths).sort().join(",") !== COMMAND_PATH_KEYS.join(",")
      ? (() => {
          throw new Error("matrix-binding-unavailable");
        })()
      : Object.fromEntries(
          Object.entries(commandPaths).map(([key, value]) => [
            key,
            trustedLocalFile(value),
          ]),
        )
    : injected
      ? {
          cmd: "cmd.exe",
          reg: "reg.exe",
          node: "node",
          git: "git",
          edgeDriver: "msedgedriver",
          tauriDriver: "tauri-driver",
        }
      : resolveTrustedCommandPaths(source);
  const env = injected
    ? undefined
    : Object.fromEntries(
        Object.entries(bindingEnvironment(source)).filter(
          ([, value]) => value !== undefined,
        ),
      );
  const run = (pathKey, args = []) =>
    runCommand(paths[pathKey], args, { env });
  let snapshot;
  let osBuildOutput;
  try {
    osBuildOutput = run("cmd", ["/d", "/q", "/c", "ver"]);
    snapshot = gitSnapshot({
      runCommand,
      git: paths.git,
      env,
      readFile,
    });
  } catch {
    throw new Error("matrix-binding-unavailable");
  }
  const configPaths = runnerConfig ? [runnerConfig] : runnerConfigPaths;
  if (!Array.isArray(configPaths) || configPaths.length === 0)
    throw new Error("matrix-binding-unavailable");
  const configDigest = digestFiles(readFile, configPaths, !injected);
  const tauriDriverVersion = readTauriDriverVersion({
    executablePath: paths.tauriDriver,
    metadata: tauriDriverMetadata,
    readFile,
  });
  const binding = createReleaseBinding({
    osBuild: firstVersion(osBuildOutput),
    webview2Version: readWebView2Version(run),
    tauriDriverVersion,
    tauriDriverDigest: readDigest(readFile, paths.tauriDriver),
    edgeDriverVersion: commandVersion(run, "edgeDriver", ["--version"]),
    edgeDriverDigest: readDigest(readFile, paths.edgeDriver),
    nodeVersion: commandVersion(run, "node", ["--version"]),
    gitHead: snapshot.gitHead,
    gitDirty: snapshot.gitDirty,
    gitDirtyDigest: snapshot.gitDirtyDigest,
    productionBinaryDigest: readDigest(
      readFile,
      !injected ? trustedLocalFile(productionBinary, "threadterm.exe") : productionBinary,
    ),
    harnessBinaryDigest: readDigest(
      readFile,
      !injected ? trustedLocalFile(harnessBinary, "threadterm.exe") : harnessBinary,
    ),
    runnerConfigDigest: configDigest,
    flagsPlanDigest: sha256(canonicalJson(flagsPlan)),
  });
  return binding;
}

const define = (id, flow, artifact, group, repetition, extra = {}) => ({
  id,
  flow,
  artifact,
  group,
  repetition,
  deadlineMs: DEADLINE_MS,
  sampleCount: 1,
  ...extra,
});
export function createMatrixPlan() {
  const plan = [
    define(
      "production-smoke-01",
      "production",
      "production",
      "productionSmoke",
      1,
    ),
    define("harness-isolation-01", "isolation", "harness", "isolation", 1),
    define("da1-01", "da1", "harness", "da1", 1, { sampleCount: 6 }),
    define("encoding-enabled-01", "encoding", "harness", "encoding", 1, {
      encodingCase: "enabled",
      sampleCount: 4,
    }),
    define("encoding-disabled-01", "encoding", "harness", "encoding", 2, {
      encodingCase: "disabled",
      sampleCount: 4,
    }),
    define("warm-provider-01", "provider", "harness", "warm", 1, {
      providerRepeats: 30,
      providerShell: "cmd",
      sampleCount: 30,
    }),
  ];
  for (let i = 1; i <= 10; i += 1)
    plan.push(
      define(
        `cold-provider-${String(i).padStart(2, "0")}`,
        "provider",
        "harness",
        "cold",
        i,
        { sampleCount: 3 },
      ),
    );
  for (const warmupCase of [
    "off",
    "normalSuccess",
    "clickBeforeGrace",
    "spawnFailure",
    "neverExit",
    "clickDuringHold",
  ])
    plan.push(
      define(`warmup-${warmupCase}`, "warmup", "harness", "warmup", 1, {
        warmupCase,
      }),
    );
  for (const concurrency of [1, 5, 20])
    for (let round = 1; round <= 5; round += 1)
      plan.push(
        define(
          `concurrency-${concurrency}-${round}`,
          "provider",
          "harness",
          "concurrency",
          round,
          { concurrency, sampleCount: concurrency * 3 },
        ),
      );
  for (let i = 1; i <= 5; i += 1)
    plan.push(
      define(`same-id-${i}`, "timing", "harness", "sameId", i, {
        sampleCount: 4,
      }),
    );
  plan.push(
    define("listener-01", "listener", "harness", "listener", 1, {
      sampleCount: 2,
    }),
    define("surface-lifecycle-01", "surface", "harness", "surface", 1),
  );
  return plan;
}
export function validatePlan(plan) {
  const expected = createMatrixPlan();
  return (
    Array.isArray(plan) &&
    plan.length === expected.length &&
    plan.every(
      (entry, index) =>
        JSON.stringify(entry) === JSON.stringify(expected[index]),
    )
  );
}
const safeSample = (value) =>
  value &&
  typeof value === "object" &&
  typeof value.attemptId === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.attemptId) &&
  typeof value.scenario === "string" &&
  MATRIX_GROUPS.has(value.scenario) &&
  TERMINAL.has(value.status) &&
  Number.isSafeInteger(value.elapsedMs) &&
  value.elapsedMs >= 0 &&
  validCorrectness(value.correctness) &&
  ["none", "shellUnavailable", "toolUnavailable"].includes(value.exclusion) &&
  (value.status === "passed"
    ? Object.keys(value).sort().join(",") ===
      "attemptId,correctness,elapsedMs,exclusion,scenario,status"
    : FAILURES.has(value.failure) &&
      Object.keys(value).sort().join(",") ===
        "attemptId,correctness,elapsedMs,exclusion,failure,scenario,status");
function validState(state, plan) {
  return (
    state &&
    state.schema === "windows-terminal-startup-matrix-state-v2" &&
    validBinding(state.binding) &&
    Array.isArray(state.cases) &&
    state.cases.length === plan.length &&
    state.cases.every(
      (entry, index) =>
        entry &&
        entry.id === plan[index].id &&
        ["pending", "running", ...TERMINAL].includes(entry.status) &&
        (entry.status === "pending" || entry.status === "running"
          ? Object.keys(entry).sort().join(",") === "id,status"
          : Array.isArray(entry.samples) &&
            entry.samples.every(safeSample) &&
            (entry.status === "passed" || entry.status === "unavailable"
              ? entry.samples.length === plan[index].sampleCount &&
                (entry.status === "passed"
                  ? entry.samples.every((sample) => sample.status === "passed")
                  : entry.samples.some((sample) => sample.status === "unavailable") &&
                    entry.samples.every((sample) => sample.status === "passed" || sample.status === "unavailable"))
              : entry.samples.length === 1 &&
                entry.samples[0].status === entry.status) &&
            Object.keys(entry).sort().join(",") === "id,samples,status"),
    )
  );
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}
export function loadState(path, plan, binding) {
  if (!validBinding(binding)) throw new Error("matrix-state-binding-mismatch");
  if (!existsSync(path))
    return {
      schema: "windows-terminal-startup-matrix-state-v2",
      binding,
      cases: plan.map((entry) => ({ id: entry.id, status: "pending" })),
    };
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("matrix-state-corrupt");
  }
  if (
    !state ||
    state.schema !== "windows-terminal-startup-matrix-state-v2" ||
    !validBinding(state.binding) ||
    JSON.stringify(state.binding) !== JSON.stringify(binding)
  )
    throw new Error("matrix-state-binding-mismatch");
  if (!validState(state, plan)) throw new Error("matrix-state-corrupt");
  const resumedIds = state.cases
    .filter((entry) => entry.status === "running")
    .map((entry) => entry.id);
  const resumed = {
    ...state,
    cases: state.cases.map((entry) =>
      entry.status === "running" ? { id: entry.id, status: "pending" } : entry,
    ),
  };
  Object.defineProperty(resumed, "resumedIds", { value: new Set(resumedIds) });
  return resumed;
}
export function percentile(values, p) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    !Number.isFinite(p) ||
    p < 0 ||
    p > 100 ||
    values.some((v) => !Number.isFinite(v) || v < 0)
  )
    return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil((p / 100) * ordered.length) - 1];
}
function parseJsonl(raw) {
  if (typeof raw !== "string" || !raw.endsWith("\n")) return undefined;
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row))
        return undefined;
      rows.push(row);
    } catch {
      return undefined;
    }
  }
  return rows.length ? rows : undefined;
}
function runnerPassed(rows) {
  const runner = rows.filter(
    (row) => Object.keys(row).sort().join(",") === "outcome,runnerStage",
  );
  return (
    runner.length === 1 &&
    runner[0].runnerStage === "complete" &&
    runner[0].outcome === "success"
  );
}
function cleanupVerified(rows) {
  const cleanup = rows.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      Object.keys(row).sort().join(",") === CLEANUP_KEYS.slice().sort().join(","),
  );
  if (cleanup.length !== 1) return false;
  if (CLEANUP_KEYS.some((key) => cleanup[0][key] !== CLEANUP_ROW[key]))
    return false;
  const runnerIndex = rows.findIndex(
    (row) => Object.keys(row).sort().join(",") === "outcome,runnerStage",
  );
  const cleanupIndex = rows.indexOf(cleanup[0]);
  return runnerIndex >= 0 && cleanupIndex >= 0 && cleanupIndex < runnerIndex;
}
function exactKeys(record, keys, optional = []) {
  const actual = Object.keys(record).sort().join(",");
  return actual === [...keys].sort().join(",") ||
    optional.some((key) => actual === [...keys, key].sort().join(","));
}
const exactNumbers = (record, keys) =>
  keys.every((key) => Number.isSafeInteger(record[key]) && record[key] >= 0);
const evidenceKeys = ["correctness", "exclusion"];
const providerKeys = ["artifact", "availability", "barrierReleased", "cleanup", "correctness", "disposition", "elapsedMs", "expectedConcurrency", "exclusion", "flow", "kind", "peakConcurrentAlive", "repetition", "sentinelMatches", "sessionDisappeared", "shell", "shellFamily", "slot", "startup", "status"];
const timingKeys = ["artifact", "availability", "cleanup", "correctness", "disposition", "driveCount", "elapsedMs", "exclusion", "flow", "kind", "markerMatched", "readyCount", "sameTickCount", "scenario", "sentObserved", "sentinelMatches", "shell", "shellFamily", "snapshotReads", "startup", "status", "timeoutCount"];
const da1Keys = ["artifact", "availability", "cleanup", "committed", "correctness", "elapsedMs", "exclusion", "fatal", "fakeSequences", "fallback", "fault", "flow", "kind", "partial", "priority", "priorityElapsedMs", "queries", "rejected", "renderer", "shell", "status", "submittedBytes", "unknown", "visibleMarkers", "zero"];
const encodingKeys = ["artifact", "availability", "cmd", "cleanup", "correctness", "da1Authority", "elapsedMs", "exclusion", "flow", "git", "kind", "markerLeaks", "markerMatched", "mode", "node", "probeFailed", "probePassed", "probeUnavailable", "providerReady", "python", "roundTrip", "roundTripMatches", "sentinelMatches", "shell", "shellFamily", "status", "utf8", "warmup"];
const warmupKeys = ["artifact", "case", "childSpawned", "cleanup", "correctness", "create", "createElapsedMs", "disposition", "elapsedMs", "exclusion", "flow", "holdBeforeGraceEntered", "holdBeforeGraceReleased", "holdBeforeGraceTimedOut", "holdBeforeGraceWaitTimedOut", "holdWaitTimedOut", "killAttempted", "kind", "nativeSpawnAttempted", "realCreateSeen", "reapConfirmed", "reapTimedOut", "scenario", "skippedForRealCreate", "starts", "status", "warmup", "write"];
const listenerKeys = ["artifact", "attachCount", "availability", "cleanup", "cleanupKillCalls", "correctness", "elapsedMs", "eventGapReconciled", "eventObserved", "exclusion", "flow", "generationStable", "identityStable", "kind", "listenerBeforeCreate", "listenerReestablished", "markerHeld", "queryReads", "queryReconciled", "rendererDropped", "scenario", "sentObserved", "sentinelMatches", "shell", "startup", "status"];
const surfaceKeys = ["artifact", "availability", "cleanup", "close", "correctness", "create", "elapsedMs", "exclusion", "floatAttach", "flow", "generationStable", "harnessCleanupCalls", "hiddenReveal", "identityStable", "kind", "lruUnload", "nonceReadbacks", "orphanSessions", "ptyCleanupCalls", "providerStartup", "providerStartupDispatches", "recycleToMain", "resize", "sessionGone", "shell", "status", "writeAfterReveal"];
const productionKeys = ["correctness", "elapsedMs", "exclusion", "harnessCommandsChecked", "kind", "status"];
const floatKeys = ["artifact", "correctness", "counters", "elapsedMs", "exclusion", "kind", "managedDataRoot", "ok", "pinnedEntries", "selectorActivation", "webviewUserDataFolder"];

function validEvidenceProjection(record) {
  return (
    validCorrectness(record.correctness) &&
    ["none", "shellUnavailable", "toolUnavailable"].includes(record.exclusion)
  );
}

function sampleProjection(record) {
  return {
    correctness: { ...record.correctness },
    exclusion: record.exclusion,
  };
}
function validWarmupOutcome(record) {
  const zero = (names) => names.every((name) => record[name] === 0);
  if (record.cleanup !== "killed" || record.create !== "created" || record.write !== "observed" || record.disposition !== "created" || record.holdWaitTimedOut !== 0 || record.reapTimedOut !== 0) return false;
  switch (record.case) {
    case "off": return record.scenario === "disabled" && record.warmup === "disabled" && record.starts === 0 && zero(["realCreateSeen", "nativeSpawnAttempted", "childSpawned", "skippedForRealCreate", "holdBeforeGraceWaitTimedOut", "killAttempted", "reapConfirmed"]) && !record.holdBeforeGraceEntered && !record.holdBeforeGraceReleased && !record.holdBeforeGraceTimedOut;
    case "normalSuccess": return record.scenario === "normal" && record.warmup === "completed" && record.starts === 1 && record.nativeSpawnAttempted === 1 && record.childSpawned === 1 && record.killAttempted === 0 && record.reapConfirmed === 1 && zero(["realCreateSeen", "skippedForRealCreate", "holdBeforeGraceWaitTimedOut"]) && !record.holdBeforeGraceEntered && !record.holdBeforeGraceReleased && !record.holdBeforeGraceTimedOut;
    case "spawnFailure": return record.scenario === "spawnFailure" && record.warmup === "failed" && record.starts === 1 && record.nativeSpawnAttempted === 1 && record.childSpawned === 0 && record.killAttempted === 0 && record.reapConfirmed === 0 && zero(["realCreateSeen", "skippedForRealCreate", "holdBeforeGraceWaitTimedOut"]) && !record.holdBeforeGraceEntered && !record.holdBeforeGraceReleased && !record.holdBeforeGraceTimedOut;
    case "neverExit": return record.scenario === "neverExit" && record.warmup === "timedOut" && record.starts === 1 && record.nativeSpawnAttempted === 1 && record.childSpawned === 1 && record.killAttempted === 1 && record.reapConfirmed === 1 && zero(["realCreateSeen", "skippedForRealCreate", "holdBeforeGraceWaitTimedOut"]) && !record.holdBeforeGraceEntered && !record.holdBeforeGraceReleased && !record.holdBeforeGraceTimedOut;
    case "clickBeforeGrace": return record.scenario === "holdBeforeGrace" && record.warmup === "skippedForRealCreate" && record.starts === 1 && record.realCreateSeen === 1 && record.skippedForRealCreate === 1 && zero(["nativeSpawnAttempted", "childSpawned", "killAttempted", "reapConfirmed", "holdBeforeGraceWaitTimedOut"]) && record.holdBeforeGraceEntered && record.holdBeforeGraceReleased && !record.holdBeforeGraceTimedOut;
    case "clickDuringHold": return record.scenario === "holdBeforeNativeSpawn" && record.warmup === "skippedForRealCreate" && record.starts === 1 && record.realCreateSeen === 1 && record.skippedForRealCreate === 1 && zero(["nativeSpawnAttempted", "childSpawned", "killAttempted", "reapConfirmed", "holdBeforeGraceWaitTimedOut"]) && !record.holdBeforeGraceEntered && !record.holdBeforeGraceReleased && !record.holdBeforeGraceTimedOut;
    default: return false;
  }
}
function validTimingOutcome(record) {
  const expected = { holdMarker: [1, 1, 0, 0], manualTimeout: [1, 0, 1, 0], lateMarker: [2, 1, 1, 0], sameTick: [1, 0, 0, 1] }[record.scenario];
  return expected && record.status === "passed" && record.startup === "sent" && record.disposition === "created" && record.availability === "available" && record.cleanup === "cleaned" && ["pwsh", "windowsPowerShell", "cmd"].includes(record.shell) && record.shellFamily === record.shell && record.sentinelMatches === 1 && record.sentObserved === 1 && Number.isSafeInteger(record.snapshotReads) && record.snapshotReads >= 1 && [record.driveCount, record.readyCount, record.timeoutCount, record.sameTickCount].every((value, index) => value === expected[index]) && (record.shell === "cmd" ? record.markerMatched === "notChecked" : record.markerMatched === "yes");
}
function validProviderOutcome(record, slots, repetitions) {
  const dispatchShape =
    Number.isSafeInteger(record.expectedConcurrency) &&
    record.expectedConcurrency === slots &&
    Number.isSafeInteger(record.peakConcurrentAlive) &&
    Number.isSafeInteger(record.slot) &&
    record.slot >= 1 &&
    record.slot <= slots &&
    Number.isSafeInteger(record.repetition) &&
    record.repetition >= 1 &&
    record.repetition <= repetitions;
  if (!dispatchShape) return false;
  if (record.status === "passed") {
    return (
      record.errorKind === undefined &&
      record.availability === "available" &&
      record.startup === "sent" &&
      record.disposition === "created" &&
      record.shellFamily === record.shell &&
      record.sentinelMatches === 1 &&
      record.cleanup === "cleaned" &&
      record.peakConcurrentAlive === slots &&
      record.barrierReleased === true &&
      record.sessionDisappeared === true
    );
  }
  if (record.status !== "unavailable") return false;
  return (
    ["pwsh", "windowsPowerShell"].includes(record.shell) &&
    record.availability === "unavailable" &&
    record.startup === "notObserved" &&
    record.disposition === "unknown" &&
    record.shellFamily === "unknown" &&
    record.sentinelMatches === 0 &&
    record.cleanup === "notStarted" &&
    record.errorKind === "shellUnavailable" &&
    record.peakConcurrentAlive === 0 &&
    record.barrierReleased === false &&
    record.sessionDisappeared === true
  );
}
function validListenerOutcome(record) {
  const common =
    record.kind === "harness-listener-reconciliation" &&
    record.artifact === "harness" &&
    record.flow === "listener" &&
    ["listenerBeforeCreate", "rendererDropQuery"].includes(record.scenario) &&
    Number.isSafeInteger(record.elapsedMs) &&
    record.elapsedMs >= 0 &&
    Number.isSafeInteger(record.attachCount) &&
    Number.isSafeInteger(record.cleanupKillCalls) &&
    Number.isSafeInteger(record.eventObserved) &&
    Number.isSafeInteger(record.queryReads) &&
    Number.isSafeInteger(record.sentinelMatches) &&
    Number.isSafeInteger(record.sentObserved);
  if (!common) return false;
  if (record.status === "unavailable") {
    return (
      record.shell === "unknown" &&
      record.availability === "unavailable" &&
      record.errorKind === "shellUnavailable" &&
      record.listenerBeforeCreate === false &&
      record.rendererDropped === false &&
      record.listenerReestablished === false &&
      record.eventObserved === 0 &&
      record.eventGapReconciled === false &&
      record.queryReconciled === false &&
      record.generationStable === false &&
      record.identityStable === false &&
      record.markerHeld === false &&
      record.startup === "notObserved" &&
      record.sentinelMatches === 0 &&
      record.sentObserved === 0 &&
      record.attachCount === 0 &&
      record.queryReads === 0 &&
      record.cleanup === "notStarted" &&
      record.cleanupKillCalls === 0
    );
  }
  if (
    record.status !== "passed" ||
    record.errorKind !== undefined ||
    !["pwsh", "windowsPowerShell"].includes(record.shell) ||
    record.availability !== "available" ||
    record.listenerBeforeCreate !== true ||
    record.queryReconciled !== true ||
    record.generationStable !== true ||
    record.identityStable !== true ||
    record.markerHeld !== true ||
    record.startup !== "sent" ||
    record.sentinelMatches !== 1 ||
    record.sentObserved !== 1 ||
    record.attachCount !== 2 ||
    record.queryReads < 1 ||
    record.cleanup !== "killedAndConfirmed" ||
    record.cleanupKillCalls !== 1
  )
    return false;
  if (record.scenario === "listenerBeforeCreate") {
    return (
      record.rendererDropped === false &&
      record.listenerReestablished === false &&
      record.eventObserved === 1 &&
      record.eventGapReconciled === false
    );
  }
  return (
    record.rendererDropped === true &&
    record.listenerReestablished === true &&
    record.eventObserved === 0 &&
    record.eventGapReconciled === true
  );
}
function validSurfaceLifecycleOutcome(record) {
  return (
    record.kind === "harness-surface-lifecycle" &&
    record.artifact === "harness" &&
    record.flow === "surfaceLifecycle" &&
    ["pwsh", "windowsPowerShell", "cmd"].includes(record.shell) &&
    record.availability === "available" &&
    record.status === "passed" &&
    record.create === "created" &&
    record.nonceReadbacks === 2 &&
    record.identityStable === "yes" &&
    record.generationStable === "yes" &&
    record.providerStartup === "sent" &&
    record.providerStartupDispatches === 1 &&
    record.floatAttach === "observed" &&
    record.hiddenReveal === "observed" &&
    record.recycleToMain === "observed" &&
    record.resize === "observed" &&
    record.writeAfterReveal === "observed" &&
    record.close === "requested" &&
    record.sessionGone === "yes" &&
    record.ptyCleanupCalls === 0 &&
    record.harnessCleanupCalls === 1 &&
    record.orphanSessions === 0 &&
    record.lruUnload === "notExercised" &&
    record.cleanup === "observed" &&
    Number.isSafeInteger(record.elapsedMs) &&
    record.elapsedMs >= 0 &&
    record.errorKind === undefined
  );
}
function resultSamples(definition, records) {
  const elapsed = (record) =>
    Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0
      ? record.elapsedMs
      : undefined;
  const allowedUnavailable = (record) =>
    record.status === "unavailable" &&
    (record.shell === "pwsh" || record.shell === "windowsPowerShell") &&
    record.availability === "unavailable" &&
    record.cleanup === "notStarted" &&
    record.errorKind === "shellUnavailable";
  if (records.length !== definition.sampleCount) return undefined;
  const samples = [];
  for (const record of records) {
    const ms = elapsed(record);
    if (
      ms === undefined ||
      record.status === "failed" ||
      (record.status === "unavailable" && !allowedUnavailable(record)) ||
      !["passed", "unavailable"].includes(record.status) ||
      !validEvidenceProjection(record)
    )
      return undefined;
    samples.push(
      record.status === "passed"
        ? {
            scenario: definition.group,
            status: "passed",
            elapsedMs: ms,
            ...sampleProjection(record),
          }
        : {
            scenario: definition.group,
            status: "unavailable",
            elapsedMs: ms,
            failure: "unavailable",
            ...sampleProjection(record),
          },
    );
  }
  return samples;
}
export function validateRawEvidence(definition, raw) {
  const rows = parseJsonl(raw);
  if (!rows || !runnerPassed(rows) || !cleanupVerified(rows)) return undefined;
  if (
    definition.flow !== "isolation" &&
    rows.some(
      (row) =>
        !("kind" in row) &&
        Object.keys(row).sort().join(",") !== "outcome,runnerStage" &&
        Object.keys(row).sort().join(",") !== CLEANUP_KEYS.slice().sort().join(","),
    )
  )
    return undefined;
  const records = rows.filter((row) => "kind" in row);
  if (definition.flow === "production")
    return records.length === 1 &&
      exactKeys(records[0], productionKeys) &&
      records[0].kind === "public-ui-release-smoke" &&
      records[0].status === "passed" &&
      validEvidenceProjection(records[0]) &&
      records[0].exclusion === "none" &&
      Number.isSafeInteger(records[0].elapsedMs) &&
      Number.isSafeInteger(records[0].harnessCommandsChecked) &&
      records[0].elapsedMs >= 0 && records[0].harnessCommandsChecked === SHIPPING_HARNESS_COMMAND_COUNT
      ? [
          {
            scenario: definition.group,
            status: "passed",
            elapsedMs: records[0].elapsedMs,
            ...sampleProjection(records[0]),
          },
        ]
      : undefined;
  if (definition.flow === "float")
    return records.length === 1 &&
      exactKeys(records[0], floatKeys) &&
      records[0].kind === "public-ui-float-attach" &&
      records[0].artifact === "production" &&
      records[0].ok === true &&
      validEvidenceProjection(records[0]) &&
      records[0].exclusion === "none" &&
      records[0].selectorActivation === "shippingCommand" &&
      records[0].managedDataRoot === "isolated" &&
      records[0].webviewUserDataFolder === "isolated" &&
      ["none", "present"].includes(records[0].pinnedEntries) &&
      records[0].counters &&
      exactKeys(records[0].counters, ["closed", "floatAttach", "floatHideReveal", "harnessUnknown", "hiddenReveal", "recycle", "resize", "writable"]) &&
      records[0].counters.writable === 2 && records[0].counters.resize === 1 &&
      records[0].counters.hiddenReveal === 1 && records[0].counters.closed === 1 &&
      records[0].counters.harnessUnknown === SHIPPING_HARNESS_COMMAND_COUNT && records[0].counters.floatAttach === 1 &&
      records[0].counters.floatHideReveal === 1 && records[0].counters.recycle === 1 &&
      Number.isSafeInteger(records[0].elapsedMs) && records[0].elapsedMs >= 0
      ? [
          {
            scenario: definition.group,
            status: "passed",
            elapsedMs: records[0].elapsedMs,
            ...sampleProjection(records[0]),
          },
        ]
      : undefined;
  if (definition.flow === "isolation") {
    const lifecycle = classifyIsolationLifecycleEvidence(raw);
    return records.length === 0 &&
      (lifecycle === "natural" || lifecycle === "stopped")
      ? [{ scenario: definition.group, status: "passed", elapsedMs: 0, correctness: zeroCorrectness(), exclusion: "none" }]
      : undefined;
  }
  const expectedKind = {
    provider: "harness-provider",
    timing: "harness-provider-timing",
    listener: "harness-listener-reconciliation",
    surface: "harness-surface-lifecycle",
    da1: "harness-da1",
    encoding: "harness-encoding",
    warmup: "harness-warmup",
  }[definition.flow];
  const expectedReportFlow =
    definition.flow === "surface" ? "surfaceLifecycle" : definition.flow;
  if (
    !expectedKind ||
    records.some(
      (record) =>
        record.kind !== expectedKind ||
        !exactKeys(record, definition.flow === "provider" ? providerKeys : definition.flow === "timing" ? timingKeys : definition.flow === "listener" ? listenerKeys : definition.flow === "surface" ? surfaceKeys : definition.flow === "da1" ? da1Keys : definition.flow === "encoding" ? encodingKeys : warmupKeys, definition.flow === "surface" ? [] : ["errorKind"]) ||
        record.artifact !== "harness" ||
        record.flow !== expectedReportFlow ||
        !validEvidenceProjection(record) ||
        record.cleanup === "cleanupFailed" ||
      record.cleanup === "killNotObserved" ||
      !Number.isSafeInteger(record.elapsedMs) ||
      record.elapsedMs < 0,
    )
  )
    return undefined;
  if (definition.flow === "provider") {
    const slots = definition.concurrency ?? 1;
    const repetitions = definition.providerRepeats ?? 1;
    if (
      records.length !==
      slots * repetitions * (definition.providerShell ? 1 : 3)
    )
      return undefined;
    const expected = new Set();
    const shells = definition.providerShell
      ? [definition.providerShell]
      : ["pwsh", "windowsPowerShell", "cmd"];
    for (const shell of shells)
      for (let repetition = 1; repetition <= repetitions; repetition += 1)
        for (let slot = 1; slot <= slots; slot += 1)
          expected.add(`${shell}:${slot}:${repetition}`);
    const actual = records.map(
      (record) => `${record.shell}:${record.slot}:${record.repetition}`,
    );
    if (
      new Set(actual).size !== actual.length ||
      actual.some((key) => !expected.has(key)) ||
      records.some((record) => !validProviderOutcome(record, slots, repetitions))
    )
      return undefined;
  }
  if (definition.flow === "listener") {
    if (
      records.length !== 2 ||
      records[0].scenario !== "listenerBeforeCreate" ||
      records[1].scenario !== "rendererDropQuery" ||
      !records.every(validListenerOutcome)
    )
      return undefined;
    const passed = records.every((record) => record.status === "passed");
    const unavailable = records.every(
      (record) => record.status === "unavailable",
    );
    if (!passed && !unavailable) return undefined;
    return records.map((record) =>
      record.status === "passed"
        ? { scenario: definition.group, status: "passed", elapsedMs: record.elapsedMs, ...sampleProjection(record) }
        : { scenario: definition.group, status: "unavailable", elapsedMs: record.elapsedMs, failure: "unavailable", ...sampleProjection(record) },
    );
  }
  if (
    definition.flow === "surface" &&
    (records.length !== 1 || !validSurfaceLifecycleOutcome(records[0]))
  )
    return undefined;
  if (
    definition.flow === "warmup" &&
    (records.length !== 1 ||
      records[0].case !== definition.warmupCase ||
      records[0].status !== "passed" ||
      !validWarmupOutcome(records[0]))
  )
    return undefined;
  if (
    definition.flow === "encoding" &&
    (records.length !== 4 ||
      new Set(records.map((record) => `${record.shell}:${record.mode}`)).size !== 4 ||
      !["pwsh:plain", "pwsh:syntheticProvider", "windowsPowerShell:plain", "windowsPowerShell:syntheticProvider"].every((key) => records.some((record) => `${record.shell}:${record.mode}` === key)) ||
      records.some((record) => {
        const passed = record.status === "passed";
        const statuses = [record.git, record.node, record.python, record.cmd];
        return record.utf8 !== (definition.encodingCase === "enabled" ? "enabled" : "disabled") ||
          record.providerReady !== "disabled" || record.da1Authority !== "disabled" || record.warmup !== "disabled" ||
          record.markerLeaks !== 0 || record.probeFailed !== 0 || !exactNumbers(record, ["elapsedMs", "markerLeaks", "sentinelMatches", "roundTripMatches", "probePassed", "probeUnavailable", "probeFailed"]) ||
          record.exclusion !== (record.probeUnavailable > 0 ? "toolUnavailable" : record.status === "unavailable" ? "shellUnavailable" : "none") ||
          (passed ? record.availability !== "available" || record.cleanup !== "killed" || record.shellFamily !== record.shell || record.cmd !== "passed" || record.sentinelMatches !== 1 || record.roundTripMatches !== 1 || record.roundTrip !== (definition.encodingCase === "enabled" ? "passed" : "notRequired") || record.markerMatched !== (record.mode === "syntheticProvider" ? "no" : "notApplicable") || statuses.includes("failed") || statuses.filter((status) => status === "passed").length !== record.probePassed || statuses.filter((status) => status === "unavailable").length !== record.probeUnavailable : record.status !== "unavailable" || record.availability !== "unavailable" || record.cleanup !== "notPrepared" || record.shellFamily !== "unknown" || record.sentinelMatches !== 0 || record.roundTripMatches !== 0 || record.roundTrip !== (definition.encodingCase === "enabled" ? "failed" : "notRequired") || record.markerMatched !== (record.mode === "syntheticProvider" ? "no" : "notApplicable") || !statuses.every((status) => status === "failed") || record.probePassed !== 0 || record.probeUnavailable !== 0 || record.probeFailed !== 0);
      }))
  )
    return undefined;
  if (definition.flow === "encoding" && records.some((record) => record.status === "unavailable"))
    return records.map((record) => record.status === "passed"
      ? { scenario: definition.group, status: "passed", elapsedMs: record.elapsedMs, ...sampleProjection(record) }
      : { scenario: definition.group, status: "unavailable", elapsedMs: record.elapsedMs, failure: "unavailable", ...sampleProjection(record) });
  if (
    definition.flow === "da1" &&
    records.length === 6 &&
    records.every((record) => record.status === "unavailable" && record.availability === "unavailable" && ["pwsh", "windowsPowerShell"].includes(record.shell) && record.errorKind === "shellUnavailable" && record.queries === 0 && record.committed === 0 && record.rejected === 0 && record.zero === 0 && record.partial === 0 && record.unknown === 0 && record.fatal === 0 && record.submittedBytes === 0 && record.priority === "notRun" && record.cleanup === "notPrepared")
    )
    return records.every((record) => record.shell === records[0].shell)
      ? records.map((record) => ({ scenario: definition.group, status: "unavailable", elapsedMs: record.elapsedMs, failure: "unavailable", ...sampleProjection(record) }))
      : undefined;
  if (
    definition.flow === "timing" &&
    records.some((record) => record.status === "unavailable")
  ) {
    const unavailable = records.filter((record) => record.status === "unavailable");
    return records.length === 4 && unavailable.length === 2 &&
      unavailable.every((record) => ["holdMarker", "lateMarker"].includes(record.scenario) && record.shell === "unknown" && record.availability === "unavailable" && record.errorKind === "shellUnavailable" && record.startup === "notObserved" && record.disposition === "unknown" && record.markerMatched === "notChecked" && record.sentinelMatches === 0 && record.driveCount === 0 && record.readyCount === 0 && record.timeoutCount === 0 && record.sameTickCount === 0 && record.sentObserved === 0 && record.snapshotReads === 0 && record.cleanup === "notStarted") &&
      records.filter((record) => record.status === "passed").every((record) => ["manualTimeout", "sameTick"].includes(record.scenario) && validTimingOutcome(record))
      ? records.map((record) => record.status === "passed" ? { scenario: definition.group, status: "passed", elapsedMs: record.elapsedMs, ...sampleProjection(record) } : { scenario: definition.group, status: "unavailable", elapsedMs: record.elapsedMs, failure: "unavailable", ...sampleProjection(record) })
      : undefined;
  }
  if (
    definition.flow === "da1" &&
    (records.length !== 6 ||
      records.filter((record) => record.priority === "completed").length !== 1 ||
      ["reject", "zero", "partial", "unknown"].some((fault) => records.filter((record) => record.fault === fault).length !== 1) ||
      records.filter((record) => record.fault === "none").length !== 2 ||
      records.some(
        (record) =>
          !["none", "reject", "zero", "partial", "unknown"].includes(record.fault) ||
          !["pwsh", "windowsPowerShell"].includes(record.shell) ||
          record.availability !== "available" || record.renderer !== "unmounted" ||
          record.status !== "passed" ||
          !exactNumbers(record, ["elapsedMs", "queries", "committed", "rejected", "zero", "partial", "unknown", "fatal", "priorityElapsedMs", "submittedBytes"]) ||
          !["notRun", "completed"].includes(record.priority) ||
          (record.priority === "completed" && (record.fault !== "none" || record.submittedBytes !== 1048576 || record.priorityElapsedMs > 500)) ||
          (record.priority === "notRun" && (record.priorityElapsedMs !== 0 || record.submittedBytes <= 0)) ||
          (record.fault === "none" && (record.queries !== 6 || record.committed !== 6 || record.rejected || record.zero || record.partial || record.unknown || record.fatal || record.fallback !== "notApplicable" || record.visibleMarkers !== "preserved" || record.fakeSequences !== "preserved" || record.cleanup !== "killed")) ||
          ((record.fault === "reject" || record.fault === "zero") && (record.queries !== 6 || record.committed !== 5 || record[record.fault === "reject" ? "rejected" : "zero"] !== 1 || record.fatal !== 0 || record.partial !== 0 || record.unknown !== 0 || record.fallback !== "observed" || record.visibleMarkers !== "preserved" || record.fakeSequences !== "preserved" || record.cleanup !== "killed")) ||
          ((record.fault === "partial" || record.fault === "unknown") && (record.queries !== 1 || record.committed !== 0 || record[record.fault] !== 1 || record.fatal !== 1 || record.rejected !== 0 || record.zero !== 0 || (record.fault === "partial" && record.unknown !== 0) || (record.fault === "unknown" && record.partial !== 0) || record.fallback !== "notApplicable" || !["killed", "alreadyGone"].includes(record.cleanup))),
      ))
  )
    return undefined;
  if (
    definition.flow === "timing" &&
    (records.length !== 4 ||
      new Set(records.map((record) => record.scenario)).size !== 4 ||
      !["holdMarker", "manualTimeout", "lateMarker", "sameTick"].every((scenario) => records.some((record) => record.scenario === scenario)) ||
      records.some(
        (record) =>
          !validTimingOutcome(record) ||
          !Number.isSafeInteger(record.sentinelMatches) ||
          record.sentinelMatches !== 1,
      ))
  )
    return undefined;
  return resultSamples(definition, records);
}
export function aggregateMatrix(plan, state) {
  if (!validState(state, plan)) return undefined;
  const samples = state.cases.flatMap((entry) => entry.samples ?? []);
  const counts = Object.fromEntries(
    ["passed", "failed", "timeout", "unavailable", "pending", "running"].map(
      (status) => [
        status,
        samples.filter((sample) => sample.status === status).length,
      ],
    ),
  );
  const coverage = Object.fromEntries(
    [...new Set(plan.map((entry) => entry.group))]
      .sort()
      .map((group) => [
        group,
        plan
          .filter((entry) => entry.group === group)
          .reduce((total, entry) => total + entry.sampleCount, 0),
      ]),
  );
  const times = samples
    .filter((sample) => sample.status === "passed")
    .map((sample) => sample.elapsedMs);
  const correctness = zeroCorrectness();
  for (const sample of samples) {
    if (sample.status !== "passed") continue;
    for (const key of CORRECTNESS_KEYS)
      correctness[key] += sample.correctness[key];
  }
  const excluded = Object.fromEntries(EXCLUDED_KEYS.map((reason) => [
    reason,
    samples.filter((sample) => sample.exclusion === reason).length,
  ]));
  return {
    schema: "windows-terminal-startup-matrix-v2",
    status: state.cases.every(
      (entry) => entry.status === "passed" || entry.status === "unavailable",
    )
      ? "complete"
      : "incomplete",
    counts,
    coverage,
    timing: {
      p50Ms: percentile(times, 50) ?? 0,
      p95Ms: percentile(times, 95) ?? 0,
      maxMs: times.length ? Math.max(...times) : 0,
    },
    environment: { ...state.binding },
    correctness,
    excluded,
    samples,
  };
}
export function isPrivacySafeSummary(value) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "correctness,counts,coverage,environment,excluded,samples,schema,status,timing" ||
    value.schema !== "windows-terminal-startup-matrix-v2" ||
    !["complete", "incomplete"].includes(value.status)
  )
    return false;
  const countsOk = (object) =>
    object &&
    Object.keys(object).sort().join(",") ===
      "failed,passed,pending,running,timeout,unavailable" &&
    Object.values(object).every((n) => Number.isSafeInteger(n) && n >= 0);
  const timingOk = (object) =>
    object &&
    Object.keys(object).sort().join(",") === "maxMs,p50Ms,p95Ms" &&
    Object.values(object).every((n) => Number.isSafeInteger(n) && n >= 0);
  const excludedOk =
    value.excluded &&
    Object.keys(value.excluded).sort().join(",") ===
      EXCLUDED_KEYS.slice().sort().join(",") &&
    Object.values(value.excluded).every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    );
  if (
    !Array.isArray(value.samples) ||
    !value.coverage ||
    typeof value.coverage !== "object" ||
    Array.isArray(value.coverage) ||
    !value.timing ||
    typeof value.timing !== "object" ||
    Array.isArray(value.timing)
  )
    return false;
  const totalSamples = value.samples.length;
  const totalCoverage = Object.values(value.coverage).reduce(
    (total, count) => total + count,
    0,
  );
  const complete = value.status === "complete";
  const expectedCorrectness = zeroCorrectness();
  const expectedExcluded = Object.fromEntries(
    EXCLUDED_KEYS.map((reason) => [reason, 0]),
  );
  const passedTimes = [];
  for (const sample of value.samples ?? []) {
    if (sample.status === "passed") {
      passedTimes.push(sample.elapsedMs);
      for (const key of CORRECTNESS_KEYS)
        expectedCorrectness[key] += sample.correctness[key];
    }
    if (EXCLUDED_KEYS.includes(sample.exclusion))
      expectedExcluded[sample.exclusion] += 1;
  }
  const timingConsistent =
    value.timing.p50Ms === (percentile(passedTimes, 50) ?? 0) &&
    value.timing.p95Ms === (percentile(passedTimes, 95) ?? 0) &&
    value.timing.maxMs === (passedTimes.length ? Math.max(...passedTimes) : 0);
  return (
    countsOk(value.counts) &&
    value.coverage &&
    Object.keys(value.coverage).sort().join(",") ===
      [...MATRIX_GROUPS].sort().join(",") &&
    Object.values(value.coverage).every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) &&
    timingOk(value.timing) &&
    Array.isArray(value.samples) &&
    value.samples.every(safeSample) &&
    new Set(value.samples.map((sample) => sample.attemptId)).size ===
      value.samples.length &&
    Object.values(value.counts).reduce((total, count) => total + count, 0) ===
      totalSamples &&
    validBinding(value.environment) &&
    validCorrectness(value.correctness) &&
    JSON.stringify(value.correctness) === JSON.stringify(expectedCorrectness) &&
    excludedOk &&
    JSON.stringify(value.excluded) === JSON.stringify(expectedExcluded) &&
    timingConsistent &&
    (!complete ||
      (totalSamples === totalCoverage &&
        value.counts.failed === 0 &&
        value.counts.timeout === 0 &&
        value.counts.pending === 0 &&
        value.counts.running === 0 &&
        value.samples.every(
          (sample) =>
            sample.status === "passed" || sample.status === "unavailable",
        )))
  );
}
export function isFinalDecision(summary) {
  return Boolean(
    summary &&
      summary.status === "complete" &&
      isPrivacySafeSummary(summary) &&
      Object.values(summary.correctness).every((count) => count === 0) &&
      summary.counts.failed === 0 &&
      summary.counts.timeout === 0 &&
      summary.counts.pending === 0 &&
      summary.counts.running === 0,
  );
}
function finalizable(plan, state) {
  return isFinalDecision(aggregateMatrix(plan, state));
}
function formatMarkdown(summary) {
  const groups = Object.keys(summary.coverage).sort();
  const completed = Object.fromEntries(
    groups.map((group) => [
      group,
      summary.samples.filter((sample) => sample.scenario === group).length,
    ]),
  );
  return [
    "# Windows terminal startup matrix",
    "",
    "Status: complete",
    "",
    "## Environment",
    "",
    `- Artifact mode: ${summary.environment.artifactMode}`,
    `- Release mode: ${summary.environment.releaseMode}`,
    `- OS: ${summary.environment.osFamily} ${summary.environment.osBuild}`,
    `- WebView2: ${summary.environment.webview2Version}`,
    `- tauri-driver: ${summary.environment.tauriDriverVersion}`,
    `- EdgeDriver: ${summary.environment.edgeDriverVersion}`,
    `- Node: ${summary.environment.nodeVersion}`,
    `- Git head: ${summary.environment.gitHead}`,
    `- Dirty: ${summary.environment.gitDirty}`,
    "",
    "## Excluded reasons",
    "",
    `- shellUnavailable: ${summary.excluded.shellUnavailable}`,
    `- toolUnavailable: ${summary.excluded.toolUnavailable}`,
    "",
    "## Correctness gate",
    "",
    `blank: ${summary.correctness.blank}; unwritable: ${summary.correctness.unwritable}; duplicate: ${summary.correctness.duplicate}; lostDa1: ${summary.correctness.lostDa1}; orphan: ${summary.correctness.orphan}`,
    "",
    "## Decision",
    "",
    summary.status === "complete" && Object.values(summary.correctness).every((count) => count === 0)
      ? "PASS"
      : "HOLD",
    "",
    "## Samples",
    "",
    "| Group | Completed | Planned |",
    "| --- | ---: | ---: |",
    ...groups.map(
      (group) => `| ${group} | ${completed[group]} | ${summary.coverage[group]} |`,
    ),
    "",
    "## Groups",
    "",
    "## Timing",
    "",
    `p50: ${summary.timing.p50Ms} ms; p95: ${summary.timing.p95Ms} ms; max: ${summary.timing.maxMs} ms.`,
    "",
  ].join("\n");
}
async function probePortClear(port) {
  return new Promise((done) => {
    let settled = false;
    const finish = (clear) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(clear);
    };
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED"));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function defaultPortClear({ cleanupMs = CLEANUP_MS, pollMs = 100 } = {}) {
  const deadline = Date.now() + cleanupMs;
  do {
    const clear = await Promise.all([4444, 4445].map(probePortClear));
    if (clear.every(Boolean)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, Math.min(pollMs, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

function safeRawPath(rawRoot, id) {
  mkdirSync(rawRoot, { recursive: true });
  const rootStat = lstatSync(rawRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("matrix-raw-root-invalid");
  const canonicalRoot = realpathSync.native(rawRoot);
  const rawPath = resolve(canonicalRoot, `${id}.jsonl`);
  const contained = relative(canonicalRoot, rawPath);
  if (!contained || contained.includes(sep) || isAbsolute(contained))
    throw new Error("matrix-raw-path-invalid");
  return rawPath;
}

export async function runChildCase(
  definition,
  { spawnChild = spawn, rawPath, waitForPorts = defaultPortClear } = {},
) {
  const env = {
    ...process.env,
    THREADTERM_WDIO_ARTIFACT: definition.artifact,
    THREADTERM_WDIO_FLOW: definition.flow,
    THREADTERM_WDIO_COLD_REPEATS: "1",
    THREADTERM_WDIO_MATRIX_REPORT: rawPath,
  };
  for (const [definitionKey, envName] of [
    ["encodingCase", "THREADTERM_WDIO_ENCODING_CASE"],
    ["warmupCase", "THREADTERM_WDIO_WARMUP_CASE"],
    ["concurrency", "THREADTERM_WDIO_CONCURRENCY"],
    ["providerRepeats", "THREADTERM_WDIO_PROVIDER_REPEATS"],
    ["providerShell", "THREADTERM_WDIO_PROVIDER_SHELL"],
  ])
    if (definition[definitionKey] !== undefined)
      env[envName] = String(definition[definitionKey]);
  const child = spawnChild(
    process.execPath,
    [join(root, "tools", "windows-terminal-startup", "run.mjs")],
    { cwd: root, env, stdio: "ignore", windowsHide: true },
  );
  const exit = await new Promise((resolveExit) => {
    let settled = false;
    let expired = false;
    let deadlineTimer;
    let cleanupTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(cleanupTimer);
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      resolveExit(value);
    };
    child.once("error", () => finish({ kind: "runnerFailed" }));
    child.once("exit", (code) =>
      finish({
        kind: expired
          ? "deadlineExceeded"
          : code === 0
            ? "exitedZero"
            : "runnerFailed",
      }),
    );
    deadlineTimer = setTimeout(() => {
      expired = true;
      try {
        child.kill();
      } catch {}
      cleanupTimer = setTimeout(
        () => finish({ kind: "deadlineExceeded" }),
        CLEANUP_MS,
      );
    }, definition.deadlineMs);
  });
  const portsClear = await waitForPorts({ cleanupMs: CLEANUP_MS });
  if (!portsClear) return { outcome: "cleanupFailed" };
  if (exit.kind === "deadlineExceeded") return { outcome: "deadlineExceeded" };
  if (exit.kind !== "exitedZero") return { outcome: "runnerFailed" };
  try {
    const samples = validateRawEvidence(
      definition,
      readFileSync(rawPath, "utf8"),
    );
    return samples
      ? { outcome: "passed", samples }
      : { outcome: "runnerFailed" };
  } catch {
    return { outcome: "runnerFailed" };
  }
}
export async function executeMatrix({
  plan = createMatrixPlan(),
  binding,
  stateFile = statePath,
  rawRoot = reportsRoot,
  finalJson = finalJsonPath,
  finalMarkdown = finalMarkdownPath,
  runCase = runChildCase,
} = {}) {
  if (!validatePlan(plan)) throw new Error("matrix-plan-invalid");
  if (!validBinding(binding)) throw new Error("matrix-binding-required");
  const state = loadState(stateFile, plan, binding);
  for (const definition of plan) {
    const entry = state.cases.find((item) => item.id === definition.id);
    if (TERMINAL.has(entry.status)) continue;
    entry.status = "running";
    atomic(stateFile, state);
    const rawPath = safeRawPath(rawRoot, definition.id);
    if (existsSync(rawPath)) {
      const rawStat = lstatSync(rawPath);
      if (!rawStat.isFile() || rawStat.isSymbolicLink())
        throw new Error("matrix-raw-evidence-invalid");
      if (state.resumedIds?.has(definition.id))
        rmSync(rawPath, { force: true });
      else throw new Error("matrix-raw-evidence-preexisting");
    }
    const result = await runCase(definition, { rawPath });
    const samples = result?.samples?.map((sample) => ({
      ...sample,
      attemptId: randomUUID(),
    }));
    const failure =
      result?.outcome === "deadlineExceeded"
        ? "deadlineExceeded"
        : result?.outcome === "cleanupFailed"
          ? "cleanupFailed"
          : "runnerFailed";
    if (
      result?.outcome !== "passed" ||
      !samples ||
      samples.length !== definition.sampleCount
    )
      Object.assign(entry, {
        status: failure === "deadlineExceeded" ? "timeout" : "failed",
        samples: [
          {
            attemptId: randomUUID(),
            scenario: definition.group,
            status: failure === "deadlineExceeded" ? "timeout" : "failed",
            elapsedMs: 0,
            failure,
            correctness: zeroCorrectness(),
            exclusion: "none",
          },
        ],
      });
    else
      Object.assign(entry, {
        status: samples.every((sample) => sample.status === "passed")
          ? "passed"
          : "unavailable",
        samples,
      });
    atomic(stateFile, state);
  }
  const summary = aggregateMatrix(plan, state);
  if (!summary || !isPrivacySafeSummary(summary))
    throw new Error("matrix-evidence-invalid");
  if (finalizable(plan, state)) {
    atomic(finalJson, summary);
    mkdirSync(dirname(finalMarkdown), { recursive: true });
    writeFileSync(
      finalMarkdown,
      formatMarkdown(summary),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return summary;
}
const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    executeMatrix({ binding: captureReleaseBinding() })
      .then((summary) => {
        if (!isFinalDecision(summary)) process.exitCode = 1;
      })
      .catch(() => {
        process.stderr.write("terminal-startup-matrix-failed\n");
        process.exitCode = 1;
      });
  } catch {
    process.stderr.write("terminal-startup-matrix-failed\n");
    process.exitCode = 1;
  }
}
