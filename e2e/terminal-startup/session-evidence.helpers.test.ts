import { describe, expect, it } from "vitest";

import {
  classifySessionCreationResponse,
  createSessionEvidenceArm,
  needsNoResponseEvidence,
  sessionCreationEvidence,
  sessionCreationRecord,
} from "./session-evidence.helpers";

describe("session creation evidence", () => {
  it("maps only status and W3C error name to the fixed enum", () => {
    expect(
      classifySessionCreationResponse({ statusCode: 200, body: { value: {} } }),
    ).toBe("success");
    expect(
      classifySessionCreationResponse({
        statusCode: 400,
        body: { value: { error: "invalid argument", message: "secret" } },
      }),
    ).toBe("invalidArgument");
    expect(
      classifySessionCreationResponse({
        statusCode: 500,
        body: { value: { error: "session not created", message: "secret" } },
      }),
    ).toBe("sessionNotCreated");
    expect(
      classifySessionCreationResponse({
        statusCode: 500,
        body: { value: { error: "unknown error", message: "secret" } },
      }),
    ).toBe("unknownError");
    expect(classifySessionCreationResponse({ statusCode: 404 })).toBe("http4xx");
    expect(classifySessionCreationResponse({ statusCode: 503 })).toBe("http5xx");
    expect(classifySessionCreationResponse({ statusCode: "500" })).toBe("malformed");
  });

  it("fails closed for malformed successful HTTP responses", () => {
    expect(classifySessionCreationResponse({ statusCode: 200 })).toBe("malformed");
    expect(classifySessionCreationResponse({ statusCode: 200, body: null })).toBe(
      "malformed",
    );
    expect(
      classifySessionCreationResponse({ statusCode: 200, body: { value: null } }),
    ).toBe("malformed");
    expect(
      classifySessionCreationResponse({
        statusCode: 200,
        body: { value: { error: "unknown error" } },
      }),
    ).toBe("malformed");
  });

  it("records only the first armed POST response", () => {
    const arm = createSessionEvidenceArm();
    arm.arm();
    expect(arm.observeResponse("GET", { statusCode: 200 })).toBeUndefined();
    expect(arm.observeResponse("post", { statusCode: 500 })).toBe("http5xx");
    expect(arm.observeResponse("POST", { statusCode: 200 })).toBeUndefined();
    expect(() => arm.arm()).toThrow("session-evidence-arm-invalid");
  });

  it("emits a fixed, privacy-safe record instead of response content", () => {
    const evidence = classifySessionCreationResponse({
      statusCode: 500,
      body: { value: { error: "unknown error", message: "token=secret" } },
    });
    expect(sessionCreationRecord(evidence)).toEqual({
      sessionCreation: "unknownError",
    });
    expect(JSON.stringify(sessionCreationRecord(evidence))).not.toContain("secret");
  });

  it("keeps noResponse in the public fixed enum for the runner parser", () => {
    expect(sessionCreationEvidence.has("noResponse")).toBe(true);
  });

  it("requests noResponse only after beforeSession and before workerEnded", () => {
    const prefix = [
      '{"nativeDriverStatus":"ready"}',
      '{"wdioStage":"configLoaded"}',
      '{"wdioStage":"workerStarted"}',
      '{"wdioStage":"beforeSession"}',
    ].join("\n");
    expect(needsNoResponseEvidence(prefix)).toBe(true);
    expect(
      needsNoResponseEvidence(`${prefix}\n{"sessionCreation":"http5xx"}`),
    ).toBe(false);
    expect(() =>
      needsNoResponseEvidence(`${prefix}\n{"wdioStage":"workerEnded"}`),
    ).toThrow("session-evidence-report-order-invalid");
  });

  it("fails closed for malformed, duplicate, or out-of-order WDIO records", () => {
    expect(() => needsNoResponseEvidence("not-json")).toThrow(
      "session-evidence-report-invalid",
    );
    expect(() =>
      needsNoResponseEvidence(
        '{"wdioStage":"configLoaded"}\n{"wdioStage":"beforeSession"}',
      ),
    ).toThrow("session-evidence-report-order-invalid");
    expect(() =>
      needsNoResponseEvidence(
        '{"wdioStage":"configLoaded"}\n{"wdioStage":"workerStarted"}\n{"wdioStage":"beforeSession"}\n{"sessionCreation":"success"}\n{"sessionCreation":"success"}',
      ),
    ).toThrow("session-evidence-report-order-invalid");
  });
});
