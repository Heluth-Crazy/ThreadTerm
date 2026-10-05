export type InboxNotice = {
  kind: "approval" | "reply" | "error" | "waiting";
  sessionId?: string;
  title?: string;
  provider?: string;
  providerName?: string;
};
export type TerminalNotice = { status: string; exitCode?: number | null; title?: string; provider?: string; providerName?: string };
export type NotificationLocale = "en" | "zh-CN";

/** Same rule as the renderer: Chinese only when the user chose it, English otherwise (the default). */
export function notificationLocale(settings: unknown): NotificationLocale {
  const language = settings && typeof settings === "object" ? (settings as Record<string, unknown>).language : undefined;
  return language === "zh-CN" ? "zh-CN" : "en";
}

function providerLabel(provider?: string, providerName?: string): string {
  if (providerName) return providerName;
  if (!provider) return "";
  return provider === "claude" ? "Claude Code" : provider === "opencode" ? "OpenCode" : provider[0].toUpperCase() + provider.slice(1);
}

export function inboxNotificationCopy(value: InboxNotice, locale: NotificationLocale = "en"): { title: string; body: string } {
  const session = value.title?.trim();
  const provider = providerLabel(value.provider, value.providerName);
  const who = [provider, session].filter(Boolean).join(" · ");
  if (locale === "zh-CN") {
    const title = session || (value.kind === "reply" ? "ThreadTerm 有新回复" : "ThreadTerm 需要你处理");
    const reason = value.kind === "approval" || value.kind === "waiting" ? "正在等待你的批准。" : value.kind === "reply" ? "有新的结构化回复。" : "提供方请求失败。";
    return { title, body: who ? `${who}：${reason}` : value.kind === "reply" ? "提供方的回复已就绪。" : value.kind === "error" ? "提供方请求失败。" : "提供方正在等待你的批准。" };
  }
  const title = session || (value.kind === "reply" ? "ThreadTerm reply ready" : "ThreadTerm needs attention");
  const reason = value.kind === "approval" || value.kind === "waiting"
    ? "is waiting for your approval."
    : value.kind === "reply"
      ? "has a new structured reply."
      : "had a provider request fail.";
  return { title, body: who ? `${who} ${reason}` : value.kind === "reply" ? "A provider reply is ready." : value.kind === "error" ? "A provider request failed." : "A provider is waiting for your approval." };
}

/** Mirrors the runtime's exit inbox kinds (db.rs): exit code 0 finished, any other code failed, no code interrupted. */
function terminalOutcome(value: TerminalNotice): "finished" | "failed" | "interrupted" {
  if (value.status === "exited") return value.exitCode === 0 ? "finished" : typeof value.exitCode === "number" ? "failed" : "interrupted";
  return value.status === "error" ? "failed" : "interrupted";
}
/** Only a clean exit is a completion; a non-zero exit, a failure or an interruption needs attention. */
export function terminalNotificationKind(value: TerminalNotice): "completed" | "attention" {
  return terminalOutcome(value) === "finished" ? "completed" : "attention";
}
export function terminalNotificationCopy(value: TerminalNotice, locale: NotificationLocale = "en"): { title: string; body: string } {
  const session = value.title?.trim();
  const who = [providerLabel(value.provider, value.providerName), session].filter(Boolean).join(" · ");
  const outcome = terminalOutcome(value), code = typeof value.exitCode === "number" ? value.exitCode : undefined;
  if (locale === "zh-CN") {
    const reason = outcome === "finished" ? "已结束。" : outcome === "interrupted" ? "被中断。" : code === undefined ? "运行失败。" : `以退出码 ${code} 结束。`;
    return { title: session || (outcome === "finished" ? "终端会话已完成" : "终端会话需要你处理"), body: who ? `${who}：${reason}` : `终端会话${reason}` };
  }
  const reason = outcome === "finished" ? "finished." : outcome === "interrupted" ? "was interrupted." : code === undefined ? "failed." : `exited with code ${code}.`;
  return { title: session || (outcome === "finished" ? "Terminal session finished" : "Terminal session needs attention"), body: who ? `${who} ${reason}` : `The terminal session ${reason}` };
}

export function testNotificationCopy(locale: NotificationLocale = "en"): { title: string; body: string } {
  return locale === "zh-CN"
    ? { title: "ThreadTerm 通知已开启", body: "会话需要你处理或完成时，ThreadTerm 会这样提醒你。点击通知即可打开会话。" }
    : { title: "ThreadTerm notifications are on", body: "This is how ThreadTerm tells you a session needs you or has finished. Click a notification to open its session." };
}
