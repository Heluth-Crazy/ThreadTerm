import type { ChatAnswerResponse, ChatFormCondition, ChatFormField, ChatInteractionForm, ChatQuestion } from "@threadterm/protocol";

export type { ChatInteractionForm } from "@threadterm/protocol";
type QuestionSubmit = Extract<ChatAnswerResponse, { action: "submit" }>;
export type QuestionValue = QuestionSubmit["values"][string];
export type QuestionResponse = ChatAnswerResponse;
/** The stored form semantics a card must render. Only an explicit target policy leaves the legacy path. */
export type FormPolicy = "opencode-v2" | "unsupported" | "legacy";
export type TargetForm = Extract<ChatInteractionForm, { kind: "form" }>;
export type FormIssue =
  | "required" | "acknowledge" | "invalid" | "unoffered"
  | "too-short" | "too-long" | "too-few" | "too-many" | "out-of-range";

/**
 * `validation` is adapter-written stored policy, never caller input. A form that carries any
 * other policy is not legacy: the runtime refuses it, so the card must not silently treat it as one.
 */
export function formPolicy(form: ChatInteractionForm): FormPolicy {
  if (form.kind !== "form" || form.validation === undefined) return "legacy";
  return form.validation.semantics === "opencode-v2" && form.validation.patternAndFormat === "native" ? "opencode-v2" : "unsupported";
}

function conditionHolds(condition: ChatFormCondition, value: QuestionValue | undefined): boolean {
  if (value === undefined) return false;
  const match = Array.isArray(value) ? value.some(item => item === condition.value) : value === condition.value;
  return condition.op === "eq" ? match : !match;
}

/**
 * Active fields in declared order (F2). Only an earlier ACTIVE typed answer can activate a later
 * field, so an inactive draft never reaches its dependants. A missing predecessor satisfies
 * neither `eq` nor `neq`; multiselect equality is membership; comparisons stay typed.
 */
export function activeFormFields(form: TargetForm, values: Record<string, QuestionValue>): ChatFormField[] {
  const effective: Record<string, QuestionValue> = {};
  const active: ChatFormField[] = [];
  for (const field of form.fields) {
    if (field.when && !field.when.every(condition => conditionHolds(condition, effective[condition.key]))) continue;
    active.push(field);
    if (values[field.id] !== undefined) effective[field.id] = values[field.id];
  }
  return active;
}

/** The outgoing answer: active fields only, in declared order, with false/zero/empty kept (F2/F3). */
export function formAnswerValues(form: TargetForm, values: Record<string, QuestionValue>): Record<string, QuestionValue> {
  const answer: Record<string, QuestionValue> = {};
  for (const field of activeFormFields(form, values)) {
    const value = values[field.id];
    if (value !== undefined) answer[field.id] = value;
  }
  return answer;
}

/**
 * Target-policy issues for the fields that are active right now (F4). Pattern and format are
 * deliberately absent: the stored policy keeps them native-authoritative, so the card never
 * rejects input the native service may accept.
 */
export function formFieldIssues(form: TargetForm, values: Record<string, QuestionValue>): Record<string, FormIssue> {
  const issues: Record<string, FormIssue> = {};
  for (const field of activeFormFields(form, values)) {
    const issue = fieldIssue(field, values[field.id]);
    if (issue) issues[field.id] = issue;
  }
  return issues;
}

/** Active fields the card cannot show (hidden) and cannot answer, so cancel is the only honest action. */
export function blockedFormFields(form: TargetForm, values: Record<string, QuestionValue>): ChatFormField[] {
  return activeFormFields(form, values).filter(field => field.hidden === true && fieldIssue(field, values[field.id]) !== undefined);
}

function offered(field: ChatFormField, value: QuestionValue): boolean {
  return field.options !== undefined && field.options.some(option => option.value === value);
}

/** Mirrors the stored target policy: closed options unless custom, UTF-16 lengths, no whitespace trim. */
function fieldIssue(field: ChatFormField, value: QuestionValue | undefined): FormIssue | undefined {
  if (field.type === "external") return value === true ? undefined : "acknowledge";
  if (value === undefined) return field.required ? "required" : undefined;
  if (field.type === "boolean") return typeof value === "boolean" ? undefined : "invalid";
  if (field.type === "multiselect") {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return "invalid";
    if (value.length === 0) return field.required ? "required" : field.minItems != null && value.length < field.minItems ? "too-few" : undefined;
    if (field.minItems != null && value.length < field.minItems) return "too-few";
    if (field.maxItems != null && value.length > field.maxItems) return "too-many";
    if (field.custom !== true && value.some(item => !offered(field, item))) return "unoffered";
    return undefined;
  }
  if (field.type === "string") {
    if (typeof value !== "string") return "invalid";
    if (field.required && value.length === 0) return "required";
    if (field.minLength != null && value.length < field.minLength) return "too-short";
    if (field.maxLength != null && value.length > field.maxLength) return "too-long";
    if (field.custom !== true && field.options !== undefined && !offered(field, value)) return "unoffered";
    return undefined;
  }
  if (field.type !== "number" && field.type !== "integer") return "invalid";
  if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) return "invalid";
  if ((field.minimum != null && value < field.minimum) || (field.maximum != null && value > field.maximum)) return "out-of-range";
  return undefined;
}

/**
 * Declared defaults initialize a new request once (F3). Legacy and target cards share this rule:
 * only a declared default or a required boolean (a checkbox has no third state) starts filled.
 */
export function initialFormValues(form: ChatInteractionForm): Record<string, QuestionValue> {
  if (form.kind !== "form") return {};
  return Object.fromEntries(form.fields.filter(field => field.default !== undefined || (field.type === "boolean" && field.required)).map(field => [field.id, field.default === undefined ? false : field.default as QuestionValue]));
}

/** The answer a target-policy card sends: the active draft, never the inactive one. */
export function targetFormValid(form: TargetForm, values: Record<string, QuestionValue>): boolean {
  const answer = formAnswerValues(form, values);
  const active = new Set(activeFormFields(form, values).map(field => field.id));
  return Object.keys(values).every(id => active.has(id)) && Object.keys(formFieldIssues(form, answer)).length === 0;
}

export function validQuestionValues(form: ChatInteractionForm, values: Record<string, QuestionValue>): boolean {
  if (form.kind === "form" && formPolicy(form) === "opencode-v2") return targetFormValid(form, values);
  if (form.kind === "url") return Object.keys(values).length === 0;
  if (form.kind === "questions") return Object.keys(values).every(id => form.questions.some(question => question.id === id)) && form.questions.every(question => {
    const answer = values[question.id];
    return Array.isArray(answer) && answer.length > 0 && new Set(answer).size === answer.length && answer.every(value => value.trim().length > 0 && (question.allowOther || question.options.some(option => option.label === value))) && (question.multiSelect || answer.length <= 1);
  });
  return Object.keys(values).every(id => form.fields.some(field => field.id === id)) && form.fields.every(field => {
    const value = values[field.id];
    if (value == null) return !field.required;
    if (field.type === "boolean") return typeof value === "boolean";
    if (field.type === "multiEnum") return Array.isArray(value) && (!field.required || value.length > 0) && new Set(value).size === value.length && (field.minItems == null || value.length >= field.minItems) && (field.maxItems == null || value.length <= field.maxItems) && value.every(item => typeof item === "string" && field.options?.some(option => option.value === item));
    if (field.type === "enum") return typeof value === "string" && field.options?.some(option => option.value === value);
    if (field.type === "string") return typeof value === "string" && (!field.required || value.trim().length > 0) && (field.minLength == null || [...value].length >= field.minLength) && (field.maxLength == null || [...value].length <= field.maxLength) && validFormat(field.format, value);
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) return false;
    return (field.minimum == null || value >= field.minimum) && (field.maximum == null || value <= field.maximum);
  });
}

function validFormat(format: "email" | "uri" | "date" | "date-time" | undefined, value: string): boolean {
  if (!value || !format) return true;
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") { try { new URL(value); return true; } catch { return false; } }
  if (format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  return /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function questionSummary(form: ChatInteractionForm, values: Record<string, unknown>, copy: (en: string, zh: string) => string): string {
  if (form.kind === "url") return copy("Completed", "已完成");
  // A hidden field is prompt-only visibility, so its answer never enters a summary (F3).
  const visible = form.kind === "form" && formPolicy(form) !== "legacy" ? form.fields.filter(field => field.hidden !== true) : form.kind === "form" ? form.fields : undefined;
  const labels = form.kind === "questions"
    ? form.questions.map(question => [question.header || question.question, question.secret ? "••••" : summaryValue(values[question.id])])
    : (visible ?? []).map(field => [field.title || field.id, field.secret ? "••••" : summaryValue(values[field.id])]);
  return labels.filter(([, value]) => value).map(([label, value]) => summaryLine(label, value)).join(" · ") || copy("No answer provided", "未提供答案");
}

/** A question that already ends in "?" or ":" (ASCII or full-width) is followed by its answer without another colon. */
export function summaryLine(label: string, value: string): string {
  return /[?:？：]$/.test(label.trimEnd()) ? `${label.trimEnd()} ${value}` : `${label}: ${value}`;
}

/**
 * Characters a card must not render literally: Unicode format characters (zero-width, bidi
 * embedding/override/isolate, BOM), control characters other than tab, and line/paragraph
 * separators. The runtime refuses to approve a detected command containing them; showing them
 * visibly here is defense in depth for any other path that reaches the card.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `node safe<U+200B>.js` must never read as `node safe.js`: render the character it hides. */
export function visibleControlCharacters(text: string): string {
  return text.replace(UNPRINTABLE, (character, offset: number) => character === "\t"
    ? character
    : `⟨U+${(text.codePointAt(offset) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

/**
 * What a question's title line and command block are. Only a run approval (`presentation`
 * `command`, set by the runtime from the re-detected entry) gets a separate command block;
 * an ordinary question, including a multi-line `ask_user` one, renders exactly as before.
 */
export function questionPresentation(question: ChatQuestion): { title: string; command?: string } {
  if (question.presentation !== "command") return { title: question.question };
  const [title, ...rest] = question.question.split("\n");
  const command = question.command ?? rest.join("\n");
  return command ? { title, command: visibleControlCharacters(command) } : { title };
}

function summaryValue(value: unknown): string {
  if (Array.isArray(value)) return value.filter(item => typeof item === "string").join(", ");
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}
