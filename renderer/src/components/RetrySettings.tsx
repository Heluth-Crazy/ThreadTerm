import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionRetryState } from "@threadterm/protocol";
import { operationId, request, subscribeEvents } from "../bridge";
import { useTranslation } from "../i18n";
import { adoptStoredRetry, editRetryDraft, initialRetryDraft, mergeStoredRetry, retryEventRelevant, savedRetryDraft } from "../retryDraft";
import { useVisibleTicker } from "../visibleTicker";

type Copy = { heading:string; enabled:string; detail:string; max:string; attempts:string; save:string; saving:string; pending:string; exhausted:string; completed:string; cancelled:string; claimed:string; scheduled:string; disableNote:string; unavailable:string; conflict:string; loadSaved:string };
const copy = (locale:string):Copy => locale === "zh-CN" ? {
  heading:"自动重试", enabled:"退出失败后自动重试", detail:"仅对本机会话失败生效；关闭后会取消尚未启动的重试。", max:"最多重试次数", attempts:"重试记录", save:"保存重试策略", saving:"正在保存…", pending:"将在 {time} 后重试", exhausted:"已达到重试上限", completed:"已启动", cancelled:"已取消", claimed:"正在启动", scheduled:"已计划", disableNote:"关闭会取消所有待处理的自动重试。", unavailable:"无法读取自动重试策略。", conflict:"已保存的最大次数在别处更改。保存会覆盖它，或载入已保存的值。", loadSaved:"载入已保存的值"
} : {
  heading:"Automatic retry", enabled:"Retry after a failed exit", detail:"Only failed local terminal sessions are eligible. Turning this off cancels retries that have not launched.", max:"Maximum retries", attempts:"Retry history", save:"Save retry policy", saving:"Saving…", pending:"Retries in {time}", exhausted:"Retry limit reached", completed:"Launched", cancelled:"Cancelled", claimed:"Launching", scheduled:"Scheduled", disableNote:"Turning this off cancels every pending automatic retry.", unavailable:"Unable to load the automatic retry policy.", conflict:"The saved maximum changed elsewhere. Saving replaces it, or load the saved value.", loadSaved:"Load saved value"
};
const statusLabel = (status:string, text:Copy) => ({ pending:text.scheduled, claimed:text.claimed, completed:text.completed, cancelled:text.cancelled, exhausted:text.exhausted }[status] ?? status);
function remaining(dueAt:string, locale:string, now:number) { const ms = new Date(dueAt).getTime() - now; if (ms <= 0) return locale === "zh-CN" ? "即将" : "shortly"; const seconds=Math.ceil(ms/1000); return new Intl.NumberFormat(locale).format(seconds) + (locale === "zh-CN" ? " 秒" : "s"); }

export function RetrySettings({ sessionId, terminal }: { sessionId:string; terminal:boolean }) {
  const { locale, formatDate } = useTranslation();
  const text = useMemo(() => copy(locale), [locale]);
  const [state, setState] = useState<SessionRetryState>();
  const [draft, setDraft] = useState(() => initialRetryDraft(1));
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const load = useCallback(async () => { const next=await request("session.retry.read",{sessionId}); setState(next); setDraft(current => mergeStoredRetry(current, next.maxRetries)); },[sessionId]);
  useEffect(() => { if (!terminal) return; void load().catch(() => setIssue(text.unavailable)); }, [load, terminal, text.unavailable]);
  useEffect(() => { if (!terminal) return; return subscribeEvents((event) => { if (retryEventRelevant(event, sessionId)) void load().catch(() => undefined); }); }, [load, terminal, sessionId]);
  const pending = useMemo(() => state?.attempts.find((attempt) => attempt.status === "pending"), [state]);
  // The countdown only exists while a retry is actually pending and the window is visible.
  useVisibleTicker(() => setNow(Date.now()), Boolean(pending));
  if (!terminal) return null;
  const update = async (enabled:boolean) => {
    if (!state) return;
    setBusy(true); setIssue(undefined);
    try { const next=await request("session.retry.update",{sessionId,enabled,maxRetries:draft.value,delaySeconds:state.delaySeconds,expectedRevision:state.revision,operationId:operationId()}); setState(next); setDraft(savedRetryDraft(next.maxRetries)); }
    catch (error) { setIssue(error instanceof Error ? error.message : text.unavailable); void load().catch(() => undefined); }
    finally { setBusy(false); }
  };
  return <fieldset className="retry-settings" aria-describedby="retry-detail">
    <legend>{text.heading}</legend>
    <label className="retry-toggle"><input type="checkbox" checked={state?.enabled ?? false} disabled={!state || busy} onChange={(event) => void update(event.target.checked)} /> {text.enabled}</label>
    <p id="retry-detail">{text.detail}</p>
    <label>{text.max}<input type="number" min={1} max={10} value={draft.value} disabled={!state || busy || !state.enabled} onChange={(event) => setDraft(current => editRetryDraft(current, Number(event.target.value)))} /></label>
    {draft.conflict && <p className="retry-note" role="status">{text.conflict} <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setDraft(adoptStoredRetry)}>{text.loadSaved}</button></p>}
    {state?.enabled && <button className="btn" type="button" onClick={() => void update(true)} disabled={busy}>{busy ? text.saving : text.save}</button>}
    {!state?.enabled && <p className="retry-note">{text.disableNote}</p>}
    {pending && <p className="retry-countdown" aria-live="polite">{text.pending.replace("{time}", remaining(pending.dueAt, locale, now))}</p>}
    <section aria-label={text.attempts} className="retry-history"><strong>{text.attempts}</strong>{state?.attempts.length ? <ol>{state.attempts.map((attempt) => <li key={attempt.id}><span>{attempt.status === "pending" ? text.pending.replace("{time}", remaining(attempt.dueAt, locale, now)) : statusLabel(attempt.status,text)}</span><time dateTime={attempt.createdAt}>{formatDate(attempt.createdAt)}</time></li>)}</ol> : <p>{text.detail}</p>}</section>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </fieldset>;
}
