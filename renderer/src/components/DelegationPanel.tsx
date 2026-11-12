import type { Session } from "@threadterm/protocol";
import { delegationStateLabel } from "../delegation";
import { AgentTile } from "./PrototypeIcon";
import "./delegation-panel.css";

type Copy = (en: string, zh: string) => string;

/**
 * The one-line origin note at the top of a delegated Chat ("Delegated by …").
 * The parent's delegated agents live in the overview card now, not above the transcript.
 */
export function DelegationPanel({ session, delegatedBy, onOpenSession, copy, zh }: {
  session: Session;
  /** Kept for callers that still pass the parent's delegates; the overview card reads them. */
  delegates?: Session[];
  delegatedBy?: Session;
  onOpenSession?: (sessionId: string) => void;
  copy: Copy;
  zh: boolean;
}) {
  if (!session.delegation) return null;
  return <div className="delegation-panel">
    <p className="delegation-origin" role="note">
      {delegatedBy
        ? <>{copy("Delegated by", "委派自")} <button type="button" className="delegation-link" onClick={() => onOpenSession?.(delegatedBy.id)}><AgentTile provider={delegatedBy.provider} size={12} /> {delegatedBy.title}</button></>
        : copy("Delegated by another agent", "由其他代理委派")}
      <span className={`delegation-state st-${session.delegation.state}`}>{delegationStateLabel(session.delegation.state, zh)}</span>
      {session.delegation.branch && <span className="delegation-branch" title={session.delegation.branch}>{session.delegation.branch}</span>}
    </p>
  </div>;
}
