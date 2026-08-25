import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import type { Options } from "@wdio/types";

import {
  createSessionEvidenceArm,
  needsNoResponseEvidence,
  sessionCreationRecord,
  type SessionCreationEvidence,
} from "./session-evidence.helpers";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appBinary =
  process.env.THREADTERM_WDIO_APP ??
  path.join(
    root,
    ".cache",
    "windows-terminal-startup",
    "target",
    "release",
    "threadterm.exe",
  );
const userDataFolder = process.env.THREADTERM_WDIO_UDF;
const requestedArtifact = process.env.THREADTERM_WDIO_ARTIFACT ?? "production";
if (requestedArtifact !== "harness" && requestedArtifact !== "production") {
  throw new Error("unsupported terminal-startup artifact");
}
const artifact = requestedArtifact;
const HARNESS_ADDITIONAL_BROWSER_ARGUMENTS = Object.freeze([
  "disable-background-networking",
  "host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE asset.localhost,EXCLUDE tauri.localhost,EXCLUDE 127.0.0.1,EXCLUDE ::1",
]);

function readEnvironmentValue(name: string): string | undefined {
  const matches = Object.entries(process.env).filter(
    ([key]) => key.toUpperCase() === name.toUpperCase(),
  );
  if (matches.length > 1)
    throw new Error("ambiguous-terminal-startup-environment-variable");
  return matches[0]?.[1];
}

for (const nativeName of [
  "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
  "WEBVIEW2_USER_DATA_FOLDER",
]) {
  if (readEnvironmentValue(nativeName) !== undefined)
    throw new Error("native-webview2-environment-forbidden");
}

const browserArgumentsJson = readEnvironmentValue(
  "THREADTERM_WDIO_WEBVIEW_ADDITIONAL_BROWSER_ARGUMENTS",
);
function parseHarnessBrowserArguments(value: string | undefined): string[] {
  if (artifact !== "harness") {
    if (value !== undefined)
      throw new Error("production-webview-browser-arguments-forbidden");
    return [];
  }
  if (value === undefined)
    throw new Error("harness-webview-browser-arguments-missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("harness-webview-browser-arguments-invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== HARNESS_ADDITIONAL_BROWSER_ARGUMENTS.length ||
    parsed.some(
      (argument, index) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.startsWith("--") ||
        argument !== HARNESS_ADDITIONAL_BROWSER_ARGUMENTS[index],
    )
  ) {
    throw new Error("harness-webview-browser-arguments-invalid");
  }
  return parsed;
}
const additionalBrowserArguments =
  parseHarnessBrowserArguments(browserArgumentsJson);
const flow =
  process.env.THREADTERM_WDIO_FLOW ??
  (artifact === "harness" ? "isolation" : "production");
const shippingBinary = path.join(
  root,
  ".cache",
  "windows-terminal-startup",
  "target",
  "release",
  "threadterm.exe",
);
const harnessBinary = path.join(
  root,
  ".cache",
  "windows-terminal-startup",
  "harness-target",
  "release",
  "threadterm.exe",
);
const flowSpecs: Record<string, string> = {
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
};
if (!userDataFolder) throw new Error("runner-missing-webview-user-data-folder");
if (!Object.prototype.hasOwnProperty.call(flowSpecs, flow))
  throw new Error("unsupported terminal-startup flow");
if (flow === "production" || flow === "float") {
  if (artifact !== "production")
    throw new Error("production-flow-requires-shipping-artifact");
  if (path.resolve(appBinary) !== path.resolve(shippingBinary))
    throw new Error("production-flow-requires-shipping-binary");
} else {
  if (artifact !== "harness")
    throw new Error("terminal-startup-harness-flow-requires-harness-artifact");
  if (path.resolve(appBinary) !== path.resolve(harnessBinary))
    throw new Error("terminal-startup-harness-flow-requires-harness-binary");
}
const spec = flowSpecs[flow];
const reportPath = process.env.THREADTERM_WDIO_REPORT;
const isWdioLauncher = readEnvironmentValue("WDIO_WORKER_ID") === undefined;

type LifecycleEvidence =
  "classicConfirmed" | "bidiDetected" | "bidiUnknown" | "sessionEnded";
type WdioStageEvidence =
  | "configLoaded"
  | "workerStarted"
  | "beforeSession"
  | "workerEnded";

const sessionEvidenceArm = createSessionEvidenceArm();

function recordLifecycleEvidence(event: LifecycleEvidence): void {
  if (!reportPath) throw new Error("wdio-lifecycle-report-path-missing");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify({ event })}\n`);
}

function recordWdioStageEvidence(stage: WdioStageEvidence): void {
  if (flow !== "isolation") return;
  // Contract imports intentionally omit the runner-owned report path. Actual
  // lifecycle evidence still fails closed in `before` when a session begins.
  if (!reportPath) return;
  mkdirSync(path.dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify({ wdioStage: stage })}\n`);
}

function recordSessionCreationEvidence(event: SessionCreationEvidence): void {
  if (flow !== "isolation") return;
  if (!reportPath) throw new Error("wdio-lifecycle-report-path-missing");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(sessionCreationRecord(event))}\n`);
}

function recordNoResponseEvidenceIfNeeded(): void {
  if (flow !== "isolation") return;
  if (!reportPath) throw new Error("wdio-lifecycle-report-path-missing");
  const report = readFileSync(reportPath, "utf8");
  if (needsNoResponseEvidence(report)) recordSessionCreationEvidence("noResponse");
}

function classicLifecycleEvidence(): LifecycleEvidence {
  try {
    if (browser.isBidi === false) return "classicConfirmed";
    if (browser.isBidi === true) return "bidiDetected";
  } catch {
    // The fixed unknown evidence below makes the run fail closed.
  }
  return "bidiUnknown";
}

export const config: Options.Testrunner = {
  runner: "local",
  specs: [path.join(root, "e2e", "terminal-startup", spec)],
  maxInstances: 1,
  // Do not let WebDriver debug logs expose synthetic terminal input or output.
  logLevel: "silent",
  // Bound WDIO's reconnect attempts so a missing driver fails within 20 seconds.
  connectionRetryTimeout: 10_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: [],
  mochaOpts: { ui: "bdd", timeout: 90_000 },
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",
  transformResponse: (response, requestOptions) => {
    if (flow === "isolation") {
      const evidence = sessionEvidenceArm.observeResponse(
        requestOptions.method,
        response,
      );
      if (evidence) recordSessionCreationEvidence(evidence);
    }
    return response;
  },
  capabilities: [
    {
      "wdio:enforceWebDriverClassic": true,
      webSocketUrl: false,
      "tauri:options": {
        application: appBinary,
        webviewOptions: {
          userDataFolder,
          ...(artifact === "harness" ? { additionalBrowserArguments } : {}),
        },
      },
    },
  ],
  before: async () => {
    if (flow !== "isolation") return;
    const event = classicLifecycleEvidence();
    recordLifecycleEvidence(event);
    if (event !== "classicConfirmed")
      throw new Error("wdio-classic-negotiation-unverified");
  },
  afterSession: async () => {
    if (flow !== "isolation") return;
    recordLifecycleEvidence("sessionEnded");
  },
  onWorkerStart: () => {
    recordWdioStageEvidence("workerStarted");
  },
  beforeSession: () => {
    recordWdioStageEvidence("beforeSession");
    if (flow === "isolation") sessionEvidenceArm.arm();
  },
  onWorkerEnd: () => {
    try {
      recordNoResponseEvidenceIfNeeded();
    } finally {
      recordWdioStageEvidence("workerEnded");
    }
  },
};

// This is deliberately after all environment, artifact, and config validation.
// It is a fixed diagnostic only; it cannot attest to a WebDriver session.
if (isWdioLauncher) recordWdioStageEvidence("configLoaded");
