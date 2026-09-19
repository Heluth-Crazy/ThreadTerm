import type { Session } from "@threadterm/protocol";
import { attentionNotice, type Attention } from "../attentionState";

export function AttentionToast({
  attention,
  session,
  locale,
  onOpen,
  onClose,
}: {
  attention: Attention;
  session?: Session;
  locale: "en" | "zh-CN";
  onOpen: () => void;
  onClose: () => void;
}) {
  const zh = locale === "zh-CN";
  const notice = attentionNotice(attention, locale, session);
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
