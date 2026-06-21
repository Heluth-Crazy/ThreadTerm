export type CodexDisplayItemKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'plan'
  | 'command'
  | 'file'
  | 'tool'
  | 'search'
  | 'system'
  | 'unknown';

export interface CodexDisplayItem {
  id: string;
  kind: CodexDisplayItemKind;
  title: string;
  body: string;
  status?: string | null;
  raw: unknown;
}

export interface CodexThreadBinding {
  threadId: string;
  sessionId?: string | null;
  threadPath?: string | null;
}

let fallbackItemSeq = 0;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function getString(record: unknown, key: string): string | null {
  if (!isRecord(record)) return null;
  return asString(record[key]);
}

export function threadBindingFromThread(thread: unknown): CodexThreadBinding | null {
  if (!isRecord(thread)) return null;
  const threadId = asString(thread.id);
  if (!threadId) return null;
  return {
    threadId,
    sessionId: asString(thread.sessionId),
    threadPath: asString(thread.path),
  };
}

export function extractThreadItems(thread: unknown): CodexDisplayItem[] {
  if (!isRecord(thread) || !Array.isArray(thread.turns)) return [];
  return thread.turns.flatMap((turn) => {
    if (!isRecord(turn) || !Array.isArray(turn.items)) return [];
    return turn.items.map(normalizeCodexItem);
  });
}

export function normalizeCodexItem(raw: unknown): CodexDisplayItem {
  if (!isRecord(raw)) {
    return unknownItem(raw);
  }

  const type = asString(raw.type) ?? 'unknown';
  const id = asString(raw.id) ?? `unknown-${fallbackItemSeq++}`;
  switch (type) {
    case 'userMessage':
      return {
        id,
        kind: 'user',
        title: 'User',
        body: normalizeUserContent(raw.content),
        raw,
      };
    case 'agentMessage':
      return {
        id,
        kind: 'assistant',
        title: 'Codex',
        body: asString(raw.text) ?? '',
        status: asString(raw.phase),
        raw,
      };
    case 'reasoning':
      return {
        id,
        kind: 'reasoning',
        title: 'Reasoning',
        body: normalizeStringList(raw.summary) || normalizeStringList(raw.content),
        raw,
      };
    case 'plan':
      return {
        id,
        kind: 'plan',
        title: 'Plan',
        body: asString(raw.text) ?? '',
        raw,
      };
    case 'commandExecution':
      return {
        id,
        kind: 'command',
        title: asString(raw.command) ?? 'Command',
        body: asString(raw.aggregatedOutput) ?? '',
        status: asString(raw.status),
        raw,
      };
    case 'fileChange':
      return {
        id,
        kind: 'file',
        title: 'File changes',
        body: summarizeFileChanges(raw.changes),
        status: asString(raw.status),
        raw,
      };
    case 'mcpToolCall':
      return {
        id,
        kind: 'tool',
        title: [asString(raw.server), asString(raw.tool)].filter(Boolean).join(' / ') || 'MCP tool',
        body: summarizeToolBody(raw.result, raw.error, raw.arguments),
        status: asString(raw.status),
        raw,
      };
    case 'dynamicToolCall':
      return {
        id,
        kind: 'tool',
        title: [asString(raw.namespace), asString(raw.tool)].filter(Boolean).join(' / ') || 'Tool call',
        body: summarizeToolBody(raw.contentItems, null, raw.arguments),
        status: asString(raw.status),
        raw,
      };
    case 'collabAgentToolCall':
      return {
        id,
        kind: 'tool',
        title: `Agent ${asString(raw.tool) ?? 'tool'}`,
        body: asString(raw.prompt) ?? summarizeJson(raw.agentsStates),
        status: asString(raw.status),
        raw,
      };
    case 'webSearch':
      return {
        id,
        kind: 'search',
        title: 'Web search',
        body: asString(raw.query) ?? '',
        raw,
      };
    case 'imageView':
      return {
        id,
        kind: 'system',
        title: 'Image',
        body: asString(raw.path) ?? '',
        raw,
      };
    case 'imageGeneration':
      return {
        id,
        kind: 'system',
        title: 'Image generation',
        body: asString(raw.revisedPrompt) ?? asString(raw.result) ?? '',
        status: asString(raw.status),
        raw,
      };
    case 'contextCompaction':
      return {
        id,
        kind: 'system',
        title: 'Context compacted',
        body: '',
        raw,
      };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return {
        id,
        kind: 'system',
        title: type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode',
        body: asString(raw.review) ?? '',
        raw,
      };
    default:
      return {
        id,
        kind: 'unknown',
        title: type,
        body: summarizeJson(raw),
        raw,
      };
  }
}

export function appendDelta(
  items: CodexDisplayItem[],
  itemId: string,
  delta: string,
  kind: CodexDisplayItemKind,
  title: string,
): CodexDisplayItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== itemId) return item;
    found = true;
    return { ...item, body: `${item.body}${delta}` };
  });
  if (found) return next;
  return [
    ...next,
    {
      id: itemId,
      kind,
      title,
      body: delta,
      raw: null,
    },
  ];
}

export function upsertItem(items: CodexDisplayItem[], raw: unknown): CodexDisplayItem[] {
  const nextItem = normalizeCodexItem(raw);
  const index = items.findIndex((item) => item.id === nextItem.id);
  if (index === -1) return [...items, nextItem];
  const next = items.slice();
  next[index] = mergeDisplayItem(next[index], nextItem);
  return next;
}

function mergeDisplayItem(previous: CodexDisplayItem, next: CodexDisplayItem): CodexDisplayItem {
  if (!previous.body || next.body) return next;
  return { ...next, body: previous.body };
}

function normalizeUserContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => {
      if (!isRecord(entry)) return '';
      switch (entry.type) {
        case 'text':
          return asString(entry.text) ?? '';
        case 'skill':
          return `/${asString(entry.name) ?? 'skill'}`;
        case 'mention':
          return `@${asString(entry.name) ?? 'mention'}`;
        case 'image':
          return asString(entry.url) ?? '[image]';
        case 'localImage':
          return asString(entry.path) ?? '[local image]';
        default:
          return summarizeJson(entry);
      }
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeStringList(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((entry): entry is string => typeof entry === 'string').join('\n');
}

function summarizeFileChanges(value: unknown): string {
  if (!Array.isArray(value)) return '';
  if (value.length === 0) return '';
  return value
    .map((change) => {
      if (!isRecord(change)) return '';
      return asString(change.path) ?? asString(change.file) ?? summarizeJson(change);
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeToolBody(result: unknown, error: unknown, args: unknown): string {
  if (error) return summarizeJson(error);
  if (typeof result === 'string') return result;
  if (result !== null && result !== undefined) return summarizeJson(result);
  return summarizeJson(args);
}

function summarizeJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function unknownItem(raw: unknown): CodexDisplayItem {
  return {
    id: `unknown-${fallbackItemSeq++}`,
    kind: 'unknown',
    title: 'Unknown',
    body: summarizeJson(raw),
    raw,
  };
}
