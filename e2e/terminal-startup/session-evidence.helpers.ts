export type SessionCreationEvidence =
  | "success"
  | "invalidArgument"
  | "sessionNotCreated"
  | "unknownError"
  | "http4xx"
  | "http5xx"
  | "malformed"
  | "noResponse";

type ResponseLike = {
  statusCode: unknown;
  body?: unknown;
};

type ReportRecord = Record<string, unknown>;

export const sessionCreationEvidence = new Set<SessionCreationEvidence>([
  "success",
  "invalidArgument",
  "sessionNotCreated",
  "unknownError",
  "http4xx",
  "http5xx",
  "malformed",
  "noResponse",
]);

export function sessionCreationRecord(
  evidence: SessionCreationEvidence,
): { sessionCreation: SessionCreationEvidence } {
  return { sessionCreation: evidence };
}

const wdioStages = [
  "configLoaded",
  "workerStarted",
  "beforeSession",
  "workerEnded",
] as const;

function isObject(value: unknown): value is ReportRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sessionError(value: unknown): string | undefined {
  if (!isObject(value) || !isObject(value.value)) return undefined;
  return typeof value.value.error === "string" ? value.value.error : undefined;
}

function isSuccessfulSessionBody(value: unknown): boolean {
  return (
    isObject(value) &&
    isObject(value.value) &&
    !Object.hasOwn(value.value, "error")
  );
}

/**
 * This deliberately classifies only WebDriver's HTTP status and the W3C error
 * name.  It must never retain response messages, request data, capabilities,
 * or any other potentially sensitive material.
 */
export function classifySessionCreationResponse(
  response: ResponseLike,
): Exclude<SessionCreationEvidence, "noResponse"> {
  const { statusCode } = response;
  if (
    typeof statusCode !== "number" ||
    !Number.isSafeInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 599
  ) {
    return "malformed";
  }
  if (statusCode >= 200 && statusCode < 300)
    return isSuccessfulSessionBody(response.body) ? "success" : "malformed";

  const error = sessionError(response.body);
  if (error === "invalid argument") return "invalidArgument";
  if (error === "session not created") return "sessionNotCreated";
  if (error === "unknown error") return "unknownError";
  if (statusCode >= 400 && statusCode < 500) return "http4xx";
  if (statusCode >= 500) return "http5xx";
  return "malformed";
}

export function createSessionEvidenceArm(): {
  arm(): void;
  observeResponse(
    method: unknown,
    response: ResponseLike,
  ): Exclude<SessionCreationEvidence, "noResponse"> | undefined;
} {
  let armed = false;
  let observed = false;
  return {
    arm(): void {
      if (armed || observed) throw new Error("session-evidence-arm-invalid");
      armed = true;
    },
    observeResponse(method, response) {
      if (!armed || typeof method !== "string" || method.toUpperCase() !== "POST")
        return undefined;
      armed = false;
      observed = true;
      return classifySessionCreationResponse(response);
    },
  };
}

function parseReportRecord(line: string): ReportRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("session-evidence-report-invalid");
  }
  if (!isObject(parsed)) throw new Error("session-evidence-report-invalid");
  return parsed;
}

function exactRecord(record: ReportRecord, key: string): boolean {
  return Object.keys(record).length === 1 && Object.hasOwn(record, key);
}

/**
 * The runner owns non-WDIO diagnostics in the same JSONL file.  This reader
 * validates every WDIO-owned record and refuses malformed JSON, duplicate
 * session evidence, and invalid lifecycle order while leaving runner-owned
 * diagnostic schemas to the runner's stricter parser.
 */
export function needsNoResponseEvidence(report: string): boolean {
  let expectedStage = 0;
  let sessionCreationSeen = false;
  let workerEnded = false;

  for (const line of report.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const record = parseReportRecord(line);
    if (Object.hasOwn(record, "wdioStage")) {
      if (!exactRecord(record, "wdioStage"))
        throw new Error("session-evidence-report-invalid");
      const stage = record.wdioStage;
      if (stage !== wdioStages[expectedStage])
        throw new Error("session-evidence-report-order-invalid");
      expectedStage += 1;
      workerEnded = stage === "workerEnded";
      continue;
    }
    if (Object.hasOwn(record, "sessionCreation")) {
      if (
        !exactRecord(record, "sessionCreation") ||
        typeof record.sessionCreation !== "string" ||
        !sessionCreationEvidence.has(
          record.sessionCreation as SessionCreationEvidence,
        ) ||
        expectedStage !== 3 ||
        sessionCreationSeen ||
        workerEnded
      ) {
        throw new Error("session-evidence-report-order-invalid");
      }
      sessionCreationSeen = true;
    }
  }

  if (workerEnded) throw new Error("session-evidence-report-order-invalid");
  return expectedStage === 3 && !sessionCreationSeen;
}
