export type InboxNotice = {
  kind: "approval" | "reply" | "error" | "waiting";
  sessionId?: string;
  title?: string;
  provider?: string;
};

function providerLabel(provider?: string): string {
  if (!provider) return "";
  return provider === "claude" ? "Claude Code" : provider === "opencode" ? "OpenCode" : provider[0].toUpperCase() + provider.slice(1);
}

export function inboxNotificationCopy(value: InboxNotice): { title: string; body: string } {
  const session = value.title?.trim();
  const provider = providerLabel(value.provider);
  const title = session || (value.kind === "reply" ? "ThreadTerm reply ready" : "ThreadTerm needs attention");
  const reason = value.kind === "approval" || value.kind === "waiting"
    ? "is waiting for your approval."
    : value.kind === "reply"
      ? "has a new structured reply."
      : "had a provider request fail.";
  const who = [provider, session].filter(Boolean).join(" · ");
  return { title, body: who ? `${who} ${reason}` : value.kind === "reply" ? "A provider reply is ready." : value.kind === "error" ? "A provider request failed." : "A provider is waiting for your approval." };
}