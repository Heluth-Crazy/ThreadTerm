import type { ContextItem } from './chatContext';
import { MAX_CONTEXT_ITEMS, normalizeSingleContextItem } from './chatContext';

export type MentionableItem = Extract<ContextItem, { kind: 'file' | 'session' | 'commit' | 'agent' | 'skill' }>;
export type MentionEntry = { token: string; item: MentionableItem };
/** The catalogue only grows within one composer lifetime; no eviction. */
export const MAX_MENTION_CATALOGUE = 64;
/** Labels are bounded to this many UTF-16 code units before a token is built. */
const MENTION_LABEL_LIMIT = 40;

const MENTIONABLE_KINDS = new Set<ContextItem['kind']>(['file', 'session', 'commit', 'agent', 'skill']);
const BARE_END = /[.,;:!?)\]}']$/;
// Han, Hiragana, Katakana, Bopomofo, Hangul, CJK radicals, symbols and fullwidth forms.
const CJK = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u31A0-\u31BF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\uAC00-\uD7AF]/;
const BEFORE_BOUNDARY = /[([{"'“‘（【「《]/;
// ASCII `'` is part of the binding boundary set (§3.3); without it `'@cart.ts'` loses its badge.
const AFTER_BOUNDARY = /[.,;:!?)}\]"'”’）】」》]/;

/** A token is `@bare` or `@"quoted"`, at most 64 UTF-16 code units. */
export function isValidMentionToken(token: string): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 64 || token[0] !== '@') return false;
  const rest = token.slice(1);
  if (rest.startsWith('"')) {
    if (rest.length < 2 || !rest.endsWith('"')) return false;
    const inner = rest.slice(1, -1);
    return inner.length > 0 && !/["\r\n]/.test(inner);
  }
  // The binding grammar (§3.1) forbids only whitespace and `"` inside a bare token; internal
  // commas and apostrophes are legal (only a *trailing* one of BARE_END is rejected).
  if (rest.length === 0 || /[\s"]/.test(rest)) return false;
  return !BARE_END.test(rest);
}

function slash(path: string): string { return path.trim().replace(/\\/g, '/'); }

/** Backslashes to slashes, a lower-case drive letter, no `./` segments, collapsed slashes. */
function normalizeIdentityPath(path: string): string {
  let value = slash(path).replace(/^([a-zA-Z]):\//, (_, drive: string) => `${drive.toLowerCase()}:/`);
  value = value.replace(/^\.\//, '').replace(/\/\.\//g, '/');
  const unc = value.startsWith('//');
  value = value.replace(/\/{2,}/g, '/');
  return unc ? `/${value}` : value;
}

function workspaceRelative(path: string, workspaceRoot?: string): string | undefined {
  if (!workspaceRoot) return undefined;
  const root = normalizeIdentityPath(workspaceRoot).replace(/\/+$/, '');
  if (!root) return undefined;
  const target = normalizeIdentityPath(path);
  const caseInsensitive = /^[a-z]:\//.test(root) || root.startsWith('//');
  const rootKey = caseInsensitive ? root.toLowerCase() : root;
  const targetKey = caseInsensitive ? target.toLowerCase() : target;
  if (targetKey === rootKey) return '';
  if (targetKey.startsWith(`${rootKey}/`)) return target.slice(root.length + 1);
  return undefined;
}

/** Whether an item names a file/directory path (used only for the identity key). */
function fileIdentityPath(item: Extract<ContextItem, { kind: 'file' }>, workspaceRoot?: string): string {
  const relative = workspaceRelative(item.path, workspaceRoot);
  return relative !== undefined ? relative : normalizeIdentityPath(item.path);
}

/** Semantic identity shared by tray attachments and mentions (`design-inline-mentions.md` §2.2). */
export function contextIdentityKey(item: ContextItem, workspaceRoot?: string): string {
  switch (item.kind) {
    case 'file': {
      const range = item.startLine !== undefined ? `#L${item.startLine}-${item.endLine ?? item.startLine}` : '';
      return `file:${fileIdentityPath(item, workspaceRoot)}${range}`;
    }
    case 'session': return `session:${item.sessionId}`;
    case 'commit': return `commit:${item.sha.toLowerCase()}`;
    case 'agent': return `agent:${item.provider}`;
    case 'skill': return `skill:${item.name}`;
    default: return item.id;
  }
}

/** The base label before the 40-unit bound; keeps a trailing `/` for directories. */
export function mentionLabelForItem(item: MentionableItem): string {
  switch (item.kind) {
    case 'file': {
      const value = slash(item.path);
      const directory = /\/$/.test(value);
      const base = value.split('/').filter(Boolean).at(-1) ?? item.path;
      return directory ? `${base}/` : base;
    }
    case 'session': return item.title;
    case 'commit': return item.sha.slice(0, 7).toLowerCase();
    case 'agent': return item.provider.toLowerCase();
    case 'skill': return item.name;
  }
}

/** Bounds a label to 40 UTF-16 code units on a code-point boundary, appending `…` when cut. */
function boundLabel(label: string): { label: string; cut: boolean } {
  if (label.length <= MENTION_LABEL_LIMIT) return { label, cut: false };
  let out = '';
  for (const point of label) {
    if (out.length + point.length + '…'.length > MENTION_LABEL_LIMIT) break;
    out += point;
  }
  return { label: `${out}…`, cut: true };
}

function tokenForLabel(label: string, forceQuote: boolean): string {
  // Quote when the *original* label needs it (§3.2 step 4), but never let CR/LF or `"` reach the
  // token: a quoted token rejects them, and a label made only of those would otherwise leave every
  // candidate invalid and spin the suffix loop forever.
  const cleaned = label.replace(/[\r\n]/g, ' ').replace(/"/g, "'");
  const needsQuote = forceQuote || /[\s"]/.test(label) || BARE_END.test(label);
  return needsQuote ? `@"${cleaned}"` : `@${cleaned}`;
}

/** The kind-specific fallback label (§3.2 step 5); `undefined` for kinds without one. */
function fallbackLabel(item: MentionableItem, workspaceRoot?: string): string | undefined {
  switch (item.kind) {
    case 'file': {
      const relative = workspaceRelative(item.path, workspaceRoot);
      const value = relative !== undefined && relative !== '' ? relative : normalizeIdentityPath(item.path);
      return value || undefined;
    }
    case 'session': return `${item.title} (${item.sessionId.slice(0, 6)})`;
    case 'commit': return item.sha.slice(0, 12).toLowerCase();
    case 'agent':
    case 'skill': return undefined;
  }
}

/** The stable token for an item: reuse the identity's token, otherwise generate a free one. */
export function inlineMentionToken(item: MentionableItem, catalogue: readonly MentionEntry[], workspaceRoot?: string): string {
  const key = contextIdentityKey(item, workspaceRoot);
  const existing = catalogue.find(entry => contextIdentityKey(entry.item, workspaceRoot) === key);
  if (existing) return existing.token;
  const used = new Set(catalogue.map(entry => entry.token));
  const bounded = boundLabel(mentionLabelForItem(item));
  const fallback = fallbackLabel(item, workspaceRoot);
  const candidates = [tokenForLabel(bounded.label, bounded.cut)];
  if (fallback !== undefined) {
    const boundedFallback = boundLabel(fallback);
    candidates.push(tokenForLabel(boundedFallback.label, boundedFallback.cut));
  }
  for (const candidate of candidates) if (isValidMentionToken(candidate) && !used.has(candidate)) return candidate;
  // The catalogue holds at most 64 entries, so 65 distinct suffixed candidates cannot all be used;
  // bound the loop instead of trusting that invariant at runtime.
  for (let suffix = 2; suffix <= MAX_MENTION_CATALOGUE + 2; suffix += 1) {
    const candidate = tokenForLabel(`${bounded.label}~${suffix}`, bounded.cut);
    if (isValidMentionToken(candidate) && !used.has(candidate)) return candidate;
  }
  // Guaranteed-valid final fallback: `@mentionN` is always a legal token, and the used set is finite.
  for (let index = 1; index <= MAX_MENTION_CATALOGUE + 1; index += 1) {
    const candidate = `@mention${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('mention catalogue has no free token');
}

/** Reserves the identity's token, or reports `capacity` once 64 identities exist (no eviction). */
export function addMentionEntry(catalogue: readonly MentionEntry[], item: MentionableItem, workspaceRoot?: string): { catalogue: MentionEntry[]; token: string } | { error: 'capacity' } {
  const key = contextIdentityKey(item, workspaceRoot);
  const existing = catalogue.find(entry => contextIdentityKey(entry.item, workspaceRoot) === key);
  if (existing) return { catalogue: [...catalogue], token: existing.token };
  if (catalogue.length >= MAX_MENTION_CATALOGUE) return { error: 'capacity' };
  const token = inlineMentionToken(item, catalogue, workspaceRoot);
  return { catalogue: [...catalogue, { token, item }], token };
}

/**
 * Validates a persisted catalogue: each entry individually, at most 64, first
 * wins on duplicate tokens or identities. Invalid entries drop without text.
 */
export function validateMentionCatalogue(value: unknown, workspaceRoot?: string): MentionEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: MentionEntry[] = [];
  const tokens = new Set<string>();
  const identities = new Set<string>();
  for (const candidate of value) {
    if (entries.length >= MAX_MENTION_CATALOGUE) break;
    if (!candidate || typeof candidate !== 'object') continue;
    const { token, item } = candidate as { token?: unknown; item?: unknown };
    if (typeof token !== 'string' || !isValidMentionToken(token) || tokens.has(token)) continue;
    const normalized = normalizeSingleContextItem(item);
    if (!normalized || !MENTIONABLE_KINDS.has(normalized.kind)) continue;
    const key = contextIdentityKey(normalized, workspaceRoot);
    if (identities.has(key)) continue;
    tokens.add(token);
    identities.add(key);
    entries.push({ token, item: normalized as MentionableItem });
  }
  return entries;
}

export type ResolvedMention = { start: number; end: number; token: string; itemId: string };

function boundaryBefore(text: string, index: number): boolean {
  if (index === 0) return true;
  const char = text[index - 1]!;
  return /\s/.test(char) || BEFORE_BOUNDARY.test(char) || CJK.test(char);
}

function boundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const char = text[index]!;
  return /\s/.test(char) || AFTER_BOUNDARY.test(char) || CJK.test(char);
}

/** A `{token, itemId}` pair: the resolution rule needs no full catalogue entry. */
export type MentionTokenPair = { token: string; itemId: string };

/** The shared occurrence + overlap selection rule over plain token/identity pairs. */
function resolveRanges(text: string, tokens: readonly MentionTokenPair[]): ResolvedMention[] {
  if (typeof text !== 'string' || text.length === 0 || tokens.length === 0) return [];
  const found: ResolvedMention[] = [];
  for (const entry of tokens) {
    const token = entry.token;
    let from = 0;
    while (from <= text.length - token.length) {
      const start = text.indexOf(token, from);
      if (start < 0) break;
      const end = start + token.length;
      if (boundaryBefore(text, start) && boundaryAfter(text, end)) found.push({ start, end, token, itemId: entry.itemId });
      from = start + 1;
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const resolved: ResolvedMention[] = [];
  let cursor = 0;
  for (const candidate of found) {
    if (candidate.start < cursor) continue;
    resolved.push(candidate);
    cursor = candidate.end;
  }
  return resolved;
}

/**
 * Every place a catalogue token occurs with word/CJK boundaries. Overlaps are
 * resolved by start index and, at the same start, the longer token wins.
 */
export function resolveMentions(text: string, catalogue: readonly MentionEntry[]): ResolvedMention[] {
  return resolveRanges(text, catalogue.map(entry => ({ token: entry.token, itemId: entry.item.id })));
}

/** The same rule over raw `{token, itemId}` pairs (message envelopes resolve their map once). */
export function resolveMentionTokens(text: string, tokens: readonly MentionTokenPair[]): ResolvedMention[] {
  return resolveRanges(text, tokens);
}

/** Catalogue entries that own at least one resolved range, in catalogue order. */
export function activeMentionEntries(catalogue: readonly MentionEntry[], resolved: readonly ResolvedMention[]): MentionEntry[] {
  if (resolved.length === 0) return [];
  const active = new Set(resolved.map(range => range.token));
  return catalogue.filter(entry => active.has(entry.token));
}

/** The resolved range that contains the caret; `start < caret <= end`. */
export function mentionAtCaret(resolved: readonly ResolvedMention[], caret: number): ResolvedMention | undefined {
  return resolved.find(range => range.start < caret && caret <= range.end);
}

/** The whole-token range a Backspace/Delete should remove, or `undefined` for native behavior. */
export function deletionRange(resolved: readonly ResolvedMention[], caret: number, key: 'Backspace' | 'Delete'): { start: number; end: number } | undefined {
  const hit = key === 'Backspace'
    ? resolved.find(range => range.start < caret && caret <= range.end)
    : resolved.find(range => range.start <= caret && caret < range.end);
  return hit ? { start: hit.start, end: hit.end } : undefined;
}

/** Splits text into plain and mention runs; joining the texts restores the input. */
export function highlightSegments(text: string, resolved: readonly ResolvedMention[]): Array<{ text: string; mention?: ResolvedMention }> {
  const segments: Array<{ text: string; mention?: ResolvedMention }> = [];
  let position = 0;
  for (const mention of resolved) {
    if (mention.start > position) segments.push({ text: text.slice(position, mention.start) });
    segments.push({ text: text.slice(mention.start, mention.end), mention });
    position = mention.end;
  }
  if (position < text.length) segments.push({ text: text.slice(position) });
  return segments;
}

/** Unique identities across tray attachments and active mentions (≤ 12). */
export function contextIdentityBudget(trayItems: readonly ContextItem[], active: readonly MentionEntry[], workspaceRoot?: string): { identities: number; ok: boolean } {
  const identities = new Set<string>();
  for (const item of trayItems) identities.add(contextIdentityKey(item, workspaceRoot));
  for (const entry of active) identities.add(contextIdentityKey(entry.item, workspaceRoot));
  return { identities: identities.size, ok: identities.size <= MAX_CONTEXT_ITEMS };
}
