import { FormEvent, useEffect, useRef, useState } from "react";
import { openExternal } from "../bridge";
import type { ChatFormField, ChatQuestion } from "@threadterm/protocol";
import { activeFormFields, blockedFormFields, formAnswerValues, formFieldIssues, formPolicy, initialFormValues, questionPresentation, type ChatInteractionForm, type FormIssue, type QuestionResponse, type QuestionValue, questionSummary, summaryLine, type TargetForm, validQuestionValues } from "../chatQuestion";

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
  const [values, setValues] = useState<Record<string, QuestionValue>>(() => initialFormValues(form));
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [issue, setIssue] = useState<string>();
  // Target forms show their problems after a submit attempt instead of greying out Submit (F4).
  const [showIssues, setShowIssues] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const cardRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  // The field that most recently had keyboard focus, so a field that disappears can hand it over.
  const focusedField = useRef<string | undefined>(undefined);
  const target = form.kind === "form" && formPolicy(form) === "opencode-v2" ? form : undefined;
  const active = target ? activeFormFields(target, values) : [];
  const issues = target ? formFieldIssues(target, values) : {};
  // A pristine card shows no red marks; problems appear after the first submit attempt (F4).
  const shownIssues = showIssues ? issues : {};
  const blocked = target ? blockedFormFields(target, values) : [];
  const issueRows = active.filter(field => field.hidden !== true && shownIssues[field.id] !== undefined);
  const valid = answerable && (target ? Object.keys(issues).length === 0 : validQuestionValues(form, values));
  const canAct = writable && !submitting && Boolean(onAnswer);
  const activeKey = active.map(field => field.id).join("\u001f");
  const registerField = (id: string, node: HTMLElement | null) => {
    if (node) fieldRefs.current.set(id, node);
    else fieldRefs.current.delete(id);
  };
  const focusField = (id: string) => {
    const node = fieldRefs.current.get(id);
    const control = node?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, button");
    (control ?? node)?.focus();
  };
  const openLink = (url: string) => void openExternal(url).catch(error => setIssue(error instanceof Error ? error.message : String(error)));
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canAct) return;
    if (target) {
      if (Object.keys(issues).length > 0) {
        setShowIssues(true);
        setAttempt(count => count + 1);
        return;
      }
      onAnswer?.({ action: "submit", values: formAnswerValues(target, values) });
      return;
    }
    if (!valid) return;
    onAnswer?.({ action: "submit", values });
  };
  // A failed submit announces the summary and puts the reader on it, so the linked fields are one Tab away.
  // A layout effect would warn during server rendering, and a hidden window may never paint a frame.
  useEffect(() => {
    if (attempt > 0 && summaryRef.current) summaryRef.current.focus();
  }, [attempt]);
  // A field that becomes inactive loses its control: hand focus to its controlling field, then to
  // the next visible one, then to Submit, and say why in the card's live region (F7).
  useEffect(() => {
    const id = focusedField.current;
    if (!target || !id || active.some(field => field.id === id)) return;
    const inside = cardRef.current?.contains(document.activeElement) ?? false;
    if (!inside && document.activeElement !== document.body) return;
    focusedField.current = undefined;
    const index = target.fields.findIndex(field => field.id === id);
    const next = target.fields[index]?.when?.map(condition => condition.key).reverse().find(key => active.some(field => field.id === key))
      ?? active.find(field => target.fields.findIndex(candidate => candidate.id === field.id) > index)?.id
      ?? active[0]?.id;
    setAnnouncement(copy(`“${target.fields[index]?.title || id}” is hidden because an earlier answer changed.`, `由于前面的回答发生变化，“${target.fields[index]?.title || id}”已隐藏。`));
    if (next) focusField(next);
    else submitRef.current?.focus();
    // Only a changed active set can remove the focused field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);
  if (resolved) {
    // Target forms summarize only the answers they actually carried: hidden fields are prompt-only
    // visibility and an inactive field was never part of the answer (F3).
    if (form.kind === "form" && target) {
      if (dismissed) return <div className="chat-question-summary"><p>{copy("Dismissed", "已忽略")}</p></div>;
      const rows = form.fields.filter(field => field.hidden !== true && summary?.[field.id] !== undefined);
      return <div className="chat-question-summary">{rows.length === 0
        ? <p>{copy("No answer provided", "未提供答案")}</p>
        : rows.map(field => <p key={field.id}>{summaryLine(field.title || field.id, field.type === "external" && summary![field.id] === "true" ? copy("Done", "已完成") : String(summary![field.id]))}</p>)}</div>;
    }
    const rows = form.kind === "questions" ? form.questions.map(question => ({ kind: "questions" as const, questions: [question] }))
      : form.kind === "form" ? form.fields.map(field => ({ ...form, fields: [field] })) : [form];
    return <div className="chat-question-summary">{rows.map((row, index) => <p key={index}>{dismissed
      ? summaryLine(row.kind === "questions" ? row.questions[0].header || row.questions[0].question : row.kind === "form" ? row.fields[0].title || row.fields[0].id : row.message, copy("Dismissed", "已忽略"))
      : questionSummary(row, summary ?? {}, copy)}</p>)}</div>;
  }
  if (inactiveMessage) return <p className="chat-question-summary">{inactiveMessage}</p>;
  return <form className="chat-question-card" ref={cardRef} onSubmit={submit} onFocusCapture={event => {
    const holder = (event.target as HTMLElement).closest<HTMLElement>("[data-field-id]");
    if (holder?.dataset.fieldId !== undefined) focusedField.current = holder.dataset.fieldId;
  }}>
    {form.kind === "questions" && form.questions.map((question, index) => <fieldset key={question.id} className="chat-question-fieldset"><legend>{form.questions.length > 1 && <small className="chat-question-number">{copy(`${index + 1} of ${form.questions.length}`, `第 ${index + 1} / ${form.questions.length} 题`)}</small>}{question.header && form.questions.length > 1 && <span className="chat-question-header-chip">{question.header}</span>}<QuestionTitle question={question} /></legend>{question.options.map(option => {
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
    {form.kind === "form" && <><p className="chat-question-message">{form.message}</p>
      {target ? <>
        {showIssues && issueRows.length > 0 && <section className="chat-question-errors" role="alert" tabIndex={-1} ref={summaryRef}>
          <p className="chat-question-errors-title">{copy("Check the highlighted fields", "请检查标出的字段")}</p>
          <ul>{issueRows.map(field => <li key={field.id}><button type="button" className="chat-question-error-link" onClick={() => focusField(field.id)}>{field.title || field.id}</button>{shownIssues[field.id] !== "required" && <span> {issueText(shownIssues[field.id], field, copy)}</span>}</li>)}</ul>
        </section>}
        {blocked.length > 0 && <p className="chat-question-note">{copy("This request needs a value it does not show here, so it can't be submitted. You can dismiss it.", "此请求需要一个未在此显示的值，因此无法提交。你可以忽略它。")}</p>}
        {active.filter(field => field.hidden !== true).map((field, index) => <TargetFormField key={field.id} field={field} index={index} value={values[field.id]} issue={shownIssues[field.id]} disabled={!canAct} copy={copy} register={registerField} onOpen={openLink} onChange={value => setValues(current => {
          const next = { ...current };
          if (value === undefined) delete next[field.id];
          else next[field.id] = value;
          return next;
        })} />)}
      </> : form.fields.map(field => <FormField key={field.id} field={field} value={values[field.id]} disabled={!canAct} copy={copy} onChange={value => setValues(current => { const next = { ...current }; if (value === undefined) delete next[field.id]; else next[field.id] = value; return next; })} />)}
    </>}
    {form.kind === "url" && <><p className="chat-question-message">{form.message}</p><button type="button" className="btn btn-sm chat-question-link" disabled={!canAct} onClick={() => openLink(form.url)}>{copy("Open link", "打开链接")}</button></>}
    {nonBlocking && <p className="chat-question-note">{copy("The agent keeps working while you decide.", "你决定期间，代理会继续工作。")}</p>}
    {autoResolutionMs != null && <p className="chat-question-note">{copy(`Continues automatically in ${Math.ceil(autoResolutionMs / 1000)} s.`, `${Math.ceil(autoResolutionMs / 1000)} 秒后自动继续。`)}</p>}
    {issue && <p role="alert" className="surface-error">{issue}</p>}
    <div className="chat-approval-actions chat-question-actions">{answerable && <button type="submit" ref={submitRef} className="btn btn-sm btn-primary chat-approval-choice" disabled={!canAct || (!target && !valid)}>{submitting ? copy("Submitting…", "提交中…") : form.kind === "url" ? copy("Done", "完成") : copy("Submit", "提交")}</button>}<button type="button" className="btn btn-sm chat-approval-choice" disabled={!canAct} onClick={() => onAnswer?.({ action: "dismiss" })}>{copy("Dismiss", "忽略")}</button></div>
    {target && <p className="chat-question-sr-only" aria-live="polite">{announcement}</p>}
  </form>;
}

/** The question title and, only for a runtime-marked run approval, the exact command block. An
 * ordinary multi-line question renders exactly as before: one title span with its full text. */
function QuestionTitle({ question }: { question: ChatQuestion }) {
  const { title, command } = questionPresentation(question);
  return <><span className="chat-question-title">{title}</span>{command !== undefined && <code className="chat-question-command" data-testid="chat-question-command">{command}</code>}</>;
}

/**
 * One target-policy field. The stored policy keeps pattern/format native-authoritative, so nothing
 * here evaluates them; option values (not labels) are what the card stores and submits. External
 * steps get their own Open action and a separate acknowledgement that sends literal true (F5).
 */
function TargetFormField({ field, index, value, issue, disabled, copy, register, onOpen, onChange }: {
  field: ChatFormField; index: number; value: QuestionValue | undefined; issue: FormIssue | undefined;
  disabled: boolean; copy: Props["copy"]; register: (id: string, node: HTMLElement | null) => void;
  onOpen: (url: string) => void; onChange: (value?: QuestionValue) => void;
}) {
  const label = field.title || field.id;
  const errorId = `chat-field-${index}-error`;
  const error = issue ? <small className="chat-question-error" id={errorId}>{issueText(issue, field, copy)}</small> : undefined;
  const shared = { "aria-invalid": issue !== undefined, "aria-describedby": issue ? errorId : undefined };
  const description = field.description ? <small className="chat-question-description">{field.description}</small> : undefined;
  if (field.type === "external") return <fieldset className="chat-question-fieldset" data-field-id={field.id} ref={node => register(field.id, node)}>
    <legend className="chat-question-field-label">{label}</legend>
    {description}
    {field.url !== undefined && <div className="chat-question-external">
      <button type="button" className="btn btn-sm chat-question-link" disabled={disabled} onClick={() => onOpen(field.url!)}>{copy("Open link", "打开链接")}</button>
      <span className="chat-question-external-url">{field.url}</span>
    </div>}
    <label className={`chat-question-option${value === true ? " is-selected" : ""}`}><input type="checkbox" checked={value === true} disabled={disabled} {...shared} onChange={event => onChange(event.target.checked ? true : undefined)} /><span><b>{copy("I finished this step", "我已完成此步骤")}</b></span></label>
    {error}
  </fieldset>;
  if (field.type === "string" && field.options !== undefined) {
    const selected = typeof value === "string" ? value : undefined;
    const listed = selected !== undefined && field.options.some(option => option.value === selected);
    const custom = field.custom === true;
    const other = custom && selected !== undefined && !listed;
    return <fieldset className="chat-question-fieldset" data-field-id={field.id} ref={node => register(field.id, node)} aria-invalid={issue !== undefined} aria-describedby={issue ? errorId : undefined}>
      <legend className="chat-question-field-label">{label}</legend>
      {description}
      {field.options.map(option => <label className={`chat-question-option${selected === option.value ? " is-selected" : ""}`} key={option.value}><input type="radio" name={`chat-field-${index}`} checked={selected === option.value} disabled={disabled} aria-describedby={issue ? errorId : undefined} onChange={() => onChange(option.value)} /><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span></label>)}
      {custom && <label className={`chat-question-option${other ? " is-selected" : ""}`}><input type="radio" name={`chat-field-${index}`} checked={other} disabled={disabled} aria-describedby={issue ? errorId : undefined} onChange={() => onChange(listed ? "" : selected ?? "")} /><span><b>{copy("Other", "其他")}</b></span></label>}
      {custom && other && <label className="chat-question-other"><span>{copy("Other answer", "其他答案")}</span><input type="text" value={selected ?? ""} placeholder={field.placeholder} disabled={disabled} aria-label={field.options.length === 0 ? label : copy("Other answer", "其他答案")} aria-describedby={issue ? errorId : undefined} onChange={event => onChange(event.target.value)} /></label>}
      {error}
    </fieldset>;
  }
  if (field.type === "multiselect") {
    const options = field.options ?? [];
    const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const custom = field.custom === true;
    const unlisted = selected.find(item => !options.some(option => option.value === item)) ?? "";
    return <fieldset className="chat-question-fieldset" data-field-id={field.id} ref={node => register(field.id, node)} aria-invalid={issue !== undefined} aria-describedby={issue ? errorId : undefined}>
      <legend className="chat-question-field-label">{label}</legend>
      {description}
      {options.map(option => {
        const checked = selected.includes(option.value);
        return <label className={`chat-question-option${checked ? " is-selected" : ""}`} key={option.value}><input type="checkbox" checked={checked} disabled={disabled} aria-describedby={issue ? errorId : undefined} onChange={event => {
          const next = event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value);
          onChange(next.length ? next : undefined);
        }} /><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span></label>;
      })}
      {custom && <label className="chat-question-other"><span>{copy("Other answer", "其他答案")}</span><input type="text" value={unlisted} placeholder={field.placeholder} disabled={disabled} aria-describedby={issue ? errorId : undefined} onChange={event => {
        const offered = selected.filter(item => options.some(option => option.value === item));
        const next = event.target.value ? [...offered, event.target.value] : offered;
        onChange(next.length ? next : undefined);
      }} /></label>}
      {error}
    </fieldset>;
  }
  if (field.type === "boolean") return <label className="chat-question-control chat-question-boolean" data-field-id={field.id} ref={node => register(field.id, node)}><input type="checkbox" checked={value === true} disabled={disabled} {...shared} onChange={event => onChange(event.target.checked)} /><span>{label}</span>{description}{error}</label>;
  if (field.type === "string") return <label className="chat-question-control" data-field-id={field.id} ref={node => register(field.id, node)}>{label}<input type="text" value={typeof value === "string" ? value : ""} placeholder={field.placeholder} maxLength={field.maxLength} disabled={disabled} {...shared} onChange={event => onChange(event.target.value)} />{description}{error}</label>;
  return <label className="chat-question-control" data-field-id={field.id} ref={node => register(field.id, node)}>{label}<input type="number" value={value == null ? "" : String(value)} min={field.minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} placeholder={field.placeholder} disabled={disabled} {...shared} onChange={event => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />{description}{error}</label>;
}

/** Reader-language text for a local field issue. Never names the policy or the stored schema. */
function issueText(issue: FormIssue, field: ChatFormField, copy: Props["copy"]): string {
  if (issue === "required") return copy("Enter a value.", "请填写此项。");
  if (issue === "acknowledge") return copy("Open the link, then confirm you finished this step.", "请打开链接，然后确认你已完成此步骤。");
  if (issue === "invalid") return copy("Check this value.", "请检查此项的值。");
  if (issue === "unoffered") return copy("Choose one of the listed options.", "请选择列表中的一项。");
  if (issue === "too-short") return copy(`Use at least ${field.minLength} characters.`, `至少 ${field.minLength} 个字符。`);
  if (issue === "too-long") return copy(`Use at most ${field.maxLength} characters.`, `最多 ${field.maxLength} 个字符。`);
  if (issue === "too-few") return copy(`Choose at least ${field.minItems}.`, `至少选择 ${field.minItems} 项。`);
  if (issue === "too-many") return copy(`Choose at most ${field.maxItems}.`, `最多选择 ${field.maxItems} 项。`);
  if (field.minimum != null && field.maximum != null) return copy(`Enter a number between ${field.minimum} and ${field.maximum}.`, `请输入 ${field.minimum} 到 ${field.maximum} 之间的数字。`);
  if (field.minimum != null) return copy(`Enter ${field.minimum} or more.`, `请输入不小于 ${field.minimum} 的数字。`);
  return copy(`Enter ${field.maximum} or less.`, `请输入不大于 ${field.maximum} 的数字。`);
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

function otherValue(value: QuestionValue | undefined, labels: string[]): string {
  return Array.isArray(value) ? value.find(answer => !labels.includes(answer)) ?? "" : "";
}
