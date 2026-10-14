// Sent-message inline mention rendering (design-inline-mentions.md §8).
//
// A user message stores its versioned mention map as `token -> context block`.
// `layoutMessageMentions` resolves the whole map once with the shared mention
// rule, so:
//   * only the winning ranges become read-only badges in the user text;
//   * a mapped item whose token owns no winning range (edited away in the queue
//     editor, or lost an overlap to a longer token) keeps its fallback chip;
//   * items without an `inlineToken` keep their chip exactly as before.
import { contextDisplayMetadata, parseContext, type ContextItem, type ParsedContext, type ParsedContextItem } from './chatContext';
import { resolveMentionTokens, type ResolvedMention } from './inlineMentions';

/** A winning message range together with the chip metadata of its context block. */
export type MessageMentionBadge = ResolvedMention & {
  /** 0-based index into the parsed context items. */
  itemIndex: number;
  kind: ContextItem['kind'];
  label: string;
  title: string;
};

export type MessageMentionLayout = {
  /** Winning ranges in the user text, in order. */
  badges: MessageMentionBadge[];
  /** The whole resolution, so callers share one computation. */
  resolved: ResolvedMention[];
  /** Blocks that still render as chips: no token, or no winning range. */
  chipItems: ParsedContextItem[];
};

/** Resolves a parsed message's mention map over its user text exactly once. */
export function layoutMessageMentions(parsed: ParsedContext): MessageMentionLayout {
  const tokens = parsed.items.flatMap((item, index) => (item.inlineToken ? [{ token: item.inlineToken, itemId: String(index) }] : []));
  const resolved = resolveMentionTokens(parsed.text, tokens);
  const winners = new Set(resolved.map(range => range.itemId));
  const badges: MessageMentionBadge[] = resolved.map(range => {
    const itemIndex = Number(range.itemId);
    const metadata = contextDisplayMetadata(parsed.items[itemIndex]!.header);
    return {
      ...range,
      itemIndex,
      kind: metadata?.kind ?? 'file',
      label: metadata?.label ?? range.token,
      title: metadata?.title ?? range.token,
    };
  });
  return { badges, resolved, chipItems: parsed.items.filter((_, index) => !winners.has(String(index))) };
}

export type ParsedMessageMentions = { parsed: ParsedContext; layout: MessageMentionLayout };

// Sent-message text is immutable, but ChatView re-renders the whole transcript on
// every composer keystroke. Caching the parse + resolution + chip split by text
// keeps that work O(1) per rendered message instead of rescanning history. The
// cache is bounded so a long session cannot grow it without limit.
const parsedCache = new Map<string, ParsedMessageMentions | null>();
const PARSED_CACHE_LIMIT = 256;

/** Parses and lays out one message body once per distinct text. */
export function parseMessageMentions(text: string): ParsedMessageMentions | undefined {
  const cached = parsedCache.get(text);
  if (cached !== undefined) return cached ?? undefined;
  const parsed = parseContext(text);
  const entry: ParsedMessageMentions | null = parsed ? { parsed, layout: layoutMessageMentions(parsed) } : null;
  if (parsedCache.size >= PARSED_CACHE_LIMIT) {
    const oldest = parsedCache.keys().next().value;
    if (oldest !== undefined) parsedCache.delete(oldest);
  }
  parsedCache.set(text, entry);
  return entry ?? undefined;
}
