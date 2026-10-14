import { contextIdentityKey, isValidMentionToken, type MentionEntry } from './inlineMentions';

export const MAX_CONTEXT_ITEMS = 12;
export const MAX_CONTEXT_BYTES = 128 * 1024;
export const MAX_TERMINAL_LINES = 400;
export const MAX_TERMINAL_BYTES = 32 * 1024;
export const MAX_DIFF_BYTES = 32 * 1024;
export const MAX_SESSION_SUMMARY_BYTES = 16 * 1024;

export type TerminalContextItem = {
  kind: 'terminal'; id: string; sessionTitle: string; cwd?: string; lines: number; text: string;
};
export type FileContextItem = {
  kind: 'file'; id: string; path: string; startLine?: number; endLine?: number;
};
export type DiffContextItem = {
  kind: 'diff'; id: string; path: string; staged: boolean; text: string; truncated: boolean;
};
export type CommitContextItem = {
  kind: 'commit'; id: string; sha: string; subject: string;
};
export type ConversationContextItem = { kind: 'conversation'; id: string; copiedAt: string; text: string };
export type QuoteContextItem = { kind: 'quote'; id: string; sourceTitle: string; text: string };
/** A session referenced by `@`; the agent is told to read it with `session_info`. */
export type SessionContextItem = { kind: 'session'; id: string; sessionId: string; title: string; provider: string; summary?: string };
/** An agent mentioned by `@`; the following task is handed to it with `delegate_start`. */
export type AgentContextItem = { kind: 'agent'; id: string; provider: string };
/** A provider skill mentioned by `@`, carried as the provider-specific invocation. */
export type SkillContextItem = { kind: 'skill'; id: string; name: string; invocation: string };
export type ContextItem = TerminalContextItem | FileContextItem | DiffContextItem | CommitContextItem | ConversationContextItem | QuoteContextItem | SessionContextItem | AgentContextItem | SkillContextItem;

export type ParsedContextItem = { header: string; body: string; inlineToken?: string };
export type ParsedContext = { items: ParsedContextItem[]; text: string };
export type ContextDisplayMetadata = { kind: ContextItem['kind']; label: string; title: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const headerPrefix = /^\[ThreadTerm context (\d+)\/(\d+)\] (.+)$/;
const messageHeader = '[ThreadTerm message]';

function bytes(value: string) { return encoder.encode(value).byteLength; }
function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function oneLine(value: unknown): value is string { return nonEmptyString(value) && !/[\r\n]/.test(value) && value.length <= 4096; }
function nonNegativeLine(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function fileName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) || path; }
function lineCount(text: string) { return text ? text.split('\n').length : 0; }
function canonicalPath(path: string) {
  const slashed = path.trim().replace(/\\/g, '/');
  const isUnc = slashed.startsWith('//');
  const normalized = `${isUnc ? '//' : ''}${slashed.replace(/^\/+/, '').replace(/\/+/g, '/')}`;
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** Removes terminal CSI, OSC, and single-character ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[PX^_][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[\(\)][0-2AB]/g, '');
}

function truncateUtf8(value: string, limit: number, fromEnd = false): string {
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= limit) return value;
  const start = fromEnd ? encoded.byteLength - limit : 0;
  const end = fromEnd ? encoded.byteLength : limit;
  for (let offset = 0; offset < 4; offset++) {
    try { return decoder.decode(encoded.slice(fromEnd ? start + offset : start, fromEnd ? end : end - offset)); }
    catch { /* Move to a UTF-8 character boundary. */ }
  }
  throw new Error('Could not truncate context text safely. / 无法安全截断上下文文本。');
}

function normalizeTerminal(item: TerminalContextItem): TerminalContextItem {
  const text = truncateUtf8(stripAnsi(item.text).replace(/\r\n/g, '\n').split('\n').slice(-MAX_TERMINAL_LINES).join('\n'), MAX_TERMINAL_BYTES, true);
  return { ...item, sessionTitle: item.sessionTitle.trim(), cwd: item.cwd?.trim() || undefined, text, lines: lineCount(text) };
}

function normalizeDiff(item: DiffContextItem): DiffContextItem {
  const text = truncateUtf8(item.text, MAX_DIFF_BYTES);
  return { ...item, path: item.path.trim(), text, truncated: item.truncated || text !== item.text };
}

function assertContextItem(value: unknown): asserts value is ContextItem {
  if (!value || typeof value !== 'object') throw new Error('Invalid context attachment. / 无效的上下文附件。');
  const item = value as Partial<ContextItem>;
  if (!nonEmptyString(item.id) || !nonEmptyString(item.kind)) throw new Error('Invalid context attachment. / 无效的上下文附件。');
  if (item.kind === 'terminal' && oneLine(item.sessionTitle) && nonNegativeLine(item.lines) && typeof item.text === 'string' && (item.cwd === undefined || oneLine(item.cwd))) return;
  if (item.kind === 'file' && oneLine(item.path) && (item.startLine === undefined || nonNegativeLine(item.startLine) && item.startLine > 0) && (item.endLine === undefined || nonNegativeLine(item.endLine) && item.endLine > 0) && !(item.endLine !== undefined && item.startLine === undefined)) return;
  if (item.kind === 'diff' && oneLine(item.path) && typeof item.staged === 'boolean' && typeof item.text === 'string' && typeof item.truncated === 'boolean') return;
  if (item.kind === 'commit' && /^[a-f0-9]{7,64}$/i.test(item.sha ?? '') && oneLine(item.subject)) return;
  if (item.kind === 'conversation' && oneLine(item.copiedAt) && typeof item.text === 'string' && bytes(item.text) <= 64 * 1024) return;
  if (item.kind === 'quote' && oneLine(item.sourceTitle) && nonEmptyString(item.text) && bytes(item.text) <= MAX_TERMINAL_BYTES) return;
  if (item.kind === 'session' && /^[A-Za-z0-9._:-]{1,128}$/.test(item.sessionId ?? '') && oneLine(item.title) && /^[A-Za-z0-9._-]{1,64}$/.test(item.provider ?? '') && (item.summary === undefined || (typeof item.summary === 'string' && bytes(item.summary) <= MAX_SESSION_SUMMARY_BYTES))) return;
  if (item.kind === 'agent' && /^[A-Za-z0-9._-]{1,64}$/.test(item.provider ?? '')) return;
  if (item.kind === 'skill' && oneLine(item.name) && oneLine(item.invocation)) return;
  throw new Error('Invalid context attachment. / 无效的上下文附件。');
}

/** Validates persisted input, applies source limits, and removes duplicate file ranges. */
export function normalizeContextItems(items: unknown): ContextItem[] {
  if (!Array.isArray(items)) throw new Error('Invalid context attachments. / 无效的上下文附件。');
  const seenFileRanges = new Set<string>();
  const normalized: ContextItem[] = [];
  for (const candidate of items) {
    assertContextItem(candidate);
    if (candidate.kind === 'file') {
      if (candidate.endLine !== undefined && candidate.startLine !== undefined && candidate.endLine < candidate.startLine) {
        throw new Error('Invalid file line range. / 无效的文件行范围。');
      }
      const key = `${canonicalPath(candidate.path)}\u0000${candidate.startLine ?? ''}\u0000${candidate.endLine ?? ''}`;
      if (seenFileRanges.has(key)) continue;
      seenFileRanges.add(key);
      normalized.push({ ...candidate, path: candidate.path.trim() });
    } else if (candidate.kind === 'terminal') normalized.push(normalizeTerminal(candidate));
    else if (candidate.kind === 'diff') normalized.push(normalizeDiff(candidate));
    else if (candidate.kind === 'commit') normalized.push({ ...candidate, sha: candidate.sha.trim(), subject: candidate.subject.trim() });
    else if (candidate.kind === 'quote') normalized.push({ ...candidate });
    else if (candidate.kind === 'session') normalized.push({ ...candidate, sessionId: candidate.sessionId.trim(), title: candidate.title.trim(), provider: candidate.provider.trim() });
    else if (candidate.kind === 'agent') normalized.push({ ...candidate, provider: candidate.provider.trim() });
    else if (candidate.kind === 'skill') normalized.push({ ...candidate, name: candidate.name.trim(), invocation: candidate.invocation.trim() });
    else normalized.push({ ...candidate, copiedAt: candidate.copiedAt.trim() });
  }
  if (normalized.length > MAX_CONTEXT_ITEMS) throw new Error('Attach at most 12 context items. / 最多附加 12 个上下文项。');
  return normalized;
}

/** Validates and normalizes a single item with the exact same shape checks as the tray. */
export function normalizeSingleContextItem(value: unknown): ContextItem | undefined {
  try { assertContextItem(value); } catch { return undefined; }
  try { return normalizeContextItems([value])[0]; } catch { return undefined; }
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
}

function fence(value: string) { return '`'.repeat(Math.max(4, longestBacktickRun(value) + 1)); }

function itemHeader(item: ContextItem): string {
  switch (item.kind) {
    case 'terminal': return `Terminal output — "${item.sessionTitle}"${item.cwd ? ` (${item.cwd})` : ''}, last ${item.lines} ${item.lines === 1 ? 'line' : 'lines'}`;
    case 'file': return `File: ${item.path}${item.startLine ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ''}` : ''}`;
    case 'diff': return `Uncommitted diff — ${item.path} (${item.staged ? 'staged' : 'unstaged'}${item.truncated ? '; truncated' : ''})`;
    case 'commit': return `Commit ${item.sha} — ${item.subject}`;
    case 'conversation': return `Conversation up to ${item.copiedAt} (copied)`;
    case 'quote': return `Quote: ${item.sourceTitle}`;
    case 'session': return item.summary
      ? `Session ${item.sessionId}: ${item.title} (${item.provider}). Summary attached; session_info unavailable.`
      : `Session ${item.sessionId}: ${item.title} (${item.provider}). Call session_info with this id.`;
    case 'agent': return `Agent: delegate the following task to ${item.provider} with delegate_start.`;
    case 'skill': return `Skill: ${item.name} (invoke: ${item.invocation})`;
  }
}

function itemBody(item: ContextItem): string {
  if (item.kind === 'session') {
    if (!item.summary) return '';
    const marker = fence(item.summary);
    return `${marker}text\n${item.summary}\n${marker}`;
  }
  if (item.kind !== 'terminal' && item.kind !== 'diff' && item.kind !== 'conversation' && item.kind !== 'quote') return '';
  const marker = fence(item.text);
  return `${marker}${item.kind === 'diff' ? 'diff' : 'text'}\n${item.text}\n${marker}`;
}

/** Returns the exact context blocks that will precede the user's message. */
export function contextSerializedBlocks(items: unknown): string[] {
  const normalized = normalizeContextItems(items);
  return normalized.map((item, index) => {
    const header = `[ThreadTerm context ${index + 1}/${normalized.length}] ${itemHeader(item)}`;
    const body = itemBody(item);
    return body ? `${header}\n${body}` : header;
  });
}

/** Serializes bounded context before the user's message. */
export function serializeContext(items: unknown, text: string): string {
  if (typeof text !== 'string') throw new Error('Invalid message text. / 无效的消息文本。');
  const blocks = contextSerializedBlocks(items);
  const serialized = blocks.length ? `${blocks.join('\n')}\n${messageHeader}\n${text}` : text;
  if (bytes(serialized) > MAX_CONTEXT_BYTES) {
    throw new Error('Context attachments and message must not exceed 128 KiB. / 上下文附件和消息总大小不能超过 128 KiB。');
  }
  return serialized;
}

export type ContextEnvelopeInput = { trayItems: readonly ContextItem[]; active: readonly MentionEntry[]; workspaceRoot?: string };

/**
 * The merged composer context: one block per identity (tray data wins) plus the
 * block index of every live token. Shared by the send envelope and §9 Show details
 * so both always agree on the `i/n` numbering.
 */
function mergedMentionBlocks(input: ContextEnvelopeInput): { blocks: string[]; tokenIndex: Map<string, number> } {
  const { trayItems, active, workspaceRoot } = input;
  if (!Array.isArray(trayItems) || !Array.isArray(active)) throw new Error('Invalid context attachments. / 无效的上下文附件。');
  const order: string[] = [];
  const itemByIdentity = new Map<string, ContextItem>();
  const tokenByIdentity = new Map<string, string>();
  for (const item of trayItems) {
    const key = contextIdentityKey(item, workspaceRoot);
    if (!itemByIdentity.has(key)) { itemByIdentity.set(key, item); order.push(key); }
  }
  for (const entry of active) {
    const key = contextIdentityKey(entry.item, workspaceRoot);
    if (!itemByIdentity.has(key)) { itemByIdentity.set(key, entry.item); order.push(key); }
    tokenByIdentity.set(key, entry.token);
  }
  if (order.length > MAX_CONTEXT_ITEMS) throw new Error('Attach at most 12 context items. / 最多附加 12 个上下文项。');
  const blocks = contextSerializedBlocks(order.map(key => itemByIdentity.get(key)!));
  const tokenIndex = new Map<string, number>();
  order.forEach((key, index) => {
    const token = tokenByIdentity.get(key);
    if (token) tokenIndex.set(token, index + 1);
  });
  return { blocks, tokenIndex };
}

/**
 * The exact merged block for one live mention token (tray data wins), so Show
 * details previews the same `i/n` block the submission envelope would carry.
 */
export function mentionSerializedBlock(input: ContextEnvelopeInput, token: string): string | undefined {
  const { blocks, tokenIndex } = mergedMentionBlocks(input);
  const index = tokenIndex.get(token);
  return index === undefined ? undefined : blocks[index - 1];
}

/**
 * Serializes the context tray plus the active mentions: one block per identity
 * (tray data wins) and a `mentions v1` map from each live token to its block.
 */
export function serializeMentionedContext(input: ContextEnvelopeInput, text: string): string {
  if (typeof text !== 'string') throw new Error('Invalid message text. / 无效的消息文本。');
  const { blocks, tokenIndex } = mergedMentionBlocks(input);
  const mentions: Record<string, number> = {};
  for (const [token, index] of tokenIndex) mentions[token] = index;
  const header = tokenIndex.size ? `[ThreadTerm message; mentions v1 ${JSON.stringify(mentions)}]` : messageHeader;
  const serialized = blocks.length ? `${blocks.join('\n')}\n${header}\n${text}` : text;
  if (bytes(serialized) > MAX_CONTEXT_BYTES) {
    throw new Error('Context attachments and message must not exceed 128 KiB. / 上下文附件和消息总大小不能超过 128 KiB。');
  }
  return serialized;
}

function headerKind(header: string): ContextItem['kind'] | undefined {
  if (header.includes('\r')) return undefined;
  const match = headerPrefix.exec(header);
  if (!match) return undefined;
  const value = match[3]!;
  if (/^Terminal output — "[^\n]+"(?: \([^\n]+\))?, last \d+ lines?$/.test(value)) return 'terminal';
  if (/^File: .+$/.test(value)) return 'file';
  if (/^Uncommitted diff — .+ \((?:staged|unstaged)(?:; truncated)?\)$/.test(value)) return 'diff';
  if (/^Commit [0-9a-fA-F]{7,64} — .+$/.test(value)) return 'commit';
  if (/^Conversation up to .+ \(copied\)$/.test(value)) return 'conversation';
  if (/^Quote: .+$/.test(value)) return 'quote';
  if (/^Session [A-Za-z0-9._:-]{1,128}: .+ \([A-Za-z0-9._-]+\)\. (?:Call session_info with this id\.|Summary attached; session_info unavailable\.)$/.test(value)) return 'session';
  if (/^Agent: delegate the following task to [A-Za-z0-9._-]{1,64} with delegate_start\.$/.test(value)) return 'agent';
  if (/^Skill: .+ \(invoke: .+\)$/.test(value)) return 'skill';
  return undefined;
}

type ParsedItemHeader = { number: number; total: number; value: string; kind: ContextItem['kind'] };

/** The single envelope parser used by `parseContext` and `contextDisplayMetadata`. */
function parseItemHeader(header: string): ParsedItemHeader | undefined {
  if (header.includes('\r')) return undefined;
  const match = headerPrefix.exec(header);
  const kind = headerKind(header);
  if (!match || !kind) return undefined;
  return { number: Number(match[1]), total: Number(match[2]), value: match[3]!, kind };
}

const messageHeaderWithMentions = /^\[ThreadTerm message(?:; mentions v1 (.+))?\]$/;

/** Parses the terminating message header, including the optional v1 mention map. */
function parseMessageHeader(message: string, position: number, total: number): { text: string; tokens: Map<number, string> } | undefined {
  const lineEnd = message.indexOf('\n', position);
  if (lineEnd < 0) return undefined;
  const match = messageHeaderWithMentions.exec(message.slice(position, lineEnd));
  if (!match) return undefined;
  const tokens = new Map<number, string>();
  if (match[1] !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(match[1]); } catch { return undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const indexes = new Set<number>();
    for (const [token, index] of Object.entries(parsed)) {
      if (!isValidMentionToken(token)) return undefined;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > total || indexes.has(index)) return undefined;
      indexes.add(index);
      tokens.set(index, token);
    }
  }
  return { text: message.slice(lineEnd + 1), tokens };
}

/** Extracts ThreadTerm context only when the whole leading envelope is well formed. */
export function parseContext(message: string): ParsedContext | undefined {
  if (typeof message !== 'string' || bytes(message) > MAX_CONTEXT_BYTES || !message.startsWith('[ThreadTerm context 1/')) return undefined;
  let position = 0;
  const items: ParsedContextItem[] = [];
  let total = 0;
  while (true) {
    const lineEnd = message.indexOf('\n', position);
    if (lineEnd < 0) return undefined;
    const header = message.slice(position, lineEnd);
    const parsed = parseItemHeader(header);
    if (!parsed || !Number.isSafeInteger(parsed.number) || !Number.isSafeInteger(parsed.total) || parsed.total < 1 || parsed.total > MAX_CONTEXT_ITEMS || parsed.number !== items.length + 1 || (total && total !== parsed.total)) return undefined;
    const kind = parsed.kind;
    total = parsed.total;
    position = lineEnd + 1;
    let body = '';
    // A session summary is optional; the other body kinds must carry their fence.
    const bodyKind = kind === 'terminal' || kind === 'diff' || kind === 'conversation' || kind === 'quote';
    if (bodyKind || kind === 'session') {
      const fenceEnd = message.indexOf('\n', position);
      const opening = fenceEnd < 0 ? '' : message.slice(position, fenceEnd);
      const fenceMatch = new RegExp(`^(` + '`{4,}' + `)${kind === 'diff' ? 'diff' : 'text'}$`).exec(opening);
      if (fenceMatch) {
        const marker = fenceMatch[1]!;
        const closing = `\n${marker}`;
        let closingStart = message.indexOf(closing, fenceEnd);
        while (closingStart >= 0 && message[closingStart + closing.length] !== '\n') closingStart = message.indexOf(closing, closingStart + 1);
        if (closingStart < 0) return undefined;
        const afterClosing = closingStart + closing.length;
        const content = message.slice(fenceEnd + 1, closingStart);
        if (bytes(content) > (kind === 'terminal' ? MAX_TERMINAL_BYTES : kind === 'diff' ? MAX_DIFF_BYTES : kind === 'session' ? MAX_SESSION_SUMMARY_BYTES : 64 * 1024)) return undefined;
        if (kind === 'terminal') {
          const declaredLines = Number(/, last (\d+) lines?$/.exec(parsed.value)?.[1]);
          if (lineCount(content) !== declaredLines || declaredLines > MAX_TERMINAL_LINES) return undefined;
        }
        body = message.slice(position, afterClosing);
        position = afterClosing + 1;
      } else if (bodyKind) {
        return undefined;
      }
    }
    items.push({ header, body });
    if (items.length === total) break;
    if (position >= message.length) return undefined;
  }
  const parsedMessage = parseMessageHeader(message, position, total);
  if (!parsedMessage) return undefined;
  for (const [index, token] of parsedMessage.tokens) items[index - 1]!.inlineToken = token;
  return { items, text: parsedMessage.text };
}

/** Produces compact chip labels from a parsed serialized header. */
export function contextDisplayMetadata(header: string): ContextDisplayMetadata | undefined {
  const parsed = parseItemHeader(header);
  if (!parsed) return undefined;
  const { kind, value } = parsed;
  if (kind === 'terminal') {
    const terminal = /^Terminal output — "(.+)"(?: \((.+)\))?, last (\d+) lines?$/.exec(value)!;
    return { kind, label: `${terminal[1]} · ${terminal[3]} ${terminal[3] === '1' ? 'line' : 'lines'}`, title: value };
  }
  if (kind === 'file') {
    const file = value.slice('File: '.length);
    const range = /:(\d+(?:-\d+)?)$/.exec(file);
    const path = range ? file.slice(0, -range[0].length) : file;
    return { kind, label: `${fileName(path)}${range?.[0] ?? ''}`, title: value };
  }
  if (kind === 'diff') {
    const diff = /^Uncommitted diff — (.+?)(?: \(.+\))$/.exec(value)!;
    return { kind, label: `Diff · ${fileName(diff[1]!)}`, title: value };
  }
  if (kind === 'conversation' || kind === 'quote') return { kind, label: value, title: value };
  if (kind === 'session') {
    const session = /^Session ([A-Za-z0-9._:-]{1,128}): (.+) \(([A-Za-z0-9._-]+)\)\. (?:Call session_info with this id\.|Summary attached; session_info unavailable\.)$/.exec(value)!;
    return { kind, label: `Session · ${session[2]}`, title: value };
  }
  if (kind === 'agent') {
    const agent = /^Agent: delegate the following task to ([A-Za-z0-9._-]{1,64}) with delegate_start\.$/.exec(value)!;
    return { kind, label: `Agent · ${agent[1]}`, title: value };
  }
  if (kind === 'skill') {
    const skill = /^Skill: (.+?) \(invoke: (.+)\)$/.exec(value)!;
    return { kind, label: `Skill · ${skill[1]}`, title: value };
  }
  const commit = /^Commit ([0-9a-fA-F]{7,64}) — (.+)$/.exec(value)!;
  return { kind, label: `Commit ${commit[1]!.slice(0, 7)}`, title: value };
}
