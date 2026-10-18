import { ClipboardEvent, FormEvent, Fragment, KeyboardEvent, type MouseEvent as ReactMouseEvent, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { parseChatMarkdown } from '../chatMath';
import { ChatMarkdown } from './ChatMarkdownExtras';
import type { ChatAnswerResponse, ChatContextUsage, ChatPart, ChatQueue, ChatQueueItem, ChatSlashCommand, ChatUiState, FileReference, GitCommitInfo, Session } from "@threadterm/protocol";
import { ChatItem, attachFiles, openExternal, operationId, request, subscribeEvents } from "../bridge";
import { beginResync, chatUiFromEvent, completeResync, nextRepairRevision, upsertChatItem, type ChatResync } from "../chatState";
import { acquireControl } from '../controlLease';
import { createDraftWriter } from '../chatDraft';
import { useTranslation } from '../i18n';
import { Icon, useAgentCapabilities } from "./PrototypeIcon";
import { ChatApprovalCard } from "./ChatApprovalCard";
import { isBrowserEvalApproval } from '../browserEvalApproval';
import { hasRedactedBrowserResult } from '../browserToolActivity';
import { ChatConnectOverlay } from "./ChatConnectOverlay";
import { PiProjectTrust } from './PiProjectTrust';
import { DelegationPanel } from "./DelegationPanel";
import { delegationTool, delegationToolLabel } from "../delegation";
import { UsageCard } from './UsageCard';
import { usageCardsForItems } from '../usageCard';
import { connectionFeedbackPhase, connectionStatusText, emptyLink, overlayKind, providerLabel, reduceChatLink, type ChatConnectAttempt } from "../chatConnection";
import { activeTurnId, chatCanControl, formatChatDuration, itemShowsStreaming, matchSlashCommands, partBody, partLabel, shouldRenderPart, slashQuery } from "../chatPresentation";
import { groupCodexTranscript, type CodexTurn } from "../codexTranscript";
import { completedTurnPresentation, groupToolActivity, toolEntriesForItems, type ToolActivityEntry } from "../toolActivity";
import { ToolActivity } from './ToolActivity';
import { SubagentCard } from './SubagentCard';
import { isSubagentPart, subagentInfo, subagentTitle } from '../subagentActivity';
import { createCodexStreamQueue } from "../codexStream";
import { FileLinkedText, FileReferenceChips, FileReferenceScopeProvider } from './FileReferenceText';
import { isReplyTextPart, replyActionMarkdown } from '../replyMarkdown';
import { MessageActions } from './MessageActions';
import { TurnFooter } from './TurnFooter';
import { createTurnChangesCache } from '../turnFooter';
import { liveSpeedGroupIndex, liveTurnSpeed, nextLiveTurnUsage, turnSpeedText, turnSpeedTooltip, type LiveTurnUsage } from '../turnSpeed';
import { BackgroundTasksStrip } from './BackgroundTasksStrip';
import { backgroundHasOutput, revealBackgroundOutput } from '../backgroundTasks';
import { ChatPlanPanel } from './ChatPlanPanel';
import { ComposerOptions } from './ComposerOptions';
import { ChatContextRing } from './ChatContextRing';
import { useChatContextUsage } from '../useChatContextUsage';
import { ChatConnectionChip } from './ChatConnectionChip';
import { ChatMessageNavigation } from './ChatMessageNavigation';
import { SelectionBubble } from './SelectionBubble';
import { quoteSelection } from '../chatSelection';
import { askSelectionChat } from '../askSelectionChat';
import { focusRequestedChatInput, insertChatText, registerChatInputTarget } from '../terminalInputTargets';
import { parseMarkdownFileReference } from '../fileReferences';
import { SessionSurfaceContext } from './SessionSurfaceContext';
import { ChatForkButton, ChatForkMenu, ChatForkStatus, useChatFork } from './ChatForkControls';
import { decodeCopiedConversationDraft, decodeForkDraftV2, encodeForkDraftV2, copiedConversationPayload } from '../chatForkDraft';
import { composerTextAfterFork, isCompletedForkReply } from '../chatFork';
import { CatalogPopover } from './CatalogActions';
import { isWebTabUrl } from '../workspaceTabs';
import { insertAtCaret } from '../workbench/agentReference';
import "./chat-network-notice.css";
import { isChatImage, readClipboardImage, selectChatImageAttachments, validateChatImages } from '../chatImages';
import './chat-images.css';
import { queueComposerMode } from '../chatQueue';
import { slashPaletteEnter } from '../composeKeys';
import { noteBodyFits } from '../feedbackNotes';
import { ChatQueue as ChatQueuePanel } from './ChatQueue';
import { ChatNotes as ChatNotesPanel } from './ChatNotes';
import { SteerSend } from './SteerSend';
import { steerControlKind, steerFailureMessage } from '../steerSend';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { partitionAttachedFiles } from '../chatAttachments';
import { parseQuickMessages } from '../quickMessages';
import { useAppSettings } from '../appSettings';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';
import { textFieldContextMenuItems } from '../contextMenuFallback';
import { useChatContext } from '../useChatContext';
import { ContextMessage, ContextTray } from './ContextTray';
import { ChatMentions } from './ChatMentions';
import { ComposerMentionHighlights } from './ComposerMentionHighlights';
import { MessageMentionText } from './MessageMentionText';
import { agentMentionItems, beginMentionLoad, commitMentionItems, fileMentionItems, flatMentionItems, initialMentionLoadState, mentionGroups as buildMentionGroups, mentionKeyAction, mentionLoadCurrent, mentionLoadKey, mentionQuery, sessionContextItem, sessionMentionItems, skillMentionItems, type MentionItem, type MentionLoadState, type MentionSources } from '../chatMentions';
import { activeMentionEntries, addMentionEntry, deletionRange, mentionAtCaret, resolveMentions, type MentionEntry, type MentionableItem, type ResolvedMention } from '../inlineMentions';
import { mentionActionSnapshot, mentionActionStillValid, mentionContainingSelection, pointerMentionTarget, type MentionMark, type MentionRect } from '../mentionActions';
import { composerEditable, composerSnapshot, decodeLocalRecovery, encodeLocalRecovery, localRecoveryDiffers, MAX_MENTION_MESSAGE, mentionDescription, mentionInsertedText, mentionPickStillValid, serializeComposerSnapshot, tentativeMentionPick, type ComposerInputState, type ComposerSnapshot, type LocalRecovery, type MentionPickTicket } from '../composerMentions';
import { applyNativeEdit } from '../nativeTextEdit';
import { mentionSerializedBlock, type SessionContextItem } from '../chatContext';
import { contextError } from '../contextErrors';
import { CHAT_REPAIR_REQUEST, setChatRepairAvailability, type ChatRepairAvailability } from '../chatRepair';
import { discoveredRepair, discoveryMatches, type RepairDiscovery } from '../chatRepairDiscovery';
import { SurfaceDialog } from './SurfaceDialog';
import { useChatViewport } from '../useChatViewport';
import { providerRetryPresentation } from '../providerRetry';
import { ProviderRetryStatus } from './ProviderRetryStatus';
import './chat-viewport.css';
import { PageShotDrafts } from './PageComments';
import { usePageShotDraft } from '../pageShotDraft';

type RepairNotice = { kind: 'rebuilt'; total: number } | { kind: 'unchanged' | 'superseded' | 'failed' };

function ThinkingPart({ part, streaming, copy, openFile }: { part: ChatPart; streaming: boolean; copy: (en: string, zh: string) => string; openFile?: (reference: FileReference) => void }) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => { setOpen(streaming); }, [streaming]);
  const body = partBody(part);
  if (!body && !streaming) return null;
  return (
    <details className="v3-thinking" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{streaming ? copy("Thinking…", "思考中…") : copy("Thought process", "思考过程")}</summary>
      <div className="v3-message-text"><FileLinkedText text={body} openFile={openFile} /></div>
      <FileReferenceChips references={part.fileReferences} visibleText={body} openFile={openFile} />
    </details>
  );
}

const codexMarkdownCache = new Map<string, string>();
const codexMarkdownCacheLimit = 300;
function renderCodexMarkdown(text: string, zh: boolean): string {
  const cacheKey = `${zh ? "zh" : "en"}\u0000${text}`;
  const cached = codexMarkdownCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const rendered = parseChatMarkdown(text);
  const template = document.createElement('template');
  template.innerHTML = typeof rendered === "string" ? rendered : "";
  for (const element of Array.from(template.content.querySelectorAll('[data-threadterm-file-reference]'))) element.removeAttribute('data-threadterm-file-reference');
  for (const anchor of Array.from(template.content.querySelectorAll('a[href]'))) {
    const reference = parseMarkdownFileReference(anchor.getAttribute('href') ?? '');
    if (!reference) continue;
    anchor.removeAttribute('href');
    anchor.setAttribute('data-threadterm-file-reference', JSON.stringify(reference));
  }
  const sanitized = DOMPurify.sanitize(template.innerHTML, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base", "svg", "math", "audio", "video", "source", "track"],
    FORBID_ATTR: ["style", "srcset", "background", "poster"],
    SANITIZE_NAMED_PROPS: true,
  });
  // Copy controls are added after sanitizing: they are our own inert markup,
  // and the read-only pre content is never carried into an attribute.
  const holder = document.createElement('div');
  holder.innerHTML = sanitized;
  for (const pre of Array.from(holder.querySelectorAll('pre'))) {
    const block = document.createElement('div');
    block.className = 'md-code-block';
    pre.replaceWith(block);
    block.append(pre);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm md-code-copy';
    button.dataset.copyCode = 'true';
    button.textContent = zh ? '复制' : 'Copy';
    button.setAttribute('aria-label', zh ? '复制代码' : 'Copy code');
    button.title = zh ? '复制代码' : 'Copy code';
    block.append(button);
  }
  const result = holder.innerHTML;
  codexMarkdownCache.set(cacheKey, result);
  if (codexMarkdownCache.size > codexMarkdownCacheLimit) codexMarkdownCache.delete(codexMarkdownCache.keys().next().value!);
  return result;
}

function CodexToolPart({ part, copy, openFile }: { part: ChatPart; copy: (en: string, zh: string) => string; openFile?: (reference: FileReference) => void }) {
  const delegation = delegationTool(part);
  // MCP tools are named mcp__<server>__<tool>: classify by the tool alone (a server such
  // as "threadterm" must not read as a file tool).
  const name = (part.toolName ?? "").split("__").pop()!.toLowerCase();
  const isFile = name.includes("file") || name.includes("patch") || name.includes("dir") || name.includes("read") || name.includes("write") || name.includes("edit");
  const isCommand = name.includes("command") || name.includes("shell") || name.includes("exec") || name.includes("bash");
  const isSearch = name.includes("search") || name.includes("web") || name.includes("grep") || name.includes("glob") || name.includes("fetch");
  const icon = delegation ? "export" : isFile ? "file" : isCommand ? "terminal" : isSearch ? "search" : "spark";
  const label = delegation ? delegationToolLabel(delegation, copy) : (isFile
      ? copy("Accessed files", "已处理文件")
      : isCommand
        ? copy("Ran a command", "已运行命令")
        : isSearch
          ? copy("Searched", "执行了搜索")
          : part.toolName?.trim() || copy("Used a tool", "调用了工具"));
  const body = partBody(part);
  const failed = part.status === "failed" || part.status === "declined";
  const running = part.status === "running" || part.status === "pending";
  return <details className="codex-tool-disclosure">
    <summary><Icon name={icon} /><span>{running ? copy("Running", "正在执行") + ": " : ""}{label}{failed ? ` · ${copy("failed", "失败")}` : ""}</span><Icon name="chevR" className="codex-tool-chevron" /></summary>
    {body && <pre><FileLinkedText text={body} openFile={openFile} /></pre>}
    <FileReferenceChips references={part.fileReferences} visibleText={body} openFile={openFile} />
  </details>;
}

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const asString = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value : fallback;
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const prettyStatusValue = (value: unknown, unavailable: string): string => {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const record = asRecord(value);
    if (typeof record.type === "string") {
      const type = record.type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
      const extras = Object.entries(record).filter(([key]) => key !== "type" && typeof record[key] !== "object").map(([key, item]) => `${key}: ${String(item)}`);
      return [type, ...extras].join(" · ");
    }
    try { return JSON.stringify(value); } catch { return unavailable; }
  }
  return unavailable;
};
const planName = (value: unknown, unavailable: string) => {
  const plan = typeof value === "string" ? value : "";
  const names: Record<string, string> = {
    prolite: "Pro Lite", self_serve_business_usage_based: "Business", business: "Business", enterprise: "Enterprise",
    self_serve_business_prolite: "Business Premium", self_serve: "ChatGPT",
  };
  return names[plan.toLowerCase()] ?? (plan || unavailable);
};
const rateWindowLabel = (window: JsonRecord, copy: (en: string, zh: string) => string) => {
  const minutes = asNumber(window.windowDurationMins);
  if (minutes === undefined) return copy("Window", "时间窗");
  if (minutes <= 360) return copy("5-hour", "5 小时");
  if (minutes <= 2_000) return copy("Daily", "每日");
  if (minutes <= 12_000) return copy("Weekly", "每周");
  if (minutes <= 60_000) return copy("Monthly", "每月");
  return copy("Annual", "每年");
};
const rateResetText = (window: JsonRecord, copy: (en: string, zh: string) => string) => {
  const timestamp = asNumber(window.resetsAt);
  if (timestamp === undefined) return "";
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  return `${copy("resets", "重置") } ${date.toLocaleString()}`;
};

function CodexStatusCard({ part, copy }: { part: ChatPart; copy: (en: string, zh: string) => string }) {
  const data = asRecord(part.data);
  const thread = asRecord(data.thread);
  const session = asRecord(data.session);
  const account = asRecord(data.account);
  const context = asRecord(data.context);
  const unavailable = copy("Unavailable", "不可用");
  const cliVersion = asString(data.cliVersion, unavailable);
  const model = asString(data.model, unavailable);
  const reasoning = asString(data.reasoningEffort, unavailable);
  const summary = asString(data.summary, unavailable);
  const directory = asString(data.directory, unavailable);
  const collaboration = asString(data.collaborationMode, unavailable);
  const threadId = asString(thread.id, unavailable);
  const sessionId = asString(thread.sessionId ?? session.id, unavailable);
  const turn = asRecord(data.turn);
  const turnText = turn.state === "active" ? `${copy("active", "进行中")}${turn.id ? ` (${String(turn.id)})` : ""}` : copy("idle", "空闲");
  const sources = Array.isArray(data.instructionSources) ? data.instructionSources.filter(item => typeof item === "string") as string[] : [];
  const rates = Array.isArray(data.rateLimits) ? data.rateLimits.map(asRecord) : [];
  const usedTokens = asNumber(context.usedTokens);
  const contextWindow = asNumber(context.modelContextWindow);
  const contextPercent = asNumber(context.percentUsed);
  const contextLabel = usedTokens !== undefined && contextWindow !== undefined
    ? `${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} ${copy("tokens", "令牌")} · ${asNumber(context.remainingTokens)?.toLocaleString() ?? unavailable} ${copy("remaining", "剩余")}${contextPercent !== undefined ? ` · ${Math.round(contextPercent)}%` : ""}`
    : unavailable;
  const permission = [
    prettyStatusValue(data.approvalPolicy, unavailable),
    prettyStatusValue(data.sandbox, unavailable),
    data.approvalsReviewer ? `${copy("reviewer", "审核者")}: ${prettyStatusValue(data.approvalsReviewer, unavailable)}` : "",
    data.activePermissionProfile ? `${copy("profile", "配置")}: ${prettyStatusValue(data.activePermissionProfile, unavailable)}` : "",
  ].filter(Boolean).join(" · ") || unavailable;
  // `requiresOpenaiAuth` describes the active model provider, not whether the
  // current account is authenticated. Codex returns it as true for a valid
  // ChatGPT account, so prefer the concrete account type when it is present.
  const accountLoaded = data.accountLoaded === true;
  const hasAccountType = typeof account.type === "string" && account.type.trim().length > 0;
  const authRequired = accountLoaded && data.requiresOpenaiAuth === true && !hasAccountType;
  const accountText = account.type === "chatgpt"
    ? [copy("ChatGPT", "ChatGPT"), typeof account.email === "string" ? account.email : "", planName(account.planType, unavailable)].filter(Boolean).join(" · ")
    : account.type === "apiKey" ? copy("API key", "API key")
    : authRequired ? copy("OpenAI sign-in required", "需要登录 OpenAI")
    : prettyStatusValue(account.type, unavailable);
  const warningText = typeof data.warning === "string"
    ? data.warning.split(";").map(item => item.trim()).filter(item => item !== "OpenAI authentication required" || authRequired).join("; ")
    : "";
  return <div className="codex-status-card" data-testid="codex-status-card">
    <div className="codex-status-title"><strong>{copy("Codex session status", "Codex 会话状态")}</strong><span>{cliVersion}</span></div>
    {typeof data.usageUrl === "string" && <a className="codex-status-usage" href={data.usageUrl} target="_blank" rel="noreferrer">{copy("View usage limits", "查看用量限制")}</a>}
    <dl className="codex-status-grid">
      <div><dt>{copy("Model", "模型")}</dt><dd>{model}</dd></div>
      <div><dt>{copy("Reasoning", "推理程度")}</dt><dd>{reasoning}</dd></div>
      <div><dt>{copy("Summaries", "摘要")}</dt><dd>{summary}</dd></div>
      <div className="codex-status-wide"><dt>{copy("Directory", "目录")}</dt><dd className="codex-status-mono">{directory}</dd></div>
      <div className="codex-status-wide"><dt>{copy("Permissions", "权限")}</dt><dd>{permission}</dd></div>
      <div className="codex-status-wide"><dt>AGENTS.md</dt><dd className="codex-status-list">{sources.length ? sources.map(source => <code key={source}>{source}</code>) : unavailable}</dd></div>
      <div><dt>{copy("Account", "账户")}</dt><dd>{accountText}</dd></div>
      <div><dt>{copy("Collaboration", "协作模式")}</dt><dd>{collaboration}</dd></div>
      <div><dt>{copy("Thread", "线程")}</dt><dd className="codex-status-mono">{threadId}</dd></div>
      <div><dt>{copy("Session", "会话")}</dt><dd className="codex-status-mono">{sessionId}</dd></div>
      <div><dt>{copy("Thread name", "线程名称")}</dt><dd>{asString(thread.name, unavailable)}</dd></div>
      <div><dt>{copy("Turn", "轮次")}</dt><dd>{turnText}</dd></div>
    </dl>
    <div className="codex-status-context">
      <div className="codex-status-section-title"><strong>{copy("Context window", "上下文窗口")}</strong><span>{contextLabel}</span></div>
      {contextPercent !== undefined && <meter min={0} max={100} value={contextPercent} aria-label={copy("Context window used", "上下文窗口使用量")} />}
    </div>
    <div className="codex-status-limits">
      <div className="codex-status-section-title"><strong>{copy("Usage limits", "用量限制")}</strong><span>{rates.length || unavailable}</span></div>
      {rates.length ? rates.map((rate, index) => <div className="codex-limit" key={`${String(rate.limitId ?? rate.limitName ?? "limit")}-${index}`}>
        <div className="codex-limit-heading"><strong>{asString(rate.limitName ?? rate.limitId, copy("Limit", "限制"))}</strong>{rate.planType !== undefined && <span>{planName(rate.planType, unavailable)}</span>}</div>
        {(["primary", "secondary"] as const).map(kind => {
          const window = asRecord(rate[kind]);
          const used = asNumber(window.usedPercent);
          if (used === undefined) return null;
          return <div className="codex-limit-window" key={kind}><span>{rateWindowLabel(window, copy)}</span><meter min={0} max={100} value={Math.max(0, Math.min(100, used))} aria-label={`${kind} ${copy("usage", "使用量")}`} /><span>{Math.round(used)}% · {rateResetText(window, copy)}</span></div>;
        })}
      </div>) : <p className="codex-status-unavailable">{copy("Usage limits are unavailable until Codex returns an account snapshot.", "Codex 返回账户快照前，用量限制不可用。")}</p>}
    </div>
    {warningText && <p className="codex-status-warning" role="alert">{warningText}</p>}
    {!Object.keys(data).length && <pre className="v3-message-text">{part.text ?? ""}</pre>}
  </div>;
}

const USAGE_LABEL_ZH: [RegExp, string][] = [
  [/5[\s-]?h(?:our)?/i, "5 小时限额"],
  [/daily/i, "每日限额"],
  [/weekly/i, "每周限额"],
  [/monthly/i, "每月限额"],
  [/annual/i, "每年限额"],
];
const USAGE_EXTRA_LABEL_ZH: Record<string, string> = { "Used this month": "本月已用", "Monthly limit": "月度限额", "Balance": "余额" };
function usageLabelText(label: string, zh: boolean): string {
  if (!zh) return label;
  for (const [pattern, text] of USAGE_LABEL_ZH) if (pattern.test(label)) return text;
  return USAGE_EXTRA_LABEL_ZH[label] ?? label;
}
// Parses the runtime's reset hint contract: "reset" | "resets in [Xd ][Xh ][Xm ][Xs]".
function usageResetText(hint: string, zh: boolean): string {
  if (!zh || !hint) return hint;
  if (hint === "reset") return "已重置";
  const match = hint.match(/^resets in (?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
  if (!match) return hint;
  const parts = [match[1] && `${match[1]} 天`, match[2] && `${match[2]} 小时`, match[3] && `${match[3]} 分钟`, match[4] && `${match[4]} 秒`].filter(Boolean);
  return parts.length ? `${parts.join(" ")}后重置` : hint;
}

function PlanUsageCard({ part, zh, copy }: { part: ChatPart; zh: boolean; copy: (en: string, zh: string) => string }) {
  const data = asRecord(part.data);
  const rows = (Array.isArray(data.rows) ? data.rows : []).map(asRecord);
  const extra = asRecord(data.extra);
  const extraRatio = asNumber(extra.ratio);
  const extraLines = (Array.isArray(extra.lines) ? extra.lines : []).map(asRecord);
  if (!rows.length && extraRatio === undefined && !extraLines.length) return null;
  const usageRow = (label: string, percent: number, reset: string, key: string) => <div className="plan-usage-row" key={key}>
    <span className="plan-usage-label">{usageLabelText(label, zh)}</span>
    <span className="plan-usage-track"><span className="plan-usage-fill" style={{ width: `${percent}%` }} /></span>
    <span className="plan-usage-pct">{percent}%</span>
    <span className="plan-usage-meta">{copy("used", "已用")}{reset ? ` · ${usageResetText(reset, zh)}` : ""}</span>
  </div>;
  return <div className="plan-usage-card" data-testid="plan-usage-card">
    <strong className="plan-usage-heading">{copy("Plan usage", "套餐用量")}</strong>
    {rows.map((row, index) => usageRow(asString(row.label, copy("Limit", "限制")), Math.max(0, Math.min(100, asNumber(row.percent) ?? 0)), asString(row.reset, ""), `${asString(row.label, "row")}-${index}`))}
    {extraRatio !== undefined || extraLines.length ? <strong className="plan-usage-heading plan-usage-extra">{copy("Extra Usage", "额外用量")}</strong> : null}
    {extraRatio !== undefined && usageRow(copy("Monthly", "月度"), Math.round(extraRatio * 100), "", "extra-ratio")}
    {extraLines.map((line, index) => <div className="plan-usage-line" key={index}><span>{usageLabelText(asString(line.label, ""), zh)}</span><span>{zh && asString(line.value, "") === "Unlimited" ? "不限" : asString(line.value, "")}</span></div>)}
  </div>;
}

// kimi built-in command output (e.g. /status) arrives as plain "Key: value" text lines;
// render them as a structured card instead of raw markdown (which also mangles Windows path prefixes).
const KIMI_STATUS_KEY_ZH: Record<string, string> = {
  session: "会话", model: "模型", mode: "模式", "working directory": "工作目录",
  account: "账户", version: "版本", plan: "套餐", thinking: "思考程度",
};
function parseKimiStatus(text: string): { key: string; value: string }[] | undefined {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return undefined;
  const rows = lines.map(line => {
    const match = line.match(/^([A-Za-z][A-Za-z ]{0,24}):\s+(.+)$/);
    return match ? { key: match[1]!, value: match[2]!.trim() } : undefined;
  });
  if (rows.some(row => !row)) return undefined;
  const parsed = rows as { key: string; value: string }[];
  return parsed.some(row => /^(session|model)$/i.test(row.key)) ? parsed : undefined;
}

function KimiStatusCard({ rows, zh, copy }: { rows: { key: string; value: string }[]; zh: boolean; copy: (en: string, zh: string) => string }) {
  return <div className="kimi-status-card" data-testid="kimi-status-card">
    <strong className="kimi-status-heading">{copy("Session status", "会话状态")}</strong>
    <dl className="kimi-status-grid">
      {rows.map((row, index) => {
        const label = zh ? (KIMI_STATUS_KEY_ZH[row.key.toLowerCase()] ?? row.key) : row.key;
        const value = row.value.replace(/^\\\\\?\\/, "");
        const mono = /^(session|working directory|version)$/i.test(row.key);
        return <div className="kimi-status-row" key={`${row.key}-${index}`}><dt>{label}</dt><dd className={mono ? "kimi-status-mono" : undefined}>{value}</dd></div>;
      })}
    </dl>
  </div>;
}

const isEnded = (session: Session) => Boolean(session.readOnly) || session.status === "exited";
const asUserError = (caught: unknown, fallback: string) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error:\s*)?/, "") || fallback;
};
// Option classification and labels moved to ../composerOptions (C2).
type DraftWriter = ReturnType<typeof createDraftWriter>;
type ControlToken = { epoch: number; check: () => Promise<void>; release: () => void; valid: boolean };
type ChatLifecycle = { sessionId: string; writer?: DraftWriter; control?: ControlToken; flushOnExit?: Promise<void> };
type FirstResponseWait = { token: string; sessionUpdatedAt: string; turnId?: string };

function hasVisibleAssistantResponse(items: ChatItem[], turnId: string): boolean {
  return items.some(item => item.role === "assistant" && item.turnId === turnId && item.parts.some(shouldRenderPart));
}

function isTerminalChatStatus(status: Session["status"]): boolean {
  return status === "idle" || status === "error" || status === "exited" || status === "interrupted";
}

export function ChatView({ session, delegates = [], delegatedBy, onOpenSession, sessions = [], delegationEnabled = true, sessionInfoEnabled = true }: { session: Session; delegates?: Session[]; delegatedBy?: Session; onOpenSession?: (sessionId: string) => void; sessions?: Session[]; delegationEnabled?: boolean; sessionInfoEnabled?: boolean }) {
  const { locale } = useTranslation();
  const surface = useContext(SessionSurfaceContext);
  const openFile = surface?.openFile;
  const openDiff = surface?.openDiff;
  const canOpenDiff = surface?.canOpenDiff;
  const zh = locale === 'zh-CN';
  // Code-block copy buttons live inside injected Markdown HTML, so their label
  // is set imperatively; keep the latest locale so the 1.5 s reset never falls
  // back to the language that was active when the click happened.
  const zhRef = useRef(zh); zhRef.current = zh;
  const copy = (en: string, cn: string) => zh ? cn : en;
  const repairDescriptionId = useId();
  const mentionDescriptionId = useId();
  // A clicked http(s) link in the transcript: the same actions as the terminal's link bar, as a menu at the link.
  const [linkMenu, setLinkMenu] = useState<{ anchor: HTMLElement; url: string }>();
  const [linkIssue, setLinkIssue] = useState<string>();
  const [mentionPreview, setMentionPreview] = useState<string>();
  const recoveryKey = `threadterm.compose.${session.id}`;
  const canControl = chatCanControl(session);
  // Native-history repair needs a lease even when chat writes are read-only.
  const canTakeControl = canControl || (session.readOnly && session.mode === 'chat' && session.status !== 'exited');
  const ended = isEnded(session);
  const [items, setItems] = useState<ChatItem[]>([]); const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>(); const [controlIssue, setControlIssue] = useState<string>(); const [controllable, setControllable] = useState(false);
  const turnChangesCache = useMemo(() => createTurnChangesCache<import('@threadterm/protocol').ReviewFile[]>(), [session.id]);
  const [viewportSessionId, setViewportSessionId] = useState<string>();
  const [repair, setRepair] = useState<ChatRepairAvailability>();
  const [repairDiscovery, setRepairDiscovery] = useState<RepairDiscovery>();
  const discoverHistoryRef = useRef<() => void>(() => undefined);
  const [repairDialog, setRepairDialog] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairNotice, setRepairNotice] = useState<RepairNotice>();
  const [ingressFailed, setIngressFailed] = useState(false);
  const [repairFollowup, setRepairFollowup] = useState(false);
  const [queue, setQueue] = useState<ChatQueue>();
  // Presentation only: keep the recoverable draft until runtime acceptance.
  // This preview never becomes a canonical ChatItem or an active-turn source.
  const [submissionPreview, setSubmissionPreview] = useState<{ token: string; text: string; images: string[] }>();
  const itemsRef = useRef(items); itemsRef.current = items;
  const [firstResponseWait, setFirstResponseWait] = useState<FirstResponseWait | undefined>(undefined);
  const firstResponseWaitRef = useRef<FirstResponseWait | undefined>(undefined);
  const [liveTurnUsage, setLiveTurnUsage] = useState<LiveTurnUsage>();
  const reclaimRef = useRef<() => void>(() => undefined);
  const lease = useRef<number | undefined>(undefined);
  const leaseSessionId = useRef<string | undefined>(undefined);
  const lifecycle = useRef<ChatLifecycle | undefined>(undefined);
  const draftRevision=useRef(0), draftReady=useRef(false), currentText=useRef(text), lastSaved=useRef(''); currentText.current=text;
  const writer=useRef<DraftWriter | undefined>(undefined);
  const [draftFailed, setDraftFailed] = useState(false);
  const [recovery, setRecovery] = useState<LocalRecovery>();
  const [draftNotice,setDraftNotice]=useState('');
  const [draftLoaded,setDraftLoaded]=useState(false);
  const [mentionCatalogue,setMentionCatalogue]=useState<MentionEntry[]>([]);
  const mentionCatalogueRef=useRef(mentionCatalogue); mentionCatalogueRef.current=mentionCatalogue;
  const resolvedMentionsRef=useRef<readonly ResolvedMention[]>([]);
  const composerGeneration=useRef(0);
  const composingRef=useRef(false);
  const pickTicketId=useRef(0);
  const pickTicket=useRef<MentionPickTicket|undefined>(undefined);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyIssue, setHistoryIssue] = useState<string>();
  const context = useChatContext(session.id, zh, setError);
  const contextRef = useRef(context); contextRef.current = context;
  const appSettings = useAppSettings();
  const quickMessages = useMemo(() => parseQuickMessages(appSettings?.quickMessages), [appSettings?.quickMessages]);
  const [liveFeedbackSignal, setLiveFeedbackSignal] = useState(0);
  const forkActions = useChatFork(session, Boolean(activeTurnId(items, session.status)) || Boolean(firstResponseWait) || busy, zh, setError);
  const forkActionsRef = useRef(forkActions); forkActionsRef.current = forkActions;
  const [link, setLink] = useState(() => emptyLink(session.id, "disconnected"));
  const connection = link.connection;
  const contextUsage = useChatContextUsage(session.id);
  const capabilities = useAgentCapabilities();
  const [connectSlow, setConnectSlow] = useState(false);
  const connectInFlight = useRef<ChatConnectAttempt | undefined>(undefined);
  const transportGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const optionsGeneration = useRef<number | undefined>(undefined);
  const uiUpdates = useRef(0);
  const [ui, setUi] = useState<ChatUiState>({ options: [], commands: [] });
  const [trustBusy, setTrustBusy] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const imagesRef=useRef(images); imagesRef.current=images;
  const [imageReading, setImageReading] = useState(false);
  const imageReadingRef = useRef(false);
  const imageDraftKey = `threadterm.compose.images.${session.id}`;
  useEffect(() => {
    try {
      const stored = localStorage.getItem(imageDraftKey);
      setImages(stored ? validateChatImages(JSON.parse(stored)) : []);
    } catch {
      setImages([]);
      setError(copy('Image draft could not be loaded.', '无法加载图片草稿。'));
    }
  }, [imageDraftKey]);
  const [approvalBusy, setApprovalBusy] = useState<string>();
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<number>();
  const [mentionData, setMentionData] = useState<{ key?: string; files?: string[]; commits?: GitCommitInfo[] }>({});
  const mentionLoadRef = useRef<MentionLoadState>(initialMentionLoadState);
  const [caret, setCaret] = useState(0);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const logContentRef = useRef<HTMLDivElement>(null);
  const viewport = useChatViewport(session.id, viewportSessionId === session.id, logRef, logContentRef);
  async function refreshBackgroundTasks() {
    const revision = uiUpdates.current, generation = transportGeneration.current, owner = lifecycle.current;
    const snapshot = await request('chat.backgroundTasks.list', { sessionId: session.id });
    if (lifecycle.current === owner && generation === transportGeneration.current && revision === uiUpdates.current) {
      setUi(current => ({ ...current, backgroundTasks: snapshot.tasks }));
    }
  }
  async function stopBackgroundTask(task: import('@threadterm/protocol').ChatBackgroundTask) {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    if (epoch === undefined || !lifecycle.current?.control?.valid) throw new Error('Chat control is required');
    const result = await request('chat.backgroundTask.stop', { sessionId: session.id, taskId: task.id, leaseEpoch: epoch, operationId: operationId() });
    if (!result.accepted) throw new Error('Background task stop was not accepted');
  }
  function clearFirstResponseWait(token?: string) {
    if (token && firstResponseWaitRef.current?.token !== token) return;
    firstResponseWaitRef.current = undefined;
    setFirstResponseWait(undefined);
  }
  function activeMentionsFor(value: string): MentionEntry[] {
    return activeMentionEntries(mentionCatalogueRef.current, resolveMentions(value, mentionCatalogueRef.current));
  }
  function composerDraftValue(value: string): string {
    const active = activeMentionsFor(value);
    if (!active.length) return contextRef.current.persistedDraft(value);
    const copied = copiedConversationPayload(contextRef.current.items);
    return encodeForkDraftV2({ text: value, mentions: active, ...(copied ? { copiedConversation: copied } : {}) });
  }
  function persistCompose(value:string,_epoch:number) {
    if (!writer.current) return Promise.reject(new Error('Draft is not loaded'));
    return writer.current.write(composerDraftValue(value)).then(() => {
      if (currentText.current === value) {
        try { localStorage.removeItem(recoveryKey); } catch { /* Runtime copy is durable. */ }
      }
    });
  }
  function submissionSnapshot(value: string): ComposerSnapshot {
    return composerSnapshot(value, contextRef.current.items, mentionCatalogueRef.current, session.worktreePath);
  }
  function serializeSubmission(value: string): string {
    return serializeComposerSnapshot(submissionSnapshot(value), session.worktreePath);
  }
  function clearMentions() {
    mentionCatalogueRef.current = [];
    setMentionCatalogue([]);
    pickTicket.current = undefined;
  }
  function changeText(value: string) {
    currentText.current = value; setText(value);
    if (recovery !== undefined) setRecovery(undefined);
    try { localStorage.setItem(recoveryKey, encodeLocalRecovery(value, mentionCatalogueRef.current, session.worktreePath)); }
    catch { setError(copy('Local recovery is unavailable. Keep this view open until the draft is saved.', '本地恢复不可用，请在草稿保存成功前保持此视图打开。')); }
  }
  function initializeWriter(draft: {revision: number; text: string}, sessionLifecycle: ChatLifecycle) {
    const draftWriter = createDraftWriter(draft, async (value, revision) => {
      const control = sessionLifecycle.control;
      if (!control?.valid) throw new Error(copy('Chat is read-only.', '聊天当前为只读。'));
      const saved=await request('chat.draft.save',{sessionId:sessionLifecycle.sessionId,text:value,expectedRevision:revision,leaseEpoch:control.epoch,operationId:operationId()});
      if (lifecycle.current === sessionLifecycle) {draftRevision.current=saved.revision;lastSaved.current=value;}
      return saved;
    });
    sessionLifecycle.writer = draftWriter;
    writer.current = draftWriter;
  }
  const changeTextRef = useRef(changeText);
  changeTextRef.current = changeText;
  const attachImagesRef=useRef<(incoming:string[])=>number>(()=>0);
  // Editor/file "Send to agent" inserts a reference at the caret; it never submits.
  useEffect(() => registerChatInputTarget(session.id, {
    visible: () => Boolean(composeRef.current && !composeRef.current.disabled && composeRef.current.getClientRects().length > 0),
    attachImages: incoming => attachImagesRef.current(incoming),
    attachContext: context.attach,
    focus: () => { const area = composeRef.current; area?.focus({ preventScroll: true }); return !!area && document.activeElement === area; },
    insert: (reference) => {
      const area = composeRef.current;
      const next = insertAtCaret(currentText.current, area?.selectionStart ?? currentText.current.length, reference);
      changeTextRef.current(next.text);
      requestAnimationFrame(() => { area?.focus(); area?.setSelectionRange(next.caret, next.caret); });
    },
  }), [session.id]);
  async function retryDraft() {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined; if (!canControl || epoch === undefined) return;
    try {
      const remote = await request('chat.draft.read', {sessionId: session.id});
      if (remote.text !== lastSaved.current && remote.text !== composerDraftValue(currentText.current) && !confirm(copy('The saved draft changed in another view. Replace it with this text?', '其他视图更改了已保存的草稿。用此处内容替换吗？'))) return;
      await writer.current?.reset(remote);
      await persistCompose(currentText.current, epoch);
      setDraftFailed(false); setError(undefined); setDraftNotice(copy('Draft saved', '草稿已保存'));
    } catch (caught) { setError(String(caught)); }
  }
  useEffect(() => {
    let disposed = false;
    const sessionLifecycle: ChatLifecycle = {sessionId: session.id};
    lifecycle.current = sessionLifecycle;
    let resync: ChatResync | undefined = beginResync(session.id, 0);
    const newCodexStream = () => session.provider === "codex"
      ? createCodexStreamQueue((item) => {
        if (!disposed) setItems(current => upsertChatItem(current, item));
      })
      : undefined;
    let codexStream = newCodexStream();
    let repairRevision = -1;
    let integrityError: string | undefined;
    let ingressWasFailed = false;
    transportGeneration.current = 0;
    historyGeneration.current = 0;
    setRepairDiscovery({ sessionId: session.id, generation: 0, phase: 'pending' });
    optionsGeneration.current = undefined;
    uiUpdates.current = 0;
    const isCurrent = (generation: number) => !disposed && lifecycle.current === sessionLifecycle
      && transportGeneration.current === generation;
    const isCurrentHistory = (generation: number) => !disposed && lifecycle.current === sessionLifecycle
      && historyGeneration.current === generation;
    const finishResync = (generation: number, transcript?: { items: ChatItem[]; revision: number; repair?: ChatRepairAvailability }) => {
      if (!isCurrentHistory(generation)) return;
      const completed = resync;
      if (!completed || completed.generation !== generation) return;
      resync = undefined;
      setItems(current => completeResync(completed, session.id, generation, current, transcript) ?? current);
      if (transcript) {
        setViewportSessionId(session.id);
        setRepair(transcript.repair); setChatRepairAvailability(session.id, repairDescriptionId, transcript.repair);
        if (transcript.repair) {
          ingressWasFailed = Boolean(transcript.repair.ingressFailed); setIngressFailed(ingressWasFailed);
          if (!ingressWasFailed) setRepairFollowup(false);
        }
        if (transcript.repair && !transcript.repair.degraded) {
          const repairedIssue = integrityError;
          if (repairedIssue) setError(current => current === repairedIssue ? undefined : current);
          integrityError = undefined;
          if (repairRevision >= 0 && ingressWasFailed) setRepairFollowup(true);
        }
      }
      setHistoryLoaded(true); setHistoryFailed(!transcript);
      if (transcript) setHistoryIssue(undefined);
      setRepairDiscovery(transcript ? discoveredRepair(session.id, generation, transcript.repair)
        : { sessionId: session.id, generation, phase: 'failed' });
    };
    const refreshRepair = () => {
      const generation = transportGeneration.current;
      const history = historyGeneration.current;
      void request('chat.snapshot', { sessionId: session.id }).then(snapshot => {
        if (!isCurrent(generation) || !isCurrentHistory(history)) return;
        setRepair(snapshot.repair); setChatRepairAvailability(session.id, repairDescriptionId, snapshot.repair);
        if (snapshot.repair) {
          ingressWasFailed = Boolean(snapshot.repair.ingressFailed); setIngressFailed(ingressWasFailed);
          if (!ingressWasFailed) setRepairFollowup(false);
        }
      }).catch(() => undefined);
    };
    clearFirstResponseWait();
    setViewportSessionId(undefined);
    setHistoryIssue(undefined);
    setSubmissionPreview(undefined);
    setItems([]); setText(''); setBusy(false); setQueue(undefined); setDraftLoaded(false); setHistoryLoaded(false); setHistoryFailed(false); setLiveTurnUsage(undefined); setLink(emptyLink(session.id, canControl && !ended ? "connecting" : "unavailable")); setConnectSlow(false); setError(undefined); setRepair(undefined); setRepairDialog(false); setRepairBusy(false); setRepairNotice(undefined); setIngressFailed(false); setRepairFollowup(false); setChatRepairAvailability(session.id, repairDescriptionId, undefined);draftReady.current=false;writer.current=undefined;setDraftFailed(false);setRecovery(undefined);setApprovalBusy(undefined);composingRef.current=false;pickTicket.current=undefined;composerGeneration.current+=1;mentionCatalogueRef.current=[];setMentionCatalogue([]);setMentionPreview(undefined);
    const unsubscribe = subscribeEvents(event => {
      if (disposed || !event.data || typeof event.data !== 'object') return;
      const data = event.data as { sessionId?: string; item?: ChatItem; reason?: string };
      if (event.event === 'chat.turnSpeed' && data.sessionId === session.id) {
        const speed = event.data as { turnId?: unknown; active?: unknown; usage?: ChatContextUsage };
        const turnId = speed.turnId, active = speed.active;
        if (typeof turnId !== 'string') return;
        if (typeof active === 'boolean') setLiveTurnUsage(current => nextLiveTurnUsage(current, { turnId, active, usage: speed.usage }));
        return;
      }
      if (event.event === 'chat.forked' && data.sessionId === session.id) {
        const forked = event.data as {operationId?: string; session?: Session; mode?: 'native' | 'copy'};
        if (forked.operationId && forked.session && (forked.mode === 'native' || forked.mode === 'copy')) {
          forkActionsRef.current.acceptEvent(forked.operationId, forked.session, forked.mode);
        }
        return;
      }
      if (event.event === 'runtime.degraded' && (!data.sessionId || data.sessionId === session.id)) {
        if (!data.sessionId) { ingressWasFailed = true; setIngressFailed(true); }
        integrityError = data.reason ?? 'Chat updates are incomplete.';
        setError(integrityError);
        refreshRepair();
      }
      if (event.event === 'runtime.transport') {
        const transport = event.data as { state?: string; epoch?: string };
        if (transport.state === 'disconnected' || transport.state === 'incompatible') {
          transportGeneration.current += 1;
          setRepairDiscovery({ sessionId: session.id, generation: ++historyGeneration.current, phase: 'pending' });
          setLink(current => reduceChatLink(current, { type: 'transport-down' }));
          if (transport.state === 'incompatible' && typeof (event.data as { message?: string }).message === 'string') setError((event.data as { message: string }).message);
        }
        if (transport.state === 'reconnected') {
          const generation = ++transportGeneration.current;
          const history = ++historyGeneration.current;
          setRepairDiscovery({ sessionId: session.id, generation: history, phase: 'pending' });
          // Dispose also cancels the timer and dedup cache from the old stream.
          codexStream?.dispose(); codexStream = newCodexStream();
          resync = beginResync(session.id, history, resync);
          optionsGeneration.current = generation;
          const uiRevision = uiUpdates.current;
          const epoch = typeof transport.epoch === 'string' ? transport.epoch : event.epoch;
          setLink(current => reduceChatLink(current, { type: 'transport-up', epoch }));
          reclaimRef.current();
          const syncError = (caught: unknown) => {
            if (isCurrent(generation)) setError(asUserError(caught, copy('Could not synchronize the connection. Reopen this view to retry.', '无法同步连接状态，请重新打开此视图重试。')));
          };
          void request('chat.snapshot', { sessionId: session.id }).then(snapshot => {
            finishResync(history, snapshot);
          }).catch(caught => { finishResync(history); if (isCurrentHistory(history)) setHistoryIssue(asUserError(caught, copy('Could not synchronize saved history.', '无法同步已保存的历史。'))); });
          void request('chat.options', { sessionId: session.id }).then(snapshot => {
            if (isCurrent(generation) && uiUpdates.current === uiRevision) setUi(chatUiFromEvent(snapshot));
          }).catch(caught => { if (uiUpdates.current === uiRevision) syncError(caught); });
          void request('chat.connection', { sessionId: session.id }).then(snapshot => {
            if (isCurrent(generation)) setLink(current => reduceChatLink(current, { type: 'snapshot', snapshot, transportGeneration: generation, resync: true }));
          }).catch(syncError);
        }
      }
      if (event.event === 'chat.connection' && data.sessionId === session.id) {
        setLink(current => reduceChatLink(current, { type: 'event', snapshot: { ...current.connection, error: undefined, ...(event.data as object), runtimeEpoch: event.epoch, sessionId: session.id }, epoch: event.epoch }));
        refreshRepair();
      }
      if (event.event === 'chat.ui' && data.sessionId === session.id) {
        uiUpdates.current += 1;
        const next = event.data as ChatUiState & { sessionId?: string };
        setUi(chatUiFromEvent(next));
      }
      if (event.event === 'state.changed' && data.sessionId === session.id && (event.data as { kind?: unknown }).kind === 'chat.repair') {
        const changed = event.data as { revision?: unknown };
        const revision = nextRepairRevision(repairRevision, changed.revision ?? event.seq);
        if (revision === undefined) return;
        repairRevision = revision;
        const generation = ++historyGeneration.current;
        setRepairDiscovery({ sessionId: session.id, generation, phase: 'pending' });
        codexStream?.dispose(); codexStream = newCodexStream();
        resync = beginResync(session.id, generation, resync);
        void request('chat.snapshot', { sessionId: session.id }).then(snapshot => {
          finishResync(generation, snapshot);
        }).catch(caught => {
          finishResync(generation);
          if (isCurrentHistory(generation)) setHistoryIssue(asUserError(caught, copy('Could not synchronize repaired history.', '无法同步已修复的历史。')));
        });
        return;
      }
      if (event.event === 'state.changed' && data.sessionId === session.id && ['chat.turn.completed', 'chat.error'].includes(String((event.data as { kind?: unknown }).kind))) refreshRepair();
      if (event.event !== 'chat.item' || data.sessionId !== session.id || !data.item) return;
      if (resync) resync.buffered.push({seq: event.seq, item: data.item});
      else if (codexStream) codexStream.push(data.item);
      else setItems(current => upsertChatItem(current, data.item!));
    });
    // Reading does not require the write lease: other windows remain viewers.
    void request('chat.draft.read',{sessionId:session.id}).then(draft=>{
      if(disposed)return;draftRevision.current=draft.revision;lastSaved.current=draft.text;draftReady.current=true;initializeWriter(draft,sessionLifecycle);setDraftLoaded(true);
      const v2 = decodeForkDraftV2(draft.text);
      const v1 = v2 ? undefined : decodeCopiedConversationDraft(draft.text);
      const value = v2?.text ?? v1?.text ?? draft.text;
      const runtimeMentions = v2?.mentions ?? [];
      if (v2?.copiedConversation) contextRef.current.restoreConversationPayload(v2.copiedConversation);
      else if (v1) contextRef.current.restoreCopiedConversation(draft.text);
      mentionCatalogueRef.current = runtimeMentions; setMentionCatalogue(runtimeMentions);
      const preexisting = currentText.current;
      if (!preexisting) { setText(value); currentText.current=value; }
      try {
        const local = localStorage.getItem(recoveryKey);
        if (local !== null) {
          const pair = decodeLocalRecovery(local);
          const differs = preexisting
            ? pair.text !== preexisting || pair.text !== value
            : localRecoveryDiffers(pair, { text: value, mentions: runtimeMentions }, session.worktreePath);
          if (differs) setRecovery(pair);
        }
      } catch { /* Runtime draft is still available. */ }
    }).catch(caught=>{if(!disposed){setError(`Draft could not be loaded: ${String(caught)}`);setDraftFailed(true);setDraftLoaded(true);}});
    discoverHistoryRef.current = () => {
      const generation = ++historyGeneration.current;
      resync = beginResync(session.id, generation, resync);
      setRepairDiscovery({ sessionId: session.id, generation, phase: 'pending' });
      void request('chat.snapshot', {sessionId: session.id}).then(transcript => {
        finishResync(generation, transcript);
      }).catch(caught => { finishResync(generation); if (isCurrentHistory(generation)) setHistoryIssue(String(caught)); });
    };
    discoverHistoryRef.current();
    const onRepairRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; owner?: string }>).detail;
      if (detail?.sessionId === session.id && detail.owner === repairDescriptionId) setRepairDialog(true);
    };
    addEventListener(CHAT_REPAIR_REQUEST, onRepairRequest);
    return () => {
      disposed = true; unsubscribe();
      removeEventListener(CHAT_REPAIR_REQUEST, onRepairRequest); setChatRepairAvailability(session.id, repairDescriptionId, undefined);
      codexStream?.dispose();
      const control = sessionLifecycle.control;
      const draftWriter = sessionLifecycle.writer;
      const value = currentText.current;
      if (draftReady.current && control?.valid && draftWriter) {
        sessionLifecycle.flushOnExit = draftWriter.write(composerDraftValue(value)).then(() => {
          try { if (localStorage.getItem(recoveryKey) === value) localStorage.removeItem(recoveryKey); } catch { /* The runtime copy is durable. */ }
        }).catch(() => undefined);
      }
      if (lifecycle.current === sessionLifecycle) { lifecycle.current = undefined; discoverHistoryRef.current = () => undefined; }
    };
  }, [session.id]);
  useEffect(() => {
    const pending = firstResponseWaitRef.current;
    if (pending?.turnId && hasVisibleAssistantResponse(items, pending.turnId)) clearFirstResponseWait(pending.token);
    // The projection emits state.changed when a turn completes even when the
    // provider produced no parts. App refreshes the Session snapshot, so this
    // also clears a cancelled or empty reply without treating old idle state as
    // completion of a newly submitted turn.
    if (pending?.turnId && session.updatedAt !== pending.sessionUpdatedAt && isTerminalChatStatus(session.status)) clearFirstResponseWait(pending.token);
  }, [firstResponseWait, items, session.status, session.updatedAt]);
  useEffect(() => {
    if (ended || connection.phase === "failed") {
      clearFirstResponseWait();
      setSubmissionPreview(undefined);
    }
  }, [connection.phase, ended]);
  useEffect(() => {
    let disposed = false;
    let control: ControlToken | undefined;
    let taking = false;
    let autoTries = 0;
    const sessionLifecycle = lifecycle.current;
    lease.current = undefined; leaseSessionId.current = undefined; setControllable(false); setControlIssue(undefined);
    async function take() {
      if (disposed || taking || !canTakeControl || control?.valid) return;
      taking = true;
      try {
        const claim = await acquireControl(session.id, () => {
          if (disposed) return;
          if (control) { control.valid = false; control.release(); }
          control = undefined;
          lease.current = undefined; leaseSessionId.current = undefined; setControllable(false);
          taking = false;
          if (autoTries < 2) {
            autoTries += 1;
            setControlIssue(copy('Reconnecting chat control…', '正在重新取得聊天控制权…'));
            void take();
            return;
          }
          setControlIssue(copy('Chat control was lost. Retry from this view.', '聊天控制权已丢失，请在此视图重试。'));
        });
        const target = lifecycle.current;
        if (disposed || target?.sessionId !== session.id) { claim.release(); return; }
        control = {epoch: claim.epoch, check: claim.check, release: claim.release, valid: true};
        target.control = control;
        lease.current = claim.epoch; leaseSessionId.current = session.id; setControllable(true); setControlIssue(undefined); autoTries = 0;
      } catch {
        if (!disposed) setControlIssue(copy('Could not take chat control. Retry from this view.', '无法取得聊天控制权，请在此视图重试。'));
      } finally { taking = false; }
    }
    reclaimRef.current = () => {
      autoTries = 0;
      if (!control?.valid) { void take(); return; }
      // Retry/transport resync validate the owned lease without taking another
      // pool reference. A failed check follows the existing onLost recovery.
      const current = control;
      setControllable(false);
      void current.check().then(() => {
        if (!disposed && control === current && current.valid) setControllable(true);
      }).catch(() => undefined);
    };
    if (canTakeControl) void take();
    return () => {
      disposed = true;
      lease.current = undefined; leaseSessionId.current = undefined;
      if (!control) return;
      const release = () => {control!.valid = false; control!.release();};
      if (sessionLifecycle?.flushOnExit) void sessionLifecycle.flushOnExit.finally(release);
      else release();
    };
  }, [canTakeControl, canControl, session.id, session.mode, session.readOnly]);
  const connected = connection.phase === "ready" && link.transport === "up";
  const discoveryCurrent = discoveryMatches(repairDiscovery, session.id, historyGeneration.current);
  const discoveryClear = discoveryCurrent && repairDiscovery?.phase === 'clear';
  const connectionHeld = discoveryCurrent && repairDiscovery?.phase === 'held';
  const discoveryFailed = discoveryCurrent && repairDiscovery?.phase === 'failed';
  const writable = canControl && controllable && connected && discoveryClear && leaseSessionId.current === session.id && lease.current !== undefined;
  useEffect(() => { if (writable && draftLoaded && !busy && surface?.focused !== false) focusRequestedChatInput(session.id); }, [writable, draftLoaded, busy, session.id, surface?.focused]);
  const repairWritable = controllable && leaseSessionId.current === session.id && lease.current !== undefined;
  const repairHasLiveTurn = !ended && Boolean(activeTurnId(items, session.status));
  useEffect(() => {
    if (repair) setChatRepairAvailability(session.id, repairDescriptionId, {
      ...repair, offered: repair.offered && !repairHasLiveTurn, writable: repairWritable,
    });
  }, [repair, session.id, repairDescriptionId, repairWritable, repairHasLiveTurn]);
  useEffect(() => {
    let disposed = false;
    if (!canControl || ended) {
      setLink(current => current.connection.sessionId === session.id && current.connection.phase !== "ready"
        ? { ...current, connection: { ...current.connection, phase: "unavailable" } }
        : current);
      return;
    }
    const generation = transportGeneration.current;
    void request("chat.connection", { sessionId: session.id }).then(snapshot => {
      if (!disposed) setLink(current => reduceChatLink(current, { type: "snapshot", snapshot, transportGeneration: generation }));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [canControl, ended, session.id]);
  useEffect(() => {
    connectInFlight.current = undefined;
    return () => { connectInFlight.current = undefined; };
  }, [session.id, link.transportGeneration]);
  useEffect(() => {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    const shouldConnect = connection.phase === "connecting" || connection.phase === "disconnected";
    if (connectInFlight.current && connection.connectionGeneration > connectInFlight.current.connectionGeneration) connectInFlight.current = undefined;
    if (!discoveryClear || !canControl || ended || !controllable || epoch === undefined || connected || !shouldConnect || link.transport !== "up" || connectInFlight.current) return;
    const generation = transportGeneration.current;
    const attempt: ChatConnectAttempt = {
      sessionId: session.id, runtimeEpoch: connection.runtimeEpoch, transportGeneration: generation,
      connectionGeneration: Math.max(connection.connectionGeneration + (connection.phase === "connecting" && connection.connectionGeneration > 0 ? 0 : 1), (link.failedAttempt?.connectionGeneration ?? -1) + 1),
    };
    connectInFlight.current = attempt;
    // Phase/options updates do not cancel this request. Only a newer explicit
    // attempt, mounted session or transport generation can supersede its result.
    void request("chat.connect", { sessionId: session.id, leaseEpoch: epoch, operationId: operationId() }).then(snapshot => {
      if (connectInFlight.current !== attempt || generation !== transportGeneration.current) return;
      connectInFlight.current = undefined;
      setLink(current => reduceChatLink(current, { type: "snapshot", snapshot, transportGeneration: generation, attempt }));
    }).catch(caught => {
      if (connectInFlight.current !== attempt || generation !== transportGeneration.current) return;
      connectInFlight.current = undefined;
      setLink(current => reduceChatLink(current, { type: "connect-failed", attempt, message: asUserError(caught, copy("Could not connect.", "无法连接。")) }));
    });
  }, [discoveryClear, canControl, ended, controllable, connected, connection.phase, connection.connectionGeneration, connection.runtimeEpoch, link.transport, link.transportGeneration, session.id, zh]);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    const generation = transportGeneration.current;
    if (optionsGeneration.current === generation) return;
    optionsGeneration.current = generation;
    const uiRevision = uiUpdates.current;
    void request("chat.options", { sessionId: session.id }).then(next => { if (!disposed && generation === transportGeneration.current && uiUpdates.current === uiRevision) setUi(chatUiFromEvent(next)); }).catch(caught => {
      if (!disposed && generation === transportGeneration.current && uiUpdates.current === uiRevision) setUi(current => ({ ...current, loadState: "error", error: { code: "options_failed", message: asUserError(caught, copy("Options could not be loaded.", "无法读取选项。")) } }));
    });
    return () => { disposed = true; };
  }, [connected, session.id, zh]);
  const overlay = connectionHeld || discoveryFailed ? 'none' : overlayKind({
    ended,
    canControl,
    phase: connection.phase,
    hasTranscript: items.length > 0,
    transportDown: link.transport !== "up",
  });
  // One live snapshot of the composer's editability. Every guard (native edits,
  // picks, submission, attachment) and the textarea's disabled state read it, so
  // an async continuation can never act on permissions captured before an await.
  const composerStateRef = useRef<ComposerInputState>({ writable: false, ended: false, busy: false, draftLoaded: false, overlayFull: false, recoveryPending: false });
  composerStateRef.current = { writable, ended, busy, draftLoaded, overlayFull: overlay === 'full', recoveryPending: recovery !== undefined };
  const composerEditableNow = composerEditable(composerStateRef.current);
  // Losing control, a connection change or a pending recovery choice cancels an
  // outstanding session pick before it can mutate the catalogue.
  useEffect(() => { if (!composerEditable(composerStateRef.current)) pickTicket.current = undefined; }, [writable, ended, busy, draftLoaded, overlay, recovery]);
  useEffect(() => {
    if (overlay !== "full" || connection.phase === "failed") {
      setConnectSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setConnectSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [overlay, connection.phase, session.id]);
  function retryConnection() {
    connectInFlight.current = undefined;
    setLink(current => reduceChatLink(current, { type: "reset", sessionId: session.id, phase: "disconnected" }));
    reclaimRef.current();
  }
  function continueWithoutReload() {
    if (!discoveryCurrent || repairBusy || !connectionHeld) return;
    setRepairDiscovery({ sessionId: session.id, generation: historyGeneration.current, phase: 'clear' });
  }
  useEffect(()=>{
    if(!draftReady.current||!writable||lease.current===undefined||recovery!==undefined||draftFailed)return;
    const epoch=lease.current;
    const timer=setTimeout(()=>{setDraftNotice(copy('Saving draft…','正在保存草稿…'));void persistCompose(text,epoch).then(()=>setDraftNotice(copy('Draft saved','草稿已保存'))).catch(caught=>{setDraftFailed(true);setDraftNotice(copy('Draft not saved','草稿未保存'));setError(String(caught));});},400);
    return()=>clearTimeout(timer);
  },[text,writable,recovery,draftFailed,context.items,mentionCatalogue]);
  async function submit(event: FormEvent) {
    event.preventDefault();let value:string;
    if(text.trim()==='/fork' && !images.length && !context.items.length){
      if(forkActions.disabledReason){setError(forkActions.disabledReason);return;}
      const captured=text;
      const child=await forkActions.fork();
      if(child){
        const remaining=composerTextAfterFork(currentText.current,captured);
        if(remaining!==currentText.current){
          changeText(remaining);
          const epoch=lease.current;
          if(epoch!==undefined)void persistCompose(remaining,epoch).catch(caught=>setError(String(caught)));
        }
      }
      return;
    }
    try { value=serializeSubmission(text.trim()); } catch(caught) { setError(contextError(caught,zh)); return; }
    const epoch=leaseSessionId.current === session.id ? lease.current : undefined;
    const queueing = queueComposerMode(Boolean(activeTurnId(itemsRef.current, session.status)), queue);
    if((!value&&!images.length)||queue?.sessionId!==session.id||imageReading||epoch===undefined||!composerEditable(composerStateRef.current)||(!queueing&&(firstResponseWaitRef.current||activeTurnId(itemsRef.current,session.status))))return;
    pickTicket.current = undefined;
    const submittingLifecycle = lifecycle.current;
    const token = operationId();
    if (queueing) {
      setBusy(true); setError(undefined);
      try {
        await persistCompose(text, epoch);
        if (lifecycle.current !== submittingLifecycle) return;
        const nextQueue = await request('chat.queue.add', {sessionId:session.id, text:value, ...(images.length ? {images} : {}), operationId:token, leaseEpoch:epoch});
        if (lifecycle.current !== submittingLifecycle) return;
        setQueue(nextQueue);
        clearMentions(); composerGeneration.current += 1;
        changeText(''); setImages([]); context.clear();
        try { localStorage.removeItem(imageDraftKey); } catch { /* The accepted queue item is already durable. */ }
        await persistCompose('', epoch);
      } catch (caught) {
        if (lifecycle.current === submittingLifecycle) setError(asUserError(caught, copy('Message was not queued.', '消息未能加入队列。')));
      } finally { if (lifecycle.current === submittingLifecycle) setBusy(false); }
      return;
    }
    const pendingStart = { token, sessionUpdatedAt: session.updatedAt };
    setSubmissionPreview({ token, text: value, images });
    firstResponseWaitRef.current = pendingStart;
    setFirstResponseWait(pendingStart);
    setBusy(true);setError(undefined);
    let accepted = false;
    try{
      await persistCompose(text,epoch);
      if (lifecycle.current !== submittingLifecycle) return;
      const sent = await request('chat.send',{sessionId:session.id,text:value,...(images.length ? {images} : {}),operationId:token,leaseEpoch:epoch});
      if (lifecycle.current !== submittingLifecycle) return;
      accepted = true;
      setSubmissionPreview(undefined);
      clearMentions(); composerGeneration.current += 1;
      if (firstResponseWaitRef.current?.token === token) {
        const pending = { token, sessionUpdatedAt: session.updatedAt, turnId: sent.turnId };
        firstResponseWaitRef.current = pending;
        setFirstResponseWait(pending);
        if (hasVisibleAssistantResponse(itemsRef.current, sent.turnId)) clearFirstResponseWait(token);
      }
      changeText('');
      setImages([]); context.clear();
      try { localStorage.removeItem(imageDraftKey); } catch { /* The accepted message is already durable. */ }
      await persistCompose('',epoch);
    }catch(caught){
      if (lifecycle.current === submittingLifecycle) {
        setSubmissionPreview(undefined);
        if (accepted) {
          setDraftFailed(true);
          setDraftNotice(copy('Draft not saved', '草稿未保存'));
          setError(asUserError(caught, copy('Message sent, but the draft could not be cleared. Retry draft save.', '消息已发送，但草稿未能清空。请重试保存草稿。')));
        } else {
          clearFirstResponseWait(token);
          setError(asUserError(caught, copy('Message was not sent.', '消息未发送。')));
        }
      }
    }
    finally{if (lifecycle.current === submittingLifecycle) setBusy(false);}
  }
  function updateImages(next: string[]) {
    try {
      if (next.length) localStorage.setItem(imageDraftKey, JSON.stringify(validateChatImages(next)));
      else localStorage.removeItem(imageDraftKey);
      imagesRef.current=next; setImages(next); return true;
    } catch {
      setError(copy('Image draft could not be saved. Remove an image or free device storage and paste again.', '无法保存图片草稿。请移除图片或释放设备存储空间后重新粘贴。'));
      return false;
    }
  }
  // F3: attach files picked in the native dialog. Images use the composer's image
  // path when the agent accepts images; every other file becomes a context chip.
  async function attachPickedFiles() {
    if (!composerEditable(composerStateRef.current)) return;
    setError(undefined);
    const target = lifecycle.current;
    try {
      const picked = await attachFiles();
      if (lifecycle.current !== target || !picked.length) return;
      const canImages = Boolean(ui.inputCapabilities?.images);
      const idFor = () => `attach-${crypto.randomUUID()}`;
      const plan = partitionAttachedFiles(picked, imagesRef.current, canImages, idFor);
      if (plan.images.length) updateImages([...imagesRef.current, ...plan.images]);
      for (const item of plan.files) {
        try { context.attach(item); }
        catch (caught) { setError(contextError(caught, zh)); break; }
      }
      if (plan.imagesAsFiles > 0) {
        setError(copy(
          `${plan.imagesAsFiles} image${plan.imagesAsFiles === 1 ? '' : 's'} attached as a file because the image limit was reached.`,
          `由于达到图片数量或大小上限，${plan.imagesAsFiles} 张图片已作为文件附加。`,
        ));
      }
    } catch (caught) {
      if (lifecycle.current === target) setError(asUserError(caught, copy('Files could not be attached.', '无法附加文件。')));
    }
  }
  // F3: insert a snippet at the caret without replacing context chips. The
  // browser's own text insertion keeps the snippet on the native undo stack.
  function nativeEdit(start: number, end: number, insert: string) {
    return applyNativeEdit({
      area: composeRef.current,
      start,
      end,
      insert,
      blocked: composingRef.current,
      allowed: () => composerEditable(composerStateRef.current),
      apply: value => changeTextRef.current(value),
      execCommand: typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined,
      schedule: run => requestAnimationFrame(run),
    });
  }
  function insertSnippetAtCaret(snippet: string) {
    if (!composerEditable(composerStateRef.current)) return;
    const area = composeRef.current;
    const start = area?.selectionStart ?? currentText.current.length;
    const end = area?.selectionEnd ?? start;
    nativeEdit(start, end, snippet);
  }
  function insertQuickMessageAtCaret(message: import('@threadterm/protocol').QuickMessage) { insertSnippetAtCaret(message.text); }
  // M5: the highlight layer's marks with each wrapped fragment's client rect, so a
  // right-click can be hit-tested against the rendered badge instead of the caret.
  function liveMentionMarks(): MentionMark[] {
    const host = composeRef.current?.closest('.chat-compose-input');
    if (!host) return [];
    return Array.from(host.querySelectorAll<HTMLElement>('.chat-mention-badge[data-start]')).flatMap(node => {
      const start = Number(node.dataset.start), end = Number(node.dataset.end);
      const token = node.dataset.token;
      if (!Number.isInteger(start) || !Number.isInteger(end) || !token) return [];
      const rects = Array.from(node.getClientRects()).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
      return rects.length ? [{ start, end, token, itemId: node.dataset.id ?? '', rects }] : [];
    });
  }
  // M5: the client rects of the current selection, measured from the highlight
  // layer (which mirrors the textarea exactly) so a pointer inside the selection
  // is distinguishable from one on an unselected part of the same token.
  function selectionClientRects(start: number, end: number): MentionRect[] {
    if (start >= end) return [];
    const scroll = composeRef.current?.closest('.chat-compose-input')?.querySelector('.chat-compose-highlights-scroll');
    if (!scroll) return [];
    const walker = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let position = 0;
    let started = false;
    let ended = false;
    while (!ended) {
      const node = walker.nextNode();
      if (!node) break;
      const length = node.textContent?.length ?? 0;
      const nodeEnd = position + length;
      if (!started && start < nodeEnd && end > position) { range.setStart(node, Math.max(0, start - position)); started = true; }
      if (started && end <= nodeEnd) { range.setEnd(node, Math.min(length, end - position)); ended = true; }
      position = nodeEnd;
    }
    if (!started || !ended) return [];
    return Array.from(range.getClientRects()).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
  }
  // M5: Show details / Open file / Remove mention for a live token, revalidated when run.
  function mentionMenuItems(target: ResolvedMention): ContextMenuItem[] {
    const item = mentionCatalogueRef.current.find(entry => entry.token === target.token)?.item;
    if (!item) return [];
    const snapshot = mentionActionSnapshot(target, lifecycle.current);
    const valid = () => mentionActionStillValid(snapshot, { lifecycle: lifecycle.current, resolved: resolvedMentionsRef.current });
    const changed = copy('The mention changed before the action ran. Reopen the menu and try again.', '执行操作前提及已更改。请重新打开菜单后重试。');
    const directory = item.kind === 'file' && /[\\/]$/.test(item.path);
    const canOpen = item.kind === 'file' && !directory && Boolean(openFile);
    const openReason = canOpen ? undefined
      : directory ? copy('Folders cannot be opened as a file.', '文件夹无法作为文件打开。')
        : copy('This mention cannot be opened as a file.', '此提及无法作为文件打开。');
    return [
      { id: 'mention-details', label: copy('Show details', '查看详情'), testId: 'mention-action-details', onSelect: () => {
        if (!valid()) { setError(changed); return; }
        // The identity's block inside the merged composer context, so its `i/n`
        // numbering and data match the envelope the send path would build.
        const active = activeMentionEntries(mentionCatalogueRef.current, resolvedMentionsRef.current);
        const block = mentionSerializedBlock({ trayItems: contextRef.current.items, active, workspaceRoot: session.worktreePath }, snapshot.token);
        if (block === undefined) { setError(changed); return; }
        setMentionPreview(block);
      } },
      { id: 'mention-open-file', label: copy('Open file', '打开文件'), testId: 'mention-action-open-file', disabled: !canOpen, reason: openReason, onSelect: () => {
        if (!valid()) { setError(changed); return; }
        if (item.kind !== 'file' || directory || !openFile) return;
        openFile({ path: item.path, ...(item.startLine ? { line: item.startLine } : {}) });
      } },
      { id: 'mention-remove', label: copy('Remove mention', '移除提及'), testId: 'mention-action-remove', onSelect: () => {
        if (!valid()) { setError(changed); return; }
        deleteMention({ start: snapshot.start, end: snapshot.end });
      } },
      { id: 'mention-actions-end', label: '', separator: true },
    ];
  }
  function showComposerMenu(field: HTMLTextAreaElement, x: number, y: number, target?: ResolvedMention) {
    const items: ContextMenuItem[] = target ? mentionMenuItems(target) : [];
    items.push(...textFieldContextMenuItems(field));
    if (quickMessages.length) items.push({
      id: 'chat-quick-messages', label: copy('Quick messages', '快捷消息'),
      onSelect: () => showContextMenu({ x, y, restoreFocus: field, items: quickMessages.map(message => ({
        id: `chat-quick-message-${message.id}`, label: message.title, testId: 'context-quick-message',
        onSelect: () => insertQuickMessageAtCaret(message),
      })) }),
    });
    showContextMenu({ x, y, items, restoreFocus: field });
  }
  // F3/M5: the composer keeps its clipboard menu and gains mention actions when the pointer lands on a token.
  function openComposerContextMenu(event: ReactMouseEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    const field = event.currentTarget;
    const selectionStart = field.selectionStart ?? 0;
    const selectionEnd = field.selectionEnd ?? selectionStart;
    const target = pointerMentionTarget({
      resolved: resolvedMentionsRef.current,
      marks: liveMentionMarks(),
      selectionStart,
      selectionEnd,
      selectionRects: selectionClientRects(selectionStart, selectionEnd),
      x: event.clientX,
      y: event.clientY,
    });
    showComposerMenu(field, event.clientX, event.clientY, target);
  }
  // M5: Shift+F10 / the Menu key targets the resolved range at the caret or
  // selection. The event is always handled - a clipboard-only menu opens when no
  // mention is at the caret - so the global fallback never dispatches a synthetic
  // right-click near the textarea origin that could hit an unrelated token.
  function openComposerMenuFromKeyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    const area = event.currentTarget;
    const start = area.selectionStart ?? 0, end = area.selectionEnd ?? start;
    const target = start === end
      ? mentionAtCaret(resolvedMentionsRef.current, start)
      : mentionContainingSelection(resolvedMentionsRef.current, start, end);
    const rect = area.getBoundingClientRect();
    showComposerMenu(area, rect.left + Math.min(20, rect.width / 2), rect.top + Math.min(rect.height, 24), target);
  }
  attachImagesRef.current=(incoming:string[])=>{
    if(!composerEditable(composerStateRef.current)||imageReadingRef.current||!composeRef.current||composeRef.current.disabled) return 0;
    const accepted=selectChatImageAttachments(imagesRef.current,incoming,Boolean(ui.inputCapabilities?.images));
    if(!accepted.length) return 0;
    const next=[...imagesRef.current,...accepted];
    try {
      localStorage.setItem(imageDraftKey,JSON.stringify(validateChatImages(next)));
      imagesRef.current=next; setImages(next); return accepted.length;
    } catch {
      setError(copy('Image draft could not be saved. Screenshots are available by their file paths.', '无法保存图片草稿。截图可通过文件路径读取。')); return 0;
    }
  };
  const pageShots=usePageShotDraft({sessionId:session.id,images,contextItems:context.items,visible:()=>composerEditable(composerStateRef.current)&&Boolean(composeRef.current?.getClientRects().length),attachImages:incoming=>attachImagesRef.current(incoming),updateImages,attachContext:item=>contextRef.current.attach(item),removeContext:id=>contextRef.current.remove(id),onIssue:setError});
  async function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (!files.length || !ui.inputCapabilities?.images) return;
    event.preventDefault();
    if (!composerEditable(composerStateRef.current) || imageReadingRef.current) return;
    const target = lifecycle.current;
    imageReadingRef.current = true; setImageReading(true); setError(undefined);
    try {
      const pasted = await Promise.all(files.map(readClipboardImage));
      if (lifecycle.current !== target) return;
      const next = validateChatImages([...images, ...pasted]);
      updateImages(next);
    } catch (caught) {
      if (lifecycle.current === target) setError(asUserError(caught, copy('Image was not pasted.', '图片未能粘贴。')));
    } finally { imageReadingRef.current = false; setImageReading(false); }
  }
  async function approval(turnId:string,approvalId:string,choiceId:string){
    if(items.some(item=>item.turnId===turnId&&item.parts.some(part=>part.approvalId===approvalId&&isBrowserEvalApproval(part))))return;
    const epoch=leaseSessionId.current===session.id?lease.current:undefined;
    if(!writable||epoch===undefined)return;
    const key=`${approvalId}:${choiceId}`;
    if(approvalBusy)return;
    setApprovalBusy(key);
    try{
      await request("chat.approve",{sessionId:session.id,turnId,approvalId,choiceId,leaseEpoch:epoch,operationId:operationId()});
    }catch(caught){
      setError(asUserError(caught,copy("Approval was not recorded.","审批未能记录。")));
    }finally{
      setApprovalBusy(current=>current===key?undefined:current);
    }
  }
  async function cancel(turnId:string){const epoch=leaseSessionId.current===session.id?lease.current:undefined;if(!writable||epoch===undefined)return;const pending=firstResponseWaitRef.current;if(pending?.turnId===turnId)clearFirstResponseWait(pending.token);try{await request("chat.cancel",{sessionId:session.id,turnId,leaseEpoch:epoch})}catch(caught){setError(caught instanceof Error?caught.message:"Cancellation failed.")}}
  async function insertIntoTurn(queued?: { text: string; images?: string[]; id?: string }) {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    const turnId = activeTurnId(itemsRef.current, session.status);
    const refused = () => { throw new Error(copy('Message was not inserted.', '消息未能插入。')); };
    if (!writable || epoch === undefined || !turnId || busy || (!queued && !composerEditable(composerStateRef.current))) { if (queued) refused(); return; }
    let value = queued?.text ?? '';
    if (!queued) {
      try { value = serializeSubmission(text.trim()); } catch (caught) { setError(contextError(caught, zh)); return; }
    }
    const attachment = queued ? queued.images ?? [] : images;
    if ((!value && !attachment.length) || imageReading) { if (queued) refused(); return; }
    pickTicket.current = undefined;
    const submittingLifecycle = lifecycle.current;
    setBusy(true); setError(undefined);
    try {
      if (!queued) await persistCompose(text, epoch);
      if (lifecycle.current !== submittingLifecycle) return;
      await request('chat.steer', {
        sessionId: session.id, turnId, text: value,
        ...(attachment.length ? { images: attachment } : {}),
        ...(queued?.id ? { queueItemId: queued.id } : {}),
        operationId: operationId(), leaseEpoch: epoch,
      });
      if (lifecycle.current !== submittingLifecycle || queued) return;
      clearMentions(); composerGeneration.current += 1;
      changeText(''); setImages([]); context.clear();
      try { localStorage.removeItem(imageDraftKey); } catch { /* The accepted insert is already durable. */ }
      await persistCompose('', epoch);
    } catch (caught) {
      const message = steerFailureMessage(caught, copy);
      if (lifecycle.current === submittingLifecycle) setError(message);
      // The queue row deletes itself only after this promise resolves. A
      // rejection leaves the item for the server snapshot to restore or fail.
      if (queued) throw new Error(message);
    } finally { if (lifecycle.current === submittingLifecycle) setBusy(false); }
  }
  /** E2: the agent reads a note on its next `feedback_check`. The note carries
   * the same serialized context the send path uses, inside the store's cap. */
  async function addNote() {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    const turnId = activeTurnId(itemsRef.current, session.status);
    if (!writable || epoch === undefined || !turnId || busy || !composerEditable(composerStateRef.current)) return;
    let value: string;
    try { value = serializeSubmission(text.trim()); } catch (caught) { setError(contextError(caught, zh)); return; }
    if (!value.trim()) return;
    if (!noteBodyFits(value)) { setError(copy('The note and its attached context must not exceed 4,000 characters.', '备注及其附加上下文不能超过 4,000 个字符。')); return; }
    pickTicket.current = undefined;
    const submittingLifecycle = lifecycle.current;
    setBusy(true); setError(undefined);
    try {
      await request('chat.feedback.add', { sessionId: session.id, turnId, text: value, operationId: operationId(), leaseEpoch: epoch });
      if (lifecycle.current !== submittingLifecycle) return;
      clearMentions(); composerGeneration.current += 1;
      changeText(''); context.clear();
      await persistCompose('', epoch);
    } catch (caught) {
      if (lifecycle.current === submittingLifecycle) setError(asUserError(caught, copy('The note was not sent.', '备注未能发送。')));
    } finally { if (lifecycle.current === submittingLifecycle) setBusy(false); }
  }
  /** E2: a queued prompt becomes a note, and only then leaves the queue. Its
   * serialized context is already part of the queue text, so it is preserved. */
  async function sendNoteFromQueue(item: ChatQueueItem): Promise<ChatQueue> {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    const turnId = activeTurnId(itemsRef.current, session.status);
    if (!writable || epoch === undefined || !turnId) throw new Error(copy('The queued prompt was not sent as a note.', '队列提示未能作为备注发送。'));
    if (!noteBodyFits(item.text)) throw new Error(copy('The note and its attached context must not exceed 4,000 characters.', '备注及其附加上下文不能超过 4,000 个字符。'));
    await request('chat.feedback.add', { sessionId: session.id, turnId, text: item.text, operationId: operationId(), leaseEpoch: epoch });
    return await request('chat.queue.remove', { sessionId: session.id, itemId: item.id, operationId: operationId(), leaseEpoch: epoch });
  }
  async function answer(turnId: string, approvalId: string, response: ChatAnswerResponse) {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    if (!writable || epoch === undefined || approvalBusy) return;
    const key = `${approvalId}:${response.action}`;
    setApprovalBusy(key);
    try {
      await request("chat.answer", { sessionId: session.id, turnId, approvalId, response, leaseEpoch: epoch, operationId: operationId() });
      if (response.action === "request_changes") composeRef.current?.focus();
    } catch (caught) {
      setError(asUserError(caught, copy("Answer was not recorded.", "回答未能记录。")));
    } finally {
      setApprovalBusy(current => current === key ? undefined : current);
    }
  }
  async function setPiProjectTrust(decision: 'trusted'|'declined'|'none') {
    const epoch=leaseSessionId.current===session.id?lease.current:undefined;
    if(!writable||trustBusy||liveTurn||!session.projectId||epoch===undefined)return;
    setTrustBusy(true);
    try { setUi(await request('chat.projectTrust.set',{sessionId:session.id,decision,leaseEpoch:epoch,operationId:operationId()})); }
    catch(caught) { setError(asUserError(caught,copy('The trust decision or reconnection could not be completed. Review the connection before retrying.','信任决定或重新连接未完成，请检查连接后重试。'))); }
    finally { setTrustBusy(false); }
  }
  const liveTurn = ended ? undefined : activeTurnId(items, session.status);
  const liveSpeed = liveTurnSpeed(liveTurn, liveTurnUsage);
  const turnGroups = useMemo(() => groupCodexTranscript(items, session.provider === "codex"), [items, session.provider]);
  const speedGroupIndex = liveSpeed ? liveSpeedGroupIndex(turnGroups, liveTurnUsage?.turnId) : -1;
  const legacyHistoryReload = repair?.reason === 'history_metadata_missing' || (connectionHeld && repairDiscovery?.recovery === 'legacy');
  const repairOffered = Boolean(repair?.offered && !liveTurn);
  const repairDisabled = !repairOffered || !repairWritable || repairBusy;
  const repairDisabledReason = liveTurn || repair?.reason === 'busy'
    ? copy('Stop the current turn before repairing.', '请先停止当前回合，再修复。')
    : !repairWritable ? copy('Take control of this chat to repair it.', '请先取得此对话的控制权，再修复。')
    : repair?.reason === 'unknown_activity' ? copy('Stop the session before repairing its history.', '请先停止会话，再修复历史。')
    : repair?.reason === 'history_unavailable' ? copy("This agent's saved history can't be read.", '无法读取此代理保存的历史。')
    : undefined;
  const beginRepair = () => { if (!repairDisabled) setRepairDialog(true); };
  async function confirmRepair() {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    if (!repairOffered || !repairWritable || epoch === undefined || repairBusy) return;
    const repairLifecycle = lifecycle.current;
    setRepairBusy(true); setRepairNotice(undefined);
    try {
      const result = await request('chat.repair', { sessionId: session.id, leaseEpoch: epoch, operationId: operationId() });
      if (lifecycle.current !== repairLifecycle) return;
      // The reply is a committed receipt. Resync also when its outbox event was
      // missed; only the resulting canonical snapshot can release connection.
      discoverHistoryRef.current();
      setRepairNotice(result.added === 0 && result.updated === 0 && result.removed === 0
        ? { kind: 'unchanged' } : { kind: 'rebuilt', total: result.total });
      setRepairDialog(false); if (ingressFailed) setRepairFollowup(true);
    } catch (caught) {
      if (lifecycle.current !== repairLifecycle) return;
      const message = String(caught);
      setRepairNotice({ kind: message.includes('chat_repair_superseded') ? 'superseded' : 'failed' });
    } finally { if (lifecycle.current === repairLifecycle) setRepairBusy(false); }
  }
  const queueMode = queueComposerMode(Boolean(liveTurn), queue);
  const steerKind = steerControlKind(Boolean(liveTurn), ui.inputCapabilities?.steer, queueMode);
  const resolutionReady = draftLoaded && recovery === undefined;
  const resolvedMentions = useMemo(() => resolutionReady ? resolveMentions(text, mentionCatalogue) : [], [resolutionReady, text, mentionCatalogue]);
  resolvedMentionsRef.current = resolvedMentions;
  const activeMentions = useMemo(() => activeMentionEntries(mentionCatalogue, resolvedMentions), [mentionCatalogue, resolvedMentions]);
  const rawMention = mentionQuery(text, caret);
  const mention = composerEditableNow && rawMention && rawMention.start !== mentionDismissed && !resolvedMentions.some(range => range.start <= caret && caret <= range.end) ? rawMention : undefined;
  const mentionKey = mentionLoadKey(session.projectId, session.worktreePath);
  useEffect(() => {
    // Reload on every closed->open transition and on a session, project or
    // worktree change. A ticket generation drops a late response after an await
    // so it cannot overwrite newer data (no timers or polling).
    const loadState = beginMentionLoad(mentionLoadRef.current, mention !== undefined, mentionKey);
    mentionLoadRef.current = loadState;
    const ticket = loadState.ticket;
    if (!ticket) return;
    let disposed = false;
    setMentionData(current => current.key === ticket.key ? current : { key: ticket.key });
    const project = { projectId: session.projectId ?? '', worktreePath: session.worktreePath };
    void Promise.all([
      request("filesystem.files", project).then(result => result.paths).catch(() => undefined),
      request("git.log", { ...project, limit: 50 }).then(result => result.commits).catch(() => undefined),
    ]).then(([files, commits]) => {
      if (disposed || !mentionLoadCurrent(ticket, mentionLoadRef.current)) return;
      setMentionData({ key: ticket.key, files: files ?? undefined, commits: commits ?? undefined });
    });
    return () => { disposed = true; };
  }, [mention !== undefined, mentionKey, session.id]);
  const mentionSourceItems = useMemo<MentionSources>(() => {
    const sources: MentionSources = {};
    const fresh = mentionData.key === mentionKey ? mentionData : {};
    if (fresh.files) sources.files = fileMentionItems(fresh.files);
    if (fresh.commits) sources.commits = commitMentionItems(fresh.commits);
    const otherSessions = sessionMentionItems(sessions, session.id, session.projectId);
    if (otherSessions.length) sources.sessions = otherSessions;
    if (delegationEnabled) {
      const agents = agentMentionItems(capabilities, session.provider);
      if (agents.length) sources.agents = agents;
    }
    const skills = skillMentionItems(ui.skills ?? []);
    if (skills.length) sources.skills = skills;
    return sources;
  }, [mentionData, mentionKey, sessions, session.id, session.projectId, session.provider, delegationEnabled, capabilities, ui.skills]);
  const mentionGroups = useMemo(() => mention ? buildMentionGroups(mentionSourceItems, mention.query) : [], [mention?.query, mentionSourceItems]);
  const slash = composerEditableNow ? slashQuery(text) : undefined;
  const slashCommands = useMemo(() => {
    const commands: ChatSlashCommand[] = [...ui.commands];
    if (liveTurn && !commands.some(command => command.name === "stop")) commands.unshift({ name: "stop", description: copy("Stop this turn", "停止此轮") });
    return slash === undefined ? [] : matchSlashCommands(slash, commands);
  }, [zh, liveTurn, slash, ui.commands]);
  async function setOption(optionId: string, value: string) {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    if (!writable || epoch === undefined) return;
    try {
      setUi(await request("chat.option.set", { sessionId: session.id, optionId, value, leaseEpoch: epoch, operationId: operationId() }));
    } catch (caught) { setError(asUserError(caught, copy("Option was not updated.", "未能更新选项。"))); }
  }
  useEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text, submissionPreview]);
  useEffect(() => {
    const el = logRef.current;
    if (el && viewport.followRef.current) el.scrollTop = el.scrollHeight;
  }, [items, text, firstResponseWait]);
  function applySlash(command: ChatSlashCommand) {
    if (!composerEditable(composerStateRef.current)) return;
    if (command.name === "stop" && liveTurn) { void cancel(liveTurn); changeText(""); return; }
    if(command.name.replace(/^\//,'')==='fork'){
      if(forkActions.disabledReason)setError(forkActions.disabledReason);
      else {
        const captured=text;
        void forkActions.fork().then(child=>{
          if(!child)return;
          const remaining=composerTextAfterFork(currentText.current,captured);
          if(remaining!==currentText.current)changeText(remaining);
        });
      }
      return;
    }
    changeText(`/${command.name.replace(/^\//, "")} `);
    composeRef.current?.focus();
  }
  function applyMention(pick: MentionItem) {
    // Every pick cancels an outstanding async session pick, including a newer
    // synchronous pick and a pick this method then rejects (design §6.4).
    pickTicket.current = undefined;
    const range = mention;
    if (!range || composingRef.current || !composerEditable(composerStateRef.current)) return;
    const item = pick.item;
    if (item.kind !== 'file' && item.kind !== 'session' && item.kind !== 'commit' && item.kind !== 'agent' && item.kind !== 'skill') return;
    setMentionIndex(0); setMentionDismissed(undefined);
    const sessionItem: SessionContextItem | undefined = item.kind === 'session' ? item : undefined;
    if (sessionItem && !sessionInfoEnabled) {
      // The session-info tool is off: read a bounded inline summary first.
      // Nothing is inserted until the read resolves and the ticket still holds.
      const ticket: MentionPickTicket = {
        id: ++pickTicketId.current,
        lifecycle: lifecycle.current,
        sessionId: lifecycle.current?.sessionId,
        composerGeneration: composerGeneration.current,
        start: range.start,
        end: range.end,
        queryText: currentText.current.slice(range.start, range.end),
      };
      pickTicket.current = ticket;
      void request('chat.read', { sessionId: sessionItem.sessionId })
        .then(items => {
          if (pickTicket.current?.id !== ticket.id) return;
          const stillValid = mentionPickStillValid(ticket, {
            lifecycle: lifecycle.current,
            sessionId: lifecycle.current?.sessionId,
            composerGeneration: composerGeneration.current,
            text: currentText.current,
            composing: composingRef.current,
            editable: composerEditable(composerStateRef.current),
          });
          if (!stillValid) { setError(copy('The mention was not added because the draft changed.', '草稿已更改，未添加提及。')); return; }
          const item = sessionContextItem(sessionItem, items, false);
          // Without the tool and without a transcript there is nothing to
          // reference, and the header must never promise a call that is off.
          if (!item.summary) { pickTicket.current = undefined; setError(copy('This session has no readable transcript to attach.', '此会话没有可附加的对话记录。')); return; }
          pickTicket.current = undefined;
          commitMention(item, { start: ticket.start, end: ticket.end });
        })
        .catch(caught => {
          if (pickTicket.current?.id !== ticket.id) return;
          pickTicket.current = undefined;
          setError(asUserError(caught, copy('Session context could not be attached.', '无法附加会话上下文。')));
        });
      return;
    }
    commitMention(item, range);
  }
  /** Reserves the identity and inserts its token without leaving a tray chip. */
  function commitMention(item: MentionableItem, range: { start: number; end: number }) {
    // Re-read the live permissions: this is also reached from a resolved async
    // session read, whose closure captured an older render.
    if (!composerEditable(composerStateRef.current) || composingRef.current) return;
    const added = addMentionEntry(mentionCatalogueRef.current, item, session.worktreePath);
    if ('error' in added) { setError(contextError(new Error(MAX_MENTION_MESSAGE), zh)); return; }
    const nextText = mentionInsertedText(currentText.current, range, added.token);
    const tentative = tentativeMentionPick({ text: nextText, trayItems: contextRef.current.items, catalogue: added.catalogue, workspaceRoot: session.worktreePath });
    if (!tentative.ok) { setError(contextError(tentative.error, zh)); return; }
    mentionCatalogueRef.current = added.catalogue;
    setMentionCatalogue(added.catalogue);
    nativeEdit(range.start, range.end, `${added.token} `);
  }
  function deleteMention(range: { start: number; end: number }) {
    nativeEdit(range.start, range.end, '');
  }
  function onComposeKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current;
    if (!composing && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      openComposerMenuFromKeyboard(event); event.preventDefault(); return;
    }
    if (!composing && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'Backspace' || event.key === 'Delete')) {
      const area = event.currentTarget;
      const position = area.selectionStart ?? caret;
      if (area.selectionStart === area.selectionEnd) {
        const hit = deletionRange(resolvedMentions, position, event.key);
        if (hit) { event.preventDefault(); deleteMention(hit); return; }
      }
    }
    if (mention) {
      const action = mentionKeyAction(event.key, { count: mentionGroups.length ? flatMentionItems(mentionGroups).length : 0, composing, shiftKey: event.shiftKey });
      if (action === "next") { event.preventDefault(); setMentionIndex(value => Math.min(value + 1, flatMentionItems(mentionGroups).length - 1)); return; }
      if (action === "previous") { event.preventDefault(); setMentionIndex(value => Math.max(0, value - 1)); return; }
      if (action === "pick") { event.preventDefault(); const flat = flatMentionItems(mentionGroups); const pick = flat[mentionIndex] ?? flat[0]; if (pick) applyMention(pick); return; }
      if (action === "close") { event.preventDefault(); setMentionDismissed(mention.start); return; }
    }
    if (slash !== undefined && slashCommands.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSlashIndex(value => Math.min(value + 1, slashCommands.length - 1)); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSlashIndex(value => Math.max(0, value - 1)); return; }
      if (slashPaletteEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); applySlash(slashCommands[slashIndex] ?? slashCommands[0]!); return; }
      if (event.key === "Escape") { event.preventDefault(); changeText(""); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !composing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }
  const usageCards = useMemo(() => usageCardsForItems(session.provider, items), [session.provider, items]);
  const replyActions = useMemo(() => replyActionMarkdown(items, session.status), [items, session.status]);
  function copyCodeBlock(event: ReactMouseEvent<HTMLElement>) {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-copy-code]') : null;
    if (!button || !event.currentTarget.contains(button)) return;
    const block = button.closest('.md-code-block');
    const code = block?.querySelector('code') ?? block?.querySelector('pre');
    const value = code?.textContent ?? '';
    if (!value) return;
    void navigator.clipboard.writeText(value).then(() => {
      if (button.dataset.copying === 'true') return;
      button.dataset.copying = 'true';
      button.textContent = zhRef.current ? '已复制' : 'Copied';
      window.setTimeout(() => { button.textContent = zhRef.current ? '复制' : 'Copy'; delete button.dataset.copying; }, 1500);
    }).catch(() => undefined);
  }
  function renderItem(item: ChatItem, nested = false, replyEligible = true) {
      if (!item.parts.length) return null;
      if (!nested && item.parts.some(isSubagentPart)) {
        const lastReplyIndex = item.parts.reduce((last, part, index) => isReplyTextPart(part) ? index : last, -1);
        return <Fragment key={item.id}>
        {item.parts.map((part, index) => {
          if (!isSubagentPart(part)) return <Fragment key={`part-${index}`}>{renderItem({ ...item, parts: [part] }, false, index === lastReplyIndex)}</Fragment>;
          const info = subagentInfo(part);
          return info ? <SubagentCard key={`${session.id}:${info.key}`} sessionId={session.id} info={info} copy={copy} zh={zh} renderItem={renderItem} openFile={openFile} /> : null;
        })}
      </Fragment>;
      }
      const usage = nested ? undefined : usageCards.get(item.id);
      if (usage) return <article className={`v3-chat-message assistant is-native is-${session.provider} is-usage`} key={item.id}><UsageCard model={usage} zh={zh} /></article>;
      const live = itemShowsStreaming(item, items);
      const replyText = item.role === 'assistant' && !nested && replyEligible && item.parts.some(isReplyTextPart) ? replyActions.get(item.id) ?? '' : '';
      const showReplyActions = !!replyText;
      return <article data-chat-item={item.id} className={`v3-chat-message ${item.role} is-native is-${session.provider}${showReplyActions ? ' has-reply-actions' : ''}`} key={item.id} onClick={copyCodeBlock}>
      {item.parts.filter(part => shouldRenderPart(part) || (Array.isArray(asRecord(part.data).images) && (asRecord(part.data).images as unknown[]).some(isChatImage))).map((part, index) => {
        if (isSubagentPart(part)) {
          const info = subagentInfo(part);
          return <p className="chat-subagent-nested" key={`subagent-${index}`}>{info ? subagentTitle(info, copy) : copy('Subagent', '子代理')}</p>;
        }
        if (part.type === "thinking") return <ThinkingPart key={`thinking-${index}`} part={part} streaming={live && part.status === "streaming"} copy={copy} openFile={openFile} />;
        if (part.type === 'status' && providerRetryPresentation(part.data)) return <ProviderRetryStatus key={`retry-${index}`} data={part.data} copy={copy} />;
        if (part.type === "status") return <CodexStatusCard key={`status-${index}`} part={part} copy={copy} />;
        if (part.type === "text" && asRecord(part.data).kind === "plan") return <PlanUsageCard key={`usage-${index}`} part={part} zh={zh} copy={copy} />;
        if (part.type === "text" && (session.provider === "kimi" || session.provider === "grok") && item.role !== "user" && typeof part.text === "string") {
          const statusRows = parseKimiStatus(part.text);
          if (statusRows) return <KimiStatusCard key={`kstatus-${index}`} rows={statusRows} zh={zh} copy={copy} />;
        }
        // A question can paint before chat.send settles. The composer busy flag
        // must not disable that card, or Dismiss enables under the pointer.
        if (part.type === "approval") return <div className={`chat-part approval v3-tool-card ${part.status ?? ""}`} key={`${part.type}-${index}`}>
          <ChatApprovalCard part={part} writable={writable} browserEvalContext={{sessionId:session.id,turnId:item.turnId??'',leaseEpoch:leaseSessionId.current===session.id?lease.current??0:0,generation:`${connection.runtimeEpoch??''}:${connection.connectionGeneration}:${link.transportGeneration}`,writable:!nested&&item.turnOrigin!=='history'&&writable,live:!nested&&item.turnOrigin!=='history'&&item.turnId!==undefined&&item.turnId===liveTurn}} submitting={approvalBusy?.startsWith(`${part.approvalId ?? ""}:`) ? approvalBusy.slice((part.approvalId ?? "").length + 1) : undefined} onChoose={choiceId => { if (item.turnId && part.approvalId) void approval(item.turnId, part.approvalId, choiceId); }} onAnswer={response => { if (item.turnId && part.approvalId) void answer(item.turnId, part.approvalId, response); }} onPlanResponse={response => { if (item.turnId && part.approvalId) void answer(item.turnId, part.approvalId, response); }} copy={copy} />
        </div>;
        const label = partLabel(part, copy);
        const redactedBrowser=hasRedactedBrowserResult(part);
        const localizedText = asRecord(asRecord(part.data).localizedText);
        const body = redactedBrowser?partBody(part):asString(localizedText[zh ? "zh-CN" : "en"], partBody(part));
        const partImages = asRecord(part.data).images;
        const messageImages = !redactedBrowser&&Array.isArray(partImages) ? partImages.filter(isChatImage) : [];
        const foldedTool = part.type === "tool";
        const codexMarkdown = item.role !== "user" && part.type === "text";
        return <div className={`chat-part ${part.type}${part.type === 'tool' ? ` v3-tool-card ${part.status ?? ''}` : ''}`} key={`${part.type}-${index}`}>
          {!!messageImages.length && <div className="chat-message-images">{messageImages.map((image, imageIndex) => <img key={imageIndex} src={image} alt={`${copy('Pasted image', '已粘贴图片')} ${imageIndex + 1}`} loading="lazy" />)}</div>}
          {foldedTool ? <CodexToolPart part={part} copy={copy} openFile={openFile} /> : <>
            {label && <strong>{label}</strong>}
            {body ? codexMarkdown
              ? <ChatMarkdown sanitizedHtml={renderCodexMarkdown(body, zh)} references={part.fileReferences} openFile={openFile} copy={copy} onInsert={writable ? text => insertChatText(session.id, text) : undefined} />
              : item.role === 'user' ? <><ContextMessage text={body} zh={zh}>{(value, badges) => <div className="v3-message-text"><MessageMentionText text={value} badges={badges} openFile={openFile} zh={zh} /></div>}</ContextMessage>{asRecord(part.data).steered === true && <span className="chip is-plain chat-inserted-tag" data-testid="inserted-tag">{copy('Inserted', '已插入')}</span>}</> : <div className="v3-message-text"><FileLinkedText text={body} openFile={openFile} /></div>
              : null}
            {!codexMarkdown && <FileReferenceChips references={redactedBrowser?undefined:part.fileReferences} visibleText={body} openFile={openFile} />}
          </>}
          {part.status && !foldedTool && part.type !== 'text' && part.status !== 'complete' && part.status !== 'streaming' && <small>{part.status}</small>}
        </div>;
      })}
      {showReplyActions && <MessageActions markdown={replyText} copy={copy}>{isCompletedForkReply(item, items) && <ChatForkButton itemId={item.id} disabledReason={forkActions.disabledReason} busy={forkActions.busy} onFork={id => void forkActions.fork(id)} zh={zh}/>}</MessageActions>}
    </article>;
  }
  function renderTurn(group: CodexTurn, groupIndex: number) {
    // Display activity follows runtime liveness even in a read-only observer;
    // it is independent of whether this window owns the control lease.
    const displayTurn = activeTurnId(items, session.status);
    const active = group.items.some(item => item.turnId && item.turnId === displayTurn);
    const awaitingApproval = active && session.status === 'waiting' && group.items.some(item => item.parts.some(part => part.type === 'approval' && part.status === 'pending'));
    const awaitingQuestion = awaitingApproval && group.items.some(item => item.parts.some(part => part.type === 'approval' && part.status === 'pending' && asRecord(part.data).interaction === 'question'));
    const drawer = (entries: ToolActivityEntry[], id = `${group.id}-tools`) => <ToolActivity key={id} entries={entries} onInspect={viewport.pauseForNavigation} active={active} awaitingApproval={awaitingApproval} awaitingQuestion={awaitingQuestion} provider={session.provider} copy={copy} openFile={openFile} openDiff={openDiff} canOpenDiff={canOpenDiff} sessionCwd={session.worktreePath} />;
    if (!group.settled) {
      // Subagents are chronology boundaries, while intervening parent text keeps
      // the existing single-drawer policy. Preserve the first drawer's turn key.
      const segments: ChatItem[][] = [[]];
      for (const item of group.response) {
        segments[segments.length - 1]!.push(item);
        if (item.parts.some(isSubagentPart)) segments.push([]);
      }
      let drawerIndex = 0;
      const visible = segments.flatMap(rows => groupToolActivity(rows)).map(entry => entry.type === 'tools'
        ? drawer(entry.tools, drawerIndex++ ? `${group.id}-tools-${drawerIndex}` : `${group.id}-tools`)
        : <Fragment key={entry.item.parts.some(isSubagentPart) ? `${entry.item.id}-subagent` : entry.id}>{renderItem(entry.item)}</Fragment>);
      if (group.turnStatus && !group.items.some(item => item.parts.some(shouldRenderPart))) {
        visible.push(<p className="chat-duration" key={`${group.id}-status`}>{group.turnStatus === 'inProgress'
          ? copy('Saved turn: in progress', '保存的回合：进行中') : copy('Saved turn: status unknown', '保存的回合：状态未知')}</p>);
      }
      if (liveSpeed && groupIndex === speedGroupIndex) visible.push(<p className="chat-turn-speed-live" key={`${group.id}-turn-speed`} data-testid="turn-speed-live" data-estimated={String(liveSpeed.estimated)} data-tokens-per-second={String(liveSpeed.tokensPerSecond)} title={turnSpeedTooltip(liveSpeed, zh)}>{turnSpeedText(liveSpeed)}</p>);
      return visible;
    }
    const tools = toolEntriesForItems(group.items);
    const { activity, subagents, response } = completedTurnPresentation(group.activity, group.response);
    const outcome = group.turnStatus === 'failed' ? copy('Turn failed', '回合失败') : group.turnStatus === 'interrupted' ? copy('Turn interrupted', '回合已中断') : undefined;
    const summary = group.elapsedMs == null ? (activity.length ? copy('Activity','过程') : outcome ?? copy('Completed','已完成')) : formatChatDuration(group.elapsedMs, zh);
    return [
      outcome && (activity.length || group.elapsedMs != null) && !group.items.some(item => item.parts.some(part => part.type === 'error'))
        ? <p className="chat-duration" key={`${group.id}-status`}>{outcome}</p> : null,
      !group.response.some(item => usageCards.has(item.id)) && (activity.length ? <details className="codex-work" key={`${group.id}-work`}>
        <summary><span className="codex-work-label">{summary}<Icon name="chevR" /></span></summary>
        <div className="codex-work-body">{activity.length ? activity.map(item => renderItem(item)) : <p className="dim">{copy('No additional activity recorded.', '没有记录额外的过程。')}</p>}</div>
      </details> : null),
      tools.length ? drawer(tools) : null,
      ...subagents.map(item => <Fragment key={`${item.id}-subagent`}>{renderItem(item)}</Fragment>),
      ...response.map(item => <Fragment key={item.parts.some(isSubagentPart) ? `${item.id}-subagent` : `${item.id}-response`}>{renderItem(item)}</Fragment>),
      group.items.some(item => item.role !== 'user' && item.role !== 'system') && <TurnFooter key={`${group.id}-footer`} items={group.items} elapsedMs={group.elapsedMs} session={session} zh={zh} copy={copy} cache={turnChangesCache} openFile={openFile} />,
    ];
  }
  return <FileReferenceScopeProvider sourceSessionId={session.id} canonicalRoot={session.worktreePath}><section className={`chat-view v3-session-chat${overlay === "full" ? " is-connecting" : ""}`} data-provider={session.provider} data-testid={`session-chat-${session.id}`} aria-label={copy('Structured chat', '图形聊天')}>
    <ChatForkMenu disabledReason={forkActions.disabledReason} busy={forkActions.busy} onFork={id => void forkActions.fork(id)} zh={zh}/>
    <ChatForkStatus session={session} zh={zh} onOpenSession={onOpenSession}/>
    {ended && <p className="chat-history-note" role="note">{copy('Session ended · history is read-only.', '会话已结束 · 历史记录只读。')}</p>}
    <DelegationPanel session={session} delegates={delegates} delegatedBy={delegatedBy} onOpenSession={onOpenSession} copy={copy} zh={zh} />
    {(connectionHeld || ((repair?.degraded || legacyHistoryReload) && !liveTurn && repair?.reason !== 'busy')) && <section className="chat-repair-banner" role="status" aria-label={legacyHistoryReload ? copy('Reload saved history', '重新加载已保存的历史') : copy('Chat history may be incomplete', '对话记录可能不完整')}>
      <div><strong>{legacyHistoryReload ? copy('Reload saved history', '重新加载已保存的历史') : copy('Chat history may be incomplete', '对话记录可能不完整')}</strong><p>{legacyHistoryReload ? copy('This older import is missing turn grouping. Reload saved history to restore its presentation; a backup is kept.', '此旧版导入记录缺少回合分组。可重新加载已保存的历史以恢复显示，当前记录会保留备份。') : copy("Some chat updates could not be saved. Repair from the agent's native history when the turn has stopped.", '部分对话更新未能保存。回合停止后，可从代理的原生历史修复。') }</p>{repair?.diagnostic && !legacyHistoryReload && <small>{repair.diagnostic}</small>}</div>
      <button type="button" className="btn" disabled={repairDisabled} title={repairDisabledReason} onClick={beginRepair}>{legacyHistoryReload ? copy('Reload native history', '重新加载原生历史') : copy('Repair from native history', '从原生历史修复')}</button>
      {connectionHeld && canControl && !ended && <button type="button" className="btn" disabled={repairBusy} onClick={continueWithoutReload}>{copy('Continue chat without reloading', '不重新加载，继续聊天')}</button>}
    </section>}
    {repairFollowup && <p className="chat-repair-notice" role="status">{copy('History repaired. Queued prompts stay paused until ThreadTerm restarts.', '历史已修复。排队的提示词将保持暂停，直到 ThreadTerm 重启。')}</p>}
    {overlay === "banner" && <ChatConnectOverlay provider={session.provider} phase={connection.phase} slow={false} error={connection.error} variant="banner" onRetry={retryConnection} copy={copy} transportDown={link.transport !== "up"} />}
    <PiProjectTrust trust={ui.piTrust} disabled={!writable || trustBusy || Boolean(liveTurn) || !session.projectId} disabledReason={!session.projectId ? copy('Add this session to a project before changing project trust.', '请先将此会话加入项目，再更改项目信任。') : undefined} onDecide={setPiProjectTrust} copy={copy} />
    {ui.loadState === "error" && ui.error && <p className="surface-error" role="alert">{ui.error.message} <button type="button" className="btn" disabled={!writable} onClick={() => void request("chat.options", { sessionId: session.id }).then(setUi).catch(caught => setUi(current => ({ ...current, loadState: "error", error: { code: "options_failed", message: asUserError(caught, copy("Options could not be loaded.", "无法读取选项。")) } })))}>{copy("Retry options", "重试读取选项")}</button></p>}
    {historyFailed && <section className="chat-repair-banner" role="alert"><div><strong>{copy('Saved history could not be checked.', '无法检查已保存的历史。')}</strong><p>{copy('Retry loading saved history before continuing this chat.', '请重试加载已保存的历史，再继续聊天。')}</p>{historyIssue && <small>{historyIssue}</small>}</div><button className="btn" disabled={repairBusy} onClick={() => discoverHistoryRef.current()}>{copy('Retry loading history', '重试加载历史')}</button></section>}
    {linkIssue && <p className="surface-error" role="alert">{linkIssue}</p>}
    <BackgroundTasksStrip key={session.id} tasks={ui.backgroundTasks ?? []} copy={copy} zh={zh} writable={writable && !ended} onExpand={refreshBackgroundTasks} onStop={stopBackgroundTask} canOutput={task => backgroundHasOutput(task, items)} onOutput={task => { if (logRef.current) revealBackgroundOutput(logRef.current, task, viewport.pauseForNavigation); }} />
    {linkMenu && <CatalogPopover anchor={linkMenu.anchor} label={copy("Link", "链接")} onClose={() => setLinkMenu(undefined)}>
      <div className="menu-label chat-link-menu-url" title={linkMenu.url}>{linkMenu.url}</div>
      {surface?.openWeb && <button type="button" role="menuitem" className="menu-item" onClick={() => { surface.openWeb?.(linkMenu.url); setLinkMenu(undefined); }}><Icon name="split" />{copy("Open in preview", "在预览中打开")}</button>}
      <button type="button" role="menuitem" className="menu-item" onClick={() => { const url = linkMenu.url; setLinkMenu(undefined); void openExternal(url).catch(error => setLinkIssue(String(error))); }}><Icon name="popout" />{copy("Open in browser", "在浏览器中打开")}</button>
      <button type="button" role="menuitem" className="menu-item" onClick={() => { const url = linkMenu.url; setLinkMenu(undefined); void navigator.clipboard.writeText(url).catch(error => setLinkIssue(String(error))); }}><Icon name="export" />{copy("Copy link", "复制链接")}</button>
    </CatalogPopover>}
    <SelectionBubble rootRef={logRef} visible={surface?.focused !== false && overlay !== 'full'} copy={copy} quoteEnabled={writable} askEnabled={!!onOpenSession} onQuote={text => insertChatText(session.id, quoteSelection(text))} onAsk={(text, current) => askSelectionChat(session, text, current, id => onOpenSession?.(id))} />
    <div className="chat-log-shell" onKeyDown={viewport.onKeyDown}>
    <div className="chat-scroll v3-chat-log" data-chat-log={session.id} ref={logRef} tabIndex={0} aria-label={copy('Chat transcript', '聊天记录')} inert={overlay === "full" || undefined} onClickCapture={viewport.pauseForDisclosure} onFocusCapture={viewport.onFocus} onWheelCapture={viewport.onWheel} onTouchStartCapture={viewport.onTouchStart} onTouchMoveCapture={viewport.onTouchMove} onMouseDownCapture={viewport.onPointerDown} onClick={event => {
      // Links never navigate the app window (the desktop blocks that, so they used to do nothing).
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || !event.currentTarget.contains(anchor)) return;
      event.preventDefault();
      const url = anchor.getAttribute('href') ?? '';
      if (isWebTabUrl(url)) { setLinkIssue(undefined); setLinkMenu({ anchor, url }); }
    }} onScroll={viewport.onScroll}><ChatPlanPanel items={items} copy={copy} liveTurnId={activeTurnId(items, session.status)} historyReady={historyLoaded} navigation={items.filter(item => item.role === 'user').length >= 3 ? <ChatMessageNavigation items={items} copy={copy} onNavigate={viewport.navigateToMessage} /> : undefined} /><div ref={logContentRef}>{items.length ? turnGroups.map((group, groupIndex) => <section className="codex-turn chat-turn" key={group.id}>
      {renderTurn(group, groupIndex)}
    </section>) : firstResponseWait ? null : <div className="empty v3-empty"><strong>{copy('No messages yet.', '暂无消息。')}</strong><p>{copy('Send a message to start working with this provider.', '发送消息，开始与此提供方协作。')}</p></div>}
      {submissionPreview && !items.some(item => item.role === 'user' && item.turnId === submissionPreview.token) && <article className={`v3-chat-message user is-native is-${session.provider} chat-pending-submission`} aria-label={copy('Message being sent', '正在发送的消息')}>
        <div className="chat-part text">
          {!!submissionPreview.images.length && <div className="chat-message-images">{submissionPreview.images.map((image, index) => <img key={index} src={image} alt={`${copy('Pasted image', '已粘贴图片')} ${index + 1}`} />)}</div>}
          {!!submissionPreview.text && <ContextMessage text={submissionPreview.text} zh={zh}>{(value, badges) => <div className="v3-message-text"><MessageMentionText text={value} badges={badges} zh={zh} /></div>}</ContextMessage>}
        </div>
      </article>}
      {firstResponseWait && <div className="chat-first-response-wait" role="status" aria-live="polite" aria-label={submissionPreview && busy ? copy('Sending…', '正在发送…') : copy("Thinking", "思考中")}><span>{submissionPreview && busy ? copy('Sending…', '正在发送…') : copy("Thinking", "思考中")}</span><span className="chat-first-response-dots" aria-hidden="true"><i /><i /><i /></span></div>}
      </div>
    </div>
    {viewport.paused && overlay !== 'full' && <button type="button" className="btn chat-back-to-bottom" aria-keyshortcuts="Escape" aria-label={copy('Back to bottom (Esc)', '返回底部（Esc）')} title={copy('Back to bottom (Esc)', '返回底部（Esc）')} onClick={viewport.followLatest}><Icon name="arrowUp" /></button>}
    </div>
    {recovery !== undefined && <div role="alert" className="surface-error">
      <p>{copy('An unsaved draft is available on this device.', '此设备上有一份未保存的草稿。')}</p>
      <pre>{recovery.text || copy('(Empty draft)', '（空草稿）')}</pre>
      <button className="btn" disabled={!writable} onClick={() => {
        const local = recovery;
        mentionCatalogueRef.current = local.mentions; setMentionCatalogue(local.mentions);
        composerGeneration.current += 1; pickTicket.current = undefined;
        changeText(local.text);
      }}>{copy('Recover text', '恢复内容')}</button>
      <button className="btn" onClick={() => { setRecovery(undefined); try { localStorage.removeItem(recoveryKey); } catch {} }}>{copy('Keep saved draft', '保留已保存草稿')}</button>
    </div>}
    {draftFailed && <button className="btn" disabled={!writable} onClick={() => void retryDraft()}>{copy('Retry draft save', '重试保存草稿')}</button>}
    {/* The repair banner already shows this integrity diagnostic; don't repeat it below. */}
    {error && !(repair?.degraded && !liveTurn && repair.reason !== 'busy' && error === repair.diagnostic) && <p className="surface-error" role="alert">{error}</p>}
    {repairNotice && <p className="chat-repair-notice" role="status">{repairNotice.kind === 'rebuilt'
      ? copy(`History rebuilt from the agent's record: ${repairNotice.total} messages.`, `已根据代理记录重建历史：共 ${repairNotice.total} 条消息。`)
      : repairNotice.kind === 'unchanged' ? copy("History already matches the agent's saved record.", '历史已与代理保存的记录一致。')
      : repairNotice.kind === 'superseded' ? copy('This chat changed during repair. Review it and try again.', '修复期间此对话发生了变化。请检查后重试。')
      : copy('Could not repair history. The local transcript is unchanged.', '未能修复历史。本地对话记录未更改。')}</p>}
    <ChatNotesPanel sessionId={session.id} liveTurn={liveTurn} leaseEpoch={leaseSessionId.current === session.id ? lease.current : undefined} writable={writable} busy={busy} zh={zh} onIssue={message => setError(message)} />
    <ChatQueuePanel sessionId={session.id} queue={queue} leaseEpoch={leaseSessionId.current === session.id ? lease.current : undefined} writable={writable} idle={!liveTurn} canInsert={steerKind === 'split'} onInsertNow={item => insertIntoTurn({ text: item.text, images: item.images, id: item.id })} canNote={steerKind === 'split-note'} onSendNote={sendNoteFromQueue} ingressFailed={ingressFailed} onChange={setQueue} onIssue={message => setError(message)} zh={zh} />
    <form className="chat-compose chat-compose-shell" data-v3-chat-form={session.id} onSubmit={submit} inert={overlay === "full" || undefined}>
      {slash !== undefined && <div className="chat-slash" role="listbox" aria-label={copy("Commands", "命令")}>
        {slashCommands.length ? slashCommands.map((command, index) => <button type="button" role="option" aria-selected={index === slashIndex} className={index === slashIndex ? "active" : ""} key={command.name} onMouseEnter={() => setSlashIndex(index)} onClick={() => applySlash(command)}>
          <b>/{command.name.replace(/^\//, "")}</b><span>{command.description ?? ""}</span>
        </button>) : <p className="chat-slash-empty">{copy("No matching command", "没有匹配的命令")}</p>}
      </div>}
      {mention && <ChatMentions groups={mentionGroups} index={mentionIndex} zh={zh} onHover={setMentionIndex} onPick={applyMention} />}
      <label className="sr-only" htmlFor={`chat-message-${session.id}`}>{copy('Message', '消息')}</label>
      {!!images.length && !submissionPreview && <div className="chat-image-draft" aria-label={copy('Image attachments', '图片附件')}>{images.map((image, index) => pageShots.records.some(record=>record.imageIndex===index)?null:<figure key={index}><img src={image} alt={`${copy('Pasted image', '已粘贴图片')} ${index + 1}`} /><button type="button" className="icon-btn chat-image-remove" disabled={busy || imageReading || !writable} aria-label={`${copy('Remove image', '移除图片')} ${index + 1}`} onClick={() => updateImages(images.filter((_, imageIndex) => imageIndex !== index))}>×</button></figure>)}<span className="chat-image-draft-note">{copy('Images saved on this device', '图片已保存在此设备')}</span></div>}
      {!submissionPreview && <PageShotDrafts draft={pageShots} disabled={busy||imageReading||!writable}/>}
      {!submissionPreview && <ContextTray items={context.items.filter(item=>!pageShots.records.some(record=>item.id===`browser-shot:${record.shot.id}`))} text={text} zh={zh} onRemove={context.remove} disabled={busy || imageReading || !writable} mentions={activeMentions} workspaceRoot={session.worktreePath} />}
      {!!activeMentions.length && <p id={mentionDescriptionId} className="sr-only">{mentionDescription(activeMentions, zh)}</p>}
      <div className="chat-compose-input">
        {!submissionPreview && <ComposerMentionHighlights text={text} resolved={resolvedMentions} catalogue={mentionCatalogue} areaRef={composeRef} />}
      <textarea id={`chat-message-${session.id}`} ref={composeRef} value={submissionPreview ? '' : text} onChange={event => { setCaret(event.target.selectionStart ?? event.target.value.length); setMentionDismissed(undefined); changeText(event.target.value); setSlashIndex(0); setMentionIndex(0); }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={event => { composingRef.current = false; changeText(event.currentTarget.value); }} onSelect={event => setCaret(event.currentTarget.selectionStart ?? caret)} onClick={event => setCaret(event.currentTarget.selectionStart ?? caret)} onKeyUp={event => setCaret(event.currentTarget.selectionStart ?? caret)} onPaste={pasteImages} onContextMenu={composerEditableNow ? openComposerContextMenu : undefined} onKeyDown={onComposeKey} aria-describedby={activeMentions.length ? mentionDescriptionId : undefined} placeholder={copy('Message, or type / for commands', '发送消息，或输入 / 命令')} rows={1} disabled={!composerEditableNow} />
      </div>
      <ComposerOptions
        options={ui.options}
        loadState={ui.loadState}
        zh={zh}
        copy={copy}
        disabled={ended || !writable}
        busy={busy}
        onSetOption={setOption}
        leading={<ComposerPlusMenu quickMessages={quickMessages} disabled={busy || ended || !writable} liveFeedbackEnabled={steerKind === 'split-note' && Boolean(text.trim()) && !images.length} onAttachFiles={attachPickedFiles} onPickQuickMessage={insertQuickMessageAtCaret} onSlashCommands={() => insertSnippetAtCaret("/")} onLiveFeedback={() => { setLiveFeedbackSignal(value => value + 1); composeRef.current?.focus(); }} copy={copy} />}
        status={<Fragment>
          <ChatContextRing usage={contextUsage} copy={copy} />
          <ChatConnectionChip
            phase={connectionFeedbackPhase(connection.phase, overlay)}
            transportDown={link.transport !== "up"}
            providerName={providerLabel(session.provider, capabilities)}
            providerVersion={capabilities.find(capability => capability.id === session.provider)?.version}
            cwd={session.worktreePath}
            nativeId={connection.nativeId ?? session.nativeId}
            reconnectDisabled={Boolean(liveTurn) || busy || ended || !canControl || link.transport !== "up" || connection.phase === "connecting"}
            onReconnect={retryConnection}
            copy={copy}
          />
        </Fragment>}
        trailing={<Fragment>
          {controlIssue && <span className="dim">{controlIssue}</span>}
          {canControl && !controllable && <button type="button" className="chip chip-btn chat-compose-reclaim" onClick={() => reclaimRef.current()} disabled={busy}>{copy('Reclaim control', '重新取得控制')}</button>}
          {liveTurn && <button type="button" className="icon-btn icon-btn-sm icon-btn-round is-secondary chat-compose-send is-stop" disabled={!writable || busy} onClick={() => void cancel(liveTurn)} aria-label={copy('Stop', '停止')} title={copy('Stop', '停止')}><span className="chat-stop-square" /></button>}
          <SteerSend kind={steerKind} openSignal={liveFeedbackSignal} busy={busy} disabled={(!text.trim() && !images.length && !context.items.length) || queue?.sessionId !== session.id || imageReading || busy || !writable || !draftLoaded || draftFailed || recovery !== undefined} copy={copy} onInsert={() => void insertIntoTurn()} onNote={() => void addNote()} noteDisabled={!text.trim() || images.length > 0} noteDisabledReason={!text.trim() ? copy('Type a note first.', '请先输入备注。') : images.length ? copy('Images cannot be sent as a note.', '图片不能作为备注发送。') : undefined} />
        </Fragment>}
      />
    </form>
    {overlay === "full" && <ChatConnectOverlay provider={session.provider} phase={connection.phase} slow={connectSlow} error={connection.error} variant="full" onRetry={connection.phase === "failed" && link.transport === "up" ? retryConnection : undefined} copy={copy} transportDown={link.transport !== "up"} />}
    {repairDialog && <SurfaceDialog title={legacyHistoryReload ? copy('Reload saved history?', '重新加载已保存的历史？') : copy('Repair chat history?', '修复对话记录？')} subtitle={session.title} icon={legacyHistoryReload ? 'clock' : 'refresh'} size="sm" className="chat-repair-dialog" descriptionId={repairDescriptionId} onClose={() => { if (!repairBusy) setRepairDialog(false); }} footer={<><button autoFocus className="btn" disabled={repairBusy} onClick={() => setRepairDialog(false)}>{copy('Cancel', '取消')}</button><button className="btn btn-primary" disabled={repairBusy} onClick={() => void confirmRepair()}>{repairBusy ? (legacyHistoryReload ? copy('Reloading…', '正在重新加载…') : copy('Repairing…', '正在修复…')) : (legacyHistoryReload ? copy('Reload history', '重新加载历史') : copy('Repair history', '修复历史'))}</button></>}><div id={repairDescriptionId} className="chat-repair-confirm"><p>{copy("The local transcript will be replaced by the agent's saved record. Some local details may be lost: tool details, subagent cards, question answers, usage and timings. A backup of the current transcript is kept, and pending requests will expire.", '本地对话记录将被代理保存的记录替换。部分本地细节可能丢失：工具详情、子代理卡片、问题回答、用量和耗时。当前记录会保留一份备份，待处理的请求将过期。')}</p><p>{copy('Queued prompts, drafts and review checkpoints are not changed.', '排队的提示词、草稿和审查检查点不受影响。')}</p><p className="note">{copy('This only reads the agent\'s saved history. It does not send a prompt or continue the conversation.', '此操作仅读取代理保存的历史，不会发送提示词，也不会继续对话。')}</p></div></SurfaceDialog>}
    {mentionPreview !== undefined && <SurfaceDialog title={copy('Context preview', '上下文预览')} variant="plain" size="wide" className="context-preview-dialog" onClose={() => setMentionPreview(undefined)}><pre className="context-preview" data-testid="context-preview">{mentionPreview}</pre></SurfaceDialog>}
  </section></FileReferenceScopeProvider>;
}
