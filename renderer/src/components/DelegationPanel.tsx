import { useEffect, useState } from "react";
import type { Session } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { delegateOutcomePreview, delegationActive, delegationStateLabel } from "../delegation";
import { AgentIcon } from "./PrototypeIcon";
import "./delegation-panel.css";

type Copy = (en: string, zh: string) => string;

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
  if (!session.delegation && delegates.length === 0) return null;
  return <div className="delegation-panel">
    {session.delegation && <p className="delegation-origin" role="note">
      {delegatedBy
        ? <>{copy("Delegated by", "委派自")} <button type="button" className="delegation-link" onClick={() => onOpenSession?.(delegatedBy.id)}><AgentIcon provider={delegatedBy.provider} size={12} /> {delegatedBy.title}</button></>
        : copy("Delegated by another agent", "由其他代理委派")}
      <span className={`delegation-state st-${session.delegation.state}`}>{delegationStateLabel(session.delegation.state, zh)}</span>
      {session.delegation.branch && <span className="delegation-branch" title={session.delegation.branch}>{session.delegation.branch}</span>}
    </p>}
    {delegates.length > 0 && <section className="delegation-cards" aria-label={copy("Delegated agents", "委派的代理")}>
      <header>{copy(`Delegated agents (${delegates.length})`, `委派的代理（${delegates.length}）`)}</header>
      {delegates.map(delegate => <DelegateCard key={delegate.id} delegate={delegate} onOpenSession={onOpenSession} copy={copy} zh={zh} />)}
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
      {active && <button type="button" className="btn btn-subtle delegate-stop" disabled={stopping} onClick={stop}>{stopping ? copy("Stopping…", "停止中…") : copy("Stop", "停止")}</button>}
    </div>
    {delegate.delegation!.branch && <small className="delegation-branch" title={delegate.delegation!.branch}>{delegate.delegation!.branch}</small>}
    {preview && <p className={`delegate-card-preview${failed ? " is-error" : ""}`}>{preview}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </article>;
}
