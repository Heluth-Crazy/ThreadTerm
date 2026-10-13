import { FormEvent, useState } from "react";
import { openExternal } from "../bridge";
import type { ChatFormField } from "@threadterm/protocol";
import { type ChatInteractionForm, type QuestionResponse, type QuestionValue, questionSummary, summaryLine, validQuestionValues } from "../chatQuestion";

type Props = {
  form: ChatInteractionForm;
  answerable: boolean;
  resolved: boolean;
  dismissed?: boolean;
  summary?: Record<string, unknown>;
  writable: boolean;
  submitting?: boolean;
  onAnswer?: (response: QuestionResponse) => void;
  copy: (en: string, zh: string) => string;
  nonBlocking?: boolean;
  autoResolutionMs?: number;
  inactiveMessage?: string;
};

export function ChatQuestionCard({ form, answerable, resolved, dismissed, summary, writable, submitting, onAnswer, copy, nonBlocking, autoResolutionMs, inactiveMessage }: Props) {
  const [values, setValues] = useState<Record<string, QuestionValue>>(() => initialValues(form));
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [issue, setIssue] = useState<string>();
  const valid = answerable && validQuestionValues(form, values);
  const canAct = writable && !submitting && Boolean(onAnswer);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!valid || !canAct) return;
    onAnswer?.({ action: "submit", values });
  };
  if (resolved) {
    const rows = form.kind === "questions" ? form.questions.map(question => ({ kind: "questions" as const, questions: [question] }))
      : form.kind === "form" ? form.fields.map(field => ({ ...form, fields: [field] })) : [form];
    return <div className="chat-question-summary">{rows.map((row, index) => <p key={index}>{dismissed
      ? summaryLine(row.kind === "questions" ? row.questions[0].header || row.questions[0].question : row.kind === "form" ? row.fields[0].title || row.fields[0].id : row.message, copy("Dismissed", "已忽略"))
      : questionSummary(row, summary ?? {}, copy)}</p>)}</div>;
  }
  if (inactiveMessage) return <p className="chat-question-summary">{inactiveMessage}</p>;
  return <form className="chat-question-card" onSubmit={submit}>
    {form.kind === "questions" && form.questions.map((question, index) => <fieldset key={question.id} className="chat-question-fieldset"><legend>{form.questions.length > 1 && <small className="chat-question-number">{copy(`${index + 1} of ${form.questions.length}`, `第 ${index + 1} / ${form.questions.length} 题`)}</small>}{question.header && form.questions.length > 1 && <span className="chat-question-header-chip">{question.header}</span>}<span className="chat-question-title">{question.question}</span></legend>{question.options.map(option => {
      const selected = Array.isArray(values[question.id]) ? values[question.id] as string[] : [];
      const checked = selected.includes(option.label);
      return <label className={`chat-question-option${checked ? " is-selected" : ""}`} key={option.label}><input type={question.multiSelect ? "checkbox" : "radio"} name={question.id} checked={checked} disabled={!canAct} onChange={() => { if (!question.multiSelect) setOtherOpen(current => ({ ...current, [question.id]: false })); setValues(current => ({ ...current, [question.id]: question.multiSelect ? (checked ? selected.filter(value => value !== option.label) : [...selected, option.label]) : [option.label] })); }} /><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span></label>;
    })}{question.allowOther && question.options.length > 0 && <label className={`chat-question-option${otherOpen[question.id] ? " is-selected" : ""}`}><input type={question.multiSelect ? "checkbox" : "radio"} name={question.id} checked={Boolean(otherOpen[question.id])} disabled={!canAct} onChange={() => {
      const open = !otherOpen[question.id];
      setOtherOpen(current => ({ ...current, [question.id]: open }));
      setValues(current => ({ ...current, [question.id]: question.multiSelect ? (Array.isArray(current[question.id]) ? (current[question.id] as string[]).filter(value => question.options.some(option => option.label === value)) : []) : [] }));
    }} /><span><b>{copy("Other", "其他")}</b></span></label>}{question.allowOther && (question.options.length === 0 || otherOpen[question.id]) && <label className="chat-question-other">{question.options.length > 0 && <span>{copy("Other answer", "其他答案")}</span>}<input aria-label={question.options.length === 0 ? question.question : undefined} type={question.secret ? "password" : "text"} value={otherValue(values[question.id], question.options.map(option => option.label))} disabled={!canAct} onChange={event => setValues(current => {
      const currentAnswer = current[question.id];
      const selected = Array.isArray(currentAnswer) && question.multiSelect ? currentAnswer.filter(value => question.options.some(option => option.label === value)) : [];
      const value = event.target.value;
      return { ...current, [question.id]: value ? [...selected, value] : selected };
    })} /></label>}</fieldset>)}
    {form.kind === "form" && <><p className="chat-question-message">{form.message}</p>{form.fields.map(field => <FormField key={field.id} field={field} value={values[field.id]} disabled={!canAct} copy={copy} onChange={value => setValues(current => { const next = { ...current }; if (value === undefined) delete next[field.id]; else next[field.id] = value; return next; })} />)}</>}
    {form.kind === "url" && <><p className="chat-question-message">{form.message}</p><button type="button" className="btn btn-sm chat-question-link" disabled={!canAct} onClick={() => void openExternal(form.url).catch(error => setIssue(error instanceof Error ? error.message : String(error)))}>{copy("Open link", "打开链接")}</button></>}
    {nonBlocking && <p className="chat-question-note">{copy("The agent keeps working while you decide.", "你决定期间，代理会继续工作。")}</p>}
    {autoResolutionMs != null && <p className="chat-question-note">{copy(`Continues automatically in ${Math.ceil(autoResolutionMs / 1000)} s.`, `${Math.ceil(autoResolutionMs / 1000)} 秒后自动继续。`)}</p>}
    {issue && <p role="alert" className="surface-error">{issue}</p>}
    <div className="chat-approval-actions chat-question-actions">{answerable && <button type="submit" className="btn btn-sm btn-primary chat-approval-choice" disabled={!canAct || !valid}>{submitting ? copy("Submitting…", "提交中…") : form.kind === "url" ? copy("Done", "完成") : copy("Submit", "提交")}</button>}<button type="button" className="btn btn-sm chat-approval-choice" disabled={!canAct} onClick={() => onAnswer?.({ action: "dismiss" })}>{copy("Dismiss", "忽略")}</button></div>
  </form>;
}

function FormField({ field, value, disabled, onChange, copy }: { field: ChatFormField; value: QuestionValue | undefined; disabled: boolean; onChange: (value?: QuestionValue) => void; copy: Props['copy'] }) {
  const label = field.title || field.id;
  const options = field.options ?? [];
  const common = <>{field.description && <small className="chat-question-description">{field.description}</small>}</>;
  if (field.type === "boolean") return <label className="chat-question-control chat-question-boolean"><input type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span>{common}</label>;
  if (field.type === "multiEnum") return <fieldset className="chat-question-fieldset"><legend className="chat-question-field-label">{label}</legend>{options.map(option => <label className={`chat-question-option${Array.isArray(value) && value.includes(option.value) ? " is-selected" : ""}`} key={option.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} disabled={disabled} onChange={event => { const selected = Array.isArray(value) ? value : []; const next = event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value); onChange(next.length || field.required ? next : undefined); }} /><span>{option.label}</span></label>)}{common}</fieldset>;
  if (field.type === "enum") return <label className="chat-question-control">{label}<select value={typeof value === "string" ? value : ""} disabled={disabled} onChange={event => onChange(event.target.value || undefined)}><option value="">{copy("Choose…", "请选择…")}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{common}</label>;
  if (field.type === "string" && field.multiline && !field.secret) return <label className="chat-question-control">{label}<textarea rows={6} value={value == null ? "" : String(value)} disabled={disabled} onChange={event => onChange(event.target.value)} />{common}</label>;
  return <label className="chat-question-control">{label}<input type={field.secret ? "password" : field.type === "string" ? "text" : "number"} value={value == null ? "" : String(value)} min={field.minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} disabled={disabled} onChange={event => onChange(field.type === "string" ? event.target.value : event.target.value === "" ? undefined : Number(event.target.value))} />{common}</label>;
}

function initialValues(form: ChatInteractionForm): Record<string, QuestionValue> {
  if (form.kind !== "form") return {};
  return Object.fromEntries(form.fields.filter(field => field.default !== undefined || (field.type === "boolean" && field.required)).map(field => [field.id, field.default === undefined ? false : field.default as QuestionValue]));
}

function otherValue(value: QuestionValue | undefined, labels: string[]): string {
  return Array.isArray(value) ? value.find(answer => !labels.includes(answer)) ?? "" : "";
}
