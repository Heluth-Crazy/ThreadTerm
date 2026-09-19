export function isActionableInboxItem(item: { read: boolean; kind: string }): boolean {
  return !item.read && item.kind !== "stalled" && item.kind !== "reply";
}

export function inboxEventGroup(kind: string): string {
  if (kind === "error") return "failed";
  if (kind === "completed" || kind === "reply") return "review";
  if (kind === "attention") return "waiting";
  return kind;
}

export function inboxKindLabel(kind: string, zh: boolean): string {
  const group = inboxEventGroup(kind);
  if (group === "approval") return zh ? "待确认" : "Approval";
  if (group === "waiting") return zh ? "待输入" : "Input";
  if (group === "failed") return zh ? "失败" : "Failed";
  if (group === "review") return zh ? "待复核" : "Review";
  return zh ? "需要处理" : "Needs attention";
}
