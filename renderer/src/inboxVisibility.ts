export function isActionableInboxItem(item: { read: boolean; kind: string }): boolean {
  return !item.read && item.kind !== "stalled" && item.kind !== "reply";
}

export function inboxEventGroup(kind: string): string {
  if (kind === "error") return "failed";
  if (kind === "completed" || kind === "reply") return "review";
  // A quiet delegate needs a decision (check, wait or stop), so it sits with Input.
  if (kind === "attention" || kind === "quiet") return "waiting";
  return kind;
}

export function inboxKindLabel(kind: string, zh: boolean): string {
  if (kind === "quiet") return zh ? "无活动" : "No activity";
  const group = inboxEventGroup(kind);
  if (group === "approval") return zh ? "待确认" : "Approval";
  if (group === "waiting") return zh ? "待输入" : "Input";
  if (group === "failed") return zh ? "失败" : "Failed";
  if (group === "review") return zh ? "待复核" : "Review";
  return zh ? "需要处理" : "Needs attention";
}
