import type { ChatConnectionError, ChatConnectionPhase, ProviderId } from "@threadterm/protocol";
import { connectionStatusText } from "../chatConnection";
import { AgentIcon } from "./PrototypeIcon";

export function ChatConnectOverlay({
  provider,
  phase,
  slow,
  error,
  variant,
  onRetry,
  copy,
  transportDown = false,
}: {
  provider: ProviderId | string;
  phase: ChatConnectionPhase;
  slow: boolean;
  error?: ChatConnectionError;
  variant: "full" | "banner";
  onRetry?: () => void;
  copy: (en: string, zh: string) => string;
  transportDown?: boolean;
}) {
  const failed = phase === "failed" && !transportDown;
  const status = transportDown ? connectionStatusText(provider, phase, copy, true) : (error?.message || connectionStatusText(provider, phase, copy));
  const retryable = failed ? error?.retryable !== false && Boolean(onRetry) : false;
  if (variant === "banner") {
    return (
      <div className={`chat-reconnect-banner${failed ? " is-failed" : ""}`} role="status" aria-live="polite">
        <AgentIcon provider={provider} size={18} />
        <span>{status}</span>
        {retryable && <button type="button" className="btn" onClick={onRetry}>{copy("Retry connection", "重试连接")}</button>}
      </div>
    );
  }
  return (
    <div className={`chat-connect-mask${failed ? " is-failed" : ""}`} role="status" aria-live="polite" aria-label={status} style={{ position: "absolute", inset: 0, zIndex: 20 }}>
      <div className="chat-connect-center">
        <span className="chat-connect-mark" aria-hidden="true">
          <span className="chat-connect-logo">
            <AgentIcon provider={provider} size={64} />
            {!failed && <span className="chat-connect-wave"><AgentIcon provider={provider} size={64} /></span>}
          </span>
        </span>
        <p className="chat-connect-status">{status}</p>
        {slow && !failed && <p className="chat-connect-slow">{copy("This is taking longer than usual. You can leave this view; the connection continues in the background.", "连接时间较长。你可以离开此视图，连接会在后台继续。")}</p>}
        {failed && <p className="chat-connect-hint">{copy("Existing messages stay readable. Retry only restores this connection.", "已有消息仍可阅读。重试只会恢复连接。")}</p>}
        {retryable && <button type="button" className="btn chat-connect-retry" onClick={onRetry}>{copy("Retry connection", "重试连接")}</button>}
      </div>
    </div>
  );
}
