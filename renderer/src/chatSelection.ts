export const quoteSelection = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n');

/** Both endpoints and every intersected text node must belong to one assistant Markdown reply. */
export function assistantSelection(selection: Selection | null, root: HTMLElement): { text: string; rect: DOMRect } | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const element = (node: Node) => node instanceof Element ? node : node.parentElement;
  const start = element(range.startContainer)?.closest<HTMLElement>('article.assistant .codex-markdown');
  const end = element(range.endContainer)?.closest<HTMLElement>('article.assistant .codex-markdown');
  if (!start || start !== end || !root.contains(start) || start.closest('.chat-tool-activity, .v3-tool-card, .v3-thinking, .subagent-card')) return;
  const text = selection.toString();
  if (!text.trim()) return;
  return { text, rect: range.getBoundingClientRect() };
}

export function selectionPosition(selection: { left: number; right: number; top: number; bottom: number }, pane: { left: number; right: number; top: number; bottom: number }, width: number, height: number) {
  const left = Math.max(pane.left + 8, Math.min((selection.left + selection.right - width) / 2, pane.right - width - 8));
  const above = selection.top - height - 6;
  const top = Math.max(pane.top + 8, Math.min(above < pane.top + 8 ? selection.bottom + 6 : above, pane.bottom - height - 8));
  return { left, top };
}
