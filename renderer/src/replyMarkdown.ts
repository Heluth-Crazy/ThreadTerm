import type { ChatItem, ChatPart } from '@threadterm/protocol';

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * A reply text part is a Markdown body the assistant wrote as its answer.
 * Commentary, the plan-usage card and empty bodies are not replies. Tool,
 * thinking and sub-agent parts are never text parts, so they are excluded.
 */
export function isReplyTextPart(part: ChatPart): boolean {
  if (part.type !== 'text' || typeof part.text !== 'string' || !part.text.trim()) return false;
  if (part.phase === 'commentary') return false;
  if (asRecord(part.data).kind === 'plan') return false;
  return true;
}

/**
 * The reply's Markdown source: its final-answer text parts, joined with blank
 * lines when the native turn split the answer across several parts.
 */
export function replyMarkdown(item: ChatItem): string {
  if (item.role !== 'assistant') return '';
  return item.parts.filter(isReplyTextPart).map(part => (part.text ?? '').trim()).filter(Boolean).join('\n\n');
}
