import { normalizeContextItems, type ContextItem } from './chatContext';
import { validateMentionCatalogue, type MentionEntry } from './inlineMentions';
const header = '[ThreadTerm copied conversation v1]\n';
const draftV2Header = '[ThreadTerm draft v2]\n';
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

/** The runtime draft envelope v2: composer text, the live catalogue and an optional copied conversation. */
export type ForkDraftV2 = {
  text: string;
  mentions: MentionEntry[];
  copiedConversation?: { copiedAt: string; transcript: string };
};

export function encodeForkDraftV2(draft: ForkDraftV2): string {
  return draftV2Header + JSON.stringify({
    text: draft.text,
    mentions: draft.mentions,
    ...(draft.copiedConversation ? { copiedConversation: draft.copiedConversation } : {}),
  });
}

/**
 * Decodes v2. Invalid mention entries are dropped individually without losing
 * the text; a malformed envelope returns `undefined` and stays plain text.
 */
export function decodeForkDraftV2(value: string): ForkDraftV2 | undefined {
  try {
    if (typeof value !== 'string' || value.length > 1024 * 1024 || !value.startsWith(draftV2Header)) return undefined;
    const parsed = JSON.parse(value.slice(draftV2Header.length));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.text !== 'string') return undefined;
    const mentions = validateMentionCatalogue(parsed.mentions);
    let copiedConversation: ForkDraftV2['copiedConversation'];
    if (parsed.copiedConversation !== undefined) {
      const candidate = parsed.copiedConversation;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        && typeof candidate.copiedAt === 'string' && candidate.copiedAt.trim() && candidate.copiedAt.length <= 4096 && !/[\r\n]/.test(candidate.copiedAt)
        && typeof candidate.transcript === 'string' && new TextEncoder().encode(candidate.transcript).length <= 64 * 1024) {
        copiedConversation = { copiedAt: candidate.copiedAt, transcript: candidate.transcript };
      }
    }
    return { text: parsed.text, mentions, ...(copiedConversation ? { copiedConversation } : {}) };
  } catch { return; }
}
