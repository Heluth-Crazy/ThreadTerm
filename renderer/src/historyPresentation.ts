import type { ChatItem, ChatPart, Session } from "@threadterm/protocol";
import { shouldRenderPart } from "./chatPresentation";

type Copy = (en: string, zh: string) => string;
export type HistoryPreview = { text?: string; complete: boolean; issue?: string };

export function historyRenderablePart(part: ChatPart): boolean {
  return shouldRenderPart(part) || part.type === "text" && typeof part.text !== "string" && typeof part.data === "string" && Boolean(part.data);
}

/** Only conversation text belongs in a card preview; reasoning/tools are disclosures. */
export function historyChatPreview(items: ChatItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = item.parts.filter(part => part.type === "text")
      .map(part => typeof part.text === "string" ? part.text : typeof part.data === "string" ? part.data : "").join("");
    if (text.trim()) return text;
  }
  return "";
}

export function historyOpenLabel(session: Pick<Session, "mode" | "readOnly">, copy: Copy): string {
  if (session.readOnly) return copy("Open transcript", "打开记录");
  return session.mode === "chat" ? copy("Open chat", "打开 Chat") : copy("Open terminal", "打开终端");
}

export function historyPreviewText(session: Pick<Session, "mode" | "readOnly">, output: HistoryPreview | undefined, copy: Copy): string {
  if (output?.issue) return output.issue;
  if (!output?.complete) return copy("Reading recent output…", "正在读取最近输出…");
  return output.text?.trim() ? output.text : session.mode === "chat" || session.readOnly
    ? copy("No messages yet", "暂无消息") : copy("No output yet", "暂无输出");
}

export function historyToolStatus(status: string | undefined, copy: Copy): string {
  switch (status) {
    case "completed": case "complete": case "success": return copy("Completed", "已完成");
    case "failed": case "error": return copy("Failed", "失败");
    case "running": case "streaming": case "in_progress": return copy("In progress", "进行中");
    case "pending": return copy("Pending", "待处理");
    case "cancelled": case "canceled": return copy("Cancelled", "已取消");
    default: return copy("Recorded", "已记录");
  }
}
