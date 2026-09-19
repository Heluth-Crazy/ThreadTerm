import type { ChatApprovalChoice, ChatApprovalData, ChatApprovalKind, ChatApprovalScope, ChatPart } from "@threadterm/protocol";

export function approvalData(part: ChatPart): ChatApprovalData | undefined {
  if (part.type !== "approval" || !isRecord(part.data)) return undefined;
  const data = part.data;
  const choices = Array.isArray(data.choices) ? data.choices.filter(isChoice).map(asChoice) : [];
  const approvalId = typeof data.approvalId === "string" ? data.approvalId : part.approvalId;
  if (!approvalId) return undefined;
  return {
    approvalId,
    sessionId: stringField(data.sessionId),
    turnId: stringField(data.turnId),
    provider: isProvider(data.provider) ? data.provider : undefined,
    requestType: stringField(data.requestType),
    title: stringField(data.title),
    details: data.details,
    choices,
    interaction: data.interaction === "userInput" || data.interaction === "elicitation" || data.interaction === "permission" || data.interaction === "unknown"
      ? data.interaction
      : undefined,
    submittable: data.submittable === true && choices.length > 0,
  };
}

export function approvalButtonsEnabled(part: ChatPart, writable: boolean): boolean {
  if (!writable || part.status !== "pending") return false;
  const data = approvalData(part);
  return Boolean(data?.submittable);
}

export function scopeLabel(scope: ChatApprovalScope, copy: (en: string, zh: string) => string): string {
  if (scope === "once") return copy("This time", "仅本次");
  if (scope === "turn") return copy("This turn", "本轮");
  if (scope === "session") return copy("This session", "本次会话");
  if (scope === "persistent") return copy("Always", "始终");
  return copy("Unknown scope", "范围未知");
}

export function kindLabel(kind: ChatApprovalKind, copy: (en: string, zh: string) => string): string {
  if (kind === "allow") return copy("Allow", "允许");
  if (kind === "deny") return copy("Deny", "拒绝");
  if (kind === "cancel") return copy("Cancel", "取消");
  return copy("Other", "其他");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChoice(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.choiceId === "string" && value.choiceId.length > 0;
}

function asChoice(value: Record<string, unknown>): ChatApprovalChoice {
  const kind = value.kind === "allow" || value.kind === "deny" || value.kind === "cancel" || value.kind === "other" ? value.kind : "other";
  const scope = value.scope === "once" || value.scope === "turn" || value.scope === "session" || value.scope === "persistent" || value.scope === "unknown"
    ? value.scope
    : "unknown";
  return {
    choiceId: String(value.choiceId),
    label: typeof value.label === "string" && value.label ? value.label : String(value.choiceId),
    kind,
    scope,
    description: typeof value.description === "string" ? value.description : undefined,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isProvider(value: unknown): value is ChatApprovalData["provider"] {
  return value === "codex" || value === "claude" || value === "kimi" || value === "gemini" || value === "opencode" || value === "grok" || value === "shell" || value === "custom";
}
