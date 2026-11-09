import type { ProviderCapability, Session } from "@threadterm/protocol";

export const LIVE_SESSION_STATUSES = ["starting", "running", "idle", "waiting"] as const;

export function isLiveSession(session: Pick<Session, "readOnly" | "status">): boolean {
  return !session.readOnly && LIVE_SESSION_STATUSES.includes(session.status as (typeof LIVE_SESSION_STATUSES)[number]);
}

/** Why releasing this session is unavailable, or undefined when it can be released. */
export function releaseBlockedReason(
  session: Pick<Session, "status" | "readOnly" | "mode" | "provider" | "nativeId" | "activity">,
  providers: readonly ProviderCapability[],
  zh: boolean,
): string | undefined {
  const text = (en: string, cn: string) => (zh ? cn : en);
  if (!isLiveSession(session)) return text("The session is not running.", "此会话未在运行。");
  if (session.status === "starting" || (session.mode === "chat" && (session.status === "running" || session.status === "waiting"))
    || ["running", "awaiting_approval", "awaiting_parent"].includes(session.activity?.state ?? "")) {
    return text("This session is working or waiting for your answer.", "此会话正在工作或在等待你的处理。");
  }
  if (!session.nativeId) return text("This session could not be continued later, so it cannot be stopped.", "此会话之后无法继续，所以不能停止。");
  const capability = providers.find(item => item.id === session.provider);
  if (!capability) return undefined;
  if (session.mode === "terminal" && capability.terminalResumeCapture === "none") {
    return text("This tool cannot continue a terminal later, so it cannot be stopped.", "此工具之后无法继续终端，所以不能停止。");
  }
  return undefined;
}

// The runtime refuses with `session_release_blocked: <reason>` or
// `session_release_unavailable: <reason>`, and Running agents reports the same
// reasons; show them in the reader's language: a full sentence and a short label.
const RELEASE_REASONS: [needle: string, en: string, zh: string, shortEn: string, shortZh: string][] = [
  ["working or waiting for your answer", "This session is working or waiting for your answer.", "此会话正在工作或在等待你的处理。", "Working", "工作中"],
  ["pending request", "Answer or dismiss its pending request first.", "请先回答或关闭它待处理的请求。", "Waiting for you", "等待你处理"],
  ["queued messages", "Send or remove its queued messages first.", "请先发送或删除它排队中的消息。", "Messages queued", "有排队消息"],
  ["background task", "A background task is still running. Stop it first.", "后台任务仍在运行，请先停止它。", "Background task", "后台任务运行中"],
  ["the session is busy", "This session is busy right now.", "此会话正忙。", "Busy", "忙碌"],
  ["read-only history", "Read-only history has nothing to stop.", "只读历史记录无需停止。", "Read-only", "只读"],
  ["no native session id", "This session could not be continued later, so it cannot be stopped.", "此会话之后无法继续，所以不能停止。", "Can't continue later", "之后无法继续"],
  ["cannot resume a terminal", "This tool cannot continue a terminal later, so it cannot be stopped.", "此工具之后无法继续终端，所以不能停止。", "Can't continue later", "之后无法继续"],
];

/** What to show when a Stop request is refused: never the runtime code. */
export function releaseErrorText(caught: unknown, zh: boolean): string {
  const message = (caught instanceof Error ? caught.message : String(caught)).toLowerCase();
  const known = RELEASE_REASONS.find(([needle]) => message.includes(needle));
  if (known) return zh ? known[2] : known[1];
  return zh ? "此会话现在无法停止。" : "This session can't be stopped right now.";
}

/** A Running agents row's blocked reason: a short state label and its full sentence. */
export function releaseReasonLabel(reason: string, zh: boolean): { short: string; full: string } {
  const message = String(reason).toLowerCase();
  const known = RELEASE_REASONS.find(([needle]) => message.includes(needle));
  if (known) return zh ? { short: known[4], full: known[2] } : { short: known[3], full: known[1] };
  return zh ? { short: "无法停止", full: "此会话现在无法停止。" } : { short: "Can't stop now", full: "This session can't be stopped right now." };
}

export function releaseMenuLabel(zh: boolean): string {
  return zh ? "停止（释放资源）" : "Stop (release resources)";
}

/**
 * Archiving a project must not stop some sessions and then fail on a later one:
 * every live session is checked first, and a refusal names the sessions.
 */
export function archiveReleaseRefusals(
  sessions: readonly Pick<Session, "title" | "status" | "readOnly" | "mode" | "provider" | "nativeId" | "activity">[],
  providers: readonly ProviderCapability[],
  zh: boolean,
): { titles: string[]; reason: string } | undefined {
  const refused = sessions
    .filter(session => !session.readOnly && isLiveSession(session))
    .map(session => ({ title: session.title, reason: releaseBlockedReason(session, providers, zh) }))
    .filter((entry): entry is { title: string; reason: string } => Boolean(entry.reason));
  if (!refused.length) return undefined;
  const titles = refused.map(entry => entry.title);
  const reason = zh
    ? `以下会话无法停止：${titles.join("、")}。请先完成或关闭它们，再归档。`
    : `These sessions cannot be stopped: ${titles.join(", ")}. Finish or close them, then archive again.`;
  return { titles, reason };
}
/** Shared byte format for Running agents and the Stop idle label. */
export function formatMemory(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/** The project/worktree menu entry; `undefined` hides it when nothing is idle. */
export function idleMenuLabel(count: number, bytes: number | undefined, zh: boolean): string | undefined {
  if (count <= 0) return undefined;
  const size = formatMemory(bytes);
  return zh ? `停止空闲会话（${count}${size ? ` · ${size}` : ""}）` : `Stop idle sessions (${count}${size ? ` · ${size}` : ""})`;
}

/** The Running agents header line: "8 running · 5.2 GB". */
export function runningSummary(count: number, bytes: number | undefined, zh: boolean): string {
  const size = formatMemory(bytes);
  return zh ? `${count} 个运行中${size ? ` · ${size}` : ""}` : `${count} running${size ? ` · ${size}` : ""}`;
}

/** The Stop idle action beside that header. */
export function stopIdleLabel(count: number, bytes: number | undefined, zh: boolean): string {
  const size = formatMemory(bytes);
  return zh ? `停止空闲（${count}${size ? ` · ${size}` : ""}）` : `Stop idle (${count}${size ? ` · ${size}` : ""})`;
}

