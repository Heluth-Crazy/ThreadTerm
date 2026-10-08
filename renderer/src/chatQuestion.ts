import type { ChatAnswerResponse, ChatInteractionForm } from "@threadterm/protocol";

export type { ChatInteractionForm } from "@threadterm/protocol";
type QuestionSubmit = Extract<ChatAnswerResponse, { action: "submit" }>;
export type QuestionValue = QuestionSubmit["values"][string];
export type QuestionResponse = ChatAnswerResponse;

export function validQuestionValues(form: ChatInteractionForm, values: Record<string, QuestionValue>): boolean {
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
  const labels = form.kind === "questions"
    ? form.questions.map(question => [question.header || question.question, question.secret ? "••••" : summaryValue(values[question.id])])
    : form.fields.map(field => [field.title || field.id, field.secret ? "••••" : summaryValue(values[field.id])]);
  return labels.filter(([, value]) => value).map(([label, value]) => summaryLine(label, value)).join(" · ") || copy("No answer provided", "未提供答案");
}

/** A question that already ends in "?" or ":" (ASCII or full-width) is followed by its answer without another colon. */
export function summaryLine(label: string, value: string): string {
  return /[?:？：]$/.test(label.trimEnd()) ? `${label.trimEnd()} ${value}` : `${label}: ${value}`;
}

function summaryValue(value: unknown): string {
  if (Array.isArray(value)) return value.filter(item => typeof item === "string").join(", ");
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}
