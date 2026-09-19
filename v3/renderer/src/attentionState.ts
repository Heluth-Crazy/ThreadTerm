export type Attention = { id: string; sessionId: string; kind: string; title?: string; provider?: string };

export function attentionFromEvent(event: { event: string; data: unknown }): Attention | undefined {
  if (event.event !== "inbox.created" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) return undefined;
  const value = event.data as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id || typeof value.sessionId !== "string" || !value.sessionId || typeof value.kind !== "string" || !value.kind) return undefined;
  return {
    id: value.id,
    sessionId: value.sessionId,
    kind: value.kind,
    title: typeof value.title === "string" && value.title.trim() ? value.title : undefined,
    provider: typeof value.provider === "string" && value.provider.trim() ? value.provider : undefined,
  };
}

export function shouldPresentAttention(options: {
  attention: Attention;
  routeKind: string;
  routeId?: string;
  initialized: boolean;
  seen: Set<string>;
}): boolean {
  const { attention, routeKind, routeId, initialized, seen } = options;
  if (seen.has(attention.id)) return false;
  seen.add(attention.id);
  if (!initialized || routeKind === "inbox") return false;
  if (routeKind === "session" && routeId === attention.sessionId) return false;
  return true;
}

export function providerLabel(provider?: string): string {
  if (!provider) return "";
  return provider === "claude" ? "Claude Code" : provider === "opencode" ? "OpenCode" : provider[0].toUpperCase() + provider.slice(1);
}

export function attentionNotice(
  attention: Attention,
  locale: "en" | "zh-CN",
  session?: { title?: string; provider?: string },
): { heading: string; detail: string; action: string } {
  const zh = locale === "zh-CN";
  const heading = session?.title?.trim() || attention.title?.trim() || (zh ? "未命名会话" : "Untitled session");
  const provider = providerLabel(session?.provider || attention.provider);
  const reason = attention.kind === "reply"
    ? (zh ? "有新的结构化回复，需要你查看。" : "has a new structured reply.")
    : attention.kind === "approval" || attention.kind === "waiting"
      ? (zh ? "正在等待你的批准。" : "is waiting for your approval.")
      : attention.kind === "error"
        ? (zh ? "的提供方请求失败，需要你处理。" : "had a provider request fail.")
        : (zh ? "有需要你处理的事项。" : "needs your attention.");
  return {
    heading,
    detail: provider ? (zh ? `${provider} · ${reason}` : `${provider} ${reason}`) : reason,
    action: zh ? "打开会话" : "Open session",
  };
}
