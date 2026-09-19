import type { ChatApprovalChoice, ChatPart } from "@threadterm/protocol";
import { approvalButtonsEnabled, approvalData, kindLabel, scopeLabel } from "../chatApproval";

export function ChatApprovalCard({
  part,
  submitting,
  writable,
  onChoose,
  copy,
}: {
  part: ChatPart;
  submitting?: string;
  writable: boolean;
  onChoose: (choiceId: string) => void;
  copy: (en: string, zh: string) => string;
}) {
  const data = approvalData(part);
  const expired = part.status === "expired" || part.status === "outcomeUnknown" || part.status === "failed";
  const resolved = part.status === "resolved";
  const enabled = approvalButtonsEnabled(part, writable) && !submitting;
  if (!data) {
    return <p className="chat-approval-stale">{copy("This older approval cannot be acted on. Reload the live session to review current requests.", "这条旧审批无法操作。请同步当前会话后再查看新的请求。")}</p>;
  }
  const title = data.title || copy("Approval required", "需要批准");
  const unsupported = data.interaction === "userInput" || data.submittable === false;
  const details = detailsText(data.details);
  return (
    <div className={`chat-approval-card ${part.status ?? "pending"}`}>
      <strong>{title}</strong>
      {data.requestType && <small className="chat-approval-type">{data.requestType}</small>}
      {details && <details className="chat-approval-details"><summary>{copy("Request details", "请求详情")}</summary><pre>{details}</pre></details>}
      {unsupported && <p>{copy("This request is a native prompt and cannot be answered as Allow or Deny.", "这是原生问答请求，不能压缩成允许或拒绝。")}</p>}
      {expired && <p>{copy("This request is no longer active and cannot grant permission.", "该请求已失效，不能再授权。")}</p>}
      {resolved && <p>{copy("Decision sent. This does not confirm that the tool already ran.", "决定已发送。这不代表工具已经执行。")}</p>}
      {part.status === "pending" && data.choices.length > 0 && (
        <div className="chat-approval-actions">
          {data.choices.map(choice => (
            <ApprovalButton key={choice.choiceId} choice={choice} disabled={!enabled} busy={submitting === choice.choiceId} onChoose={onChoose} copy={copy} />
          ))}
        </div>
      )}
    </div>
  );
}

function detailsText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return ""; }
}

function ApprovalButton({
  choice,
  disabled,
  busy,
  onChoose,
  copy,
}: {
  choice: ChatApprovalChoice;
  disabled: boolean;
  busy: boolean;
  onChoose: (choiceId: string) => void;
  copy: (en: string, zh: string) => string;
}) {
  return (
    <button
      type="button"
      className={`btn chat-approval-choice kind-${choice.kind}`}
      disabled={disabled}
      aria-label={`${choice.label}. ${scopeLabel(choice.scope, copy)}`}
      onClick={() => onChoose(choice.choiceId)}
    >
      <span>{busy ? copy("Submitting…", "提交中…") : choice.label || kindLabel(choice.kind, copy)}</span>
      <small>{scopeLabel(choice.scope, copy)}</small>
    </button>
  );
}
