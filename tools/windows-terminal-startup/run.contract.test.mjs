import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildSync, transformSync } from "esbuild";

import {
  assertDriverPortsAvailable,
  appendRunnerCleanupEvidence,
  appendAppObservationDiagnostic,
  appendNativeDriverStatusDiagnostic,
  attestHarnessBinaryIdentity,
  classifyPortProbeError,
  classifyNativeDriverStatusResponse,
  classifyProductionDisposableProfileObservation,
  classifyIsolationDriverUdfEvidence,
  classifyIsolationDriverEligibility,
  classifyIsolationLifecycleEvidence,
  classifyIsolationRuntimeUdfAttestation,
  classifyProductionSingleInstanceObservation,
  driverUdfRuntimeIsolationStatus,
  evaluateOfflineWebViewIsolation,
  encodeSupervisorLaunchSpec,
  buildRunEnv,
  buildProcessObservationEnvironment,
  discoverProviderShellAvailability,
  isOwnedProcessTreeGone,
  parseHarnessIdentifiersConfig,
  parseProductionIdentifierConfig,
  probeNativeDriverStatus,
  projectOwnedAppObservation,
  nativeDriverStatusAllowsWdio,
  runAfterProductionPreflight,
  runAfterProductionSingleInstancePreflight,
  validateMatrixReportPath,
  isMatrixRawReportsDirectory,
  resolveSafeLocalPathExecutable,
  canonicalPwshExecutable,
  discoverCanonicalEncodingToolReceipts,
  discoverCanonicalShellReceipts,
  shellDiscoveryPlan,
  isolationWaitEvidence,
  isolationIncompleteWorkerFailureEvidence,
  isolationTimeoutStage,
  stripIsolationWdioStageDiagnostics,
  shouldWaitForIsolationWdioSession,
  shouldAppendNativeDriverStatusDiagnostic,
  wdioSessionDeadline,
  shouldObserveRuntimeIsolation,
  shouldPublishRuntimeIsolationMarker,
  retainOwnedThreadTermIdentity,
  runtimeIsolationRequirements,
  reduceIsolationLifecycleSnapshot,
  reduceIsolationWdioPollDecision,
  waitForIsolationDriverUdfEvidence,
  waitForIsolationRuntimeUdfEvidence,
  waitForDriverPortsReady,
} from "./run.mjs";

const root = resolve(import.meta.dirname, "../..");
const offlineBrowserArguments = [
  "disable-background-networking",
  "host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE asset.localhost,EXCLUDE tauri.localhost,EXCLUDE 127.0.0.1,EXCLUDE ::1",
];
const testLayout = {
  udf: "C:\\runner\\webview",
  dataRoot: "C:\\runner\\data",
  runtimeIsolationMarker: "C:\\runner\\marker",
  sandbox: "C:\\runner",
  temp: "C:\\runner\\temp",
};
const harnessApp = join(
  root,
  ".cache",
  "windows-terminal-startup",
  "harness-target",
  "release",
  "threadterm.exe",
);

test("matrix-v2 report paths accept one contained new file and reject legacy, sibling, symlink, and stale paths", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "threadterm-matrix-v2-"));
  const raw = join(sandbox, "matrix-v2", "raw");
  const accepted = join(raw, "sample.jsonl");
  try {
    assert.equal(validateMatrixReportPath(accepted, raw), accepted);
    assert.throws(() => validateMatrixReportPath(join(sandbox, "matrix-v1", "raw", "sample.jsonl"), raw), /matrix-report-path-invalid/);
    assert.throws(() => validateMatrixReportPath(join(sandbox, "matrix-v2", "sibling", "sample.jsonl"), raw), /matrix-report-path-invalid/);
    writeFileSync(join(raw, "stale.jsonl"), "stale");
    assert.throws(() => validateMatrixReportPath(join(raw, "stale.jsonl"), raw), /matrix-report-path-stale/);

    assert.equal(isMatrixRawReportsDirectory({ isSymbolicLink: () => true, isDirectory: () => true }), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("shell availability is derived only from canonical runner receipts", () => {
  assert.deepEqual(
    discoverProviderShellAvailability("provider", {
      pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      windowsPowerShell: undefined,
      cmd: "C:\\Windows\\System32\\cmd.exe",
    }),
    { pwsh: true, windowsPowerShell: false, cmd: true },
  );
  assert.deepEqual(discoverProviderShellAvailability("production", {}), {
    pwsh: false,
    windowsPowerShell: false,
    cmd: false,
  });
});

test("safe local PATH resolver never probes unsafe entries and accepts nonstandard local receipts", () => {
  const source = {
    PATH: "\\\\server\\share;relative;. ;%LOCALAPPDATA%\\bin;C:/slash;C:\\Users\\runner\\AppData\\Local\\Microsoft\\WindowsApps;\"C:\\Tools\\Git\";C:\\Tools\\Python;C:\\Tools\\PowerShell",
  };
  const observed = [];
  const probe = (candidate, basename) => {
    observed.push(candidate);
    if (candidate === "C:\\Tools\\Git\\git.exe" && basename === "git.exe") return candidate;
    if (candidate === "C:\\Tools\\Python\\python.exe" && basename === "python.exe") return candidate;
    if (candidate === "C:\\Tools\\PowerShell\\pwsh.exe" && basename === "pwsh.exe") return candidate;
    return undefined;
  };
  assert.equal(resolveSafeLocalPathExecutable("git.exe", source, probe), "C:\\Tools\\Git\\git.exe");
  assert.equal(resolveSafeLocalPathExecutable("python.exe", source, probe), "C:\\Tools\\Python\\python.exe");
  assert.equal(resolveSafeLocalPathExecutable("pwsh.exe", source, probe), "C:\\Tools\\PowerShell\\pwsh.exe");
  assert.deepEqual(observed, [
    "C:\\Tools\\Git\\git.exe",
    "C:\\Tools\\Git\\python.exe",
    "C:\\Tools\\Python\\python.exe",
    "C:\\Tools\\Git\\pwsh.exe",
    "C:\\Tools\\Python\\pwsh.exe",
    "C:\\Tools\\PowerShell\\pwsh.exe",
  ]);
  assert.equal(resolveSafeLocalPathExecutable("git.exe", { PATH: "C:\\Tools\\Git" }, () => "C:\\Tools\\Git\\wrong.exe"), undefined);
  assert.equal(resolveSafeLocalPathExecutable("git.exe", { PATH: "C:\\Tools\\Git" }, () => undefined), undefined);
  assert.equal(resolveSafeLocalPathExecutable("git.exe", { PATH: "C:\\Tools\\Git" }, () => "\\\\?\\C:\\Tools\\Git\\git.exe"), "\\\\?\\C:\\Tools\\Git\\git.exe");
  assert.equal(
    canonicalPwshExecutable(
      { PATH: "C:\\Portable\\PowerShell" },
      (candidate) => candidate === "C:\\Portable\\PowerShell\\pwsh.exe" ? candidate : undefined,
    ),
    "C:\\Portable\\PowerShell\\pwsh.exe",
  );
});

test("flow-scoped harness discovery does not probe isolation or cmd-only provider tools", () => {
  const calls = [];
  const resolvers = {
    cmd: () => { calls.push("cmd"); return "C:\\Windows\\System32\\cmd.exe"; },
    pwsh: () => { calls.push("pwsh"); return "C:\\Tools\\pwsh.exe"; },
    windowsPowerShell: () => { calls.push("windowsPowerShell"); return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"; },
  };
  const isolation = shellDiscoveryPlan("harness", "isolation");
  assert.deepEqual(discoverCanonicalShellReceipts({}, isolation, resolvers), {
    cmd: "C:\\Windows\\System32\\cmd.exe", pwsh: undefined, windowsPowerShell: undefined,
  });
  assert.deepEqual(calls, ["cmd"]);
  assert.deepEqual(
    discoverCanonicalEncodingToolReceipts({}, isolation, () => {
      throw new Error("encoding-discovery-must-not-run");
    }),
    {},
  );
  calls.length = 0;
  const cmdProvider = shellDiscoveryPlan("harness", "provider", "cmd");
  assert.deepEqual(discoverCanonicalShellReceipts({}, cmdProvider, resolvers), {
    cmd: "C:\\Windows\\System32\\cmd.exe", pwsh: undefined, windowsPowerShell: undefined,
  });
  assert.deepEqual(calls, ["cmd"]);
});

test("harness child receives path receipts only for runner-attested shells", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `import { buildRunEnv } from ${JSON.stringify(new URL("./run.mjs", import.meta.url).href)}; console.log(JSON.stringify(buildRunEnv(${JSON.stringify(testLayout)}, { pwsh: true, windowsPowerShell: false, cmd: true }, { SYSTEMROOT: "C:\\\\Windows" }, "default-src 'self'", { pwsh: "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe", windowsPowerShell: "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", cmd: "C:\\\\Windows\\\\System32\\\\cmd.exe" })));`], {
    env: { ...process.env, THREADTERM_WDIO_ARTIFACT: "harness", THREADTERM_WDIO_FLOW: "provider" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(result.stdout);
  assert.equal(environment.THREADTERM_WDIO_PROVIDER_PWSH_PATH, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(environment.THREADTERM_WDIO_PROVIDER_CMD_PATH, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(environment.THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_PATH, undefined);
});

test("DA1 and warmup harness flows receive the same shell receipts as other PTY flows", () => {
  for (const flow of ["da1", "warmup"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `import { buildRunEnv } from ${JSON.stringify(new URL("./run.mjs", import.meta.url).href)}; console.log(JSON.stringify(buildRunEnv(${JSON.stringify(testLayout)}, { pwsh: true, windowsPowerShell: true, cmd: true }, { SYSTEMROOT: "C:\\\\Windows" }, "default-src 'self'", { pwsh: "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe", windowsPowerShell: "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", cmd: "C:\\\\Windows\\\\System32\\\\cmd.exe" })));`], {
      env: { ...process.env, THREADTERM_WDIO_ARTIFACT: "harness", THREADTERM_WDIO_FLOW: flow, THREADTERM_WDIO_WARMUP_CASE: "off" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const environment = JSON.parse(result.stdout);
    assert.equal(environment.THREADTERM_WDIO_PROVIDER_CMD_PATH, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(environment.THREADTERM_WDIO_PROVIDER_PWSH_PATH, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  }
});

test("terminal startup harness includes the project custom protocol feature", () => {
  const cargoToml = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
  const harnessFeature = cargoToml.match(
    /^terminal-startup-harness\s*=\s*\[([^\]]*)\]\s*$/m,
  );
  const customProtocolFeature = cargoToml.match(
    /^custom-protocol\s*=\s*\[([^\]]*)\]\s*$/m,
  );

  assert.ok(harnessFeature, "harness feature declaration is required");
  assert.ok(customProtocolFeature, "custom protocol feature declaration is required");
  assert.match(
    harnessFeature[1],
    /["']custom-protocol["']/,
    "harness must enable the project custom-protocol feature",
  );
  assert.match(
    customProtocolFeature[1],
    /["']tauri\/custom-protocol["']/,
    "project custom-protocol must enable tauri/custom-protocol",
  );
});

test("terminal startup harness uses a distinct fixed application identifier", () => {
  const baseConfigText = readFileSync(
    resolve(root, "src-tauri/tauri.conf.json"),
    "utf8",
  );
  const harnessConfigText = readFileSync(
    resolve(root, "src-tauri/tauri.webdriver.conf.json"),
    "utf8",
  );
  const baseConfig = JSON.parse(baseConfigText);
  const harnessConfig = JSON.parse(harnessConfigText);
  const identifiers = parseHarnessIdentifiersConfig(
    baseConfigText,
    harnessConfigText,
  );

  assert.equal(baseConfig.identifier, "com.Heluth-Crazy.threadterm");
  assert.equal(
    harnessConfig.identifier,
    "com.Heluth-Crazy.threadterm.terminal-startup-harness",
  );
  assert.notEqual(harnessConfig.identifier, baseConfig.identifier);
  assert.deepEqual(identifiers, {
    productionId: "com.Heluth-Crazy.threadterm",
    harnessId: "com.Heluth-Crazy.threadterm.terminal-startup-harness",
  });
});

test("production identifier parsing fails closed on configuration drift", () => {
  assert.equal(
    parseProductionIdentifierConfig(
      JSON.stringify({ identifier: "com.Heluth-Crazy.threadterm" }),
    ),
    "com.Heluth-Crazy.threadterm",
  );
  assert.throws(
    () =>
      parseProductionIdentifierConfig(
        JSON.stringify({ identifier: "com.Heluth-Crazy.threadterm.drifted" }),
      ),
    /production-identifier-config-unexpected/,
  );
});

test("harness binary attestation requires the harness identifier bytes", () => {
  const harnessId = "com.Heluth-Crazy.threadterm.terminal-startup-harness";
  assert.doesNotThrow(() =>
    attestHarnessBinaryIdentity(
      Buffer.from(`binary-prefix\0${harnessId}\0binary-suffix`, "utf8"),
      harnessId,
    ),
  );
  assert.throws(
    () =>
      attestHarnessBinaryIdentity(
        Buffer.from("com.Heluth-Crazy.threadterm", "utf8"),
        harnessId,
      ),
    /harness-identifier-not-embedded/,
  );
  assert.throws(
    () => attestHarnessBinaryIdentity("not-a-buffer", harnessId),
    /harness-identifier-attestation-input-invalid/,
  );
});

test("production single-instance observation accepts only absent or present", () => {
  assert.equal(
    classifyProductionSingleInstanceObservation({
      status: 0,
      stdout: "absent",
    }),
    "absent",
  );
  assert.equal(
    classifyProductionSingleInstanceObservation({
      status: 0,
      stdout: "present",
    }),
    "present",
  );
  for (const result of [
    undefined,
    { status: 1, stdout: "absent" },
    { status: 0, stdout: "" },
    { status: 0, stdout: "unknown" },
    { status: 0, stdout: "absent present" },
    { status: 0, stdout: "absent", error: new Error("tool failure") },
  ]) {
    assert.equal(
      classifyProductionSingleInstanceObservation(result),
      "invalid",
    );
  }
});

test("production single-instance preflight blocks side effects unless absence is exact", () => {
  const exercise = (observation) => {
    const effects = { observations: 0, writes: 0, spawns: 0 };
    const invoke = () =>
      runAfterProductionSingleInstancePreflight(
        "production",
        () => {
          effects.observations += 1;
          return observation;
        },
        () => {
          effects.writes += 1;
          effects.spawns += 1;
          return "started";
        },
      );
    return { effects, invoke };
  };

  const absent = exercise("absent");
  assert.equal(absent.invoke(), "started");
  assert.deepEqual(absent.effects, { observations: 1, writes: 1, spawns: 1 });

  const present = exercise("present");
  assert.throws(present.invoke, /production-single-instance-already-running/);
  assert.deepEqual(present.effects, {
    observations: 1,
    writes: 0,
    spawns: 0,
  });

  const invalid = exercise("invalid");
  assert.throws(invalid.invoke, /production-single-instance-observation-failed/);
  assert.deepEqual(invalid.effects, {
    observations: 1,
    writes: 0,
    spawns: 0,
  });

  const toolFailureEffects = { observations: 0, writes: 0, spawns: 0 };
  assert.throws(
    () =>
      runAfterProductionSingleInstancePreflight(
        "production",
        () => {
          toolFailureEffects.observations += 1;
          throw new Error("ambiguous tool failure");
        },
        () => {
          toolFailureEffects.writes += 1;
          toolFailureEffects.spawns += 1;
        },
      ),
    /production-single-instance-observation-failed/,
  );
  assert.deepEqual(toolFailureEffects, {
    observations: 1,
    writes: 0,
    spawns: 0,
  });
});

test("production disposable-profile attestation is exact and fails before every side effect", () => {
  for (const result of [
    { status: 0, stdout: "valid" },
    { status: 0, stdout: "valid\n" },
  ]) {
    assert.equal(classifyProductionDisposableProfileObservation(result), "valid");
  }
  for (const result of [
    undefined,
    { status: 1, stdout: "valid" },
    { status: 0, stdout: "invalid" },
    { status: 0, stdout: "valid extra" },
    { status: 0, stdout: "valid", error: new Error("tool failure") },
  ]) {
    assert.equal(classifyProductionDisposableProfileObservation(result), "invalid");
  }

  const exercise = (profileObservation, singleObservation = "absent") => {
    const effects = [];
    const invoke = () =>
      runAfterProductionPreflight(
        "production",
        () => {
          effects.push("profile");
          if (profileObservation instanceof Error) throw profileObservation;
          return profileObservation;
        },
        () => {
          effects.push("single");
          return singleObservation;
        },
        () => {
          effects.push("side-effect");
          return "started";
        },
      );
    return { effects, invoke };
  };

  const valid = exercise("valid");
  assert.equal(valid.invoke(), "started");
  assert.deepEqual(valid.effects, ["profile", "single", "side-effect"]);

  for (const observation of ["invalid", "missing", new Error("tool failure")]) {
    const blocked = exercise(observation);
    assert.throws(blocked.invoke, /production-disposable-profile-required/);
    assert.deepEqual(blocked.effects, ["profile"]);
  }

  const present = exercise("valid", "present");
  assert.throws(present.invoke, /production-single-instance-already-running/);
  assert.deepEqual(present.effects, ["profile", "single"]);
});

test("harness preflight bypasses both production-only observations", () => {
  const effects = [];
  const result = runAfterProductionPreflight(
    "harness",
    () => {
      effects.push("profile");
      return "invalid";
    },
    () => {
      effects.push("single");
      return "present";
    },
    () => {
      effects.push("side-effect");
      return "started";
    },
  );
  assert.equal(result, "started");
  assert.deepEqual(effects, ["side-effect"]);
});

test("harness artifacts bypass only the production single-instance preflight", () => {
  let observations = 0;
  let sideEffects = 0;
  const result = runAfterProductionSingleInstancePreflight(
    "harness",
    () => {
      observations += 1;
      return "present";
    },
    () => {
      sideEffects += 1;
      return "started";
    },
  );
  assert.equal(result, "started");
  assert.equal(observations, 0);
  assert.equal(sideEffects, 1);
});

test("production child environment omits harness browser capability and native WebView2 inputs", () => {
  const environment = buildRunEnv(testLayout, undefined, {
    PSModuleAnalysisCachePath: "C:\\real-user\\cache",
    PSDisableModuleAnalysisCacheCleanup: "0",
    webview2_additional_browser_arguments: "unexpected",
    WebView2_User_Data_Folder: "C:\\unexpected",
  });
  assert.equal(
    environment.THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS,
    undefined,
  );
  assert.equal(environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined);
  assert.equal(environment.WEBVIEW2_USER_DATA_FOLDER, undefined);
  assert.equal(environment.PSModuleAnalysisCachePath, "NUL");
  assert.equal(environment.PSDisableModuleAnalysisCacheCleanup, "1");

  const launchSpec = JSON.parse(
    Buffer.from(
      encodeSupervisorLaunchSpec(process.execPath, root, [], environment),
      "base64",
    ).toString("utf8"),
  );
  assert.equal(launchSpec.environment.PSModuleAnalysisCachePath, "NUL");
  assert.equal(launchSpec.environment.PSDisableModuleAnalysisCacheCleanup, "1");
});

test("harness child environment owns capability JSON but not native WebView2 inputs", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { buildRunEnv } from ${JSON.stringify(new URL("./run.mjs", import.meta.url).href)}; console.log(JSON.stringify(buildRunEnv(${JSON.stringify(testLayout)}, undefined, { SYSTEMROOT: "C:\\\\Windows", USERPROFILE: "C:\\\\real-user", APPDATA: "C:\\\\real-appdata", LOCALAPPDATA: "C:\\\\real-local", HOME: "C:\\\\real-home", webview2_additional_browser_arguments: "unexpected", WebView2_User_Data_Folder: "C:\\\\unexpected" }, "default-src 'self'", { cmd: "C:\\\\Windows\\\\System32\\\\cmd.exe" })));`,
    ],
    {
      env: {
        ...process.env,
        THREADTERM_WDIO_ARTIFACT: "harness",
        THREADTERM_WDIO_FLOW: "isolation",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(result.stdout);
  assert.equal(
    environment.THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS,
    JSON.stringify(offlineBrowserArguments),
  );
  assert.equal(environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined);
  assert.equal(environment.WEBVIEW2_USER_DATA_FOLDER, undefined);
  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(environment.PATH.includes("\\\\"), false);
  assert.equal(environment.PATH.toLowerCase().includes("\\users\\"), false);
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    assert.equal(environment[name].includes("real-"), false);
    assert.equal(environment[name].startsWith("C:\\runner\\profile\\"), true);
  }
  assert.equal(environment.POWERSHELL_TELEMETRY_OPTOUT, "1");
  assert.equal(environment.POWERSHELL_UPDATECHECK, "Off");
});

test("listener harness flow owns provider readiness and shell capability inputs", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { buildRunEnv } from ${JSON.stringify(new URL("./run.mjs", import.meta.url).href)}; console.log(JSON.stringify(buildRunEnv(${JSON.stringify(testLayout)}, { pwsh: true, windowsPowerShell: true, cmd: true }, { SYSTEMROOT: "C:\\\\Windows" }, "default-src 'self'", { pwsh: "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe", windowsPowerShell: "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", cmd: "C:\\\\Windows\\\\System32\\\\cmd.exe" })));`,
    ],
    {
      env: {
        ...process.env,
        THREADTERM_WDIO_ARTIFACT: "harness",
        THREADTERM_WDIO_FLOW: "listener",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(result.stdout);
  assert.equal(environment.THREADTERM_WDIO_FLOW, "listener");
  assert.equal(environment.THREADTERM_PROVIDER_SHELL_READY, "1");
  assert.equal(environment.THREADTERM_WDIO_PROVIDER_PWSH_AVAILABLE, "1");
  assert.equal(
    environment.THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_AVAILABLE,
    "1",
  );
  assert.equal(environment.THREADTERM_WDIO_PROVIDER_CMD_AVAILABLE, "1");
});

test("surface lifecycle harness flow is offline and owns provider readiness inputs", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { buildRunEnv } from ${JSON.stringify(new URL("./run.mjs", import.meta.url).href)}; console.log(JSON.stringify(buildRunEnv(${JSON.stringify(testLayout)}, { pwsh: true, windowsPowerShell: true, cmd: true }, { SYSTEMROOT: "C:\\\\Windows" }, "default-src 'self'", { pwsh: "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe", windowsPowerShell: "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", cmd: "C:\\\\Windows\\\\System32\\\\cmd.exe" })));`,
    ],
    {
      env: {
        ...process.env,
        THREADTERM_WDIO_ARTIFACT: "harness",
        THREADTERM_WDIO_FLOW: "surface",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(result.stdout);
  assert.equal(environment.THREADTERM_WDIO_FLOW, "surface");
  assert.equal(environment.THREADTERM_PROVIDER_SHELL_READY, "1");
  assert.equal(environment.THREADTERM_WDIO_PROVIDER_PWSH_AVAILABLE, "1");
  assert.equal(
    environment.THREADTERM_WDIO_PROVIDER_WINDOWS_POWERSHELL_AVAILABLE,
    "1",
  );
  assert.equal(environment.THREADTERM_WDIO_PROVIDER_CMD_AVAILABLE, "1");
  assert.equal(environment.THREADTERM_TERMINAL_STARTUP_HARNESS_OFFLINE, "1");
});

async function loadWdioConfig(environment) {
  const configPath = resolve(root, "e2e/terminal-startup/wdio.conf.ts");
  const outputDirectory = mkdtempSync(
    join(tmpdir(), "threadterm-wdio-contract-"),
  );
  const outputPath = join(outputDirectory, "wdio.conf.mjs");
  const originalEnvironment = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    buildSync({
      entryPoints: [configPath],
      outfile: outputPath,
      bundle: true,
      define: {
        "import.meta.url": JSON.stringify(pathToFileURL(configPath).href),
      },
      format: "esm",
      platform: "node",
      target: "node20",
    });
    return await import(`${pathToFileURL(outputPath).href}?${Date.now()}`);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

async function loadSurfaceDiagnosticHelpers() {
  const helpersPath = resolve(root, "e2e/terminal-startup/helpers.ts");
  const outputDirectory = mkdtempSync(
    join(tmpdir(), "threadterm-surface-diagnostic-contract-"),
  );
  const outputPath = join(outputDirectory, "helpers.mjs");
  try {
    const source = `${readFileSync(helpersPath, "utf8")}\nexport { surfaceUnavailableDiagnostic };\n`;
    const transformed = transformSync(source, {
      format: "esm",
      loader: "ts",
      target: "node20",
    });
    writeFileSync(outputPath, transformed.code);
    return await import(`${pathToFileURL(outputPath).href}?${Date.now()}`);
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

function saveBrowserGlobals() {
  return new Map(
    ["browser", "window", "document"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
}

function restoreBrowserGlobals(saved) {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

async function captureSurfaceDiagnostic(
  helpers,
  { handles, details = {}, unavailable = [] },
) {
  const saved = saveBrowserGlobals();
  const unavailableHandles = new Set(unavailable);
  let activeHandle = handles[0];
  const fallback = {
    location: { href: "about:blank", hostname: "", protocol: "about:" },
    readyState: "loading",
    bodyText: "",
  };
  const current = () => details[activeHandle] ?? fallback;
  globalThis.window = {
    get location() {
      return current().location;
    },
  };
  globalThis.document = {
    get readyState() {
      return current().readyState;
    },
    querySelector() {
      return null;
    },
    get body() {
      return { childElementCount: 0, textContent: current().bodyText };
    },
  };
  globalThis.browser = {
    async getWindowHandles() {
      return handles;
    },
    async switchToWindow(handle) {
      activeHandle = handle;
      if (unavailableHandles.has(handle)) throw new Error("unavailable");
    },
    async execute(callback) {
      return callback();
    },
  };
  try {
    return await helpers.surfaceUnavailableDiagnostic();
  } finally {
    restoreBrowserGlobals(saved);
  }
}

test("WebDriver configuration keeps setup-owned creation and closed capability input", async () => {
  const webdriverConfig = JSON.parse(
    readFileSync(resolve(root, "src-tauri/tauri.webdriver.conf.json"), "utf8"),
  );
  assert.equal(webdriverConfig.app.windows[0].create, false);
  const harness = await loadWdioConfig({
    THREADTERM_WDIO_ARTIFACT: "harness",
    THREADTERM_WDIO_APP: harnessApp,
    THREADTERM_WDIO_UDF: testLayout.udf,
    THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: JSON.stringify(
      offlineBrowserArguments,
    ),
  });
  assert.deepEqual(
    harness.config.capabilities[0]["tauri:options"].webviewOptions,
    {
      userDataFolder: testLayout.udf,
      additionalBrowserArguments: offlineBrowserArguments,
    },
  );
  const production = await loadWdioConfig({
    THREADTERM_WDIO_ARTIFACT: "production",
    THREADTERM_WDIO_UDF: testLayout.udf,
  });
  assert.deepEqual(
    production.config.capabilities[0]["tauri:options"].webviewOptions,
    { userDataFolder: testLayout.udf },
  );
  const listener = await loadWdioConfig({
    THREADTERM_WDIO_ARTIFACT: "harness",
    THREADTERM_WDIO_FLOW: "listener",
    THREADTERM_WDIO_APP: harnessApp,
    THREADTERM_WDIO_UDF: testLayout.udf,
    THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: JSON.stringify(
      offlineBrowserArguments,
    ),
  });
  assert.equal(listener.config.specs.length, 1);
  assert.match(listener.config.specs[0], /listener\.spec\.ts$/);
  const surface = await loadWdioConfig({
    THREADTERM_WDIO_ARTIFACT: "harness",
    THREADTERM_WDIO_FLOW: "surface",
    THREADTERM_WDIO_APP: harnessApp,
    THREADTERM_WDIO_UDF: testLayout.udf,
    THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: JSON.stringify(
      offlineBrowserArguments,
    ),
  });
  assert.equal(surface.config.specs.length, 1);
  assert.match(surface.config.specs[0], /surface-lifecycle\.spec\.ts$/);
  await assert.rejects(
    loadWdioConfig({
      THREADTERM_WDIO_ARTIFACT: "harness",
      THREADTERM_WDIO_APP: harnessApp,
      THREADTERM_WDIO_UDF: testLayout.udf,
      THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: '["harmless"]',
    }),
    /harness-webview-browser-arguments-invalid/,
  );
  await assert.rejects(
    loadWdioConfig({
      THREADTERM_WDIO_ARTIFACT: "harness",
      THREADTERM_WDIO_APP: harnessApp,
      THREADTERM_WDIO_UDF: testLayout.udf,
      THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: JSON.stringify([
        "--disable-background-networking",
        offlineBrowserArguments[1],
      ]),
    }),
    /harness-webview-browser-arguments-invalid/,
  );
  await assert.rejects(
    loadWdioConfig({
      THREADTERM_WDIO_ARTIFACT: "production",
      THREADTERM_WDIO_UDF: testLayout.udf,
      threadterm_wdio_webview_additional_browser_arguments: JSON.stringify(
        offlineBrowserArguments,
      ),
    }),
    /production-webview-browser-arguments-forbidden/,
  );
  await assert.rejects(
    loadWdioConfig({
      THREADTERM_WDIO_ARTIFACT: "production",
      THREADTERM_WDIO_UDF: testLayout.udf,
      webview2_user_data_folder: "C:\\unexpected",
    }),
    /native-webview2-environment-forbidden/,
  );
});

test("WDIO config-loaded diagnostic is launcher-only across a worker reload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "threadterm-wdio-stage-contract-"));
  const reportPath = join(directory, "report.jsonl");
  const environment = {
    THREADTERM_WDIO_ARTIFACT: "harness",
    THREADTERM_WDIO_FLOW: "isolation",
    THREADTERM_WDIO_APP: harnessApp,
    THREADTERM_WDIO_UDF: testLayout.udf,
    THREADTERM_WDIO_REPORT: reportPath,
    THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: JSON.stringify(
      offlineBrowserArguments,
    ),
  };
  try {
    await loadWdioConfig(environment);
    await loadWdioConfig({ ...environment, WDIO_WORKER_ID: "0-0" });
    assert.deepEqual(
      readFileSync(reportPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line)),
      [{ wdioStage: "configLoaded" }],
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("WDIO session hook records fixed creation evidence without retaining response content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "threadterm-wdio-session-hook-"));
  const environment = {
    THREADTERM_WDIO_ARTIFACT: "harness",
    THREADTERM_WDIO_FLOW: "isolation",
    THREADTERM_WDIO_APP: harnessApp,
    THREADTERM_WDIO_UDF: testLayout.udf,
    THREADTERM_WDIO_REPORT: join(directory, "error.jsonl"),
    THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: JSON.stringify(
      offlineBrowserArguments,
    ),
  };
  const secret = "session-response-secret-must-not-appear";
  try {
    const errorConfig = await loadWdioConfig(environment);
    errorConfig.config.onWorkerStart();
    errorConfig.config.beforeSession();
    const response = {
      statusCode: 500,
      body: { value: { error: "unknown error", message: secret } },
    };
    assert.equal(
      errorConfig.config.transformResponse(response, { method: "POST" }),
      response,
    );
    errorConfig.config.onWorkerEnd();
    const errorReport = readFileSync(environment.THREADTERM_WDIO_REPORT, "utf8");
    assert.equal(errorReport.includes(secret), false);
    assert.deepEqual(
      errorReport.trim().split(/\r?\n/).map(JSON.parse),
      [
        { wdioStage: "configLoaded" },
        { wdioStage: "workerStarted" },
        { wdioStage: "beforeSession" },
        { sessionCreation: "unknownError" },
        { wdioStage: "workerEnded" },
      ],
    );

    const noResponseReport = join(directory, "no-response.jsonl");
    const noResponseConfig = await loadWdioConfig({
      ...environment,
      THREADTERM_WDIO_REPORT: noResponseReport,
    });
    noResponseConfig.config.onWorkerStart();
    noResponseConfig.config.beforeSession();
    noResponseConfig.config.onWorkerEnd();
    assert.deepEqual(
      readFileSync(noResponseReport, "utf8")
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse),
      [
        { wdioStage: "configLoaded" },
        { wdioStage: "workerStarted" },
        { wdioStage: "beforeSession" },
        { sessionCreation: "noResponse" },
        { wdioStage: "workerEnded" },
      ],
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("harness capability permits tauri.localhost while mapping all other hosts to NOTFOUND", async () => {
  const harness = await loadWdioConfig({
    THREADTERM_WDIO_ARTIFACT: "harness",
    THREADTERM_WDIO_APP: harnessApp,
    THREADTERM_WDIO_UDF: testLayout.udf,
    THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS: JSON.stringify(
      offlineBrowserArguments,
    ),
  });
  assert.equal(
    harness.config.capabilities[0]["tauri:options"].webviewOptions
      .additionalBrowserArguments[1],
    "host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE asset.localhost,EXCLUDE tauri.localhost,EXCLUDE 127.0.0.1,EXCLUDE ::1",
  );
});

test("surface diagnostic returns only enum fields and classifies Tauri origins exactly", async () => {
  const helpers = await loadSurfaceDiagnosticHelpers();
  const zeroHandles = await captureSurfaceDiagnostic(helpers, { handles: [] });
  assert.deepEqual(zeroHandles, {
    event: "surfaceUnavailable",
    handleStatus: "none",
    urlKind: "unavailable",
    readyState: "unavailable",
    rootStatus: "unavailable",
    bodyStatus: "unavailable",
  });

  const cases = [
    ["tauri://localhost", "tauri:", "localhost", "tauriLocal"],
    ["http://tauri.localhost", "http:", "tauri.localhost", "tauriLocal"],
    ["https://tauri.localhost", "https:", "tauri.localhost", "tauriLocal"],
    ["ws://tauri.localhost", "ws:", "tauri.localhost", "other"],
  ];
  for (const [href, protocol, hostname, urlKind] of cases) {
    const diagnostic = await captureSurfaceDiagnostic(helpers, {
      handles: ["main"],
      details: {
        main: {
          location: { href, protocol, hostname },
          readyState: "interactive",
          bodyText: "private terminal content",
        },
      },
    });
    assert.equal(diagnostic.urlKind, urlKind);
    assert.equal(diagnostic.bodyStatus, "nonempty");
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      "bodyStatus",
      "event",
      "handleStatus",
      "readyState",
      "rootStatus",
      "urlKind",
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private|localhost/);
  }

  const mixed = await captureSurfaceDiagnostic(helpers, {
    handles: ["main", "unavailable"],
    unavailable: ["unavailable"],
    details: {
      main: {
        location: {
          href: "https://tauri.localhost",
          protocol: "https:",
          hostname: "tauri.localhost",
        },
        readyState: "complete",
        bodyText: "nonempty",
      },
    },
  });
  assert.deepEqual(mixed, {
    event: "surfaceUnavailable",
    handleStatus: "multiple",
    urlKind: "mixed",
    readyState: "mixed",
    rootStatus: "mixed",
    bodyStatus: "mixed",
  });
});

test("surface diagnostic callback runs once only after the surface deadline", async () => {
  const helpers = await loadSurfaceDiagnosticHelpers();
  const saved = saveBrowserGlobals();
  const originalNow = Date.now;
  let now = 0;
  let callbackAt;
  const records = [];
  Date.now = () => now;
  globalThis.window = {
    location: {
      href: "https://tauri.localhost",
      hostname: "tauri.localhost",
      protocol: "https:",
    },
  };
  globalThis.document = {
    readyState: "loading",
    querySelector() {
      return null;
    },
    body: { childElementCount: 0, textContent: "" },
  };
  globalThis.browser = {
    async getWindowHandles() {
      return ["main"];
    },
    async switchToWindow() {},
    async execute(callback) {
      return callback();
    },
    async pause() {
      now = 30_000;
    },
  };
  try {
    await assert.rejects(
      helpers.waitForSurface((diagnostic) => {
        callbackAt = now;
        records.push(diagnostic);
      }),
      /public-main-surface-unavailable/,
    );
  } finally {
    Date.now = originalNow;
    restoreBrowserGlobals(saved);
  }
  assert.equal(callbackAt, 30_000);
  assert.equal(records.length, 1);
  assert.equal(records[0].urlKind, "tauriLocal");
});

const expectedRule =
  "MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE asset.localhost,EXCLUDE tauri.localhost,EXCLUDE 127.0.0.1,EXCLUDE ::1";
const browserCommand = (extra = "") =>
  `msedgewebview2.exe --disable-background-networking --host-resolver-rules="${expectedRule}"${extra}`;
const descendants = [
  { pid: 1, parentProcessId: 0, name: "threadterm.exe" },
  { pid: 2, parentProcessId: 1, name: "MSEDGEWEBVIEW2.EXE" },
  { pid: 3, parentProcessId: 1, name: "MSEDGEWEBVIEW2.EXE" },
  { pid: 4, parentProcessId: 1, name: "MSEDGEWEBVIEW2.EXE" },
];

function commandRows(
  browser = browserCommand(),
  renderer = "msedgewebview2.exe --type=renderer",
  helper = "msedgewebview2.exe --type=gpu-process",
) {
  return [
    { ProcessId: 2, CommandLine: browser },
    { ProcessId: 3, CommandLine: renderer },
    { ProcessId: 4, CommandLine: helper },
  ];
}

function observe(browser, renderer, helper) {
  return evaluateOfflineWebViewIsolation(
    descendants,
    commandRows(browser, renderer, helper),
    1,
    "C:\\runner\\expected-udf",
  );
}

test("derived helper/renderer UDF and flags cannot splice into browser evidence", () => {
  const result = observe(
    browserCommand(),
    `msedgewebview2.exe --type=renderer --user-data-dir="C:\\wrong\\udf" --host-resolver-rules="${expectedRule} --bad"`,
    "msedgewebview2.exe --type=gpu-process --disable-background-networking --host-resolver-rules=MAP-wrong",
  );
  assert.equal(result.status, "matched");
});

test("browser host must be unique and every owned WebView commandline observable", () => {
  assert.equal(
    observe(
      "msedgewebview2.exe --type=renderer --disable-background-networking",
      "msedgewebview2.exe --type=renderer",
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "browser-host-missing",
  );
  assert.equal(
    observe(
      browserCommand(),
      browserCommand(),
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "browser-host-ambiguous",
  );
  assert.equal(
    evaluateOfflineWebViewIsolation(descendants, commandRows(), 1).status,
    "matched",
  );
  assert.equal(
    evaluateOfflineWebViewIsolation(descendants, commandRows().slice(0, 2), 1)
      .status,
    "commandline-missing",
  );
});

test("only the unique browser host may carry the exact offline rules", () => {
  assert.equal(
    observe(
      browserCommand().replace(",EXCLUDE tauri.localhost", ""),
      "msedgewebview2.exe --type=renderer",
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "offline-host-resolver-rule-conflict",
  );
  assert.equal(
    observe(
      "msedgewebview2.exe --disable-background-networking",
      "msedgewebview2.exe --type=renderer",
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "offline-host-resolver-rule-missing",
  );
  assert.equal(
    observe(
      browserCommand(' --host-resolver-rules="MAP * ~NOTFOUND"'),
      "msedgewebview2.exe --type=renderer",
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "offline-host-resolver-rule-conflict",
  );
  assert.equal(
    observe(
      browserCommand().replace(
        ` --host-resolver-rules="${expectedRule}"`,
        ` --host-resolver-rules="${expectedRule}" --host-resolver-rules="${expectedRule}"`,
      ),
      "msedgewebview2.exe --type=renderer",
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "offline-host-resolver-rule-conflict",
  );
});

test("background networking is required exactly once on the browser host", () => {
  assert.equal(
    observe(
      `msedgewebview2.exe --host-resolver-rules="${expectedRule}"`,
      "msedgewebview2.exe --type=renderer --disable-background-networking",
      "msedgewebview2.exe --type=gpu-process --disable-background-networking",
    ).status,
    "offline-background-networking-missing",
  );
  assert.equal(
    observe(
      `${browserCommand()} --disable-background-networking`,
      "msedgewebview2.exe --type=renderer",
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "offline-background-networking-conflict",
  );
  assert.equal(
    observe(
      browserCommand().replace(
        "--disable-background-networking",
        "--disable-background-networking=false",
      ),
      "msedgewebview2.exe --type=renderer",
      "msedgewebview2.exe --type=gpu-process",
    ).status,
    "offline-background-networking-conflict",
  );
});

const projection = {
  isolation: "isolated",
  csp: "isolated",
  enabled: true,
  capabilities: {
    shellForcing: "supported",
    timingInjection: "supported",
    faultInjection: "supported",
    readOnlyObservation: "supported",
  },
  counters: {
    activeCases: 0,
    queuedUiCreateCases: 0,
    preparedCases: 0,
    claimedCases: 0,
    boundCases: 0,
    failedCases: 0,
    snapshotReads: 0,
    cleanups: 0,
    duplicateTokens: 0,
    unknownTokens: 0,
    rejectedRequests: 0,
  },
};

const matchedDiagnostic = {
  runtimeIsolationStatus: "matched",
  markerPublished: true,
};

const runtimeConfirmed = { event: "runtimeUdfConfirmed" };

test("early UDF evidence tolerates one legal projection and diagnostic but stays closed", () => {
  const confirmed = [
    { event: "classicConfirmed" },
    { event: "driverUdfConfirmed" },
    runtimeConfirmed,
    projection,
    matchedDiagnostic,
    { event: "frameworkPassed" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  assert.equal(classifyIsolationDriverUdfEvidence(confirmed), "confirmed");
  assert.equal(
    classifyIsolationDriverUdfEvidence(
      `${confirmed}\n${JSON.stringify(projection)}`,
    ),
    "invalid",
  );
  assert.equal(
    classifyIsolationDriverUdfEvidence(`${confirmed}\n{"unexpected":true}`),
    "invalid",
  );
});

test("runner evidence without lifecycle events remains a closed pending stream", () => {
  assert.equal(
    classifyIsolationLifecycleEvidence(
      '{"runnerStage":"preflight","outcome":"failed"}',
    ),
    "pending",
  );
});

const surfaceUnavailable = {
  event: "surfaceUnavailable",
  handleStatus: "single",
  urlKind: "tauriLocal",
  readyState: "interactive",
  rootStatus: "missing",
  bodyStatus: "nonempty",
};

function isolationEvidence(records) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

const cleanupEvidence = {
  runnerCleanup: "verified",
  driverSupervisor: "exited",
  wdioSupervisor: "exited",
  appTree: "gone",
  tauriDriverPort: "refused",
  nativeDriverPort: "refused",
  sandbox: "removed",
};
const successfulIsolationLifecycle = [
  { event: "classicConfirmed" },
  { event: "driverUdfConfirmed" },
  runtimeConfirmed,
  projection,
  matchedDiagnostic,
  { event: "frameworkPassed" },
  { event: "sessionEnded" },
];

test("cleanup evidence is exact, unique, and ordered before complete success", () => {
  const successful = isolationEvidence([
    ...successfulIsolationLifecycle,
    cleanupEvidence,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(successful), "natural");
  assert.equal(classifyIsolationDriverUdfEvidence(successful), "confirmed");

  for (const key of Object.keys(cleanupEvidence)) {
    const mutation = { ...cleanupEvidence, [key]: "wrong" };
    const report = isolationEvidence([
      ...successfulIsolationLifecycle,
      mutation,
      { runnerStage: "complete", outcome: "success" },
    ]);
    assert.equal(classifyIsolationLifecycleEvidence(report), "invalid", key);
    assert.equal(classifyIsolationDriverUdfEvidence(report), "invalid", key);
  }
  for (const malformed of [
    Object.fromEntries(
      Object.entries(cleanupEvidence).filter(([key]) => key !== "sandbox"),
    ),
    { ...cleanupEvidence, extra: "nope" },
  ]) {
    const report = isolationEvidence([
      ...successfulIsolationLifecycle,
      malformed,
      { runnerStage: "complete", outcome: "success" },
    ]);
    assert.equal(classifyIsolationLifecycleEvidence(report), "invalid");
    assert.equal(classifyIsolationDriverUdfEvidence(report), "invalid");
  }
  const duplicate = isolationEvidence([
    ...successfulIsolationLifecycle,
    cleanupEvidence,
    cleanupEvidence,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(duplicate), "invalid");
  assert.equal(classifyIsolationDriverUdfEvidence(duplicate), "invalid");
  const missing = isolationEvidence([
    ...successfulIsolationLifecycle,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(missing), "invalid");
  assert.equal(classifyIsolationDriverUdfEvidence(missing), "invalid");
  const outOfOrder = isolationEvidence([
    ...successfulIsolationLifecycle,
    { runnerStage: "complete", outcome: "success" },
    cleanupEvidence,
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(outOfOrder), "invalid");
  assert.equal(classifyIsolationDriverUdfEvidence(outOfOrder), "invalid");
  const beforeLifecycleEnd = isolationEvidence([
    ...successfulIsolationLifecycle.slice(0, 4),
    cleanupEvidence,
    ...successfulIsolationLifecycle.slice(4),
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(beforeLifecycleEnd), "invalid");
  assert.equal(classifyIsolationDriverUdfEvidence(beforeLifecycleEnd), "invalid");
});

test("cleanup evidence remains compatible with stopped isolation lifecycle", () => {
  const stopped = isolationEvidence([
    ...successfulIsolationLifecycle,
    { event: "evidenceStopRequested" },
    cleanupEvidence,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(stopped), "stopped");
  assert.equal(classifyIsolationDriverUdfEvidence(stopped), "confirmed");
});

test("not-requested app cleanup closes only pre-WDIO failures", () => {
  const notRequestedCleanup = { ...cleanupEvidence, appTree: "notRequested" };
  const preWdioFailure = isolationEvidence([
    { nativeDriverStatus: "transportFailed" },
    { runnerStage: "driverStatus", outcome: "failed" },
    notRequestedCleanup,
    { runnerStage: "complete", outcome: "failed" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(preWdioFailure), "failed");

  const successWithNoRequestedApp = isolationEvidence([
    { nativeDriverStatus: "transportFailed" },
    { runnerStage: "driverStatus", outcome: "failed" },
    notRequestedCleanup,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(
    classifyIsolationLifecycleEvidence(successWithNoRequestedApp),
    "invalid",
  );
  assert.equal(
    classifyIsolationDriverUdfEvidence(successWithNoRequestedApp),
    "invalid",
  );

  for (const runnerStage of ["wdioIdentity", "wdioSession"]) {
    const forgedPostBoundaryFailure = isolationEvidence([
      { nativeDriverStatus: "transportFailed" },
      { runnerStage, outcome: "failed" },
      notRequestedCleanup,
      { runnerStage: "complete", outcome: "failed" },
    ]);
    assert.equal(
      classifyIsolationLifecycleEvidence(forgedPostBoundaryFailure),
      "invalid",
      runnerStage,
    );
  }

  const successfulLifecycleWithNoRequestedApp = isolationEvidence([
    ...successfulIsolationLifecycle,
    notRequestedCleanup,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(
    classifyIsolationLifecycleEvidence(successfulLifecycleWithNoRequestedApp),
    "invalid",
  );
  assert.equal(
    classifyIsolationDriverUdfEvidence(successfulLifecycleWithNoRequestedApp),
    "invalid",
  );

  const postWdioMissingIdentity = isolationEvidence([
    { nativeDriverStatus: "ready" },
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
    { sessionCreation: "noResponse" },
    { wdioStage: "workerEnded" },
    { runnerStage: "webdriverSession", outcome: "failed" },
    notRequestedCleanup,
    { runnerStage: "complete", outcome: "failed" },
  ]);
  assert.equal(
    classifyIsolationLifecycleEvidence(postWdioMissingIdentity),
    "invalid",
  );
});

test("cleanup evidence append writes only the fixed privacy-safe record", () => {
  const directory = mkdtempSync(join(tmpdir(), "threadterm-cleanup-contract-"));
  const reportPath = join(directory, "report.jsonl");
  try {
    writeFileSync(reportPath, "prefix\n");
    assert.equal(appendRunnerCleanupEvidence(reportPath), true);
    const lines = readFileSync(reportPath, "utf8").trim().split(/\r?\n/);
    assert.deepEqual(JSON.parse(lines[1]), cleanupEvidence);
    assert.doesNotMatch(lines[1], /pid|path|error|command|cwd/i);
    assert.equal(appendRunnerCleanupEvidence(reportPath, "notRequested"), true);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8").trim().split(/\r?\n/)[2]), {
      ...cleanupEvidence,
      appTree: "notRequested",
    });
    assert.equal(appendRunnerCleanupEvidence(reportPath, "unverified"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owned app tree cleanup fails closed for root, descendants, PID reuse, and observation failure", () => {
  const identity = {
    pid: 42,
    executablePath: "C:\\runner\\threadterm.exe",
    creationDate: "20260824010101.000000-000",
  };
  assert.equal(
    isOwnedProcessTreeGone(
      [{ pid: 1, parentProcessId: 0, executablePath: "C:\\Windows\\x.exe", creationDate: "x" }],
      identity,
    ),
    true,
  );
  assert.equal(
    isOwnedProcessTreeGone(
      [{ pid: 99, parentProcessId: 42, executablePath: "C:\\runner\\child.exe", creationDate: "y" }],
      identity,
    ),
    false,
  );
  assert.equal(
    isOwnedProcessTreeGone(
      [{ pid: 42, parentProcessId: 0, executablePath: "C:\\runner\\other.exe", creationDate: "z" }],
      identity,
    ),
    false,
  );
  assert.equal(isOwnedProcessTreeGone(undefined, identity), false);
  assert.equal(isOwnedProcessTreeGone([], undefined), false);
});

test("port cleanup proof accepts only ECONNREFUSED", () => {
  assert.equal(classifyPortProbeError({ code: "ECONNREFUSED" }), "refused");
  for (const error of [
    { code: "ECONNRESET" },
    { code: "EACCES" },
    undefined,
  ]) {
    assert.equal(classifyPortProbeError(error), "failed");
  }
});

test("driver preflight requires both proxy and native ports before any spawn", async () => {
  const calls = [];
  await assertDriverPortsAvailable(123_456, async (port, deadline) => {
    calls.push({ port, deadline });
  });
  assert.deepEqual(calls.map(({ port }) => port), [4444, 4445]);
  assert.equal(calls[0].deadline, 123_456);
  assert.equal(calls[1].deadline, 123_456);

  const rejectedCalls = [];
  await assert.rejects(
    assertDriverPortsAvailable(123_456, async (port) => {
      rejectedCalls.push(port);
      if (port === 4445) throw new Error("occupied");
    }),
    /webdriver-port-preflight-failed/,
  );
  assert.deepEqual(rejectedCalls, [4444, 4445]);
});

test("driver ports wait proxy then native using one deadline", async () => {
  const calls = [];
  const stages = [];
  await waitForDriverPortsReady({}, Date.now() + 10_000, {
    waitForPort: async (port, deadline) => {
      calls.push({ port, deadline });
    },
    onProxyReady: () => stages.push("driverReady"),
    onReady: () => stages.push("wdio"),
  });
  assert.deepEqual(calls.map(({ port }) => port), [4444, 4445]);
  assert.equal(calls[0].deadline, calls[1].deadline);
  assert.deepEqual(stages, ["driverReady", "wdio"]);
});

test("driver port failures fail closed without probing later ports or starting WDIO", async () => {
  const firstFailure = [];
  await assert.rejects(
    waitForDriverPortsReady({}, Date.now() + 10_000, {
      waitForPort: async (port) => {
        firstFailure.push(port);
        throw new Error("port-failed");
      },
      onProxyReady: () => firstFailure.push("native-stage"),
      onReady: () => firstFailure.push("wdio"),
    }),
    /port-failed/,
  );
  assert.deepEqual(firstFailure, [4444]);

  const nativeFailure = [];
  await assert.rejects(
    waitForDriverPortsReady({}, Date.now() + 10_000, {
      waitForPort: async (port) => {
        nativeFailure.push(port);
        if (port === 4445) throw new Error("port-failed");
      },
      onProxyReady: () => nativeFailure.push("native-stage"),
      onReady: () => nativeFailure.push("wdio"),
    }),
    /port-failed/,
  );
  assert.deepEqual(nativeFailure, [4444, "native-stage", 4445]);
});

test("surface-unavailable diagnostic is strict and remains pending before framework failure", () => {
  const prefix = [
    { event: "classicConfirmed" },
    { event: "driverUdfConfirmed" },
  ];
  assert.equal(
    classifyIsolationLifecycleEvidence(
      isolationEvidence([...prefix, surfaceUnavailable]),
    ),
    "pending",
  );
  assert.equal(
    classifyIsolationDriverUdfEvidence(
      isolationEvidence([...prefix, surfaceUnavailable]),
    ),
    "pending",
  );
  for (const malformed of [
    (({ bodyStatus, ...record }) => record)(surfaceUnavailable),
    { ...surfaceUnavailable, url: "https://secret" },
    { ...surfaceUnavailable, error: "secret" },
    { ...surfaceUnavailable, count: 1 },
    { ...surfaceUnavailable, readyState: "invalid" },
    { ...surfaceUnavailable, bodyStatus: 1 },
  ]) {
    assert.equal(
      classifyIsolationLifecycleEvidence(
        isolationEvidence([...prefix, malformed]),
      ),
      "invalid",
    );
  }
});

test("surface-unavailable diagnostic is rejected before valid classic and driver evidence", () => {
  for (const records of [
    [surfaceUnavailable],
    [{ event: "classicConfirmed" }, surfaceUnavailable],
    [
      { event: "classicConfirmed" },
      { event: "driverUdfInvalid" },
      surfaceUnavailable,
    ],
  ]) {
    const evidence = isolationEvidence(records);
    assert.equal(classifyIsolationLifecycleEvidence(evidence), "invalid");
    assert.equal(classifyIsolationDriverUdfEvidence(evidence), "invalid");
  }
});

test("surface-unavailable diagnostic only permits its failed isolation path", () => {
  for (const driverUdf of ["driverUdfConfirmed", "driverUdfMissing"]) {
    const prefix = [{ event: "classicConfirmed" }, { event: driverUdf }];
    for (const suffix of [
      [{ event: "frameworkFailed" }],
      [{ event: "frameworkFailed" }, { event: "sessionEnded" }],
      [
        { event: "frameworkFailed" },
        {
          runtimeIsolationStatus: "runtime-udf-invalid",
          markerPublished: false,
        },
      ],
    ]) {
      const evidence = isolationEvidence([
        ...prefix,
        surfaceUnavailable,
        ...suffix,
      ]);
      assert.equal(classifyIsolationLifecycleEvidence(evidence), "failed");
      assert.equal(classifyIsolationDriverUdfEvidence(evidence), "failed");
    }
    for (const invalid of [
      [...prefix, surfaceUnavailable, surfaceUnavailable],
      [...prefix, { event: "runtimeUdfConfirmed" }, surfaceUnavailable],
      [...prefix, projection, surfaceUnavailable],
      [...prefix, surfaceUnavailable, { event: "frameworkPassed" }],
      [...prefix, surfaceUnavailable, runtimeConfirmed],
      [
        ...prefix,
        surfaceUnavailable,
        matchedDiagnostic,
        { event: "frameworkFailed" },
      ],
      [
        ...prefix,
        surfaceUnavailable,
        { event: "frameworkFailed" },
        matchedDiagnostic,
      ],
    ]) {
      assert.equal(
        classifyIsolationLifecycleEvidence(isolationEvidence(invalid)),
        "invalid",
      );
    }
  }
});

test("lifecycle success requires driver eligibility then runtime UDF confirmation", () => {
  const success = [
    { event: "classicConfirmed" },
    { event: "driverUdfConfirmed" },
    runtimeConfirmed,
    projection,
    matchedDiagnostic,
    { event: "frameworkPassed" },
    { event: "sessionEnded" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  assert.equal(classifyIsolationLifecycleEvidence(success), "natural");
  assert.equal(
    classifyIsolationLifecycleEvidence(
      success.replace('{"event":"runtimeUdfConfirmed"}\n', ""),
    ),
    "invalid",
  );
  for (const malformed of [
    '{"event":"classicConfirmed"}\n{"event":"classicConfirmed"}',
    '{"event":"driverUdfConfirmed"}\n{"event":"classicConfirmed"}',
    '{"event":"classicConfirmed"}\n{"event":"driverUdfConfirmed","extra":true}',
    '{"event":"classicConfirmed"}\n{"event":"driverUdfConfirmed"}\n{"event":"frameworkPassed"}',
    '{"event":"classicConfirmed"}\n{"event":"driverUdfConfirmed"}\n{"event":"runtimeUdfConfirmed"}\n{"event":"runtimeUdfConfirmed"}',
    `${JSON.stringify(projection)}\n{"event":"classicConfirmed"}\n{"event":"driverUdfConfirmed"}\n{"event":"runtimeUdfConfirmed"}\n${JSON.stringify(matchedDiagnostic)}\n{"event":"frameworkPassed"}\n{"event":"sessionEnded"}`,
  ]) {
    assert.equal(classifyIsolationLifecycleEvidence(malformed), "invalid");
  }
});

test("driver missing may continue but runtime UDF is the required authority", () => {
  const missingDriverSuccess = [
    { event: "classicConfirmed" },
    { event: "driverUdfMissing" },
    runtimeConfirmed,
    projection,
    matchedDiagnostic,
    { event: "frameworkPassed" },
    { event: "sessionEnded" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  assert.equal(
    classifyIsolationDriverUdfEvidence(missingDriverSuccess),
    "confirmed",
  );
  assert.equal(
    classifyIsolationLifecycleEvidence(missingDriverSuccess),
    "natural",
  );
});

test("early isolation gates separate driver eligibility from runtime attestation", () => {
  const eligibility = '{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}';
  assert.equal(classifyIsolationDriverEligibility(""), "pending");
  assert.equal(classifyIsolationDriverEligibility(eligibility), "eligible");
  assert.equal(classifyIsolationRuntimeUdfAttestation(eligibility), "pending");
  assert.equal(
    classifyIsolationRuntimeUdfAttestation(
      `${eligibility}\n{"event":"runtimeUdfConfirmed"}`,
    ),
    "confirmed",
  );
  assert.equal(
    classifyIsolationDriverEligibility(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfMismatch"}',
    ),
    "failed",
  );
  assert.equal(
    classifyIsolationRuntimeUdfAttestation(
      `${eligibility}\n{"event":"runtimeUdfUnavailable"}`,
    ),
    "failed",
  );
  assert.equal(
    classifyIsolationDriverEligibility(
      `${eligibility}\n{"event":"runtimeUdfConfirmed"}`,
    ),
    "eligible",
  );
});

test("isolation timeout taxonomy and marker decision are fixed and fail closed", () => {
  assert.deepEqual(isolationWaitEvidence("wdioSession", "timeout"), {
    runnerStage: "wdioSession",
    outcome: "timeout",
  });
  assert.deepEqual(isolationWaitEvidence("driverUdf", "timeout"), {
    runnerStage: "driverUdf",
    outcome: "timeout",
  });
  assert.deepEqual(isolationWaitEvidence("runtimeUdf", "failed"), {
    runnerStage: "runtimeUdf",
    outcome: "failed",
  });
  assert.equal(isolationWaitEvidence("appIdentity", "pending"), undefined);
  assert.equal(isolationTimeoutStage(""), "wdioSession");
  assert.equal(
    isolationTimeoutStage('{"wdioStage":"configLoaded"}'),
    "wdioWorker",
  );
  assert.equal(
    isolationTimeoutStage(
      '{"wdioStage":"configLoaded"}\n{"wdioStage":"workerStarted"}',
    ),
    "wdioWorker",
  );
  assert.equal(
    isolationTimeoutStage(
      '{"wdioStage":"configLoaded"}\n{"wdioStage":"workerStarted"}\n{"wdioStage":"beforeSession"}',
    ),
    "webdriverSession",
  );
  assert.equal(
    isolationTimeoutStage(
      '{"wdioStage":"configLoaded"}\n{"wdioStage":"workerStarted"}\n{"wdioStage":"beforeSession"}\n{"event":"classicConfirmed"}',
    ),
    "driverUdf",
  );
  assert.equal(
    isolationTimeoutStage(
      '{"wdioStage":"configLoaded"}\n{"wdioStage":"workerStarted"}\n{"wdioStage":"beforeSession"}\n{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}',
    ),
    "runtimeUdf",
  );
  assert.equal(
    isolationTimeoutStage('{"event":"classicConfirmed"}'),
    "driverUdf",
  );
  assert.equal(
    isolationTimeoutStage(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}',
    ),
    "runtimeUdf",
  );
  for (const gateOutcome of ["driver", "runtime"]) {
    assert.equal(shouldWaitForIsolationWdioSession(gateOutcome), false);
  }
  assert.equal(shouldWaitForIsolationWdioSession("none"), true);
  const workDeadline = 151_000;
  assert.equal(wdioSessionDeadline("isolation", workDeadline, 1_000), 91_000);
  assert.equal(wdioSessionDeadline("provider", workDeadline, 1_000), 121_000);
  const identity = { pid: 123, executablePath: "C:\\runner\\threadterm.exe" };
  assert.equal(shouldObserveRuntimeIsolation("eligible", "confirmed", identity), true);
  assert.equal(shouldObserveRuntimeIsolation("eligible", "timeout", identity), false);
  assert.equal(shouldObserveRuntimeIsolation("failed", "confirmed", identity), false);
  assert.equal(shouldPublishRuntimeIsolationMarker("confirmed", { ok: true }), true);
  assert.equal(shouldPublishRuntimeIsolationMarker("timeout", { ok: true }), false);
  assert.equal(shouldPublishRuntimeIsolationMarker("confirmed", { ok: false }), false);
  const captured = { app: identity, supervisor: { pid: 456 } };
  assert.equal(retainOwnedThreadTermIdentity(captured, undefined), captured);
});

test("WDIO pre-session diagnostics are fixed ordered single-field records", () => {
  const prefix = [
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
  ];
  const report = isolationEvidence([
    ...prefix,
    ...successfulIsolationLifecycle,
    { event: "evidenceStopRequested" },
    { wdioStage: "workerEnded" },
    cleanupEvidence,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.deepEqual(stripIsolationWdioStageDiagnostics(report), {
    report: isolationEvidence([
      ...successfulIsolationLifecycle,
      { event: "evidenceStopRequested" },
      cleanupEvidence,
      { runnerStage: "complete", outcome: "success" },
    ]),
    lastStage: "workerEnded",
    lastProgressStage: "beforeSession",
    terminal: true,
  });
  assert.equal(classifyIsolationLifecycleEvidence(report), "stopped");
  assert.equal(classifyIsolationDriverUdfEvidence(report), "confirmed");

  for (const invalid of [
    [{ wdioStage: "configLoaded", extra: true }],
    [{ wdioStage: "unexpected" }],
    [{ wdioStage: "workerStarted" }],
    [{ wdioStage: "configLoaded" }, { wdioStage: "configLoaded" }],
    [{ wdioStage: "configLoaded" }, { event: "classicConfirmed" }, { wdioStage: "workerStarted" }],
    [
      { wdioStage: "configLoaded" },
      { wdioStage: "workerStarted" },
      { wdioStage: "workerEnded" },
      { wdioStage: "beforeSession" },
    ],
  ]) {
    const evidence = isolationEvidence(invalid);
    assert.equal(stripIsolationWdioStageDiagnostics(evidence), undefined);
    assert.equal(classifyIsolationLifecycleEvidence(evidence), "invalid");
    assert.equal(classifyIsolationDriverUdfEvidence(evidence), "invalid");
    assert.equal(classifyIsolationRuntimeUdfAttestation(evidence), "invalid");
    assert.equal(isolationTimeoutStage(evidence), "wdioSession");
  }
});

test("native driver status stays bounded, enum-only, and fails closed", async () => {
  const response = (status, body) =>
    Buffer.from(
      `HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      "utf8",
    );
  assert.equal(
    classifyNativeDriverStatusResponse(
      response("200 OK", '{"value":{"ready":true}}'),
    ),
    "ready",
  );
  assert.equal(
    classifyNativeDriverStatusResponse(
      response("503 Service Unavailable", '{"value":{"ready":true}}'),
    ),
    "notReady",
  );
  assert.equal(
    classifyNativeDriverStatusResponse(
      response("200 OK", '{"value":{"ready":false}}'),
    ),
    "notReady",
  );
  assert.equal(
    classifyNativeDriverStatusResponse(
      response("200 OK", "{}"),
    ),
    "malformed",
  );
  assert.equal(
    classifyNativeDriverStatusResponse(
      response("200 OK", "x".repeat(8 * 1024 + 1)),
    ),
    "malformed",
  );
  assert.equal(shouldAppendNativeDriverStatusDiagnostic("isolation"), true);
  for (const currentFlow of [
    "provider",
    "timing",
    "listener",
    "surface",
    "da1",
    "warmup",
    "encoding",
    "production",
  ]) {
    assert.equal(shouldAppendNativeDriverStatusDiagnostic(currentFlow), false);
  }
  assert.equal(nativeDriverStatusAllowsWdio("ready"), true);
  for (const status of ["notReady", "malformed", "transportFailed", "unknown"]) {
    assert.equal(nativeDriverStatusAllowsWdio(status), false);
  }

  const probeSocketResponse = async (wireResponse, expectedStatus, keepOpen = false) => {
    const fixture = createServer((socket) => {
      socket.once("data", () => {
        socket.write(wireResponse);
        if (!keepOpen) socket.end();
      });
    });
    await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = fixture.address();
      assert.equal(typeof address, "object");
      assert.equal(
        await probeNativeDriverStatus(Date.now() + 2_000, { port: address.port }),
        expectedStatus,
      );
    } finally {
      await new Promise((resolveClose) => fixture.close(resolveClose));
    }
  };
  await probeSocketResponse(
    response("200 OK", '{"value":{"ready":true}}'),
    "ready",
    true,
  );
  await probeSocketResponse(
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
    "malformed",
    true,
  );
  await probeSocketResponse(
    "HTTP/1.1 200 OK\r\nContent-Length: 25\r\n\r\n{\"value\":{\"ready\":true}}",
    "malformed",
  );
  await probeSocketResponse(
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}!",
    "malformed",
    true,
  );

  const server = createServer((socket) => {
    socket.once("data", () => {
      // Deliberately exceed the response body ceiling; the probe must not
      // retain or emit any response content.
      socket.end(response("200 OK", "x".repeat(8 * 1024 + 1)));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.equal(
      await probeNativeDriverStatus(Date.now() + 2_000, { port: address.port }),
      "malformed",
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  const timeoutServer = createServer((socket) => {
    socket.once("data", () => {});
  });
  await new Promise((resolveListen) => timeoutServer.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = timeoutServer.address();
    assert.equal(typeof address, "object");
    assert.equal(
      await probeNativeDriverStatus(Date.now() + 25, { port: address.port }),
      "transportFailed",
    );
  } finally {
    await new Promise((resolveClose) => timeoutServer.close(resolveClose));
  }
});

test("runner launch and app-observation diagnostics are exact, ordered, and private", () => {
  const prefix = [
    { nativeDriverStatus: "ready" },
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
    { sessionCreation: "success" },
    { event: "classicConfirmed" },
    { event: "driverUdfConfirmed" },
    { wdioStage: "workerEnded" },
    { appObservation: "appObservedExited" },
  ];
  assert.deepEqual(stripIsolationWdioStageDiagnostics(isolationEvidence(prefix)), {
    report: isolationEvidence([
      { event: "classicConfirmed" },
      { event: "driverUdfConfirmed" },
    ]),
    lastStage: "workerEnded",
    lastProgressStage: "beforeSession",
    terminal: true,
    nativeDriverStatus: "ready",
    appObservation: "appObservedExited",
    sessionCreation: "success",
  });
  for (const appObservation of [
    "processTableUnavailable",
    "appIdentityMismatch",
  ]) {
    assert.equal(
      stripIsolationWdioStageDiagnostics(
        isolationEvidence([
          ...prefix.slice(0, -1),
          { appObservation },
        ]),
      )?.appObservation,
      appObservation,
    );
  }
  for (const invalid of [
    [{ nativeDriverStatus: "ready", extra: true }],
    [{ nativeDriverStatus: "unexpected" }],
    [{ wdioStage: "configLoaded" }, { nativeDriverStatus: "ready" }],
    [{ nativeDriverStatus: "ready" }, { nativeDriverStatus: "ready" }],
    [
      { nativeDriverStatus: "ready" },
      { wdioStage: "configLoaded" },
      { wdioStage: "workerStarted" },
      { wdioStage: "beforeSession" },
      { wdioStage: "workerEnded" },
    ],
    [
      { nativeDriverStatus: "ready" },
      { wdioStage: "configLoaded" },
      { wdioStage: "workerStarted" },
      { wdioStage: "beforeSession" },
      { sessionCreation: "noResponse" },
      { event: "classicConfirmed" },
    ],
    [...prefix, { appObservation: "appObservedAlive" }],
    [...prefix, { appObservation: "unexpected" }],
  ]) {
    assert.equal(stripIsolationWdioStageDiagnostics(isolationEvidence(invalid)), undefined);
  }

  const sandbox = mkdtempSync(join(tmpdir(), "threadterm-runner-diagnostic-"));
  const reportPath = join(sandbox, "report.jsonl");
  try {
    assert.equal(appendNativeDriverStatusDiagnostic(reportPath, "ready"), true);
    assert.equal(appendAppObservationDiagnostic(reportPath, "appNotObserved"), true);
    assert.deepEqual(
      readFileSync(reportPath, "utf8").trim().split(/\r?\n/).map(JSON.parse),
      [{ nativeDriverStatus: "ready" }, { appObservation: "appNotObserved" }],
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  const app = {
    pid: 42,
    executablePath: "C:\\runner\\threadterm.exe",
    creationDate: "20260824000000.000000+000",
  };
  assert.equal(projectOwnedAppObservation(undefined, []), "appNotObserved");
  assert.equal(
    projectOwnedAppObservation({ app }, undefined, () => {
      throw new Error("observation-source-failed");
    }),
    "processTableUnavailable",
  );
  assert.equal(
    projectOwnedAppObservation({ app }, undefined, () => undefined),
    "processTableUnavailable",
  );
  assert.equal(projectOwnedAppObservation({ app }, []), "appObservedExited");
  assert.equal(
    projectOwnedAppObservation({ app }, [{ ...app, parentProcessId: 1 }]),
    "appObservedAlive",
  );
  assert.equal(
    projectOwnedAppObservation(
      { app },
      [{ ...app, creationDate: "20260824000001.000000+000" }],
    ),
    "appIdentityMismatch",
  );
});

test("worker end closes every unfinished isolation lifecycle prefix at its exact runner stage", () => {
  const wdioPrefix = [
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
  ];
  for (const [businessPrefix, runnerStage] of [
    [[], "webdriverSession"],
    [[{ event: "classicConfirmed" }], "driverUdf"],
    [
      [
        { event: "classicConfirmed" },
        { event: "driverUdfMissing" },
      ],
      "runtimeUdf",
    ],
    [
      [
        { event: "classicConfirmed" },
        { event: "driverUdfConfirmed" },
        { event: "runtimeUdfConfirmed" },
      ],
      "wdioSession",
    ],
  ]) {
    const report = isolationEvidence([
      ...wdioPrefix,
      ...businessPrefix,
      { wdioStage: "workerEnded" },
    ]);
    const snapshot = reduceIsolationLifecycleSnapshot(report);
    assert.equal(snapshot.preterminalLifecycle, "pending");
    assert.equal(snapshot.terminal, true);
    assert.equal(snapshot.publicStatus, "failed");
    assert.equal(classifyIsolationLifecycleEvidence(report), "failed");
    assert.equal(reduceIsolationWdioPollDecision(snapshot, false), "failed");
    assert.deepEqual(isolationIncompleteWorkerFailureEvidence(report), {
      runnerStage,
      outcome: "failed",
    });
  }
});

test("worker-ended root failure remains a valid sealed report through observation, cleanup, and completion", () => {
  const report = isolationEvidence([
    { nativeDriverStatus: "ready" },
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
    { sessionCreation: "noResponse" },
    { wdioStage: "workerEnded" },
    { runnerStage: "webdriverSession", outcome: "failed" },
    { appObservation: "appObservedExited" },
    cleanupEvidence,
    { runnerStage: "complete", outcome: "failed" },
  ]);
  assert.deepEqual(stripIsolationWdioStageDiagnostics(report), {
    report: isolationEvidence([
      { runnerStage: "webdriverSession", outcome: "failed" },
      cleanupEvidence,
      { runnerStage: "complete", outcome: "failed" },
    ]),
    lastStage: "workerEnded",
    lastProgressStage: "beforeSession",
    terminal: true,
    nativeDriverStatus: "ready",
    appObservation: "appObservedExited",
    sessionCreation: "noResponse",
  });
  assert.equal(classifyIsolationLifecycleEvidence(report), "failed");
  assert.equal(reduceIsolationLifecycleSnapshot(report).publicStatus, "failed");

  for (const invalidTail of [
    [
      { runnerStage: "webdriverSession", outcome: "failed" },
      { runnerStage: "driverUdf", outcome: "failed" },
    ],
    [{ runnerStage: "webdriverSession", outcome: "timeout" }],
    [cleanupEvidence, { runnerStage: "webdriverSession", outcome: "failed" }],
    [
      { appObservation: "appObservedExited" },
      { runnerStage: "webdriverSession", outcome: "failed" },
    ],
    [
      { runnerStage: "webdriverSession", outcome: "failed" },
      { runnerStage: "complete", outcome: "failed" },
    ],
  ]) {
    assert.equal(
      stripIsolationWdioStageDiagnostics(
        isolationEvidence([
          { nativeDriverStatus: "ready" },
          { wdioStage: "configLoaded" },
          { wdioStage: "workerStarted" },
          { wdioStage: "beforeSession" },
          { sessionCreation: "noResponse" },
          { wdioStage: "workerEnded" },
          ...invalidTail,
        ]),
      ),
      undefined,
    );
  }
});

test("unfinished worker end fails both UDF gates immediately without mutating root evidence", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "threadterm-worker-ended-"));
  const reportPath = join(sandbox, "report.jsonl");
  const supervisor = { exitCode: null, signalCode: null };
  try {
    writeFileSync(
      reportPath,
      isolationEvidence([
        { wdioStage: "configLoaded" },
        { wdioStage: "workerStarted" },
        { wdioStage: "beforeSession" },
        { wdioStage: "workerEnded" },
      ]),
    );
    const beforeDriverGate = readFileSync(reportPath, "utf8");
    assert.equal(
      await waitForIsolationDriverUdfEvidence(
        supervisor,
        reportPath,
        Date.now() + 10_000,
      ),
      "failed",
    );
    assert.equal(readFileSync(reportPath, "utf8"), beforeDriverGate);

    writeFileSync(
      reportPath,
      isolationEvidence([
        { wdioStage: "configLoaded" },
        { wdioStage: "workerStarted" },
        { wdioStage: "beforeSession" },
        { event: "classicConfirmed" },
        { event: "driverUdfMissing" },
        { wdioStage: "workerEnded" },
      ]),
    );
    const beforeRuntimeGate = readFileSync(reportPath, "utf8");
    assert.equal(
      await waitForIsolationRuntimeUdfEvidence(
        supervisor,
        reportPath,
        Date.now() + 10_000,
      ),
      "failed",
    );
    assert.equal(readFileSync(reportPath, "utf8"), beforeRuntimeGate);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("worker end seals WDIO diagnostics before runner cleanup and completion", () => {
  const prefix = [
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
    { event: "classicConfirmed" },
    { event: "driverUdfConfirmed" },
    { wdioStage: "workerEnded" },
  ];
  for (const record of [
    { event: "classicConfirmed" },
    { event: "driverUdfMissing" },
    { event: "frameworkPassed" },
    { event: "evidenceStopRequested" },
    runtimeConfirmed,
    projection,
    matchedDiagnostic,
    surfaceUnavailable,
  ]) {
    const report = isolationEvidence([...prefix, record]);
    assert.equal(stripIsolationWdioStageDiagnostics(report), undefined);
    assert.equal(classifyIsolationLifecycleEvidence(report), "invalid");
  }
  const completeSuccess = isolationEvidence([
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
    ...successfulIsolationLifecycle,
    { event: "evidenceStopRequested" },
    { wdioStage: "workerEnded" },
    cleanupEvidence,
    { runnerStage: "complete", outcome: "success" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(completeSuccess), "stopped");
});

test("staged natural lifecycle waits for worker end without appending a stop request", () => {
  const prefix = [
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
  ];
  const natural = isolationEvidence([...prefix, ...successfulIsolationLifecycle]);
  const terminal = isolationEvidence([
    ...prefix,
    ...successfulIsolationLifecycle,
    { wdioStage: "workerEnded" },
  ]);
  assert.equal(classifyIsolationLifecycleEvidence(natural), "pending");
  assert.equal(classifyIsolationLifecycleEvidence(terminal), "natural");

  const naturalSnapshot = reduceIsolationLifecycleSnapshot(natural);
  const terminalSnapshot = reduceIsolationLifecycleSnapshot(terminal);
  assert.equal(reduceIsolationWdioPollDecision(naturalSnapshot, false), "wait");
  assert.deepEqual(
    reduceIsolationWdioPollDecision(terminalSnapshot, false),
    "naturalComplete",
  );
  assert.equal(
    reduceIsolationWdioPollDecision(terminalSnapshot, true),
    "naturalExit",
  );
});

test("terminal natural lifecycle before the first poll never appends a terminal stop request", () => {
  const report = isolationEvidence([
    { wdioStage: "configLoaded" },
    { wdioStage: "workerStarted" },
    { wdioStage: "beforeSession" },
    ...successfulIsolationLifecycle,
    { wdioStage: "workerEnded" },
  ]);
  const snapshot = reduceIsolationLifecycleSnapshot(report);
  assert.equal(snapshot.publicStatus, "natural");
  assert.equal(snapshot.preterminalLifecycle, "natural");
  assert.equal(snapshot.terminal, true);
  // First 50 ms poll: alive supervisor finishes from verified business evidence;
  // exited supervisor retains its natural-exit semantics. Neither path appends.
  assert.equal(
    reduceIsolationWdioPollDecision(snapshot, false),
    "naturalComplete",
  );
  assert.equal(
    reduceIsolationWdioPollDecision(snapshot, true),
    "naturalExit",
  );
});

test("all harness flows retain offline WebView observation while only isolation awaits runtime UDF", () => {
  assert.deepEqual(runtimeIsolationRequirements("harness", "isolation"), {
    observeHarnessIsolation: true,
    requireRuntimeUdfAttestation: true,
  });
  for (const flow of ["provider", "timing", "listener", "surface", "da1", "warmup", "encoding"]) {
    assert.deepEqual(runtimeIsolationRequirements("harness", flow), {
      observeHarnessIsolation: true,
      requireRuntimeUdfAttestation: false,
    });
  }
  assert.deepEqual(runtimeIsolationRequirements("production", "production"), {
    observeHarnessIsolation: false,
    requireRuntimeUdfAttestation: false,
  });
});

test("process observation disables module cache and only receives contained sandbox temp paths", () => {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.equal(typeof systemRoot, "string");
  const environment = buildProcessObservationEnvironment({
    SystemRoot: systemRoot,
    THREADTERM_TERMINAL_STARTUP_HARNESS_ROOT: "C:\\runner",
    TEMP: "C:\\runner\\temp",
    TMP: "C:\\runner\\temp",
    LOCALAPPDATA: "C:\\runner\\profile\\local",
    HOME: "C:\\runner\\profile\\home",
    USERPROFILE: "C:\\runner\\profile\\home",
  });
  assert.deepEqual(
    {
      TEMP: environment?.TEMP,
      TMP: environment?.TMP,
      LOCALAPPDATA: environment?.LOCALAPPDATA,
      HOME: environment?.HOME,
      USERPROFILE: environment?.USERPROFILE,
      PSModuleAnalysisCachePath: environment?.PSModuleAnalysisCachePath,
      PSDisableModuleAnalysisCacheCleanup:
        environment?.PSDisableModuleAnalysisCacheCleanup,
    },
    {
      TEMP: "C:\\runner\\temp",
      TMP: "C:\\runner\\temp",
      LOCALAPPDATA: undefined,
      HOME: undefined,
      USERPROFILE: undefined,
      PSModuleAnalysisCachePath: "NUL",
      PSDisableModuleAnalysisCacheCleanup: "1",
    },
  );
  const preflight = buildProcessObservationEnvironment({ SystemRoot: systemRoot });
  assert.equal(preflight?.TEMP, undefined);
  assert.equal(preflight?.TMP, undefined);
  assert.equal(preflight?.LOCALAPPDATA, undefined);
});

test("runtime UDF failures, conflicts, and malformed ordering fail closed", () => {
  assert.equal(
    classifyIsolationLifecycleEvidence(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfConfirmed"}\n{"event":"runtimeUdfConfirmed"}\n{"event":"frameworkFailed"}',
    ),
    "failed",
  );
  assert.equal(
    classifyIsolationLifecycleEvidence(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfMismatch"}',
    ),
    "failed",
  );
  for (const status of [
    "runtimeUdfMismatch",
    "runtimeUdfUnavailable",
    "runtimeUdfInvalid",
  ]) {
    assert.equal(
      classifyIsolationLifecycleEvidence(
        `{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}\n{"event":"${status}"}`,
      ),
      "failed",
    );
  }
  assert.equal(
    classifyIsolationDriverUdfEvidence(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfConfirmed"}\n{"event":"runtimeUdfConfirmed"}',
    ),
    "confirmed",
  );
  assert.equal(
    classifyIsolationDriverUdfEvidence(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}',
    ),
    "pending",
  );
});

test("runtime UDF failure diagnostics take precedence over an earlier missing driver capability", () => {
  assert.equal(
    driverUdfRuntimeIsolationStatus(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}\n{"event":"runtimeUdfMismatch"}',
    ),
    "runtime-udf-mismatch",
  );
  assert.equal(
    driverUdfRuntimeIsolationStatus(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}',
    ),
    "driver-udf-missing",
  );
  assert.equal(
    classifyIsolationLifecycleEvidence(
      '{"event":"classicConfirmed"}\n{"event":"driverUdfMissing"}\n{"event":"runtimeUdfMismatch"}\n{"event":"frameworkFailed"}\n{"runtimeIsolationStatus":"runtime-udf-mismatch","markerPublished":false}\n{"event":"sessionEnded"}',
    ),
    "failed",
  );
});
