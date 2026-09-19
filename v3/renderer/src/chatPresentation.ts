import type { ChatItem, ChatPart } from "@threadterm/protocol";

export function partBody(part: ChatPart): string {
  if (typeof part.text === "string") return part.text;
  if (typeof part.data === "string") return part.data;
  if (part.data == null) return "";
  return JSON.stringify(part.data, null, 2);
}

export function formatChatDuration(ms: number, zh: boolean): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return zh ? `用时 ${seconds}s` : `${seconds}s`;
  return zh ? `用时 ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

export function shouldRenderPart(part: ChatPart): boolean {
  if (part.type === "usage") return false;
  if (part.type === "text") return Boolean(part.text);
  if (part.type === "thinking") return Boolean(part.text) || part.status === "streaming";
  return true;
}

export function partLabel(part: ChatPart, copy: (en: string, zh: string) => string): string | undefined {
  if (part.type === "text" || part.type === "usage" || part.type === "thinking" || part.type === "status") return undefined;
  if (part.type === "tool") return part.toolName || copy("Tool", "工具");
  if (part.type === "approval") return copy("Approval required", "需要批准");
  if (part.type === "error") return copy("Error", "错误");
  return part.type;
}

export function chatCanControl(session: { readOnly?: boolean; status: string }): boolean {
  return !session.readOnly && session.status !== "exited";
}

export function itemShowsStreaming(item: ChatItem, items: ChatItem[]): boolean {
  if (item.elapsedMs != null || (item.turnId && items.some(entry => entry.turnId === item.turnId && entry.elapsedMs != null))) return false;
  const lastUser = lastIndex(items, (entry) => entry.role === "user");
  const lastAssistant = lastIndex(items, (entry) => entry.role === "assistant");
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0 || index !== lastAssistant) return false;
  if (lastUser >= 0 && lastAssistant < lastUser) return false;
  return item.parts.some((part) => part.status === "streaming" || part.status === "running");
}

export function slashQuery(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  if (text.includes("\n") || text.includes(" ")) return undefined;
  return text.slice(1).toLowerCase();
}

export function matchSlashCommands(query: string, commands: { name: string; description?: string }[]): { name: string; description?: string }[] {
  const needle = query.replace(/^\//, "").toLowerCase();
  return commands.filter((command) => command.name.replace(/^\//, "").toLowerCase().startsWith(needle));
}

export function activeTurnId(items: ChatItem[], sessionStatus?: string): string | undefined {
  // Persisted native parts can retain streaming flags after reload. Only the
  // runtime's current running/waiting state can authorize a stop action.
  if (sessionStatus !== undefined && sessionStatus !== 'running' && sessionStatus !== 'waiting') return undefined;
  const latest = [...items].reverse().find(item => item.turnId);
  if (!latest?.turnId) return undefined;
  const turnId = latest.turnId;
  if (items.some(item => item.turnId === turnId && item.elapsedMs != null)) return undefined;
  if (sessionStatus !== undefined) return turnId;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.turnId !== turnId) continue;
    if (item.parts.some((part) => part.status === "streaming" || part.status === "running" || (part.type === "approval" && part.status === "pending"))) {
      return item.turnId;
    }
  }
}

function lastIndex<T>(items: T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index]!)) return index;
  }
  return -1;
}
