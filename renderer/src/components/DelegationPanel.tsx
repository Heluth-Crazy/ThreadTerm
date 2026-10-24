import { useEffect, useId, useState } from "react";
import type { Session } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { attachedMessagesLabel, authorityLabel, delegateOutcomePreview, delegationActive, delegationStateLabel, delegationStateSummary, delegationStripVisible } from "../delegation";
import { AgentIcon, Icon } from "./PrototypeIcon";
import "./delegation-panel.css";

type Copy = (en: string, zh: string) => string;

const expandedBySession = new Map<string, boolean>();
const hiddenBySession = new Map<string, string[]>();
const hiddenStorageKey = "threadterm.delegationStrip.hidden.v1";
let hiddenLoaded = false;

function hiddenDelegates(sessionId: string): string[] | undefined {
  if (!hiddenLoaded) {
    hiddenLoaded = true;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(hiddenStorageKey) ?? "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        const entries = Object.entries(stored).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(id => typeof id === "string"));
        for (const [id, ids] of entries.slice(-200)) hiddenBySession.set(id, ids);
      }
    } catch { /* Keep in-memory preferences when storage is unavailable. */ }
  }
  return hiddenBySession.get(sessionId);
}

function hideDelegates(sessionId: string, delegates: readonly Session[]): void {
  hiddenDelegates(sessionId);
  hiddenBySession.delete(sessionId);
  hiddenBySession.set(sessionId, delegates.map(delegate => delegate.id));
  while (hiddenBySession.size > 200) hiddenBySession.delete(hiddenBySession.keys().next().value!);
  try { localStorage.setItem(hiddenStorageKey, JSON.stringify(Object.fromEntries(hiddenBySession))); }
  catch { /* Keep in-memory preferences when storage is unavailable. */ }
}

/**
 * Agent delegation in a Chat: a parent shows a card per agent it delegated to;
 * a delegate shows which session delegated it. Renders nothing otherwise.
 */
export function DelegationPanel({ session, delegates, delegatedBy, onOpenSession, copy, zh }: {
  session: Session;
  delegates: Session[];
  delegatedBy?: Session;
  onOpenSession?: (sessionId: string) => void;
  copy: Copy;
  zh: boolean;
}) {
  const cardsId = useId();
  const [, refresh] = useState(0);
  const active = delegates.some(delegate => delegate.delegation && delegationActive(delegate.delegation.state));
  const visible = delegationStripVisible(hiddenDelegates(session.id), delegates);
  const expanded = expandedBySession.get(session.id) ?? active;
  const toggle = () => { expandedBySession.set(session.id, !expanded); refresh(value => value + 1); };
  const hide = () => { hideDelegates(session.id, delegates); refresh(value => value + 1); };
  if (!session.delegation && !visible) return null;
  return <div className="delegation-panel">
    {session.delegation && <p className="delegation-origin" role="note">
      {delegatedBy
        ? <>{copy("Delegated by", "委派自")} <button type="button" className="delegation-link" onClick={() => onOpenSession?.(delegatedBy.id)}><AgentIcon provider={delegatedBy.provider} size={12} /> {delegatedBy.title}</button></>
        : copy("Delegated by another agent", "由其他代理委派")}
      <span className={`delegation-state st-${session.delegation.state}`}>{delegationStateLabel(session.delegation.state, zh)}</span>
      {session.delegation.branch && <span className="delegation-branch" title={session.delegation.branch}>{session.delegation.branch}</span>}
    </p>}
    {visible && <section className="delegation-strip" aria-label={copy("Delegated agents", "委派的代理")}>
      <header className="delegation-header">
        <button type="button" className="delegation-toggle" aria-expanded={expanded} aria-controls={cardsId} onClick={toggle}><Icon name="chevR" className="delegation-chevron" />{copy(`Delegated agents (${delegates.length})`, `委派的代理（${delegates.length}）`)}</button>
        <div className="delegation-summary">{delegationStateSummary(delegates, copy).map(group => <span key={group.state} className={`delegation-state st-${group.state}`}>{group.label}</span>)}</div>
        {!active && <button type="button" className="icon-btn icon-btn-sm delegation-hide" aria-label={copy("Hide delegated agents", "隐藏委派的代理")} title={copy("Hide delegated agents", "隐藏委派的代理")} onClick={hide}><Icon name="close" /></button>}
      </header>
      <div id={cardsId} className="delegation-cards" hidden={!expanded}>
        {expanded && delegates.map(delegate => <DelegateCard key={delegate.id} delegate={delegate} onOpenSession={onOpenSession} copy={copy} zh={zh} />)}
      </div>
    </section>}
  </div>;
}

function DelegateCard({ delegate, onOpenSession, copy, zh }: { delegate: Session; onOpenSession?: (sessionId: string) => void; copy: Copy; zh: boolean }) {
  const state = delegate.delegation!.state;
  const active = delegationActive(state);
  const failed = state === "failed";
  const [preview, setPreview] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const attached = delegate.delegation!.userMessages ? attachedMessagesLabel(delegate.delegation!.userMessages, copy) : undefined;
  useEffect(() => {
    if (active) { setPreview(undefined); return; }
    let disposed = false;
    // The delegate's answer (or failure) once the delegated turn ended.
    void request("chat.read", { sessionId: delegate.id }).then(items => {
      if (!disposed) setPreview(delegateOutcomePreview(items, failed));
    }).catch(() => { if (!disposed) setPreview(undefined); });
    return () => { disposed = true; };
  }, [delegate.id, active, failed]);
  const stop = () => {
    setStopping(true); setIssue(undefined);
    void request("session.stop", { sessionId: delegate.id, operationId: operationId() })
      .catch(error => setIssue(error instanceof Error ? error.message : String(error)))
      .finally(() => setStopping(false));
  };
  return <article className={`delegate-card st-${state}`} data-session-id={delegate.id}>
    <div className="delegate-card-head">
      <AgentIcon provider={delegate.provider} size={14} />
      <button type="button" className="delegation-link delegate-card-title" title={copy("Open this delegated session", "打开这个委派会话")} onClick={() => onOpenSession?.(delegate.id)}>{delegate.title}</button>
      <span className={`delegation-state st-${state}`}>{delegationStateLabel(state, zh)}</span>
      {active && <button type="button" className="btn btn-sm btn-danger delegate-stop" disabled={stopping} onClick={stop}>{stopping ? copy("Stopping…", "停止中…") : copy("Stop", "停止")}</button>}
    </div>
    {delegate.delegation!.branch && <small className="delegation-branch" title={delegate.delegation!.branch}>{delegate.delegation!.branch}</small>}
    {delegate.delegation!.authority && <small className="delegate-card-authority" title={copy("The most this delegate may do; it can never exceed the delegating chat's own authority.", "该委派可用的最高权限；不会超出委派它的对话自身的权限。")}>{copy("Access", "权限")}: {authorityLabel(delegate.delegation!.authority, copy)}</small>}
    {attached && <small className="delegate-card-attached" title={attached.title}>{attached.label}</small>}
    {preview && <p className={`delegate-card-preview${failed ? " is-error" : ""}`}>{preview}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </article>;
}
