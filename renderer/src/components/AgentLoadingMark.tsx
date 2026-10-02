import type { ProviderId } from "@threadterm/protocol";
import { AgentIcon } from "./PrototypeIcon";

/**
 * The provider mark used while a connection or a native terminal is pending.
 * It deliberately has no lifecycle knowledge: callers decide when it may hide
 * their underlying surface, so an authentication prompt is never inferred from
 * animation timing.
 */
export function AgentLoadingMark({ provider, active = true }: { provider: ProviderId | string; active?: boolean }) {
  return <span className="chat-connect-mark" aria-hidden="true">
    <span className="chat-connect-logo">
      <AgentIcon provider={provider} size={64} />
      {active && <span className="chat-connect-wave"><AgentIcon provider={provider} size={64} /></span>}
    </span>
  </span>;
}
