import { useState } from "react";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { approvalPreview } from "../approvalPreview";
import { approvalPreviewBudget, diffView } from "../toolCards";
import { EditBody } from "./ToolCards";
import "./tool-activity.css";
import "./approval-preview.css";
import type { ChatAnswerResponse, ChatApprovalChoice, ChatPart } from "@threadterm/protocol";
import { approvalButtonsEnabled, approvalData, choiceLabel, scopeLabel } from "../chatApproval";
import { ChatQuestionCard } from "./ChatQuestionCard";
import type { ChatInteractionForm, QuestionResponse } from "../chatQuestion";
import './subagent-card.css';

export function ChatApprovalCard({
  part,
  submitting,
  writable,
  onChoose,
  onAnswer,
  onPlanResponse,
  copy,
}: {
  part: ChatPart;
  submitting?: string;
  writable: boolean;
  onChoose: (choiceId: string) => void;
  onAnswer?: (response: QuestionResponse) => void;
  onPlanResponse?: (response: ChatAnswerResponse) => void;
  copy: (en: string, zh: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const data = approvalData(part);
  const preview = approvalPreview(part);
  const previewBudget = preview?.kind === 'edit' ? approvalPreviewBudget(preview.files, showAll) : undefined;
  const previewUnavailableReason = (part.data as { previewUnavailableReason?: unknown; details?: { previewUnavailableReason?: unknown } } | undefined)?.previewUnavailableReason
    ?? (part.data as { details?: { previewUnavailableReason?: unknown } } | undefined)?.details?.previewUnavailableReason;
  const expired = part.status === "expired" || part.status === "outcomeUnknown" || part.status === "failed";
  const resolved = part.status === "resolved" || part.status === "answered" || part.status === "dismissed";
  const enabled = approvalButtonsEnabled(part, writable) && !submitting;
  if (!data) {
    return <p className="chat-approval-stale">{copy("This older approval cannot be acted on. Reload the live session to review current requests.", "这条旧审批无法操作。请同步当前会话后再查看新的请求。")}</p>;
  }
  if (data.interaction === "plan") return <PlanApprovalCard part={part} writable={writable} submitting={submitting} onRespond={onPlanResponse} copy={copy} />;
  // A provider with no request text falls back to its protocol method (Codex file changes); name it instead.
  const rawTitle = !data.title || data.title === data.requestType;
  const title = !rawTitle ? data.title
    : /fileChange/i.test(data.requestType ?? "") ? copy("Approve file changes", "批准文件修改")
    : /commandExecution/i.test(data.requestType ?? "") ? copy("Approve command", "批准命令")
    : copy("Approval required", "需要批准");
  const unsupported = data.interaction === "userInput" || data.submittable === false;
  const question = (part.data as { interaction?: string; form?: ChatInteractionForm; answerable?: boolean; answerSummary?: Record<string, string>; isBlocking?: boolean; autoResolutionMs?: number } | undefined);
  const details = detailsText(data.details);
  // Set by the runtime on a delegated session's requests (agent delegation): the
  // delegating agent decides, or the user does once that agent's turn is over
  // (escalated, or the request arrived after the turn had ended).
  const delegation = (part.data as { delegation?: { route?: string } } | undefined)?.delegation;
  const subagent = (part.data as { subagent?: { label?: string } } | undefined)?.subagent;
  if (question?.interaction === "question" && question.form) return <div className={`chat-approval-card chat-question-wrapper ${part.status ?? "pending"}`}>
    <div className="chat-question-header">
      <svg className="chat-question-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M8 9a4 4 0 0 1 8 0c0 3-4 3-4 6"/><circle cx="12" cy="12" r="10"/><path d="M12 18h.01"/></svg>
      <span className="chat-question-header-chip">{question.form.kind === "questions" && question.form.questions.length === 1 ? question.form.questions[0].header || copy("Question", "问题") : question.form.kind === "form" ? copy("Form", "表单") : question.form.kind === "url" ? copy("Action required", "需要操作") : copy("Questions", "问题")}</span>
      {subagent && <span className="chat-subagent-chip">{copy("Subagent", "子代理")} · {subagent.label || copy("Subagent", "子代理")}</span>}
      {(resolved || expired) && <span className="chat-question-status">{expired ? copy("Inactive", "已失效") : part.status === "dismissed" ? copy("Dismissed", "已忽略") : copy("Answered", "已回答")}</span>}
    </div>
    <ChatQuestionCard form={question.form} answerable={question.answerable !== false} resolved={resolved} dismissed={part.status === "dismissed"} summary={question.answerSummary} writable={writable && !expired} submitting={Boolean(submitting)} onAnswer={onAnswer} copy={copy} nonBlocking={question.isBlocking === false} autoResolutionMs={question.autoResolutionMs} inactiveMessage={expired ? copy("This question is no longer active.", "此问题已失效。") : undefined} />
  </div>;
  return (
    <div className={`chat-approval-card ${part.status ?? "pending"}${delegation?.route === "parent" ? " is-delegated" : ""}`}>
      {subagent && <span className="chat-subagent-chip">{copy("Subagent", "子代理")} · {subagent.label || copy("Subagent", "子代理")}</span>}
      <strong>{title}</strong>
      {data.requestType && <small className="chat-approval-type">{data.requestType}</small>}
      {part.status === "pending" && delegation?.route === "parent" && <p className="chat-approval-delegated">{copy("The agent that delegated this session decides this request. You can still answer it yourself.", "此请求由委派这个会话的代理决定。你也可以直接处理。")}</p>}
      {part.status === "pending" && delegation?.route === "user" && !unsupported && <p className="chat-approval-delegated">{copy("The delegating agent is no longer in its turn, so this request is yours to decide.", "委派方已结束当前轮次，此请求需要你来决定。")}</p>}
      {typeof previewUnavailableReason === 'string' && <p className="tool-card-note" role="status">{copy(`Preview unavailable: ${previewUnavailableReason}. Review the request details before deciding.`, `预览不可用：${previewUnavailableReason}。请在决定前查看请求详情。`)}</p>}
      {preview?.kind === "edit" && <>
        <div className="chat-approval-preview" role="region" aria-label={copy("Proposed edits", "拟议修改")} tabIndex={0}>
          <EditBody view={preview} copy={copy} fileLimit={previewBudget!.files} rowLimits={previewBudget!.rows} />
        </div>
        {(preview.files.length > 3 || approvalPreviewBudget(preview.files, true).omittedRows > 0) && <button type="button" className="btn btn-sm chat-approval-show-all" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? copy("Show less", "收起") : copy("Show all", "显示全部")}</button>}
        {preview.files.some(file => file.diff && diffView(file.diff).openOnly) && <p className="tool-card-note">{copy('Preview is incomplete for a large edit. Review the request details before deciding.', '大型修改的预览不完整。请在决定前查看请求详情。')}</p>}
      </>}
      {preview?.kind === "command" && <div className="chat-approval-command"><code>{preview.command}</code>{preview.cwd && <small>{copy("Working directory", "工作目录")}: {preview.cwd}</small>}</div>}
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
      className={`btn btn-sm chat-approval-choice kind-${choice.kind}`}
      disabled={disabled}
      aria-label={`${choiceLabel(choice, copy)}. ${scopeLabel(choice.scope, copy)}`}
      onClick={() => onChoose(choice.choiceId)}
    >
      <span>{busy ? copy("Submitting…", "提交中…") : choiceLabel(choice, copy)}</span>
      <small>{scopeLabel(choice.scope, copy)}</small>
    </button>
  );
}
