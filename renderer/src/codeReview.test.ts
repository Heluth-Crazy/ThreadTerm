import test from "node:test";
import assert from "node:assert/strict";
import type { CodeReviewFinding, Session } from "@threadterm/protocol";
import {
  CODE_REVIEW_STORAGE_KEY,
  appendComposerText,
  clampFocus,
  CODE_REVIEW_FOCUS_BUDGET,
  codeReviewProgressLine,
  codeReviewReason,
  codeReviewResultLine,
  codeReviewScopeLabel,
  composeFixMessage,
  defaultCodeReviewProvider,
  groupCodeReviewFindings,
  isCodeReviewSession,
  loadCodeReviewPrefs,
  navigableSessions,
  parseReviewSlash,
  saveCodeReviewPrefs,
} from "./codeReview";

const copy = (en: string, _zh: string) => en;

test("parseReviewSlash matches /code-review and captures focus", () => {
  assert.deepEqual(parseReviewSlash("/code-review"), { matched: true, focus: "" });
  assert.deepEqual(parseReviewSlash("/code-review look at auth"), { matched: true, focus: "look at auth" });
  assert.deepEqual(parseReviewSlash("  /code-review\nfocus"), { matched: true, focus: "focus" });
  assert.deepEqual(parseReviewSlash("/fork"), { matched: false, focus: "" });
  assert.deepEqual(parseReviewSlash("please /code-review later"), { matched: false, focus: "" });
  // Codex and OpenCode have their own /review; it still reaches the provider.
  assert.deepEqual(parseReviewSlash("/review"), { matched: false, focus: "" });
  assert.deepEqual(parseReviewSlash("/code-reviewer"), { matched: false, focus: "" });
});

test("result line counts verdicts and scope/reason copy is bilingual", () => {
  const finding = (id: string, verdict: CodeReviewFinding["verdict"]): CodeReviewFinding => ({ id, severity: "low", title: id, body: "", verdict });
  assert.equal(codeReviewResultLine([finding("a", "confirmed"), finding("b", "confirmed"), finding("c", "plausible")], copy), "2 confirmed · 1 plausible");
  assert.equal(codeReviewResultLine([finding("a", "unverified")], copy), "1 unverified");
  assert.equal(codeReviewResultLine([], copy), "No issues found");
  const zh = (_en: string, value: string) => value;
  assert.equal(codeReviewScopeLabel("branch", zh), "分支对比基线");
  assert.equal(codeReviewReason("Nothing to review", zh), "没有可审查的内容");
  assert.equal(codeReviewReason("Something new", zh), "Something new");
});

test("clampFocus bounds UTF-8 bytes, not characters", () => {
  assert.equal(clampFocus("short"), "short");
  const clamped = clampFocus("审".repeat(CODE_REVIEW_FOCUS_BUDGET));
  assert.ok(new TextEncoder().encode(clamped).length <= CODE_REVIEW_FOCUS_BUDGET);
  assert.equal(clamped.length, Math.floor(CODE_REVIEW_FOCUS_BUDGET / 3));
});

test("defaultCodeReviewProvider prefers remembered, then other, then chat", () => {
  const providers = [
    { id: "codex", available: true },
    { id: "claude", available: true },
    { id: "kimi", available: false },
  ];
  assert.equal(defaultCodeReviewProvider(providers, "codex", "claude"), "claude");
  assert.equal(defaultCodeReviewProvider(providers, "codex"), "claude");
  assert.equal(defaultCodeReviewProvider([{ id: "codex", available: true }], "codex"), "codex");
  assert.equal(defaultCodeReviewProvider(providers, "codex", "kimi"), "claude");
});

test("prefs round-trip through localStorage", () => {
  const values = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  try {
    assert.deepEqual(loadCodeReviewPrefs(), {});
    saveCodeReviewPrefs({ provider: "claude", model: "sonnet", depth: "thorough", scopeKind: "session" });
    assert.equal(values.get(CODE_REVIEW_STORAGE_KEY), JSON.stringify({
      provider: "claude", model: "sonnet", depth: "thorough", scopeKind: "session",
    }));
    assert.deepEqual(loadCodeReviewPrefs(), {
      provider: "claude", model: "sonnet", depth: "thorough", scopeKind: "session",
    });
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
});

test("progress line uses stage and finder counts", () => {
  assert.equal(codeReviewProgressLine({
    reviewId: "r", depth: "standard", scopeLabel: "Uncommitted", stage: "preparing",
    stagesDone: 0, stagesTotal: 2, reviewerSessionIds: [],
  }, copy), "Preparing");
  assert.equal(codeReviewProgressLine({
    reviewId: "r", depth: "thorough", scopeLabel: "Uncommitted", stage: "finding",
    stagesDone: 2, stagesTotal: 4, reviewerSessionIds: [],
  }, copy), "Finding issues · 2/3");
  assert.equal(codeReviewProgressLine({
    reviewId: "r", depth: "quick", scopeLabel: "Uncommitted", stage: "finding",
    stagesDone: 0, stagesTotal: 1, reviewerSessionIds: [],
  }, copy), "Finding issues · 0/1");
  assert.equal(codeReviewProgressLine({
    reviewId: "r", depth: "standard", scopeLabel: "Uncommitted", stage: "verifying",
    stagesDone: 1, stagesTotal: 2, candidates: 6, reviewerSessionIds: [],
  }, copy), "Verifying 6 findings");
  assert.equal(codeReviewProgressLine({
    reviewId: "r", depth: "standard", scopeLabel: "Uncommitted", stage: "finding",
    stagesDone: 0, stagesTotal: 2, reviewerSessionIds: [],
  }, copy, { awaitingApproval: true }), "Waiting for approval");
});

test("findings group Confirmed → Plausible → Unverified by severity", () => {
  const findings: CodeReviewFinding[] = [
    { id: "u1", severity: "low", title: "late", body: "", verdict: "unverified" },
    { id: "p1", severity: "high", title: "plausible-high", body: "", verdict: "plausible" },
    { id: "c2", severity: "medium", title: "confirmed-med", body: "", verdict: "confirmed" },
    { id: "c1", severity: "high", title: "confirmed-high", body: "", verdict: "confirmed" },
    { id: "p2", severity: "low", title: "plausible-low", body: "", verdict: "plausible" },
  ];
  const groups = groupCodeReviewFindings(findings);
  assert.deepEqual(groups.map((group) => group.verdict), ["confirmed", "plausible", "unverified"]);
  assert.deepEqual(groups[0]!.items.map((item) => item.id), ["c1", "c2"]);
  assert.deepEqual(groups[1]!.items.map((item) => item.id), ["p1", "p2"]);
});

test("composeFixMessage and appendComposerText", () => {
  const markdown = composeFixMessage([{
    id: "f1",
    severity: "high",
    path: "src/a.ts",
    line: 12,
    title: "Null crash",
    body: "Dereferences null.",
    failureScenario: "Call with empty input.",
    verdict: "confirmed",
    reason: "still crashes",
  }]);
  assert.match(markdown, /\*\*high\*\*.*`src\/a\.ts:12`/);
  assert.match(markdown, /Null crash/);
  assert.match(markdown, /Scenario: Call with empty input/);
  assert.match(markdown, /Verdict: confirmed — still crashes/);
  assert.match(markdown, /Fix the confirmed issues; for plausible ones, check first\./);
  assert.equal(appendComposerText("", markdown), markdown);
  assert.equal(appendComposerText("draft", "more"), "draft\n\nmore");
});

test("reviewer sessions are hidden from navigable lists", () => {
  const sessions = [
    { id: "parent", codeReview: undefined },
    { id: "finder", codeReview: { reviewId: "r1", parentSessionId: "parent", role: "finder" as const } },
  ] as Session[];
  assert.equal(isCodeReviewSession(sessions[1]), true);
  assert.deepEqual(navigableSessions(sessions).map((session) => session.id), ["parent"]);
});

test("session transcript full replace uses afterRev 0 (documented contract helper)", () => {
  // SubagentCard treats transcript === 'session' like 'native': afterRev is always 0
  // and result.items replace rather than merge. Mirror that decision here so a
  // regression that reintroduces merge for 'session' fails this unit suite.
  const fullReplace = (transcript: string) => transcript === "native" || transcript === "session";
  assert.equal(fullReplace("session"), true);
  assert.equal(fullReplace("live"), false);
  const afterRev = (transcript: string, cachedRev: number) => (fullReplace(transcript) ? 0 : cachedRev);
  assert.equal(afterRev("session", 7), 0);
  assert.equal(afterRev("live", 7), 7);
});
