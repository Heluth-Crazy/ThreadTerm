// Target-policy (OpenCode 2.2.5) form semantics in the renderer. The corpus is the same file the
// Rust runtime validates against, so the ordered evaluation contract cannot drift between them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ChatInteractionForm } from "./chatQuestion";
import { activeFormFields, blockedFormFields, formAnswerValues, formFieldIssues, formPolicy, initialFormValues, questionSummary, type QuestionValue, type TargetForm, validQuestionValues } from "./chatQuestion";

const en = (text: string) => text;
const corpus = JSON.parse(readFileSync("runtime/tests/fixtures/opencode-v2-canonical-forms.json", "utf8")) as {
  vectors: { id: string; form: ChatInteractionForm; values: Record<string, QuestionValue>; expectedValid: boolean; activeIds?: string[] }[];
};
/** Schema-level rows: the adapter rejects these before any card exists, so there is no UI to test. */
const rejectedByTheAdapter = new Set([
  "v2-condition-boolean-false-does-not-match-zero",
  "v2-malformed-forward-condition-reference",
  "v2-malformed-condition-targets-external",
  "v2-malformed-closed-option-condition",
  "v2-malformed-multiselect-missing-options",
  "v2-malformed-duplicate-field-keys",
  "v2-malformed-numeric-condition-with-boolean-value",
  "v2-malformed-unknown-condition-op",
]);

test("the stored target policy evaluates the shared corpus exactly like the runtime", () => {
  for (const row of corpus.vectors) {
    if (row.id === "v2-malformed-validation-metadata") {
      assert.equal(formPolicy(row.form), "unsupported", "an unknown stored policy is never treated as legacy");
      continue;
    }
    if (rejectedByTheAdapter.has(row.id)) {
      assert.notEqual(formPolicy(row.form), "legacy", row.id);
      continue;
    }
    assert.equal(validQuestionValues(row.form, row.values), row.expectedValid, row.id);
    if (row.activeIds && formPolicy(row.form) === "opencode-v2") {
      assert.deepEqual(activeFormFields(row.form as TargetForm, row.values).map(field => field.id), row.activeIds, row.id);
    }
  }
});

test("only an explicit stored target policy leaves the legacy form semantics", () => {
  const fields = [{ id: "name", type: "string" as const, required: true }];
  assert.equal(formPolicy({ kind: "form", message: "m", fields }), "legacy");
  assert.equal(formPolicy({ kind: "form", message: "m", fields, validation: { semantics: "opencode-v2", patternAndFormat: "native" } }), "opencode-v2");
  assert.equal(formPolicy({ kind: "url", message: "m", url: "https://example.test" }), "legacy");
  assert.equal(formPolicy({ kind: "questions", questions: [] }), "legacy");
});

test("target drafts survive deactivation in memory but never reach the outgoing answer", () => {
  const form: TargetForm = { kind: "form", message: "cascade", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [
    { id: "enabled", type: "boolean", required: true },
    { id: "detail", type: "string", required: true, when: [{ key: "enabled", op: "eq", value: true }] },
  ] };
  const active = { enabled: true, detail: "typed" };
  assert.deepEqual(formAnswerValues(form, active), { enabled: true, detail: "typed" });
  const inactive = { ...active, enabled: false };
  assert.deepEqual(formAnswerValues(form, inactive), { enabled: false }, "the inactive draft is not sent");
  assert.deepEqual(formAnswerValues(form, { ...inactive, enabled: true }), active, "reactivation restores it unchanged");
  assert.deepEqual(formFieldIssues(form, { enabled: false, detail: "" }), {}, "an inactive draft is not validated");
  assert.deepEqual(formFieldIssues(form, { enabled: true, detail: "" }), { detail: "required" });
});

test("target answers keep explicit false, zero and empty values", () => {
  const form: TargetForm = { kind: "form", message: "values", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [
    { id: "flag", type: "boolean", required: true },
    { id: "zero", type: "integer", required: true, minimum: 0 },
    { id: "empty", type: "string", required: false },
    { id: "missing", type: "string", required: false },
  ] };
  const values = { flag: false, zero: 0, empty: "" };
  assert.deepEqual(formAnswerValues(form, values), values, "only the missing value is omitted");
  assert.deepEqual(formFieldIssues(form, values), {});
  assert.equal(validQuestionValues(form, values), true);
  assert.equal(validQuestionValues(form, { ...values, extra: "no" }), false, "an unanswered key is not a valid answer");
});

test("target choice fields submit option values, keep custom text and describe options", () => {
  const form: TargetForm = { kind: "form", message: "choices", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [
    { id: "one", type: "string", required: true, options: [{ value: "v1", label: "Label one", description: "First" }], custom: false },
    { id: "free", type: "string", required: true, options: [{ value: "v2", label: "Label two" }], custom: true },
    { id: "many", type: "multiselect", required: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], custom: true },
  ] };
  assert.deepEqual(formFieldIssues(form, { one: "v1", free: "typed", many: ["a", "typed"] }), {});
  assert.deepEqual(formAnswerValues(form, { one: "v1", free: "Label one", many: ["a", "b"] }), { one: "v1", free: "Label one", many: ["a", "b"] }, "labels are never substituted for values, and long/custom text is unchanged");
  assert.equal(formFieldIssues(form, { one: "Label one", free: "x", many: ["a"] }).one, "unoffered", "a display label is not a value");
  assert.equal(formFieldIssues(form, { one: "v1", free: "x", many: ["a", "a"] }).many, undefined, "the target accepts duplicate selections");
  assert.equal(formFieldIssues(form, { one: "v1", free: "x", many: [] }).many, "required");
  assert.equal(formFieldIssues(form, { one: "v1", free: "x", many: ["a", "zzz"] }).many, undefined, "custom multiselect keeps unoffered text");
  const closed: TargetForm = { ...form, fields: [{ ...form.fields[2], custom: false }] };
  assert.equal(formFieldIssues(closed, { many: ["a", "zzz"] }).many, "unoffered", "a closed multiselect rejects unoffered text");
});

test("target lengths follow the native UTF-16 and whitespace rules", () => {
  const form: TargetForm = { kind: "form", message: "lengths", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [{ id: "v", type: "string", required: true, maxLength: 1 }] };
  assert.equal(formFieldIssues(form, { v: "😀" }).v, "too-long", "an astral emoji is two UTF-16 units");
  assert.deepEqual(formFieldIssues(form, { v: " " }), {}, "whitespace satisfies a required target string");
  const legacy = { kind: "form" as const, message: "legacy", fields: [{ id: "v", type: "string" as const, required: true }] };
  assert.equal(validQuestionValues(legacy, { v: " " }), false, "legacy keeps its trimmed-whitespace rule");
});

test("target external steps need their own acknowledgement, not a click", () => {
  const form: TargetForm = { kind: "form", message: "external", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [
    { id: "first", type: "external", url: "https://example.test/a", title: "Open A" },
    { id: "second", type: "external", url: "not-a-url", title: "Open B" },
  ] };
  assert.deepEqual(formFieldIssues(form, {}), { first: "acknowledge", second: "acknowledge" });
  assert.deepEqual(formFieldIssues(form, { first: true }), { second: "acknowledge" });
  assert.equal(formFieldIssues(form, { first: true, second: "true" }).second, "acknowledge", "only literal true acknowledges");
  assert.deepEqual(formAnswerValues(form, { first: true, second: true }), { first: true, second: true }, "each acknowledgement keeps its own key and no URL is evaluated locally");
});

test("hidden target fields are not summarized and an unanswerable one is reported", () => {
  const withDefault: TargetForm = { kind: "form", message: "hidden", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [
    { id: "hidden", type: "string", required: true, hidden: true, default: "H" },
    { id: "zero", type: "integer", required: true, minimum: 0, default: 0 },
  ] };
  assert.deepEqual(initialFormValues(withDefault), { hidden: "H", zero: 0 });
  assert.equal(questionSummary(withDefault, { hidden: "H", zero: 0 }, en), "zero: 0");
  const missing: TargetForm = { kind: "form", message: "hidden", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [{ id: "hidden", type: "string", required: true, hidden: true }] };
  assert.deepEqual(blockedFormFields(missing, {}).map(field => field.id), ["hidden"]);
  assert.deepEqual(blockedFormFields(withDefault, { hidden: "H" }), []);
});

test("a target form's constraints stay native-authoritative", () => {
  const form: TargetForm = { kind: "form", message: "native constraints", validation: { semantics: "opencode-v2", patternAndFormat: "native" }, fields: [
    { id: "pattern", type: "string", required: true, pattern: "[" },
    { id: "mail", type: "string", required: true, format: "email" },
    { id: "uri", type: "string", required: true, format: "uri" },
  ] };
  assert.deepEqual(formFieldIssues(form, { pattern: "anything", mail: "bad", uri: "not-a-url" }), {}, "no local regex or URL approximation runs on the card");
  assert.equal(validQuestionValues(form, { pattern: "anything", mail: "bad", uri: "not-a-url" }), true);
});
