import type { ProviderCapability, Session } from "@threadterm/protocol";
import { attentionNotice, type Attention } from "../attentionState";

export function AttentionToast({
  attention,
  capabilities,
  session,
  locale,
  onOpen,
  onClose,
}: {
  attention: Attention;
  capabilities?: readonly ProviderCapability[];
  session?: Session;
  locale: "en" | "zh-CN";
  onOpen: () => void;
  onClose: () => void;
}) {
  const zh = locale === "zh-CN";
  const notice = attentionNotice(attention, locale, session, capabilities);
  return (
    <aside className="attention-toast" role="status" aria-live="polite">
      <div>
        <strong>{notice.heading}</strong>
        <p>{notice.detail}</p>
      </div>
      <div className="attention-toast-actions">
        <button type="button" className="btn btn-primary" onClick={onOpen}>{notice.action}</button>
        <button type="button" className="btn" onClick={onClose} aria-label={zh ? "关闭通知" : "Dismiss notification"}>×</button>
      </div>
    </aside>
  );
}
