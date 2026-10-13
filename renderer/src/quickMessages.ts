// Quick messages (task 10-11-chat-parity F3): saved composer snippets.
//
// The renderer keeps the runtime's bounds here as well: up to 50 items, a
// title of at most 200 characters and text of at most 4,000 characters. The
// runtime settings schema is the authority; these helpers keep the editor and
// the `+` menu from ever sending a value it would reject.
import type { QuickMessage } from '@threadterm/protocol';

export const MAX_QUICK_MESSAGES = 50;
export const MAX_QUICK_MESSAGE_TITLE = 200;
export const MAX_QUICK_MESSAGE_TEXT = 4000;

const controlCharacters = /[\u0000-\u001f\u007f]/;

/** Counts Unicode code points, matching the runtime's `chars().count()`. */
export function quickMessageLength(value: string): number {
  return [...value].length;
}

export function validQuickMessageId(id: string): boolean {
  return id.length > 0 && quickMessageLength(id) <= 128 && !controlCharacters.test(id);
}

/** Reads a persisted settings value. Invalid entries are dropped so a bad row cannot break the composer. */
export function parseQuickMessages(value: unknown): QuickMessage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const messages: QuickMessage[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    const title = typeof record.title === 'string' ? record.title : undefined;
    const text = typeof record.text === 'string' ? record.text : undefined;
    if (id === undefined || title === undefined || text === undefined) continue;
    if (!validQuickMessageId(id) || seen.has(id)) continue;
    if (!title.trim() || quickMessageLength(title) > MAX_QUICK_MESSAGE_TITLE) continue;
    if (!text.trim() || quickMessageLength(text) > MAX_QUICK_MESSAGE_TEXT) continue;
    seen.add(id);
    messages.push({ id, title, text });
    if (messages.length === MAX_QUICK_MESSAGES) break;
  }
  return messages;
}

/** Inserts `snippet` over the current selection and returns the new caret after it. */
export function insertQuickMessage(text: string, start: number, end: number, snippet: string): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: `${text.slice(0, from)}${snippet}${text.slice(to)}`, caret: from + snippet.length };
}

/** Moves one item by -1 (up) or +1 (down); out-of-range moves return a copy unchanged. */
export function moveQuickMessage(messages: readonly QuickMessage[], index: number, delta: -1 | 1): QuickMessage[] {
  const target = index + delta;
  if (index < 0 || index >= messages.length || target < 0 || target >= messages.length) return [...messages];
  const next = [...messages];
  next[index] = messages[target]!;
  next[target] = messages[index]!;
  return next;
}

/** A stable, unique id for a new message. */
export function createQuickMessageId(existing: readonly QuickMessage[] = []): string {
  const taken = new Set(existing.map(message => message.id));
  const random = globalThis.crypto?.randomUUID?.();
  if (random && !taken.has(random)) return random;
  let index = existing.length + 1;
  let candidate = `quick-message-${index}`;
  while (taken.has(candidate)) candidate = `quick-message-${++index}`;
  return candidate;
}
