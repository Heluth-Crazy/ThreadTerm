import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import {
  invoke,
  normalizeWindowsCanonicalPath,
  waitForSurface,
} from "./helpers";

const reportPath = process.env.THREADTERM_WDIO_REPORT;
const runtimeIsolationMarker =
  process.env.THREADTERM_WDIO_RUNTIME_ISOLATION_MARKER;
const runtimeIsolationMarkerBasename = ".threadterm-runtime-isolation-v1";
const runtimeIsolationMarkerContents =
  "THREADTERM_RUNTIME_ISOLATION_MATCHED_V1\n";
const runtimeIsolationMarkerTimeoutMs = 45_000;
const runtimeIsolationMarkerPollMs = 100;
const capabilityNames = [
  "shellForcing",
  "timingInjection",
  "faultInjection",
  "readOnlyObservation",
] as const;
type CapabilityName = (typeof capabilityNames)[number];
type CapabilityValue = "supported" | "unsupported" | "unknown";
type CspStatus = "isolated" | "mismatch";
type DriverUdfStatus = "confirmed" | "missing" | "invalid" | "mismatch";
type RuntimeUdfStatus = "matched" | "mismatch" | "unavailable" | "invalid";
const driverUdfEvents: Record<DriverUdfStatus, string> = {
  confirmed: "driverUdfConfirmed",
  missing: "driverUdfMissing",
  invalid: "driverUdfInvalid",
  mismatch: "driverUdfMismatch",
};
const runtimeUdfEvents: Record<RuntimeUdfStatus, string> = {
  matched: "runtimeUdfConfirmed",
  mismatch: "runtimeUdfMismatch",
  unavailable: "runtimeUdfUnavailable",
  invalid: "runtimeUdfInvalid",
};
const counterNames = [
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
] as const;

type HarnessStatus = {
  enabled?: unknown;
  shellForcing?: unknown;
  timingInjection?: unknown;
  faultInjection?: unknown;
  readOnlyObservation?: unknown;
  counters?: unknown;
};

function capability(value: unknown): CapabilityValue {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

function numericCounters(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    counterNames
      .filter(
        (name) =>
          typeof source[name] === "number" && Number.isFinite(source[name]),
      )
      .map((name) => [name, source[name] as number]),
  );
}

function statusProjection(value: unknown): {
  enabled: boolean;
  capabilities: Record<CapabilityName, CapabilityValue>;
  counters: Record<string, unknown>;
} {
  const status =
    value && typeof value === "object" ? (value as HarnessStatus) : {};
  const capabilities = Object.fromEntries(
    capabilityNames.map((name) => [name, capability(status[name])]),
  ) as Record<CapabilityName, CapabilityValue>;
  const counters = numericCounters(status.counters);
  return { enabled: status.enabled === true, capabilities, counters };
}

function classifyNegotiatedDriverUdf(expectedUdf: unknown): DriverUdfStatus {
  const capabilities = (browser as unknown as { capabilities?: unknown })
    .capabilities;
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  )
    return "invalid";
  if (!Object.prototype.hasOwnProperty.call(capabilities, "msedge.userDataDir"))
    return "missing";
  const actualUdf = (capabilities as Record<string, unknown>)[
    "msedge.userDataDir"
  ];
  if (typeof actualUdf !== "string" || actualUdf.length === 0) return "invalid";
  if (typeof expectedUdf !== "string" || expectedUdf.length === 0)
    return "invalid";
  if (!isAbsolute(actualUdf) || !isAbsolute(expectedUdf)) return "invalid";

  // This is diagnostic-only. Runtime authority comes from the feature-gated
  // Rust command that reads CoreWebView2 Environment.UserDataFolder.
  if (actualUdf !== expectedUdf) return "mismatch";

  const actualNormalized = normalizeWindowsCanonicalPath(actualUdf);
  const expectedNormalized = normalizeWindowsCanonicalPath(expectedUdf);
  if (actualNormalized !== expectedNormalized) return "invalid";

  try {
    const stat = lstatSync(expectedUdf);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "invalid";
    const canonicalExpected = realpathSync.native(expectedUdf);
    return canonicalExpected === expectedUdf &&
      normalizeWindowsCanonicalPath(canonicalExpected) === expectedNormalized
      ? "confirmed"
      : "mismatch";
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "invalid";
  }
}

async function inspectEffectiveCsp(expectedPolicy: string): Promise<CspStatus> {
  try {
    const result = (await browser.execute(async (expected) => {
      type Policy = Map<string, string[]>;

      const normalizeToken = (token: string): string => {
        // Nonce/hash values are case-sensitive; source names and schemes are not.
        return /^'(?:nonce|sha(?:256|384|512))-/.test(token)
          ? token
          : token.toLowerCase();
      };

      const parsePolicy = (value: unknown): Policy | undefined => {
        if (typeof value !== "string" || value.trim() === "") return undefined;
        const directives = new Map<string, string[]>();
        for (const part of value.split(";")) {
          const tokens = part.trim().split(/\s+/).filter(Boolean);
          if (tokens.length === 0) continue;
          const name = tokens.shift()?.toLowerCase();
          if (!name || directives.has(name)) return undefined;
          const normalizedTokens = tokens.map(normalizeToken);
          if (new Set(normalizedTokens).size !== normalizedTokens.length)
            return undefined;
          directives.set(name, normalizedTokens);
        }
        return directives.size > 0 ? directives : undefined;
      };

      const isSafeDynamicToken = (token: string): boolean =>
        // Tauri may add only these cryptographic script/style sources. Any
        // other effective-policy expansion remains a mismatch.
        /^'(?:nonce-[A-Za-z0-9+/_-]+={0,2}|sha(?:256|384|512)-[A-Za-z0-9+/_-]+=*)'$/.test(
          token,
        );

      const isOfflineSource = (directive: string, token: string): boolean => {
        const lower = token.toLowerCase();
        if (
          lower.includes("fonts.googleapis.com") ||
          lower.includes("fonts.gstatic.com")
        )
          return false;
        if (isSafeDynamicToken(token))
          return directive === "script-src" || directive === "style-src";
        if (/^(?:https?|wss?):/i.test(token))
          return lower === "http://asset.localhost";
        return [
          "'self'",
          "'none'",
          "'unsafe-inline'",
          "asset:",
          "blob:",
          "data:",
        ].includes(lower);
      };

      const matchesOfflinePolicy = (
        actualValue: unknown,
        expectedValue: unknown,
      ): boolean => {
        const actual = parsePolicy(actualValue);
        const expectedPolicy = parsePolicy(expectedValue);
        if (!actual || !expectedPolicy) return false;

        for (const [directive, tokens] of expectedPolicy) {
          if (!tokens.every((token) => isOfflineSource(directive, token)))
            return false;
          const actualTokens = actual.get(directive);
          if (!actualTokens) return false;
          const actualSet = new Set(actualTokens);
          if (!tokens.every((token) => actualSet.has(token))) return false;
          if (
            actualTokens.some(
              (token) =>
                !tokens.includes(token) &&
                (!isSafeDynamicToken(token) ||
                  (directive !== "script-src" && directive !== "style-src")),
            )
          )
            return false;
        }
        if (
          [...actual.keys()].some((directive) => !expectedPolicy.has(directive))
        )
          return false;
        return [...actual].every(([directive, tokens]) =>
          tokens.every((token) => isOfflineSource(directive, token)),
        );
      };

      const meta = [...document.querySelectorAll("meta")].find(
        (candidate) =>
          candidate.httpEquiv.toLowerCase() === "content-security-policy",
      );
      let effectivePolicy = meta?.content || undefined;
      if (!effectivePolicy) {
        try {
          // The fallback is deliberately limited to the current document URL;
          // redirects are rejected so this check cannot probe another origin.
          const response = await fetch(window.location.href, {
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
          });
          effectivePolicy =
            response.headers.get("content-security-policy") || undefined;
        } catch {
          effectivePolicy = undefined;
        }
      }

      return {
        status: matchesOfflinePolicy(effectivePolicy, expected)
          ? "isolated"
          : "mismatch",
      };
    }, expectedPolicy)) as { status?: unknown };
    return result?.status === "isolated" ? "isolated" : "mismatch";
  } catch {
    return "mismatch";
  }
}

function appendReportRecord(record: Record<string, unknown>): void {
  if (!reportPath) throw new Error("wdio-isolation-report-path-missing");
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(record)}\n`);
}

function record(
  isolation: "isolated" | "mismatch",
  projection: ReturnType<typeof statusProjection>,
  csp: CspStatus,
): void {
  appendReportRecord({
    isolation,
    csp,
    enabled: projection.enabled,
    capabilities: projection.capabilities,
    counters: projection.counters,
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function runtimeIsolationMarkerPath(): string {
  if (
    typeof runtimeIsolationMarker !== "string" ||
    !isAbsolute(runtimeIsolationMarker) ||
    basename(runtimeIsolationMarker) !== runtimeIsolationMarkerBasename
  ) {
    throw new Error("runtime-isolation-marker-invalid");
  }

  const temp = process.env.TEMP;
  const tmp = process.env.TMP;
  if (
    typeof temp !== "string" ||
    typeof tmp !== "string" ||
    !isAbsolute(temp) ||
    !isAbsolute(tmp)
  ) {
    throw new Error("runtime-isolation-temp-invalid");
  }

  const canonicalTemp = realpathSync(temp);
  if (canonicalTemp !== realpathSync(tmp)) {
    throw new Error("runtime-isolation-temp-mismatch");
  }
  if (realpathSync(dirname(runtimeIsolationMarker)) !== canonicalTemp) {
    throw new Error("runtime-isolation-marker-outside-temp");
  }
  return runtimeIsolationMarker;
}

async function waitForRuntimeIsolationMarker(): Promise<void> {
  const marker = runtimeIsolationMarkerPath();
  const deadline = Date.now() + runtimeIsolationMarkerTimeoutMs;
  for (;;) {
    try {
      const stat = lstatSync(marker);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("runtime-isolation-marker-invalid");
      }
      if (readFileSync(marker, "utf8") !== runtimeIsolationMarkerContents) {
        throw new Error("runtime-isolation-marker-mismatch");
      }
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("runtime-isolation-marker-timeout");
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, runtimeIsolationMarkerPollMs),
    );
  }
}

describe("harness terminal startup isolation", () => {
  it("fails closed unless the harness is enabled and owns the expected root", async () => {
    try {
      if (
        (process.env.THREADTERM_WDIO_ARTIFACT ?? "production") !== "harness"
      ) {
        throw new Error("isolation-requires-harness-artifact");
      }

      const driverUdfStatus = classifyNegotiatedDriverUdf(
        process.env.THREADTERM_WDIO_UDF,
      );
      appendReportRecord({ event: driverUdfEvents[driverUdfStatus] });
      if (driverUdfStatus === "invalid" || driverUdfStatus === "mismatch") {
        throw new Error("negotiated-driver-udf-unconfirmed");
      }

      await waitForSurface((diagnostic) => appendReportRecord(diagnostic));

      const runtimeUdf = await invoke(
        "terminal_startup_harness_attest_runtime_udf",
        {},
      );
      const runtimeUdfStatus =
        runtimeUdf.ok &&
        (runtimeUdf.value === "matched" ||
          runtimeUdf.value === "mismatch" ||
          runtimeUdf.value === "unavailable" ||
          runtimeUdf.value === "invalid")
          ? runtimeUdf.value
          : "invalid";
      appendReportRecord({ event: runtimeUdfEvents[runtimeUdfStatus] });
      if (runtimeUdfStatus !== "matched") {
        throw new Error("runtime-udf-unconfirmed");
      }

      const harnessStatus = await invoke("terminal_startup_harness_status", {});
      const projection = statusProjection(
        harnessStatus.ok ? harnessStatus.value : undefined,
      );
      const capabilitiesSupported = capabilityNames.every(
        (name) => projection.capabilities[name] === "supported",
      );
      if (!projection.enabled || !capabilitiesSupported) {
        record("mismatch", projection, "mismatch");
        throw new Error("terminal-startup-harness-capability-unavailable");
      }

      const expectedCsp = process.env.THREADTERM_WDIO_EXPECT_OFFLINE_CSP;
      if (typeof expectedCsp !== "string" || expectedCsp.trim() === "") {
        record("mismatch", projection, "mismatch");
        throw new Error("isolation-csp-expectation-missing");
      }

      const csp = await inspectEffectiveCsp(expectedCsp);

      const result = await invoke("data_directory_status", {});
      const root =
        result.ok && result.value && typeof result.value === "object"
          ? (result.value as { root?: unknown }).root
          : undefined;
      const expected = process.env.THREADTERM_WDIO_DATA_ROOT;
      const isolated =
        typeof root === "string" &&
        typeof expected === "string" &&
        normalizeWindowsCanonicalPath(root) ===
          normalizeWindowsCanonicalPath(expected);
      record(
        isolated && csp === "isolated" ? "isolated" : "mismatch",
        projection,
        csp,
      );
      if (!isolated) throw new Error("managed-data-root-mismatch");
      if (csp !== "isolated") throw new Error("offline-csp-mismatch");
      await waitForRuntimeIsolationMarker();
      appendReportRecord({ event: "frameworkPassed" });
    } catch (error) {
      try {
        appendReportRecord({ event: "frameworkFailed" });
      } catch {
        // The original test failure remains authoritative.
      }
      throw error;
    }
  });
});
