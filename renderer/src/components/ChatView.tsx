import { ClipboardEvent, FormEvent, Fragment, KeyboardEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ChatPart, ChatSessionOption, ChatSlashCommand, ChatUiState, FileReference, Session } from "@threadterm/protocol";
import { ChatItem, operationId, request, subscribeEvents } from "../bridge";
import { restoreChat, upsertChatItem } from "../chatState";
import { acquireControl } from '../controlLease';
import { createDraftWriter } from '../chatDraft';
import { useTranslation } from '../i18n';
import { Icon } from "./PrototypeIcon";
import { ChatApprovalCard } from "./ChatApprovalCard";
import { ChatConnectOverlay } from "./ChatConnectOverlay";
import { DelegationPanel } from "./DelegationPanel";
import { delegationTool, delegationToolLabel } from "../delegation";
import { UsageCard } from './UsageCard';
import { usageCardsForItems } from '../usageCard';
import { connectionStatusText, emptyLink, overlayKind, reduceChatLink } from "../chatConnection";
import { activeTurnId, chatCanControl, formatChatDuration, itemShowsStreaming, matchSlashCommands, partBody, partLabel, shouldRenderPart, slashQuery } from "../chatPresentation";
import { groupCodexTranscript } from "../codexTranscript";
import { createCodexStreamQueue } from "../codexStream";
import { FileLinkedMarkdown, FileLinkedText, FileReferenceChips } from './FileReferenceText';
import { parseMarkdownFileReference } from '../fileReferences';
import { SessionSurfaceContext } from './SessionSurfaceContext';
import { registerChatInputTarget } from '../terminalInputTargets';
import { insertAtCaret } from '../workbench/agentReference';
import "./chat-network-notice.css";
import { isChatImage, readClipboardImage, validateChatImages } from '../chatImages';
import './chat-images.css';

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

function renderCodexMarkdown(text: string): string {
  const rendered = marked.parse(text, { gfm: true, breaks: true });
  const template = document.createElement('template');
  template.innerHTML = typeof rendered === "string" ? rendered : "";
  for (const element of Array.from(template.content.querySelectorAll('[data-threadterm-file-reference]'))) element.removeAttribute('data-threadterm-file-reference');
  for (const anchor of Array.from(template.content.querySelectorAll('a[href]'))) {
    const reference = parseMarkdownFileReference(anchor.getAttribute('href') ?? '');
    if (!reference) continue;
    anchor.removeAttribute('href');
    anchor.setAttribute('data-threadterm-file-reference', JSON.stringify(reference));
  }
  return DOMPurify.sanitize(template.innerHTML, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base", "svg", "math", "audio", "video", "source", "track"],
    FORBID_ATTR: ["style", "srcset", "background", "poster"],
    SANITIZE_NAMED_PROPS: true,
  });
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
// Provider option ids are provider-defined (kimi ACP: model/thinking/mode); labels localize known values and fall back to the provider's own names.
const MODE_LABELS: Record<string, [string, string]> = { default: ["Default", "默认"], plan: ["Plan", "规划"], onrequest: ["Ask as needed", "按需询问"], never: ["Never ask", "从不询问"], onfailure: ["On failure", "失败时询问"], untrusted: ["Untrusted", "不受信任的"], readonly: ["Read only", "只读"], workspacewrite: ["Workspace write", "工作区可写"], dangerfullaccess: ["Full access", "完全访问"], auto: ["Auto", "自动"], yolo: ["Full access", "完全访问"], acceptedits: ["Accept edits", "接受编辑"], dontask: ["Don't ask", "不问"], bypasspermissions: ["Bypass", "跳过权限"] };
const THINKING_LABELS: Record<string, [string, string]> = { off: ["Off", "关"], none: ["Off", "关"], minimal: ["Minimal", "最低"], low: ["Low", "低"], on: ["On", "开"], medium: ["Medium", "中"], high: ["High", "高"], xhigh: ["Xhigh", "超高"], max: ["Max", "Max"], ultra: ["Ultra", "Ultra"] };
const currentChoiceName = (option: ChatSessionOption) => option.choices.find(choice => choice.value === option.value)?.name ?? option.value;
const shortThinking = (option: ChatSessionOption, zh: boolean) => {
  const known = THINKING_LABELS[option.value.toLowerCase()];
  if (known) return zh ? known[1] : known[0];
  return currentChoiceName(option).replace(/^thinking\s+/i, "") || option.value;
};
const modeText = (option: ChatSessionOption, zh: boolean) => {
  const known = MODE_LABELS[option.value.toLowerCase().replace(/[^a-z0-9]/g, "")];
  if (known) return zh ? known[1] : known[0];
  return currentChoiceName(option) || option.value;
};
const isNativeOption = (option: ChatSessionOption) => /^(collaboration|approvalpolicy|sandbox)$/i.test(option.id) || (/^mode$/i.test(option.id) && /^approval policy$/i.test(option.name));
const optionTitle = (option: ChatSessionOption, copy: (en: string, zh: string) => string) => {
  if (/^model$/i.test(option.id)) return copy("Model", "模型");
  if (/think/i.test(option.id)) return copy("Thinking level", "思考程度");
  if (/^collaboration$/i.test(option.id)) return copy("Collaboration", "协作模式");
  if (/^approvalpolicy$/i.test(option.id) || (/^mode$/i.test(option.id) && /^approval policy$/i.test(option.name))) return copy("Approval policy", "审批策略");
  if (/^sandbox$/i.test(option.id)) return copy("Sandbox", "沙箱");
  if (/^mode$/i.test(option.id)) return copy("Permission mode", "权限模式");
  return option.name;
};
type DraftWriter = ReturnType<typeof createDraftWriter>;
type ControlToken = { epoch: number; release: () => void; valid: boolean };
type ChatLifecycle = { sessionId: string; writer?: DraftWriter; control?: ControlToken; flushOnExit?: Promise<void> };
type LogViewport = { top: number; follow: boolean };
type FirstResponseWait = { token: string; sessionUpdatedAt: string; turnId?: string };
// Mirrors the reference's viewport contract: within 24px of the bottom means "follow",
// otherwise the reader's offset is preserved across transcript updates and session switches.
const CHAT_FOLLOW_THRESHOLD = 24;
const chatViewports = new Map<string, LogViewport>();

function hasVisibleAssistantResponse(items: ChatItem[], turnId: string): boolean {
  return items.some(item => item.role === "assistant" && item.turnId === turnId && item.parts.some(shouldRenderPart));
}

function isTerminalChatStatus(status: Session["status"]): boolean {
  return status === "idle" || status === "error" || status === "exited" || status === "interrupted";
}

export function ChatView({ session, delegates = [], delegatedBy, onOpenSession }: { session: Session; delegates?: Session[]; delegatedBy?: Session; onOpenSession?: (sessionId: string) => void }) {
  const { locale } = useTranslation();
  const openFile = useContext(SessionSurfaceContext)?.openFile;
  const zh = locale === 'zh-CN';
  const copy = (en: string, cn: string) => zh ? cn : en;
  const recoveryKey = `threadterm.compose.${session.id}`;
  const canControl = chatCanControl(session);
  const ended = isEnded(session);
  const [items, setItems] = useState<ChatItem[]>([]); const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>(); const [controlIssue, setControlIssue] = useState<string>(); const [controllable, setControllable] = useState(false);
  // Presentation only: keep the recoverable draft until runtime acceptance.
  // This preview never becomes a canonical ChatItem or an active-turn source.
  const [submissionPreview, setSubmissionPreview] = useState<{ token: string; text: string; images: string[] }>();
  const itemsRef = useRef(items); itemsRef.current = items;
  const [firstResponseWait, setFirstResponseWait] = useState<FirstResponseWait | undefined>(undefined);
  const firstResponseWaitRef = useRef<FirstResponseWait | undefined>(undefined);
  const reclaimRef = useRef<() => void>(() => undefined);
  const lease = useRef<number | undefined>(undefined);
  const leaseSessionId = useRef<string | undefined>(undefined);
  const lifecycle = useRef<ChatLifecycle | undefined>(undefined);
  const draftRevision=useRef(0), draftReady=useRef(false), currentText=useRef(text), lastSaved=useRef(''); currentText.current=text;
  const writer=useRef<DraftWriter | undefined>(undefined);
  const [draftFailed, setDraftFailed] = useState(false);
  const [recovery, setRecovery] = useState<string>();
  const [draftNotice,setDraftNotice]=useState('');
  const [draftLoaded,setDraftLoaded]=useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [link, setLink] = useState(() => emptyLink(session.id, "disconnected"));
  const connection = link.connection;
  const [connectSlow, setConnectSlow] = useState(false);
  const connectInFlight = useRef(false);
  const transportGeneration = useRef(0);
  const [ui, setUi] = useState<ChatUiState>({ options: [], commands: [] });
  const [images, setImages] = useState<string[]>([]);
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
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  function clearFirstResponseWait(token?: string) {
    if (token && firstResponseWaitRef.current?.token !== token) return;
    firstResponseWaitRef.current = undefined;
    setFirstResponseWait(undefined);
  }
  function persistCompose(value:string,_epoch:number) {
    if (!writer.current) return Promise.reject(new Error('Draft is not loaded'));
    return writer.current.write(value).then(() => {
      if (currentText.current === value) {
        try { localStorage.removeItem(recoveryKey); } catch { /* Runtime copy is durable. */ }
      }
    });
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
  function changeText(value: string) {
    currentText.current = value; setText(value);
    if (recovery !== undefined) setRecovery(undefined);
    try { localStorage.setItem(recoveryKey, value); }
    catch { setError(copy('Local recovery is unavailable. Keep this view open until the draft is saved.', '本地恢复不可用，请在草稿保存成功前保持此视图打开。')); }
  }
  const changeTextRef = useRef(changeText);
  changeTextRef.current = changeText;
  // Editor/file "Send to agent" inserts a reference at the caret; it never submits.
  useEffect(() => registerChatInputTarget(session.id, {
    visible: () => Boolean(composeRef.current && !composeRef.current.disabled && composeRef.current.getClientRects().length > 0),
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
      if (remote.text !== lastSaved.current && remote.text !== currentText.current && !confirm(copy('The saved draft changed in another view. Replace it with this text?', '其他视图更改了已保存的草稿。用此处内容替换吗？'))) return;
      await writer.current?.reset(remote);
      await persistCompose(currentText.current, epoch);
      setDraftFailed(false); setError(undefined); setDraftNotice(copy('Draft saved', '草稿已保存'));
    } catch (caught) { setError(String(caught)); }
  }
  useEffect(() => {
    let disposed = false, loading = true;
    const sessionLifecycle: ChatLifecycle = {sessionId: session.id};
    lifecycle.current = sessionLifecycle;
    const buffered: {seq: number; item: ChatItem}[] = [];
    const codexStream = session.provider === "codex"
      ? createCodexStreamQueue((item) => {
        if (!disposed) setItems(current => upsertChatItem(current, item));
      })
      : undefined;
    transportGeneration.current = 0;
    clearFirstResponseWait();
    setSubmissionPreview(undefined);
    setItems([]); setText(''); setBusy(false); setDraftLoaded(false); setHistoryLoaded(false); setHistoryFailed(false); setLink(emptyLink(session.id, canControl && !ended ? "connecting" : "unavailable")); setConnectSlow(false); setError(undefined);draftReady.current=false;writer.current=undefined;setDraftFailed(false);setRecovery(undefined);setMenuOpen(null);setApprovalBusy(undefined);
    const unsubscribe = subscribeEvents(event => {
      if (disposed || !event.data || typeof event.data !== 'object') return;
      const data = event.data as { sessionId?: string; item?: ChatItem; reason?: string };
      if (event.event === 'runtime.degraded' && (!data.sessionId || data.sessionId === session.id)) setError(data.reason ?? 'Chat updates are incomplete.');
      if (event.event === 'runtime.transport') {
        const transport = event.data as { state?: string; epoch?: string };
        if (transport.state === 'disconnected' || transport.state === 'incompatible') {
          transportGeneration.current += 1;
          setLink(current => reduceChatLink(current, { type: 'transport-down' }));
          if (transport.state === 'incompatible' && typeof (event.data as { message?: string }).message === 'string') setError((event.data as { message: string }).message);
        }
        if (transport.state === 'reconnected') {
          const generation = ++transportGeneration.current;
          const epoch = typeof transport.epoch === 'string' ? transport.epoch : event.epoch;
          setLink(current => reduceChatLink(current, { type: 'transport-up', epoch }));
          reclaimRef.current();
          void request('chat.connection', { sessionId: session.id }).then(snapshot => {
            if (!disposed) setLink(current => reduceChatLink(current, { type: 'snapshot', snapshot, transportGeneration: generation, resync: true }));
          }).catch(caught => { if (!disposed && transportGeneration.current === generation) setError(asUserError(caught, copy('Could not synchronize the connection. Reopen this view to retry.', '无法同步连接状态，请重新打开此视图重试。'))); });
        }
      }
      if (event.event === 'chat.connection' && data.sessionId === session.id) {
        setLink(current => reduceChatLink(current, { type: 'event', snapshot: { ...current.connection, ...(event.data as object), runtimeEpoch: event.epoch, sessionId: session.id }, epoch: event.epoch }));
      }
      if (event.event === 'chat.ui' && data.sessionId === session.id) {
        const next = event.data as ChatUiState & { sessionId?: string };
        setUi({ options: Array.isArray(next.options) ? next.options : [], commands: Array.isArray(next.commands) ? next.commands : [], loadState: "ready" });
      }
      if (event.event !== 'chat.item' || data.sessionId !== session.id || !data.item) return;
      if (loading) buffered.push({seq: event.seq, item: data.item});
      else if (codexStream) codexStream.push(data.item);
      else setItems(current => upsertChatItem(current, data.item!));
    });
    // Reading does not require the write lease: other windows remain viewers.
    void request('chat.draft.read',{sessionId:session.id}).then(draft=>{
      if(disposed)return;draftRevision.current=draft.revision;lastSaved.current=draft.text;draftReady.current=true;initializeWriter(draft,sessionLifecycle);setDraftLoaded(true);
      if (!currentText.current) { setText(draft.text); currentText.current=draft.text; }
      try { const local = localStorage.getItem(recoveryKey); if (local !== null && local !== draft.text && local !== currentText.current) setRecovery(local); } catch { /* Runtime draft is still available. */ }
    }).catch(caught=>{if(!disposed){setError(`Draft could not be loaded: ${String(caught)}`);setDraftFailed(true);setDraftLoaded(true);}});
    void request('chat.snapshot', {sessionId: session.id}).then(transcript => {
      if (disposed) return;
      setItems(restoreChat(transcript, buffered)); loading = false; setHistoryLoaded(true);
    }).catch(caught => { if (!disposed) { loading = false; setHistoryLoaded(true); setHistoryFailed(true); setItems(buffered.reduce((items, event) => upsertChatItem(items, event.item), [] as ChatItem[])); setError(String(caught)); } });
    return () => {
      disposed = true; unsubscribe();
      codexStream?.dispose();
      const control = sessionLifecycle.control;
      const draftWriter = sessionLifecycle.writer;
      const value = currentText.current;
      if (draftReady.current && control?.valid && draftWriter) {
        sessionLifecycle.flushOnExit = draftWriter.write(value).then(() => {
          try { if (localStorage.getItem(recoveryKey) === value) localStorage.removeItem(recoveryKey); } catch { /* The runtime copy is durable. */ }
        }).catch(() => undefined);
      }
      if (lifecycle.current === sessionLifecycle) lifecycle.current = undefined;
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
      if (disposed || taking || !canControl) return;
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
        control = {epoch: claim.epoch, release: claim.release, valid: true};
        target.control = control;
        lease.current = claim.epoch; leaseSessionId.current = session.id; setControllable(true); setControlIssue(undefined); autoTries = 0;
      } catch {
        if (!disposed) setControlIssue(copy('Could not take chat control. Retry from this view.', '无法取得聊天控制权，请在此视图重试。'));
      } finally { taking = false; }
    }
    reclaimRef.current = () => { autoTries = 0; taking = false; void take(); };
    if (canControl) void take();
    return () => {
      disposed = true;
      lease.current = undefined; leaseSessionId.current = undefined;
      if (!control) return;
      const release = () => {control!.valid = false; control!.release();};
      if (sessionLifecycle?.flushOnExit) void sessionLifecycle.flushOnExit.finally(release);
      else release();
    };
  }, [canControl, session.id]);
  const connected = connection.phase === "ready" && link.transport === "up";
  const writable = canControl && controllable && connected && leaseSessionId.current === session.id && lease.current !== undefined;
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
    connectInFlight.current = false;
  }, [session.id]);
  useEffect(() => {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    const shouldConnect = connection.phase === "connecting" || connection.phase === "disconnected";
    if (!canControl || ended || !controllable || epoch === undefined || connected || !shouldConnect || link.transport !== "up" || connectInFlight.current) return;
    let disposed = false;
    connectInFlight.current = true;
    const generation = transportGeneration.current;
    void request("chat.connect", { sessionId: session.id, leaseEpoch: epoch, operationId: operationId() }).then(snapshot => {
      if (!disposed) setLink(current => reduceChatLink(current, { type: "snapshot", snapshot, transportGeneration: generation }));
    }).catch(caught => {
      if (!disposed) setLink(current => reduceChatLink(current, { type: "connect-failed", message: asUserError(caught, copy("Could not connect.", "无法连接。")) }));
    }).finally(() => { connectInFlight.current = false; });
    return () => { disposed = true; };
  }, [canControl, ended, controllable, connected, connection.phase, link.transport, session.id, copy]);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    void request("chat.options", { sessionId: session.id }).then(next => { if (!disposed) setUi(next); }).catch(caught => {
      if (!disposed) setUi(current => ({ ...current, loadState: "error", error: { code: "options_failed", message: asUserError(caught, copy("Options could not be loaded.", "无法读取选项。")) } }));
    });
    return () => { disposed = true; };
  }, [connected, session.id, copy]);
  const overlay = overlayKind({
    ended,
    canControl,
    phase: connection.phase,
    hasTranscript: items.length > 0,
    transportDown: link.transport !== "up",
  });
  useEffect(() => {
    if (overlay !== "full" || connection.phase === "failed") {
      setConnectSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setConnectSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [overlay, connection.phase, session.id]);
  function retryConnection() {
    connectInFlight.current = false;
    setLink(current => reduceChatLink(current, { type: "reset", sessionId: session.id, phase: "connecting" }));
    reclaimRef.current();
  }
  useEffect(()=>{
    if(!draftReady.current||!writable||lease.current===undefined||recovery!==undefined||draftFailed)return;
    const epoch=lease.current;
    const timer=setTimeout(()=>{setDraftNotice(copy('Saving draft…','正在保存草稿…'));void persistCompose(text,epoch).then(()=>setDraftNotice(copy('Draft saved','草稿已保存'))).catch(caught=>{setDraftFailed(true);setDraftNotice(copy('Draft not saved','草稿未保存'));setError(String(caught));});},400);
    return()=>clearTimeout(timer);
  },[text,writable,recovery,draftFailed]);
  async function submit(event: FormEvent) {
    event.preventDefault();const value=text.trim(),epoch=leaseSessionId.current === session.id ? lease.current : undefined;
    if((!value&&!images.length)||imageReading||epoch===undefined||!writable||!draftLoaded||busy||firstResponseWaitRef.current||activeTurnId(itemsRef.current,session.status))return;
    const submittingLifecycle = lifecycle.current;
    const token = operationId();
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
      if (firstResponseWaitRef.current?.token === token) {
        const pending = { token, sessionUpdatedAt: session.updatedAt, turnId: sent.turnId };
        firstResponseWaitRef.current = pending;
        setFirstResponseWait(pending);
        if (hasVisibleAssistantResponse(itemsRef.current, sent.turnId)) clearFirstResponseWait(token);
      }
      changeText('');
      setImages([]);
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
      setImages(next);
    } catch {
      setError(copy('Image draft could not be saved. Remove an image or free device storage and paste again.', '无法保存图片草稿。请移除图片或释放设备存储空间后重新粘贴。'));
    }
  }
  async function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (!files.length || !ui.inputCapabilities?.images) return;
    event.preventDefault();
    if (!writable || busy || imageReadingRef.current) return;
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
  const liveTurn = ended ? undefined : activeTurnId(items, session.status);
  const modelOption = ui.options.find(option => /model/i.test(option.id) || /model/i.test(option.name));
  const thinkingOption = ui.options.find(option => option !== modelOption && (/think/i.test(option.id) || /think/i.test(option.name) || /reason/i.test(option.id)));
  const modeOption = ui.options.find(option => option !== modelOption && option !== thinkingOption && (/mode/i.test(option.id) || /mode/i.test(option.name)));
  const extraOptions = ui.options.filter(option => option !== modelOption && option !== thinkingOption && option !== modeOption && option.choices.length > 0);
  const [menuOpen, setMenuOpen] = useState<null | "model" | "mode">(null);
  const slash = slashQuery(text);
  const slashCommands = useMemo(() => {
    const commands: ChatSlashCommand[] = [...ui.commands];
    if (liveTurn && !commands.some(command => command.name === "stop")) commands.unshift({ name: "stop", description: copy("Stop this turn", "停止此轮") });
    return slash === undefined ? [] : matchSlashCommands(slash, commands);
  }, [copy, liveTurn, slash, ui.commands]);
  async function setOption(option: ChatSessionOption, value: string) {
    const epoch = leaseSessionId.current === session.id ? lease.current : undefined;
    if (!writable || epoch === undefined) return;
    try {
      setUi(await request("chat.option.set", { sessionId: session.id, optionId: option.id, value, leaseEpoch: epoch, operationId: operationId() }));
    } catch (caught) { setError(asUserError(caught, copy("Option was not updated.", "未能更新选项。"))); }
  }
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target?.closest(".chat-compose-menu, [data-menu-trigger]")) setMenuOpen(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(null); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);
  useEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text, submissionPreview]);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const saved = chatViewports.get(session.id);
    if (!saved || saved.follow) el.scrollTop = el.scrollHeight;
    else el.scrollTop = saved.top;
  }, [items, session.id]);
  useEffect(() => {
    const el = logRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [items, text, firstResponseWait]);
  function renderMenuRows(option: ChatSessionOption) {
    const choices = option.choices.length ? option.choices : [{ value: option.value, name: option.value || copy("Current", "当前") }];
    return choices.map(choice => <button type="button" key={choice.value} role="menuitemradio" aria-checked={choice.value === option.value} className={`chat-menu-item${choice.value === option.value ? " active" : ""}`} disabled={!writable || busy} onClick={() => { setMenuOpen(null); void setOption(option, choice.value); }}>
      <Icon name="check" className="chat-menu-check" /><span>{menuChoiceText(option, choice)}</span>
    </button>);
  }
  function menuChoiceText(option: ChatSessionOption, choice: ChatSessionOption["choices"][number]) {
    if (isNativeOption(option)) return modeText({ ...option, value: choice.value }, zh);
    // Providers name mode/thinking choices in English; in Chinese, translate the known values like their chips.
    const known = option === modeOption ? MODE_LABELS[choice.value.toLowerCase().replace(/[^a-z0-9]/g, "")] : option === thinkingOption ? THINKING_LABELS[choice.value.toLowerCase()] : undefined;
    return zh && known ? known[1] : choice.name;
  }
  function applySlash(command: ChatSlashCommand) {
    if (command.name === "stop" && liveTurn) { void cancel(liveTurn); changeText(""); return; }
    changeText(`/${command.name.replace(/^\//, "")} `);
    composeRef.current?.focus();
  }
  function onComposeKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slash !== undefined && slashCommands.length) {
      if (event.key === "ArrowDown") { event.preventDefault(); setSlashIndex(value => Math.min(value + 1, slashCommands.length - 1)); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSlashIndex(value => Math.max(0, value - 1)); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); applySlash(slashCommands[slashIndex] ?? slashCommands[0]!); return; }
      if (event.key === "Escape") { event.preventDefault(); changeText(""); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }
  const usageCards = useMemo(() => usageCardsForItems(session.provider, items), [session.provider, items]);
  function renderItem(item: ChatItem) {
      const usage = usageCards.get(item.id);
      if (usage) return <article className={`v3-chat-message assistant is-native is-${session.provider} is-usage`} key={item.id}><UsageCard model={usage} zh={zh} /></article>;
      const live = itemShowsStreaming(item, items);
      return <article className={`v3-chat-message ${item.role} is-native is-${session.provider}`} key={item.id}>
      {item.parts.filter(part => shouldRenderPart(part) || (Array.isArray(asRecord(part.data).images) && (asRecord(part.data).images as unknown[]).some(isChatImage))).map((part, index) => {
        if (part.type === "thinking") return <ThinkingPart key={`thinking-${index}`} part={part} streaming={live && part.status === "streaming"} copy={copy} openFile={openFile} />;
        if (part.type === "status" && asRecord(part.data).kind === "providerRetry") {
          const retry = asRecord(part.data), state = asString(retry.state, "retrying");
          const count = typeof retry.attempt === "number" && typeof retry.maxRetries === "number" ? ` (${retry.attempt}/${retry.maxRetries})` : "";
          return <div key={`retry-${index}`} className="chat-network-notice" role="status" aria-live="polite">
            <strong>{state === "retrying" ? copy("Connection interrupted · retrying", "连接遇到问题，正在重试") + count : state === "failed" ? copy("Could not reach Grok", "未能连接 Grok") : state === "stopped" ? copy("Connection retry stopped", "已停止连接重试") : copy("Connection retry finished", "连接重试已结束")}</strong>
            <p>{state === "retrying" ? copy("Grok is retrying the request. You can stop this turn using the Stop button below.", "Grok 正在重新尝试请求，可使用下方停止按钮结束本轮。") : state === "failed" ? copy("Check your network and the Grok proxy in Settings → Tools, then start a new session to apply proxy changes.", "请检查网络及“设置 → 工具”中的 Grok 代理；修改代理后，新建会话使其生效。") : copy("Your conversation has been kept.", "会话内容已保留。")}</p>
          </div>;
        }
        if (part.type === "status") return <CodexStatusCard key={`status-${index}`} part={part} copy={copy} />;
        if (part.type === "text" && asRecord(part.data).kind === "plan") return <PlanUsageCard key={`usage-${index}`} part={part} zh={zh} copy={copy} />;
        if (part.type === "text" && (session.provider === "kimi" || session.provider === "grok") && item.role !== "user" && typeof part.text === "string") {
          const statusRows = parseKimiStatus(part.text);
          if (statusRows) return <KimiStatusCard key={`kstatus-${index}`} rows={statusRows} zh={zh} copy={copy} />;
        }
        if (part.type === "approval") return <div className={`chat-part approval v3-tool-card ${part.status ?? ""}`} key={`${part.type}-${index}`}>
          <ChatApprovalCard part={part} writable={writable && !busy} submitting={approvalBusy?.startsWith(`${part.approvalId ?? ""}:`) ? approvalBusy.slice((part.approvalId ?? "").length + 1) : undefined} onChoose={choiceId => { if (item.turnId && part.approvalId) void approval(item.turnId, part.approvalId, choiceId); }} copy={copy} />
        </div>;
        const label = partLabel(part, copy);
        const localizedText = asRecord(asRecord(part.data).localizedText);
        const body = asString(localizedText[zh ? "zh-CN" : "en"], partBody(part));
        const partImages = asRecord(part.data).images;
        const messageImages = Array.isArray(partImages) ? partImages.filter(isChatImage) : [];
        const foldedTool = part.type === "tool";
        const codexMarkdown = item.role !== "user" && part.type === "text";
        return <div className={`chat-part ${part.type}${part.type === 'tool' ? ` v3-tool-card ${part.status ?? ''}` : ''}`} key={`${part.type}-${index}`}>
          {!!messageImages.length && <div className="chat-message-images">{messageImages.map((image, imageIndex) => <img key={imageIndex} src={image} alt={`${copy('Pasted image', '已粘贴图片')} ${imageIndex + 1}`} loading="lazy" />)}</div>}
          {foldedTool ? <CodexToolPart part={part} copy={copy} openFile={openFile} /> : <>
            {label && <strong>{label}</strong>}
            {body ? codexMarkdown
              ? <FileLinkedMarkdown sanitizedHtml={renderCodexMarkdown(body)} references={part.fileReferences} openFile={openFile} />
              : <div className="v3-message-text"><FileLinkedText text={body} openFile={openFile} /></div>
              : null}
            {!codexMarkdown && <FileReferenceChips references={part.fileReferences} visibleText={body} openFile={openFile} />}
          </>}
          {part.status && !foldedTool && part.type !== 'text' && part.status !== 'complete' && part.status !== 'streaming' && <small>{part.status}</small>}
        </div>;
      })}
    </article>;
  }
  return <section className={`chat-view v3-session-chat${overlay === "full" ? " is-connecting" : ""}`} data-provider={session.provider} data-testid={`session-chat-${session.id}`} aria-label={copy('Structured chat', '图形聊天')}>
    {ended && <p className="chat-history-note" role="note">{copy('Session ended · history is read-only.', '会话已结束 · 历史记录只读。')}</p>}
    <DelegationPanel session={session} delegates={delegates} delegatedBy={delegatedBy} onOpenSession={onOpenSession} copy={copy} zh={zh} />
    {overlay === "banner" && <ChatConnectOverlay provider={session.provider} phase={connection.phase} slow={false} error={connection.error} variant="banner" onRetry={retryConnection} copy={copy} transportDown={link.transport !== "up"} />}
    {ui.loadState === "error" && ui.error && <p className="surface-error" role="alert">{ui.error.message} <button type="button" className="btn" disabled={!writable} onClick={() => void request("chat.options", { sessionId: session.id }).then(setUi).catch(caught => setUi(current => ({ ...current, loadState: "error", error: { code: "options_failed", message: asUserError(caught, copy("Options could not be loaded.", "无法读取选项。")) } })))}>{copy("Retry options", "重试读取选项")}</button></p>}
    {historyFailed && <p className="surface-error" role="alert">{copy("History could not be loaded.", "无法加载历史。")}</p>}
    <div className="chat-scroll v3-chat-log" data-chat-log={session.id} ref={logRef} inert={overlay === "full" || undefined} onScroll={event => {
      const el = event.currentTarget;
      const follow = el.scrollHeight - el.scrollTop - el.clientHeight < CHAT_FOLLOW_THRESHOLD;
      followRef.current = follow;
      if (chatViewports.size > 50) { const oldest = chatViewports.keys().next(); if (!oldest.done) chatViewports.delete(oldest.value); }
      chatViewports.set(session.id, { top: el.scrollTop, follow });
    }}>{items.length ? groupCodexTranscript(items, session.provider === "codex").map(group => <section className="codex-turn chat-turn" key={group.id}>
      {group.elapsedMs != null && !group.response.some(item => usageCards.has(item.id)) && <details className="codex-work" key={`${group.id}-work`}>
        <summary><span className="codex-work-label">{formatChatDuration(group.elapsedMs, zh)}<Icon name="chevR" /></span></summary>
        <div className="codex-work-body">{group.activity.length ? group.activity.map(renderItem) : <p className="dim">{copy('No additional activity recorded.', '没有记录额外的过程。')}</p>}</div>
      </details>}
      {group.response.map(renderItem)}
    </section>) : firstResponseWait ? null : <div className="empty v3-empty"><strong>{copy('No messages yet.', '暂无消息。')}</strong><p>{copy('Send a message to start working with this provider.', '发送消息，开始与此提供方协作。')}</p></div>}
      {submissionPreview && !items.some(item => item.role === 'user' && item.turnId === submissionPreview.token) && <article className={`v3-chat-message user is-native is-${session.provider} chat-pending-submission`} aria-label={copy('Message being sent', '正在发送的消息')}>
        <div className="chat-part text">
          {!!submissionPreview.images.length && <div className="chat-message-images">{submissionPreview.images.map((image, index) => <img key={index} src={image} alt={`${copy('Pasted image', '已粘贴图片')} ${index + 1}`} />)}</div>}
          {!!submissionPreview.text && <div className="v3-message-text">{submissionPreview.text}</div>}
        </div>
      </article>}
      {firstResponseWait && <div className="chat-first-response-wait" role="status" aria-live="polite" aria-label={submissionPreview && busy ? copy('Sending…', '正在发送…') : copy("Thinking", "思考中")}><span>{submissionPreview && busy ? copy('Sending…', '正在发送…') : copy("Thinking", "思考中")}</span><span className="chat-first-response-dots" aria-hidden="true"><i /><i /><i /></span></div>}
    </div>
    {recovery !== undefined && <div role="alert" className="surface-error">
      <p>{copy('An unsaved draft is available on this device.', '此设备上有一份未保存的草稿。')}</p>
      <pre>{recovery || copy('(Empty draft)', '（空草稿）')}</pre>
      <button className="btn" disabled={!writable} onClick={() => { changeText(recovery); setRecovery(undefined); }}>{copy('Recover text', '恢复内容')}</button>
      <button className="btn" onClick={() => { setRecovery(undefined); try { localStorage.removeItem(recoveryKey); } catch {} }}>{copy('Keep saved draft', '保留已保存草稿')}</button>
    </div>}
    {draftFailed && <button className="btn" disabled={!writable} onClick={() => void retryDraft()}>{copy('Retry draft save', '重试保存草稿')}</button>}
    {error && <p className="surface-error" role="alert">{error}</p>}
    <form className="chat-compose chat-compose-shell" data-v3-chat-form={session.id} onSubmit={submit} inert={overlay === "full" || undefined}>
      {slash !== undefined && <div className="chat-slash" role="listbox" aria-label={copy("Commands", "命令")}>
        {slashCommands.length ? slashCommands.map((command, index) => <button type="button" role="option" aria-selected={index === slashIndex} className={index === slashIndex ? "active" : ""} key={command.name} onMouseEnter={() => setSlashIndex(index)} onClick={() => applySlash(command)}>
          <b>/{command.name.replace(/^\//, "")}</b><span>{command.description ?? ""}</span>
        </button>) : <p className="chat-slash-empty">{copy("No matching command", "没有匹配的命令")}</p>}
      </div>}
      {menuOpen === "model" && modelOption && <div className="chat-compose-menu chat-menu-model" role="menu" aria-label={copy("Model and thinking level", "模型与思考程度")}>
        <p className="chat-menu-label">{optionTitle(modelOption, copy)}</p>
        {renderMenuRows(modelOption)}
        {thinkingOption && <Fragment><p className="chat-menu-label">{optionTitle(thinkingOption, copy)}</p>{renderMenuRows(thinkingOption)}</Fragment>}
        {extraOptions.map(option => <Fragment key={option.id}><p className="chat-menu-label">{optionTitle(option, copy)}</p>{renderMenuRows(option)}</Fragment>)}
      </div>}
      {menuOpen === "mode" && modeOption && <div className="chat-compose-menu chat-menu-mode" role="menu" aria-label={optionTitle(modeOption, copy)}>
        <p className="chat-menu-label">{optionTitle(modeOption, copy)}</p>
        {renderMenuRows(modeOption)}
      </div>}
      <label className="sr-only" htmlFor={`chat-message-${session.id}`}>{copy('Message', '消息')}</label>
      {!!images.length && !submissionPreview && <div className="chat-image-draft" aria-label={copy('Image attachments', '图片附件')}>{images.map((image, index) => <figure key={index}><img src={image} alt={`${copy('Pasted image', '已粘贴图片')} ${index + 1}`} /><button type="button" disabled={busy || imageReading || !writable} aria-label={`${copy('Remove image', '移除图片')} ${index + 1}`} onClick={() => updateImages(images.filter((_, imageIndex) => imageIndex !== index))}>×</button></figure>)}<span className="chat-image-draft-note">{copy('Images saved on this device', '图片已保存在此设备')}</span></div>}
      <textarea id={`chat-message-${session.id}`} ref={composeRef} value={submissionPreview ? '' : text} onChange={event => { changeText(event.target.value); setSlashIndex(0); }} onPaste={pasteImages} onKeyDown={onComposeKey} placeholder={copy('Message the provider, or type / for commands', '发送消息，或输入 / 唤出命令')} rows={1} disabled={busy || ended || !writable || overlay === "full" || !draftLoaded} />
      <div className="chat-compose-bar">
        <div className="chat-compose-left">
          <button type="button" className="chat-compose-icon" disabled={busy || ended || !writable} aria-label={copy("Commands", "命令")} title={copy("Commands", "命令")} onClick={() => { changeText(text.startsWith("/") ? text : "/"); composeRef.current?.focus(); }}><Icon name="plus" /></button>
          {modeOption && <button type="button" className={`chat-compose-chip chat-mode-chip mode-${modeOption.value.replace(/[^a-z0-9]/gi, "") || "unknown"}`} data-menu-trigger="mode" aria-haspopup="menu" aria-expanded={menuOpen === "mode"} disabled={ended || !writable} title={isNativeOption(modeOption) ? modeText(modeOption, zh) : currentChoiceName(modeOption) || modeOption.name} onClick={() => setMenuOpen(menuOpen === "mode" ? null : "mode")}>
            <Icon name="shield" /><span>{modeText(modeOption, zh)}</span>
          </button>}
        </div>
        <div className="chat-compose-right">
          {controlIssue && <span className="dim">{controlIssue}</span>}
          {canControl && !writable && <button type="button" className="btn" onClick={() => reclaimRef.current()} disabled={busy}>{copy('Reclaim control', '重新取得控制')}</button>}
          {modelOption && <button type="button" className="chat-compose-chip chat-model-chip" data-menu-trigger="model" aria-haspopup="menu" aria-expanded={menuOpen === "model"} disabled={ended || !writable} title={`${modelOption.name}: ${currentChoiceName(modelOption) || modelOption.value}${thinkingOption ? ` · ${optionTitle(thinkingOption, copy)}: ${currentChoiceName(thinkingOption) || thinkingOption.value}` : ""}`} onClick={() => setMenuOpen(menuOpen === "model" ? null : "model")}>
            <span className="chat-model-name">{currentChoiceName(modelOption) || copy("Model", "模型")}</span>
            {thinkingOption && <span className="chat-model-think">{shortThinking(thinkingOption, zh)}</span>}
            <Icon name="chevD" className="chat-model-chev" />
          </button>}
          {liveTurn
            ? <button type="button" className="chat-compose-send is-stop" disabled={!writable || busy} onClick={() => void cancel(liveTurn)} aria-label={copy('Stop', '停止')} title={copy('Stop', '停止')}><span className="chat-stop-square" /></button>
            : <button className="chat-compose-send" type="submit" disabled={(!text.trim() && !images.length) || imageReading || busy || !writable || !draftLoaded || draftFailed || recovery !== undefined} aria-label={busy ? copy('Sending…', '正在发送…') : copy('Send', '发送')}><Icon name="arrowUp" /></button>}
        </div>
      </div>
    </form>
    {overlay === "full" && <ChatConnectOverlay provider={session.provider} phase={connection.phase} slow={connectSlow} error={connection.error} variant="full" onRetry={connection.phase === "failed" && link.transport === "up" ? retryConnection : undefined} copy={copy} transportDown={link.transport !== "up"} />}
  </section>;
}
