import assert from "node:assert/strict";
import { test } from "node:test";
import { questionPresentation, questionSummary, validQuestionValues, visibleControlCharacters } from "./chatQuestion";

const en = (text: string) => text;

test("question validation mirrors single, other, and typed form constraints", () => {
  const questions = { kind: "questions" as const, questions: [{ id: "one", question: "Choose", options: [{ label: "A" }], multiSelect: false, allowOther: false, secret: false }] };
  assert.equal(validQuestionValues(questions, { one: ["A"] }), true);
  assert.equal(validQuestionValues(questions, { one: ["A", "B"] }), false);
  assert.equal(validQuestionValues(questions, {}), false);
  assert.equal(validQuestionValues(questions, { one: ["B"] }), false);
  assert.equal(validQuestionValues(questions, { one: [" "] }), false);
  assert.equal(validQuestionValues(questions, { other: ["A"] }), false);
  const other = { kind: "questions" as const, questions: [{ ...questions.questions[0], allowOther: true }] };
  assert.equal(validQuestionValues(other, { one: ["B"] }), true);
  const form = { kind: "form" as const, message: "Details", fields: [
    { id: "name", type: "string" as const, required: true, minLength: 2, maxLength: 6 },
    { id: "count", type: "integer" as const, required: true, minimum: 1, maximum: 3 },
    { id: "enabled", type: "boolean" as const, required: true },
    { id: "tone", type: "enum" as const, required: true, options: [{ value: "calm", label: "Calm" }] },
    { id: "tags", type: "multiEnum" as const, required: true, minItems: 1, maxItems: 2, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { id: "optional", type: "number" as const, required: false },
  ] };
  const valid = { name: "Ada", count: 2, enabled: false, tone: "calm", tags: ["a"] as string[] };
  assert.equal(validQuestionValues(form, valid), true);
  assert.equal(validQuestionValues(form, { ...valid, name: " " }), false);
  assert.equal(validQuestionValues(form, { ...valid, count: 2.5 }), false);
  assert.equal(validQuestionValues(form, { ...valid, enabled: "false" }), false);
  assert.equal(validQuestionValues(form, { ...valid, tone: "loud" }), false);
  assert.equal(validQuestionValues(form, { ...valid, tags: [] }), false);
  assert.equal(validQuestionValues(form, { ...valid, tags: ["a", "a"] }), false);
  assert.equal(validQuestionValues(form, { ...valid, tags: ["missing"] }), false);
  assert.equal(validQuestionValues(form, { ...valid, optional: 1.5 }), true);
  assert.equal(validQuestionValues(form, { ...valid, extra: "no" }), false);
  const multiRequired = { kind: "form" as const, message: "Required", fields: [{ id: "tags", type: "multiEnum" as const, required: true, options: [{ value: "a", label: "A" }] }] };
  const multiOptional = { kind: "form" as const, message: "Optional", fields: [{ id: "tags", type: "multiEnum" as const, required: false, options: [{ value: "a", label: "A" }] }] };
  assert.equal(validQuestionValues(multiRequired, { tags: [] }), false);
  assert.equal(validQuestionValues(multiOptional, { tags: [] }), true);
});

test("question summaries mask secret values", () => {
  const form = { kind: "form" as const, message: "Credentials", fields: [{ id: "token", title: "Token", type: "string" as const, required: true, secret: true }, { id: "name", title: "Name", type: "string" as const, required: true }] };
  assert.equal(questionSummary(form, { token: "hidden", name: "Ada" }, en), "Token: •••• · Name: Ada");
});

test("question summaries add no colon after a question mark or colon", () => {
  const ask = (question: string) => ({ kind: "questions" as const, questions: [{ id: "q", question, options: [{ label: "Blue" }], multiSelect: false, allowOther: false, secret: false }] });
  assert.equal(questionSummary(ask("Which color should the QA use?"), { q: ["Blue"] }, en), "Which color should the QA use? Blue");
  assert.equal(questionSummary(ask("使用哪个颜色？"), { q: ["Blue"] }, en), "使用哪个颜色？ Blue");
  assert.equal(questionSummary(ask("Color:"), { q: ["Blue"] }, en), "Color: Blue");
  assert.equal(questionSummary(ask("Color"), { q: ["Blue"] }, en), "Color: Blue");
});

test("question validation enforces supported formats and url emptiness", () => {
  const format = (value: string, type: "email" | "uri" | "date" | "date-time") => ({ kind: "form" as const, message: "Format", fields: [{ id: "value", type: "string" as const, required: true, format: type }] });
  assert.equal(validQuestionValues(format("ada@example.test", "email"), { value: "ada@example.test" }), true);
  assert.equal(validQuestionValues(format("not an email", "email"), { value: "not an email" }), false);
  assert.equal(validQuestionValues(format("https://example.test/a", "uri"), { value: "https://example.test/a" }), true);
  assert.equal(validQuestionValues(format("2026-02-30", "date"), { value: "2026-02-30" }), false);
  assert.equal(validQuestionValues(format("2026-10-07T12:00:00Z", "date-time"), { value: "2026-10-07T12:00:00Z" }), true);
  assert.equal(validQuestionValues(format("2026-10-07", "date-time"), { value: "2026-10-07" }), false);
  const url = { kind: "url" as const, message: "Open", url: "https://example.test" };
  assert.equal(validQuestionValues(url, {}), true);
  assert.equal(validQuestionValues(url, { unexpected: "value" }), false);
});

test("only a runtime-marked run approval splits its command into its own block", () => {
  const plain = { id: "q1", question: "Choose one\nsecond line", options: [{ label: "A" }], multiSelect: false, allowOther: false, secret: false };
  assert.deepEqual(questionPresentation(plain), { title: "Choose one\nsecond line" }, "an ordinary multi-line question is untouched");
  const marked = { ...plain, question: "Run this detected command from `package.json` in `work`?\nnpm run dev", presentation: "command" as const, command: "npm run dev" };
  assert.deepEqual(questionPresentation(marked), { title: "Run this detected command from `package.json` in `work`?", command: "npm run dev" });
  assert.equal(questionPresentation({ ...marked, command: undefined }).command, "npm run dev", "the question text is the fallback when no command field arrives");
});

test("a command block shows invisible and control characters instead of hiding them", () => {
  assert.equal(visibleControlCharacters("node safe\u200B.js"), "node safe\u27E8U+200B\u27E9.js");
  assert.equal(visibleControlCharacters("a\u202Eb"), "a\u27E8U+202E\u27E9b");
  assert.equal(visibleControlCharacters("a\uFEFFb"), "a\u27E8U+FEFF\u27E9b");
  assert.equal(visibleControlCharacters("a\u2028b"), "a\u27E8U+2028\u27E9b");
  assert.equal(visibleControlCharacters("a\u0000b"), "a\u27E8U+0000\u27E9b");
  assert.equal(visibleControlCharacters("node\tsafe.js"), "node\tsafe.js", "tab stays ordinary whitespace");
  assert.equal(visibleControlCharacters("plain"), "plain");
});
