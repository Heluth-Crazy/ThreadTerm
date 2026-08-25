import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import {
  aggregateMatrix,
  captureReleaseBinding,
  createMatrixPlan,
  createReleaseBinding,
  DEFAULT_BINDING_ARTIFACT_PATHS,
  executeMatrix,
  isPrivacySafeSummary,
  isFinalDecision,
  isValidReleaseBinding,
  loadState,
  percentile,
  parseWebView2RegistryOutput,
  readWebView2Version,
  runChildCase,
  readTauriDriverVersion,
  selectTrustedGitExecutable,
  SHIPPING_HARNESS_COMMAND_COUNT,
  validatePlan,
  validateRawEvidence,
} from "./matrix.mjs";

const plan = createMatrixPlan();
const root = resolve(import.meta.dirname, "../..");
const tauriDriverMetadata = {
  installs: {
    "tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)": {
      bins: ["tauri-driver"],
      profile: "release",
    },
  },
};
const binding = createReleaseBinding({
  osBuild: "10.0.26100",
  webview2Version: "128.0.2739.42",
  tauriDriverVersion: "2.1.0",
  tauriDriverDigest: "1111111111111111111111111111111111111111111111111111111111111111",
  edgeDriverVersion: "128.0.2739.42",
  edgeDriverDigest: "2222222222222222222222222222222222222222222222222222222222222222",
  nodeVersion: "22.15.0",
  gitHead: "0123456789abcdef0123456789abcdef01234567",
  gitDirty: false,
  gitDirtyDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  productionBinaryDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  harnessBinaryDigest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  runnerConfigDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  flagsPlanDigest: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
});
const cleanupRow = JSON.stringify({
  runnerCleanup: "verified",
  driverSupervisor: "exited",
  wdioSupervisor: "exited",
  appTree: "gone",
  tauriDriverPort: "refused",
  nativeDriverPort: "refused",
  sandbox: "removed",
});
const runner = `${cleanupRow}\n{"runnerStage":"complete","outcome":"success"}\n`;
const provider = (shell, slot, repetition, expectedConcurrency = 1, overrides = {}) =>
  JSON.stringify({
    kind: "harness-provider",
    artifact: "harness",
    flow: "provider",
    shell,
    slot,
    repetition,
    expectedConcurrency,
    peakConcurrentAlive: expectedConcurrency,
    barrierReleased: true,
    sessionDisappeared: true,
    status: "passed",
    availability: "available",
    startup: "sent",
    disposition: "created",
    shellFamily: shell === "cmd" ? "cmd" : shell,
    sentinelMatches: 1,
    cleanup: "cleaned",
    elapsedMs: 1,
    correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 },
    exclusion: "none",
    ...overrides,
  });
const evidence = (record, exclusion = "none") => ({
  ...record,
  correctness: {
    blank: 0,
    unwritable: 0,
    duplicate: 0,
    lostDa1: 0,
    orphan: 0,
  },
  exclusion,
});
test("plan has exact versioned shape and one 30-create warm process", () => {
  assert.equal(validatePlan(plan), true);
  assert.equal(plan.length, 44);
  const warm = plan.find((entry) => entry.group === "warm");
  assert.deepEqual(
    warm && {
      flow: warm.flow,
      providerRepeats: warm.providerRepeats,
      providerShell: warm.providerShell,
      sampleCount: warm.sampleCount,
    },
    {
      flow: "provider",
      providerRepeats: 30,
      providerShell: "cmd",
      sampleCount: 30,
    },
  );
  assert.equal(validatePlan([...plan].reverse()), false);
  assert.equal(plan.filter((entry) => entry.group === "cold").length, 10);
  assert.equal(plan.filter((entry) => entry.group === "sameId").length, 5);
  assert.equal(plan.some((entry) => entry.flow === "float"), false);
  assert.deepEqual(
    plan.filter((entry) => entry.group === "concurrency").map((entry) => entry.concurrency),
    [1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 20, 20, 20, 20, 20],
  );
  const listener = plan.find((entry) => entry.flow === "listener");
  assert.deepEqual(
    listener && {
      artifact: listener.artifact,
      flow: listener.flow,
      group: listener.group,
      sampleCount: listener.sampleCount,
    },
    {
      artifact: "harness",
      flow: "listener",
      group: "listener",
      sampleCount: 2,
    },
  );
  const surface = plan.find((entry) => entry.flow === "surface");
  assert.deepEqual(
    surface && {
      artifact: surface.artifact,
      flow: surface.flow,
      group: surface.group,
      sampleCount: surface.sampleCount,
    },
    {
      artifact: "harness",
      flow: "surface",
      group: "surface",
      sampleCount: 1,
    },
  );
});
test("default binding artifact paths share the runner cache layout", () => {
  assert.match(
    DEFAULT_BINDING_ARTIFACT_PATHS.edgeDriver,
    /[\\/]\.cache[\\/]windows-terminal-startup[\\/]msedgedriver\.exe$/i,
  );
  assert.match(
    DEFAULT_BINDING_ARTIFACT_PATHS.productionBinary,
    /[\\/]\.cache[\\/]windows-terminal-startup[\\/]target[\\/]release[\\/]threadterm\.exe$/i,
  );
});
test("safe encoding Git receipt is accepted after fixed candidates fail", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "matrix-git-receipt-"));
  try {
    const receipt = join(fixtureRoot, "git.exe");
    writeFileSync(receipt, "fixture");
    assert.equal(
      selectTrustedGitExecutable(
        [join(fixtureRoot, "missing", "git.exe")],
        receipt,
      ),
      receipt,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
test("release binding is strict, deterministic, and dependency-injectable", () => {
  assert.equal(isValidReleaseBinding(binding), true);
  const commands = [];
  const files = [];
  let revision = 0;
  const head = "0123456789abcdef0123456789abcdef01234567";
  const readFile = (path) => {
    files.push(path);
    return Buffer.from(`fixture:${revision}:${path}`);
  };
  const runCommand = (command, args) => {
    commands.push([command, ...args]);
    if (command === "cmd.exe") return "Microsoft Windows [Version 10.0.26100.1]";
    if (command === "reg.exe") return "pv REG_SZ 128.0.2739.42";
    if (command === "msedgedriver") return "Microsoft Edge WebDriver 128.0.2739.42";
    if (command === "node") return "v22.15.0";
    if (command === "git" && args.includes("rev-parse")) return `${head}\n`;
    if (command === "git" && args.includes("status")) return "";
    if (command === "git" && args.includes("diff")) return "";
    throw new Error(`unexpected command: ${command}`);
  };
  const captureOptions = {
    platform: "win32",
    readFile,
    runCommand,
    runnerConfig: "runner.json",
    tauriDriverMetadata,
  };
  const captured = captureReleaseBinding(captureOptions);
  revision = 1;
  const changed = captureReleaseBinding(captureOptions);
  assert.equal(isValidReleaseBinding(captured), true);
  assert.equal(isValidReleaseBinding(changed), true);
  assert.notEqual(captured.runnerConfigDigest, changed.runnerConfigDigest);
  assert.notEqual(captured.tauriDriverDigest, changed.tauriDriverDigest);
  assert.notEqual(captured.edgeDriverDigest, changed.edgeDriverDigest);
  assert.notEqual(captured.bindingId, changed.bindingId);
  assert.deepEqual(
    Object.keys(captured).sort(),
    [
      "artifactMode", "bindingId", "edgeDriverVersion", "flagsPlanDigest",
      "edgeDriverDigest",
      "gitDirty", "gitDirtyDigest", "gitHead", "harnessBinaryDigest",
      "nodeVersion", "osBuild", "osFamily", "productionBinaryDigest",
      "releaseMode", "runnerConfigDigest", "tauriDriverDigest",
      "tauriDriverVersion",
      "webview2Version",
    ].sort(),
  );
  assert.ok(commands.some(([command]) => command === "reg.exe"));
  assert.ok(files.some((path) => path.endsWith(".cache\\windows-terminal-startup\\target\\release\\threadterm.exe")));
  assert.ok(files.some((path) => path.endsWith(".cache\\windows-terminal-startup\\harness-target\\release\\threadterm.exe")));
  assert.throws(
    () => captureReleaseBinding({ platform: "linux", runCommand: () => { throw new Error("must not run"); } }),
    /matrix-binding-unavailable/,
  );
  for (const key of Object.keys(binding)) {
    const mutated = { ...binding };
    if (typeof mutated[key] === "boolean") mutated[key] = !mutated[key];
    else if (key === "bindingId") mutated[key] = "f".repeat(64);
    else if (key === "gitHead") mutated[key] = `1${mutated[key].slice(1)}`;
    else if (key.endsWith("Digest")) mutated[key] = "f".repeat(64);
    else mutated[key] = `${mutated[key]}.1`;
    assert.equal(isValidReleaseBinding(mutated), false, key);
    const missing = { ...binding };
    delete missing[key];
    assert.equal(isValidReleaseBinding(missing), false, `missing ${key}`);
  }
  assert.equal(isValidReleaseBinding({ ...binding, extra: true }), false);
});
test("binding collector fails closed for unsafe command paths and command timeouts", () => {
  const unsafe = {
    cmd: "..\\cmd.exe",
    reg: "C:\\Windows\\System32\\reg.exe",
    node: "C:\\node.exe",
    git: "C:\\Git\\git.exe",
    edgeDriver: "C:\\msedgedriver.exe",
    tauriDriver: "C:\\tauri-driver.exe",
  };
  assert.throws(
    () => captureReleaseBinding({ platform: "win32", commandPaths: unsafe, runCommand: () => "" }),
    /matrix-binding-unavailable/,
  );
  const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  assert.throws(
    () => captureReleaseBinding({ platform: "win32", runCommand: () => { throw timeout; } }),
    /matrix-binding-unavailable/,
  );
});
test("tauri-driver metadata is strict and never executes the driver for version", () => {
  assert.equal(readTauriDriverVersion({ metadata: tauriDriverMetadata }), "2.1.0");
  const malformed = [
    {},
    { installs: [] },
    { installs: { "tauri-driver 2.1.0 registry": { bins: ["tauri-driver"] } } },
    {
      installs: {
        "tauri-driver 2.1.0 (registry-a)": { bins: ["tauri-driver"] },
        "tauri-driver 2.1.1 (registry-b)": { bins: ["tauri-driver"] },
      },
    },
    {
      installs: {
        "tauri-driver 2.1.0 (registry-a)": { bins: ["other"], profile: "release" },
      },
    },
    {
      installs: {
        "tauri-driver 2.1.0 (registry-a)": { bins: ["tauri-driver"], profile: "debug" },
      },
    },
  ];
  for (const metadata of malformed)
    assert.throws(
      () => readTauriDriverVersion({ metadata }),
      /matrix-binding-unavailable/,
    );
});
test("WebView2 binding queries the exact product key and parses only one pv row", () => {
  const output = [
    "HKEY_LOCAL_MACHINE\\...\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "    name    REG_SZ    Microsoft Edge WebView2 Runtime 2.0.0.34",
    "    pv      REG_SZ    128.0.2739.42",
  ].join("\n");
  assert.equal(parseWebView2RegistryOutput(output), "128.0.2739.42");
  const calls = [];
  assert.equal(
    readWebView2Version((command, args) => {
      calls.push([command, ...args]);
      return output;
    }),
    "128.0.2739.42",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5\}$/i);

  const fallbackCalls = [];
  assert.equal(
    readWebView2Version((command, args) => {
      fallbackCalls.push([command, ...args]);
      if (args[1].startsWith("HKLM\\")) throw new Error("missing HKLM");
      return "pv REG_SZ 129.0.1.2\n";
    }),
    "129.0.1.2",
  );
  assert.equal(fallbackCalls.length, 2);
  assert.match(fallbackCalls[1][2], /^HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\/i);

  for (const malformed of [
    "name REG_SZ WebView2 2.0.0.34\n",
    "pv REG_SZ 128.0.2739.42\npv REG_SZ 129.0.1.2\n",
    "pv REG_DWORD 128.0.2739.42\n",
    "pv REG_SZ 128.0.2739.42 extra\n",
  ]) {
    assert.throws(
      () => parseWebView2RegistryOutput(malformed),
      /matrix-binding-unavailable/,
    );
  }
  assert.throws(
    () => readWebView2Version(() => { throw new Error("both missing"); }),
    /matrix-binding-unavailable/,
  );
});
test("dirty digest binds normalized untracked path/content pairs", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const firstPath = "tools/windows-terminal-startup/matrix.mjs";
  const secondPath = "tools/windows-terminal-startup/matrix.contract.test.mjs";
  const values = new Map([[firstPath, "first"], [secondPath, "second"]]);
  const runCommand = (command, args) => {
    if (command === "cmd.exe") return "Microsoft Windows [Version 10.0.26100.1]";
    if (command === "reg.exe") return "pv REG_SZ 128.0.2739.42";
    if (command === "msedgedriver") return "Microsoft Edge WebDriver 128.0.2739.42";
    if (command === "node") return "v22.15.0";
    if (command === "git" && args.includes("rev-parse")) return `${head}\n`;
    if (command === "git" && args.includes("status")) return `?? ${firstPath}\0?? ${secondPath}\0`;
    if (command === "git" && args.includes("diff")) return "";
    throw new Error("unexpected command");
  };
  const readFile = (path) => {
    const normalized = path.slice(root.length + 1).split("\\").join("/");
    return Buffer.from(values.get(normalized) ?? `fixture:${normalized}`);
  };
  const options = {
    platform: "win32",
    readFile,
    runCommand,
    runnerConfig: "runner.json",
    tauriDriverMetadata,
  };
  const first = captureReleaseBinding(options);
  values.set(firstPath, "second");
  values.set(secondPath, "first");
  const swapped = captureReleaseBinding(options);
  assert.equal(first.gitDirty, true);
  assert.equal(swapped.gitDirty, true);
  assert.notEqual(first.gitDirtyDigest, swapped.gitDirtyDigest);
});
test("provider evidence requires exact dispatch invariants, while optional shells may be unavailable", () => {
  const warm = plan.find((entry) => entry.group === "warm");
  const good = `${runner}${Array.from({ length: 30 }, (_, i) => provider("cmd", 1, i + 1)).join("\n")}\n`;
  assert.equal(
    validateRawEvidence(warm, good.replace('"sentinelMatches":1', '"sentinelMatches":2')),
    undefined,
  );
  const cold = plan.find((entry) => entry.group === "cold");
  const unavailable = JSON.stringify({
    kind: "harness-provider", artifact: "harness", flow: "provider", shell: "pwsh", slot: 1, repetition: 1,
    expectedConcurrency: 1, peakConcurrentAlive: 0, barrierReleased: false, sessionDisappeared: true,
    status: "unavailable", availability: "unavailable", startup: "notObserved", disposition: "unknown", shellFamily: "unknown", sentinelMatches: 0,
    cleanup: "notStarted", errorKind: "shellUnavailable", elapsedMs: 1,
    correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 }, exclusion: "shellUnavailable",
  });
  assert.equal(validateRawEvidence(cold, `${runner}${unavailable}\n${provider("windowsPowerShell", 1, 1)}\n${provider("cmd", 1, 1)}\n`)?.length, 3);
  assert.equal(validateRawEvidence(cold, `${runner}${unavailable.replace('"pwsh"', '"cmd"')}\n${provider("windowsPowerShell", 1, 1)}\n${provider("cmd", 1, 1)}\n`), undefined);
});
test("provider raw JSONL rejects duplicate, missing, failed, and unallowed unavailable samples", () => {
  const warm = plan.find((entry) => entry.group === "warm");
  const good = `${runner}${Array.from({ length: 30 }, (_, i) => provider("cmd", 1, i + 1)).join("\n")}\n`;
  assert.equal(validateRawEvidence(warm, good)?.length, 30);
  assert.equal(
    validateRawEvidence(
      warm,
      good.replace(provider("cmd", 1, 30), provider("cmd", 1, 29)),
    ),
    undefined,
  );
  assert.equal(
    validateRawEvidence(warm, `${runner}${provider("cmd", 1, 1)}\n`),
    undefined,
  );
});
test("every flow requires one exact cleanup row before runner success", () => {
  const cold = plan.find((entry) => entry.group === "cold");
  const records = [provider("pwsh", 1, 1), provider("windowsPowerShell", 1, 1), provider("cmd", 1, 1)];
  const good = `${runner}${records.join("\n")}\n`;
  assert.equal(validateRawEvidence(cold, good)?.length, 3);
  assert.equal(validateRawEvidence(cold, good.replace(`${cleanupRow}\n`, "")), undefined, "missing cleanup");
  assert.equal(validateRawEvidence(cold, good.replace(runner, `${cleanupRow}\n${runner}`)), undefined, "duplicate cleanup");
  assert.equal(validateRawEvidence(cold, good.replace('"runnerCleanup":"verified"', '"runnerCleanup":"wrong"')), undefined, "wrong cleanup");
  const runnerOnly = '{"runnerStage":"complete","outcome":"success"}';
  assert.equal(validateRawEvidence(cold, `${runnerOnly}\n${cleanupRow}\n${records.join("\n")}\n`), undefined, "cleanup after runner");
});
test("provider concurrency reports require complete per-slot barrier evidence", () => {
  const raw = (rows) => `${runner}${rows.join("\n")}\n`;
  const single = plan.find(
    (entry) => entry.group === "concurrency" && entry.concurrency === 1 && entry.repetition === 1,
  );
  const singleRows = ["pwsh", "windowsPowerShell", "cmd"].map((shell) =>
    provider(shell, 1, 1),
  );
  assert.equal(validateRawEvidence(single, raw(singleRows))?.length, 3);

  const concurrency = plan.find(
    (entry) => entry.group === "concurrency" && entry.concurrency === 5 && entry.repetition === 1,
  );
  const rows = ["pwsh", "windowsPowerShell", "cmd"].flatMap((shell) =>
    Array.from({ length: 5 }, (_, index) => provider(shell, index + 1, 1, 5)),
  );
  assert.equal(validateRawEvidence(concurrency, raw(rows))?.length, 15);

  for (const [field, value] of [
    ["expectedConcurrency", 4],
    ["peakConcurrentAlive", 4],
    ["barrierReleased", false],
    ["sessionDisappeared", false],
  ]) {
    const mutated = rows.map((row, index) => {
      if (index !== 0) return row;
      return JSON.stringify({ ...JSON.parse(row), [field]: value });
    });
    assert.equal(validateRawEvidence(concurrency, raw(mutated)), undefined, field);
  }

  const missing = JSON.parse(rows[0]);
  delete missing.expectedConcurrency;
  assert.equal(
    validateRawEvidence(concurrency, raw([JSON.stringify(missing), ...rows.slice(1)])),
    undefined,
    "missing provider dispatch field",
  );
  assert.equal(
    validateRawEvidence(
      concurrency,
      raw([JSON.stringify({ ...JSON.parse(rows[0]), unexpected: true }), ...rows.slice(1)]),
    ),
    undefined,
    "extra provider dispatch field",
  );
  assert.equal(
    validateRawEvidence(
      concurrency,
      raw(rows.map((row, index) => index === 4 ? JSON.stringify({ ...JSON.parse(row), slot: 4 }) : row)),
    ),
    undefined,
    "duplicate provider slot",
  );
  assert.equal(
    validateRawEvidence(
      concurrency,
      raw(rows.map((row, index) => index === 0 ? JSON.stringify({ ...JSON.parse(row), repetition: 2 }) : row)),
    ),
    undefined,
    "provider repetition does not match round",
  );
});
test("provider optional-shell rows cannot claim barrier release", () => {
  const concurrency = plan.find(
    (entry) => entry.group === "concurrency" && entry.concurrency === 5 && entry.repetition === 1,
  );
  const unavailable = (slot) => JSON.stringify({
    kind: "harness-provider",
    artifact: "harness",
    flow: "provider",
    shell: "pwsh",
    slot,
    repetition: 1,
    expectedConcurrency: 5,
    peakConcurrentAlive: 0,
    barrierReleased: false,
    sessionDisappeared: true,
    status: "unavailable",
    availability: "unavailable",
    startup: "notObserved",
    disposition: "unknown",
    shellFamily: "unknown",
    sentinelMatches: 0,
    cleanup: "notStarted",
    errorKind: "shellUnavailable",
    elapsedMs: 1,
    correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 },
    exclusion: "shellUnavailable",
  });
  const rows = [
    ...Array.from({ length: 5 }, (_, index) => unavailable(index + 1)),
    ...Array.from({ length: 5 }, (_, index) => provider("windowsPowerShell", index + 1, 1, 5)),
    ...Array.from({ length: 5 }, (_, index) => provider("cmd", index + 1, 1, 5)),
  ];
  const raw = (items) => `${runner}${items.join("\n")}\n`;
  assert.equal(validateRawEvidence(concurrency, raw(rows))?.length, 15);
  for (const field of ["barrierReleased", "sessionDisappeared"]) {
    const mutated = rows.map((row, index) => {
      if (index !== 0) return row;
      return JSON.stringify({ ...JSON.parse(row), [field]: field === "barrierReleased" });
    });
    assert.equal(validateRawEvidence(concurrency, raw(mutated)), undefined, field);
  }
});
test("raw lifecycle requires complete-success and exact flow schema", () => {
  const production = plan[0];
  assert.equal(
    validateRawEvidence(
      production,
      `${runner}${JSON.stringify(evidence({ kind: "public-ui-release-smoke", status: "passed", elapsedMs: 1, harnessCommandsChecked: SHIPPING_HARNESS_COMMAND_COUNT }))}\n`,
    )?.length,
    1,
  );
  const surface = plan.find((entry) => entry.flow === "surface");
  const surfaceRecord = {
    kind: "harness-surface-lifecycle",
    artifact: "harness",
    flow: "surfaceLifecycle",
    shell: "pwsh",
    availability: "available",
    status: "passed",
    create: "created",
    nonceReadbacks: 2,
    identityStable: "yes",
    generationStable: "yes",
    providerStartup: "sent",
    providerStartupDispatches: 1,
    floatAttach: "observed",
    hiddenReveal: "observed",
    recycleToMain: "observed",
    resize: "observed",
    writeAfterReveal: "observed",
    close: "requested",
    sessionGone: "yes",
    ptyCleanupCalls: 0,
    harnessCleanupCalls: 1,
    orphanSessions: 0,
    lruUnload: "notExercised",
    cleanup: "observed",
    elapsedMs: 1,
  };
  assert.equal(validateRawEvidence(surface, `${runner}${JSON.stringify(evidence(surfaceRecord))}\n`)?.length, 1);
  for (const [field, value] of [
    ["kind", "wrong-kind"],
    ["artifact", "production"],
    ["flow", "surface"],
    ["shell", "posix"],
    ["availability", "unavailable"],
    ["status", "failed"],
    ["create", "notObserved"],
    ["nonceReadbacks", 1],
    ["identityStable", "no"],
    ["generationStable", "no"],
    ["providerStartup", "notObserved"],
    ["providerStartupDispatches", 0],
    ["floatAttach", "notObserved"],
    ["hiddenReveal", "notObserved"],
    ["recycleToMain", "notObserved"],
    ["resize", "notObserved"],
    ["writeAfterReveal", "notObserved"],
    ["close", "notRequested"],
    ["sessionGone", "no"],
    ["ptyCleanupCalls", 1],
    ["harnessCleanupCalls", 0],
    ["orphanSessions", 1],
    ["lruUnload", "observed"],
    ["cleanup", "failed"],
    ["elapsedMs", -1],
  ]) {
    assert.equal(
      validateRawEvidence(surface, `${runner}${JSON.stringify(evidence({ ...surfaceRecord, [field]: value }))}\n`),
      undefined,
      `surface mutation must fail closed: ${field}`,
    );
  }
  assert.equal(
    validateRawEvidence(surface, `${runner}${JSON.stringify(evidence({ ...surfaceRecord, extra: true }))}\n`),
    undefined,
    "surface extra field must fail closed",
  );
  for (const field of Object.keys(surfaceRecord)) {
    const missingSurfaceField = { ...surfaceRecord };
    delete missingSurfaceField[field];
    assert.equal(
      validateRawEvidence(surface, `${runner}${JSON.stringify(evidence(missingSurfaceField))}\n`),
      undefined,
      `surface missing field must fail closed: ${field}`,
    );
  }
  assert.equal(validateRawEvidence(production, `${runner}${JSON.stringify(evidence({ kind: "public-ui-release-smoke", status: "passed", elapsedMs: 1, harnessCommandsChecked: 4 }))}\n`), undefined);
  assert.equal(
    validateRawEvidence(
      production,
      `${JSON.stringify({ runnerStage: "complete", outcome: "failed" })}\n${JSON.stringify(evidence({ kind: "public-ui-release-smoke", status: "passed", elapsedMs: 1, harnessCommandsChecked: SHIPPING_HARNESS_COMMAND_COUNT }))}\n`,
    ),
    undefined,
  );
  assert.equal(
    validateRawEvidence(
      production,
      `${runner}${JSON.stringify(evidence({ kind: "public-ui-release-smoke", status: "passed", elapsedMs: 1, harnessCommandsChecked: SHIPPING_HARNESS_COMMAND_COUNT }))}\n{}\n`,
    ),
    undefined,
  );
});
test("shipping report count is tied to the authoritative helper command list", () => {
  const helpers = readFileSync(join(root, "e2e", "terminal-startup", "helpers.ts"), "utf8");
  const list = helpers.match(/export const SHIPPING_HARNESS_COMMANDS = \[([\s\S]*?)\] as const;/);
  assert.ok(list);
  assert.equal((list[1].match(/^\s*"terminal_startup_harness_[^"]+",/gm) ?? []).length, SHIPPING_HARNESS_COMMAND_COUNT);
});
test("timing, DA1, encoding, and warmup evidence reject unknown fields and required invariant mutations", () => {
  const timing = plan.find((entry) => entry.flow === "timing");
  const timingRecord = (scenario) => { const counts = { holdMarker: [1, 1, 0, 0], manualTimeout: [1, 0, 1, 0], lateMarker: [2, 1, 1, 0], sameTick: [1, 0, 0, 1] }[scenario]; return evidence({ kind: "harness-provider-timing", artifact: "harness", flow: "timing", scenario, shell: "pwsh", availability: "available", status: "passed", startup: "sent", disposition: "created", shellFamily: "pwsh", markerMatched: "yes", sentinelMatches: 1, driveCount: counts[0], readyCount: counts[1], timeoutCount: counts[2], sameTickCount: counts[3], sentObserved: 1, snapshotReads: 1, cleanup: "cleaned", elapsedMs: 1 }); };
  const timingRaw = `${runner}${["holdMarker", "manualTimeout", "lateMarker", "sameTick"].map((scenario) => JSON.stringify(timingRecord(scenario))).join("\n")}\n`;
  assert.equal(validateRawEvidence(timing, timingRaw)?.length, 4);
  assert.equal(validateRawEvidence(timing, timingRaw.replace('"sentObserved":1', '"sentObserved":0')), undefined);
  assert.equal(validateRawEvidence(timing, timingRaw.replace('"elapsedMs":1', '"elapsedMs":1,"extra":true')), undefined);
  const da1 = plan.find((entry) => entry.flow === "da1");
  const da1Record = (fault, priority = "notRun") => { const terminal = fault === "partial" || fault === "unknown"; return evidence({ kind: "harness-da1", artifact: "harness", flow: "da1", fault, status: "passed", shell: "pwsh", availability: "available", renderer: "unmounted", queries: terminal ? 1 : 6, committed: fault === "none" ? 6 : terminal ? 0 : 5, rejected: fault === "reject" ? 1 : 0, zero: fault === "zero" ? 1 : 0, partial: fault === "partial" ? 1 : 0, unknown: fault === "unknown" ? 1 : 0, fatal: terminal ? 1 : 0, visibleMarkers: "preserved", fakeSequences: "preserved", fallback: fault === "reject" || fault === "zero" ? "observed" : "notApplicable", priority, priorityElapsedMs: priority === "completed" ? 10 : 0, submittedBytes: priority === "completed" ? 1048576 : 1, cleanup: "killed", elapsedMs: 1 }); };
  const da1Raw = `${runner}${[["none", "notRun"], ["none", "completed"], ["reject", "notRun"], ["zero", "notRun"], ["partial", "notRun"], ["unknown", "notRun"]].map(([fault, priority]) => JSON.stringify(da1Record(fault, priority))).join("\n")}\n`;
  assert.equal(validateRawEvidence(da1, da1Raw)?.length, 6);
  assert.equal(validateRawEvidence(da1, da1Raw.replace('"renderer":"unmounted"', '"renderer":"mounted"')), undefined);
});
test("listener evidence requires both ordered scenarios and rejects every invariant mutation", () => {
  const definition = plan.find((entry) => entry.flow === "listener");
  const listenerRecord = (scenario, overrides = {}) => evidence({
    kind: "harness-listener-reconciliation",
    artifact: "harness",
    flow: "listener",
    scenario,
    shell: "pwsh",
    availability: "available",
    status: "passed",
    listenerBeforeCreate: true,
    rendererDropped: scenario === "rendererDropQuery",
    listenerReestablished: scenario === "rendererDropQuery",
    eventObserved: scenario === "listenerBeforeCreate" ? 1 : 0,
    eventGapReconciled: scenario === "rendererDropQuery",
    queryReconciled: true,
    generationStable: true,
    identityStable: true,
    markerHeld: true,
    startup: "sent",
    sentinelMatches: 1,
    sentObserved: 1,
    attachCount: 2,
    queryReads: 3,
    cleanup: "killedAndConfirmed",
    cleanupKillCalls: 1,
    elapsedMs: 1,
    ...overrides,
  }, overrides.exclusion ?? (overrides.status === "unavailable" ? "shellUnavailable" : "none"));
  const before = listenerRecord("listenerBeforeCreate");
  const drop = listenerRecord("rendererDropQuery");
  const raw = (rows) => `${runner}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  assert.equal(validateRawEvidence(definition, raw([before, drop]))?.length, 2);

  const mutations = {
    kind: "wrong-kind",
    artifact: "production",
    flow: "timing",
    shell: "unknown",
    availability: "unavailable",
    status: "failed",
    errorKind: "unexpected",
    listenerBeforeCreate: false,
    rendererDropped: true,
    listenerReestablished: true,
    eventObserved: 2,
    eventGapReconciled: true,
    queryReconciled: false,
    generationStable: false,
    identityStable: false,
    markerHeld: false,
    startup: "notObserved",
    sentinelMatches: 2,
    sentObserved: 2,
    attachCount: 1,
    queryReads: 0,
    cleanup: "cleanupFailed",
    cleanupKillCalls: 2,
    elapsedMs: -1,
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.equal(
      validateRawEvidence(definition, raw([{ ...before, [field]: value }, drop])),
      undefined,
      `listener mutation must fail closed: ${field}`,
    );
  }
  assert.equal(
    validateRawEvidence(
      definition,
      raw([{ ...before, extra: true }, drop]),
    ),
    undefined,
  );
  assert.equal(validateRawEvidence(definition, raw([before, before])), undefined);
  assert.equal(validateRawEvidence(definition, raw([drop, before])), undefined);
  assert.equal(validateRawEvidence(definition, raw([before])), undefined);

  const unavailable = (scenario) => listenerRecord(scenario, {
    shell: "unknown",
    availability: "unavailable",
    status: "unavailable",
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
    errorKind: "shellUnavailable",
  });
  assert.equal(validateRawEvidence(definition, raw([
    unavailable("listenerBeforeCreate"),
    unavailable("rendererDropQuery"),
  ]))?.length, 2);
  assert.equal(
    validateRawEvidence(definition, raw([unavailable("listenerBeforeCreate"), drop])),
    undefined,
  );

  const resumeDirectory = mkdtempSync(join(tmpdir(), "listener-matrix-resume-"));
  const resumePath = join(resumeDirectory, "state.json");
  writeFileSync(
    resumePath,
    JSON.stringify({
      schema: "windows-terminal-startup-matrix-state-v2",
      binding,
      cases: plan.map((entry) => ({
        id: entry.id,
        status: entry.id === definition.id ? "running" : "pending",
      })),
    }),
  );
  const resumed = loadState(resumePath, plan, binding);
  assert.equal(
    resumed.cases.find((entry) => entry.id === definition.id).status,
    "pending",
  );
  assert.equal(resumed.resumedIds.has(definition.id), true);
  rmSync(resumeDirectory, { recursive: true, force: true });

  const completeState = {
    schema: "windows-terminal-startup-matrix-state-v2",
    binding,
    cases: plan.map((entry, caseIndex) => ({
      id: entry.id,
      status: "passed",
      samples: Array.from({ length: entry.sampleCount }, (_, sampleIndex) => ({
        attemptId: `00000000-0000-4000-8000-${String(caseIndex * 100 + sampleIndex).padStart(12, "0")}`,
        scenario: entry.group,
        status: "passed",
        elapsedMs: 1,
        correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 },
        exclusion: "none",
      })),
    })),
  };
  const summary = aggregateMatrix(plan, completeState);
  assert.equal(summary.status, "complete");
  assert.equal(summary.coverage.listener, 2);
  assert.equal(summary.coverage.surface, 1);
  assert.equal(summary.coverage.float, undefined);
});
test("encoding definitions require each Cartesian shell/mode report and reject a mutated invariant", () => {
  const definition = (encodingCase) => ({ ...plan.find((entry) => entry.flow === "encoding" && entry.encodingCase === encodingCase) });
  const report = (shell, mode, encodingCase, availability = "available") => evidence({
    kind: "harness-encoding", artifact: "harness", flow: "encoding", shell, mode, availability,
    status: availability === "available" ? "passed" : "unavailable", utf8: encodingCase, providerReady: "disabled", da1Authority: "disabled", warmup: "disabled",
    shellFamily: availability === "available" ? shell : "unknown", markerMatched: mode === "syntheticProvider" ? "no" : "notApplicable", markerLeaks: 0,
    sentinelMatches: availability === "available" ? 1 : 0, roundTrip: availability === "unavailable" && encodingCase === "enabled" ? "failed" : encodingCase === "enabled" ? "passed" : "notRequired", roundTripMatches: availability === "available" ? 1 : 0,
    git: availability === "available" ? "passed" : "failed", node: availability === "available" ? "passed" : "failed", python: availability === "available" ? "passed" : "failed", cmd: availability === "available" ? "passed" : "failed",
    probePassed: availability === "available" ? 4 : 0, probeUnavailable: 0, probeFailed: 0, cleanup: availability === "available" ? "killed" : "notPrepared", elapsedMs: 1,
  }, availability === "unavailable" ? "shellUnavailable" : "none");
  for (const encodingCase of ["enabled", "disabled"]) {
    const rows = ["pwsh", "windowsPowerShell"].flatMap((shell) => ["plain", "syntheticProvider"].map((mode) => report(shell, mode, encodingCase)));
    const raw = `${runner}${rows.map(JSON.stringify).join("\n")}\n`;
    assert.equal(validateRawEvidence(definition(encodingCase), raw)?.length, 4);
    const bad = structuredClone(rows); bad[0].warmup = "enabled";
    assert.equal(validateRawEvidence(definition(encodingCase), `${runner}${bad.map(JSON.stringify).join("\n")}\n`), undefined);
    const unavailable = rows.map((row) => row.shell === "pwsh" ? report("pwsh", row.mode, encodingCase, "unavailable") : row);
    assert.equal(validateRawEvidence(definition(encodingCase), `${runner}${unavailable.map(JSON.stringify).join("\n")}\n`)?.length, 4);
  }
});
test("every warmup case has a real-shaped accepted row and rejects a case invariant mutation", () => {
  const scenarios = { off: ["disabled", "disabled"], normalSuccess: ["normal", "completed"], clickBeforeGrace: ["holdBeforeGrace", "skippedForRealCreate"], spawnFailure: ["spawnFailure", "failed"], neverExit: ["neverExit", "timedOut"], clickDuringHold: ["holdBeforeNativeSpawn", "skippedForRealCreate"] };
  for (const [warmupCase, [scenario, warmup]] of Object.entries(scenarios)) {
    const definition = plan.find((entry) => entry.flow === "warmup" && entry.warmupCase === warmupCase);
    const row = evidence({ kind: "harness-warmup", artifact: "harness", flow: "warmup", case: warmupCase, scenario, status: "passed", warmup, disposition: "created", create: "created", write: "observed", cleanup: "killed", starts: warmupCase === "off" ? 0 : 1, realCreateSeen: warmupCase.includes("click") ? 1 : 0, nativeSpawnAttempted: ["normalSuccess", "spawnFailure", "neverExit"].includes(warmupCase) ? 1 : 0, childSpawned: ["normalSuccess", "neverExit"].includes(warmupCase) ? 1 : 0, skippedForRealCreate: warmupCase.includes("click") ? 1 : 0, holdWaitTimedOut: 0, holdBeforeGraceWaitTimedOut: 0, holdBeforeGraceEntered: warmupCase === "clickBeforeGrace", holdBeforeGraceReleased: warmupCase === "clickBeforeGrace", holdBeforeGraceTimedOut: false, killAttempted: warmupCase === "neverExit" ? 1 : 0, reapConfirmed: ["normalSuccess", "neverExit"].includes(warmupCase) ? 1 : 0, reapTimedOut: 0, elapsedMs: 1, createElapsedMs: 1 });
    const raw = `${runner}${JSON.stringify(row)}\n`;
    assert.equal(validateRawEvidence(definition, raw)?.length, 1);
    const mutation = { off: "starts", normalSuccess: "reapConfirmed", spawnFailure: "childSpawned", neverExit: "killAttempted", clickBeforeGrace: "holdBeforeGraceReleased", clickDuringHold: "skippedForRealCreate" }[warmupCase];
    const bad = { ...row, [mutation]: typeof row[mutation] === "boolean" ? !row[mutation] : row[mutation] + 1 };
    assert.equal(validateRawEvidence(definition, `${runner}${JSON.stringify(bad)}\n`), undefined);
  }
});
test("a mixed available and optional-unavailable provider case remains a valid unavailable terminal case", () => {
  const cold = plan.find((entry) => entry.group === "cold");
  const samples = [
    { attemptId: "00000000-0000-4000-8000-000000000001", scenario: "cold", status: "unavailable", elapsedMs: 1, failure: "unavailable", correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 }, exclusion: "shellUnavailable" },
    { attemptId: "00000000-0000-4000-8000-000000000002", scenario: "cold", status: "passed", elapsedMs: 1, correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 }, exclusion: "none" },
    { attemptId: "00000000-0000-4000-8000-000000000003", scenario: "cold", status: "passed", elapsedMs: 1, correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 }, exclusion: "none" },
  ];
  const state = { schema: "windows-terminal-startup-matrix-state-v2", binding, cases: plan.map((entry) => entry.id === cold.id ? { id: entry.id, status: "unavailable", samples } : { id: entry.id, status: "pending" }) };
  assert.ok(aggregateMatrix(plan, state));
});
test("corrupt state fails closed while only well-formed running resumes", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const path = join(dir, "state.json");
  writeFileSync(path, "not-json");
  assert.throws(() => loadState(path, plan, binding), /matrix-state-corrupt/);
  writeFileSync(
    path,
    JSON.stringify({
      schema: "windows-terminal-startup-matrix-state-v2",
      binding,
      cases: plan.map((entry, index) => ({
        id: entry.id,
        status: index === 0 ? "running" : "pending",
      })),
    }),
  );
  assert.equal(loadState(path, plan, binding).cases[0].status, "pending");
  rmSync(dir, { recursive: true, force: true });
});
test("resume requires byte-equivalent binding and never deletes mismatched raw evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-binding-"));
  const stateFile = join(dir, "state.json");
  const rawRoot = join(dir, "raw");
  const rawPath = join(rawRoot, `${plan[0].id}.jsonl`);
  const changedFields = [
    ["productionBinaryDigest", "f".repeat(64)],
    ["tauriDriverDigest", "f".repeat(64)],
    ["edgeDriverDigest", "f".repeat(64)],
    ["gitHead", "f".repeat(40)],
    ["gitDirty", true],
    ["gitDirtyDigest", "f".repeat(64)],
    ["runnerConfigDigest", "f".repeat(64)],
    ["flagsPlanDigest", "f".repeat(64)],
  ];
  for (const [field, value] of changedFields) {
    const changed = createReleaseBinding({ ...binding, [field]: value });
    writeFileSync(stateFile, JSON.stringify({
      schema: "windows-terminal-startup-matrix-state-v2",
      binding: changed,
      cases: plan.map((entry, index) => ({ id: entry.id, status: index === 0 ? "running" : "pending" })),
    }));
    mkdirSync(rawRoot, { recursive: true });
    writeFileSync(rawPath, "keep-this-raw\n");
    await assert.rejects(
      executeMatrix({ binding, stateFile, rawRoot, finalJson: join(dir, "final.json"), finalMarkdown: join(dir, "final.md"), runCase: async () => undefined }),
      /matrix-state-binding-mismatch/,
      field,
    );
    assert.equal(readFileSync(rawPath, "utf8"), "keep-this-raw\n", field);
  }
  writeFileSync(stateFile, JSON.stringify({
    schema: "windows-terminal-startup-matrix-state-v2",
    binding,
    cases: plan.map((entry, index) => ({ id: entry.id, status: index === 0 ? "running" : "pending" })),
  }));
  assert.equal(loadState(stateFile, plan, binding).cases[0].status, "pending");
  rmSync(dir, { recursive: true, force: true });
});
test("percentiles and recursive privacy schema reject extra fields", () => {
  assert.equal(percentile([1, 2, 3], 95), 3);
  const state = {
    schema: "windows-terminal-startup-matrix-state-v2",
    binding,
    cases: plan.map((entry, caseIndex) => ({
      id: entry.id,
      status: "passed",
      samples: Array.from({ length: entry.sampleCount }, (_, index) => ({
        attemptId: `00000000-0000-4000-8000-${String(caseIndex * 1000 + index).padStart(12, "0")}`,
        scenario: entry.group,
        status: "passed",
        elapsedMs: 1,
        correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 },
        exclusion: "none",
      })),
    })),
  };
  const summary = aggregateMatrix(plan, state);
  assert.equal(isPrivacySafeSummary(summary), true);
  summary.samples[0].cwd = "forbidden";
  assert.equal(isPrivacySafeSummary(summary), false);
  summary.samples[0].attemptId = "not-a-uuid";
  assert.equal(isPrivacySafeSummary(summary), false);
});
test("complete evidence has consistent counts and writes group and timing summary only after every case passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const finalJson = join(dir, "final.json");
  const finalMarkdown = join(dir, "final.md");
  const summary = await executeMatrix({
    binding,
    stateFile: join(dir, "state.json"), rawRoot: join(dir, "raw"), finalJson, finalMarkdown,
    runCase: async (definition) => ({ outcome: "passed", samples: Array.from({ length: definition.sampleCount }, () => ({ scenario: definition.group, status: "passed", elapsedMs: 1, correctness: { blank: 0, unwritable: 0, duplicate: 0, lostDa1: 0, orphan: 0 }, exclusion: "none" })) }),
  });
  assert.equal(summary.status, "complete");
  assert.equal(summary.counts.passed, plan.reduce((count, entry) => count + entry.sampleCount, 0));
  assert.match(readFileSync(finalMarkdown, "utf8"), /\| Group \| Completed \| Planned \|/);
  assert.match(readFileSync(finalMarkdown, "utf8"), /p50: 1 ms; p95: 1 ms; max: 1 ms/);
  rmSync(dir, { recursive: true, force: true });
});
test("complete correctness failures are not a final decision and preserve old evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-correctness-"));
  const finalJson = join(dir, "final.json");
  writeFileSync(finalJson, "old-final\n");
  const summary = await executeMatrix({
    binding,
    stateFile: join(dir, "state.json"),
    rawRoot: join(dir, "raw"),
    finalJson,
    finalMarkdown: join(dir, "final.md"),
    runCase: async (definition) => ({
      outcome: "passed",
      samples: Array.from({ length: definition.sampleCount }, (_, index) => ({
        scenario: definition.group,
        status: "passed",
        elapsedMs: 1,
        correctness: {
          blank: index === 0 && definition.id === plan[0].id ? 1 : 0,
          unwritable: 0,
          duplicate: 0,
          lostDa1: 0,
          orphan: 0,
        },
        exclusion: "none",
      })),
    }),
  });
  assert.equal(summary.status, "complete");
  assert.equal(isPrivacySafeSummary(summary), true);
  assert.equal(isFinalDecision(summary), false);
  assert.equal(readFileSync(finalJson, "utf8"), "old-final\n");
  rmSync(dir, { recursive: true, force: true });
});
test("resumed raw evidence rejects directory targets before deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const rawRoot = join(dir, "raw");
  const stateFile = join(dir, "state.json");
  const resumed = {
    schema: "windows-terminal-startup-matrix-state-v2",
    binding,
    cases: plan.map((entry, index) => ({ id: entry.id, status: index === 0 ? "running" : "pending" })),
  };
  writeFileSync(stateFile, JSON.stringify(resumed));
  const rawDirectory = join(rawRoot, `${plan[0].id}.jsonl`);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(rawDirectory, { recursive: true }));
  await assert.rejects(
    executeMatrix({ binding, stateFile, rawRoot, finalJson: join(dir, "final.json"), finalMarkdown: join(dir, "final.md"), runCase: async () => undefined }),
    /matrix-raw-evidence-invalid/,
  );
  rmSync(dir, { recursive: true, force: true });
});
test("a symlinked raw root is rejected before any resumed evidence deletion", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const target = join(dir, "target");
  const rawRoot = join(dir, "raw-link");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { recursive: true }));
    symlinkSync(target, rawRoot, "junction");
  } catch (error) {
    t.skip(`symlinks unavailable: ${error instanceof Error ? error.code : "unknown"}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  await assert.rejects(
    executeMatrix({ binding, stateFile: join(dir, "state.json"), rawRoot, finalJson: join(dir, "final.json"), finalMarkdown: join(dir, "final.md"), runCase: async () => undefined }),
    /matrix-raw-root-invalid/,
  );
  rmSync(dir, { recursive: true, force: true });
});
test("any gate failure preserves existing final evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  const finalJson = join(dir, "final.json");
  writeFileSync(finalJson, "preserve");
  const summary = await executeMatrix({
    binding,
    stateFile: join(dir, "state.json"),
    rawRoot: join(dir, "raw"),
    finalJson,
    finalMarkdown: join(dir, "final.md"),
    runCase: async () => undefined,
  });
  assert.equal(summary.status, "incomplete");
  assert.equal(readFileSync(finalJson, "utf8"), "preserve");
  rmSync(dir, { recursive: true, force: true });
});
test("timeout kills the direct runner and waits for its late exit before port clearance", async () => {
  const order = [];
  class Child extends EventEmitter {
    kill() {
      order.push("kill");
      setTimeout(() => {
        order.push("exit");
        this.emit("exit", 1);
      }, 1);
    }
  }
  const result = await runChildCase(
    { ...plan[0], deadlineMs: 1 },
    {
      rawPath: join(tmpdir(), "unused.jsonl"),
      spawnChild: () => new Child(),
      waitForPorts: async () => {
        order.push("ports");
        return true;
      },
    },
  );
  assert.equal(result.outcome, "deadlineExceeded");
  assert.deepEqual(order, ["kill", "exit", "ports"]);
});
test("child receives every matrix case environment control", async () => {
  let childEnv;
  class Child extends EventEmitter {}
  const result = await runChildCase(
    { ...plan.find((entry) => entry.group === "warm"), encodingCase: "enabled", warmupCase: "off", concurrency: 5 },
    {
      rawPath: join(tmpdir(), "unused.jsonl"),
      spawnChild: (_command, _args, options) => {
        childEnv = options.env;
        const child = new Child();
        queueMicrotask(() => child.emit("exit", 1));
        return child;
      },
      waitForPorts: async (options) => {
        assert.equal(options.cleanupMs, 30_000);
        return true;
      },
    },
  );
  assert.equal(result.outcome, "runnerFailed");
  assert.deepEqual(
    Object.fromEntries(["THREADTERM_WDIO_ENCODING_CASE", "THREADTERM_WDIO_WARMUP_CASE", "THREADTERM_WDIO_CONCURRENCY", "THREADTERM_WDIO_PROVIDER_REPEATS", "THREADTERM_WDIO_PROVIDER_SHELL"].map((key) => [key, childEnv[key]])),
    { THREADTERM_WDIO_ENCODING_CASE: "enabled", THREADTERM_WDIO_WARMUP_CASE: "off", THREADTERM_WDIO_CONCURRENCY: "5", THREADTERM_WDIO_PROVIDER_REPEATS: "30", THREADTERM_WDIO_PROVIDER_SHELL: "cmd" },
  );
});
