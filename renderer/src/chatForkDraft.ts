import { normalizeContextItems, type ContextItem } from './chatContext';
const header = '[ThreadTerm copied conversation v1]\n';
type Payload = {copiedAt: string; transcript: string; text: string};
type Conversation = Extract<ContextItem, {kind: 'conversation'}>;

/** Only the private runtime envelope becomes a chip; malformed/legacy drafts stay text. */
export function decodeCopiedConversationDraft(value: string): Payload | undefined {
  try {
    if (typeof value !== 'string' || value.length > 1024 * 1024 || !value.startsWith(header)) return;
    const parsed = JSON.parse(value.slice(header.length));
    if (typeof parsed?.copiedAt !== 'string' || !parsed.copiedAt.trim()
      || parsed.copiedAt.length > 4096 || /[\r\n]/.test(parsed.copiedAt)
      || typeof parsed?.transcript !== 'string'
      || new TextEncoder().encode(parsed.transcript).length > 64 * 1024
      || typeof parsed?.text !== 'string') return;
    return {copiedAt: parsed.copiedAt, transcript: parsed.transcript, text: parsed.text};
  } catch { return; }
}

export function encodeCopiedConversationDraft(items: ContextItem[], text: string): string {
  const conversation = normalizeContextItems(items).find((item): item is Conversation => item.kind === 'conversation');
  return conversation ? header + JSON.stringify({copiedAt: conversation.copiedAt, transcript: conversation.text, text}) : text;
}

export function copiedConversationItem(value: string, id = 'fork-context'): Conversation | undefined {
  const parsed = decodeCopiedConversationDraft(value);
  return parsed && {kind: 'conversation', id, copiedAt: parsed.copiedAt, text: parsed.transcript};
}
