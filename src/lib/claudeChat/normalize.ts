export type ClaudeDisplayItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'system'
  | 'result';

export interface ClaudeDisplayItem {
  id: string;
  kind: ClaudeDisplayItemKind;
  title: string;
  body: string;
  status?: string | null;
  raw: unknown;
}

const STREAMING_ITEM_ID = 'claude:streaming';
const MAX_STRUCTURED_BODY_CHARS = 12_000;

export function applyClaudeSdkMessage(
  current: ClaudeDisplayItem[],
  message: unknown,
): ClaudeDisplayItem[] {
  if (!isRecord(message)) return current;

  switch (asString(message.type)) {
    case 'assistant':
      return applyAssistantMessage(current, message);
    case 'stream_event':
      return applyStreamEvent(current, message);
    case 'user':
      return applyToolResults(current, message);
    case 'result':
      return upsertItem(current, resultItem(message, current.length));
    case 'system':
      return upsertItem(current, systemItem(message));
    default:
      return current;
  }
}

export function createClaudeUserItem(
  text: string,
  id: string,
): ClaudeDisplayItem {
  return {
    id,
    kind: 'user',
    title: 'You',
    body: text,
    raw: null,
  };
}

export function assistantPreviewFromMessage(message: unknown): string | null {
  if (!isRecord(message) || message.type !== 'assistant') return null;
  const envelope = isRecord(message.message) ? message.message : null;
  const content = envelope && Array.isArray(envelope.content)
    ? envelope.content
    : [];
  const text = content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text) ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

export function stringifyClaudeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized.length <= MAX_STRUCTURED_BODY_CHARS) return serialized;
    return `${serialized.slice(0, MAX_STRUCTURED_BODY_CHARS)}\n…`;
  } catch {
    return String(value);
  }
}

function applyAssistantMessage(
  current: ClaudeDisplayItem[],
  sdkMessage: Record<string, unknown>,
): ClaudeDisplayItem[] {
  const envelope = isRecord(sdkMessage.message) ? sdkMessage.message : null;
  if (!envelope || !Array.isArray(envelope.content)) return current;

  const messageId =
    asString(envelope.id) ??
    asString(sdkMessage.uuid) ??
    asString(sdkMessage.session_id) ??
    `assistant-${current.length}`;
  let next = current.filter((item) => item.id !== STREAMING_ITEM_ID);

  envelope.content.forEach((rawBlock, index) => {
    if (!isRecord(rawBlock)) return;
    const blockType = asString(rawBlock.type);
    if (blockType === 'text') {
      const text = asString(rawBlock.text) ?? '';
      if (!text) return;
      next = upsertItem(next, {
        id: `${messageId}:text:${index}`,
        kind: 'assistant',
        title: 'Claude',
        body: text,
        status: null,
        raw: null,
      });
      return;
    }
    if (blockType === 'thinking') {
      const thinking =
        asString(rawBlock.thinking) ??
        asString(rawBlock.text) ??
        '';
      if (!thinking) return;
      next = upsertItem(next, {
        id: `${messageId}:thinking:${index}`,
        kind: 'thinking',
        title: 'Thinking',
        body: thinking,
        status: null,
        raw: null,
      });
      return;
    }
    if (blockType === 'tool_use') {
      const toolId =
        asString(rawBlock.id) ??
        `${messageId}:tool:${index}`;
      next = upsertItem(next, {
        id: toolId,
        kind: 'tool',
        title: asString(rawBlock.name) ?? 'Tool',
        body: stringifyClaudeValue(rawBlock.input),
        status: 'running',
        raw: null,
      });
    }
  });

  return next;
}

function applyStreamEvent(
  current: ClaudeDisplayItem[],
  sdkMessage: Record<string, unknown>,
): ClaudeDisplayItem[] {
  const event = isRecord(sdkMessage.event) ? sdkMessage.event : null;
  const eventType = event ? asString(event.type) : null;
  if (
    eventType !== 'message_start' &&
    eventType !== 'content_block_start' &&
    eventType !== 'content_block_delta'
  ) {
    return current;
  }

  return upsertItem(current, {
    id: STREAMING_ITEM_ID,
    kind: 'assistant',
    title: 'Claude',
    body: '',
    status: 'streaming',
    raw: null,
  });
}

function applyToolResults(
  current: ClaudeDisplayItem[],
  sdkMessage: Record<string, unknown>,
): ClaudeDisplayItem[] {
  const envelope = isRecord(sdkMessage.message) ? sdkMessage.message : null;
  if (!envelope || !Array.isArray(envelope.content)) return current;

  let next = current;
  envelope.content.forEach((rawBlock) => {
    if (!isRecord(rawBlock) || rawBlock.type !== 'tool_result') return;
    const toolUseId =
      asString(rawBlock.tool_use_id) ??
      asString(sdkMessage.parent_tool_use_id);
    if (!toolUseId) return;
    const result = contentText(rawBlock.content);
    const existing = next.find((item) => item.id === toolUseId);
    next = upsertItem(next, {
      id: toolUseId,
      kind: 'tool',
      title: existing?.title ?? 'Tool result',
      body: [existing?.body, result && `Result:\n${result}`]
        .filter(Boolean)
        .join('\n\n'),
      status: rawBlock.is_error === true ? 'error' : 'ok',
      raw: null,
    });
  });
  return next;
}

function resultItem(
  message: Record<string, unknown>,
  fallbackIndex: number,
): ClaudeDisplayItem {
  const subtype = asString(message.subtype) ?? 'completed';
  const sessionId = asString(message.session_id) ?? 'session';
  const turns = asNumber(message.num_turns);
  const cost = asNumber(message.total_cost_usd);
  const summary = [
    turns == null ? null : `${turns} turn${turns === 1 ? '' : 's'}`,
    cost == null ? null : `$${cost.toFixed(4)}`,
    asString(message.result),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  return {
    id:
      asString(message.uuid) ??
      `result:${sessionId}:${subtype}:${asNumber(message.duration_ms) ?? fallbackIndex}`,
    kind: 'result',
    title: subtype,
    body: summary,
    status: message.is_error === true || subtype === 'error' ? 'error' : 'ok',
    raw: null,
  };
}

function systemItem(message: Record<string, unknown>): ClaudeDisplayItem {
  const subtype = asString(message.subtype) ?? 'system';
  const sessionId = asString(message.session_id);
  const model = asString(message.model);
  return {
    id: `system:${subtype}:${sessionId ?? 'unknown'}`,
    kind: 'system',
    title: subtype === 'init' ? 'Session ready' : subtype,
    body: [sessionId, model].filter(Boolean).join(' · '),
    status: null,
    raw: null,
  };
}

function upsertItem(
  current: ClaudeDisplayItem[],
  incoming: ClaudeDisplayItem,
): ClaudeDisplayItem[] {
  const index = current.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...current, incoming];
  const next = [...current];
  next[index] = incoming;
  return next;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return stringifyClaudeValue(value);
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!isRecord(entry)) return stringifyClaudeValue(entry);
      return asString(entry.text) ?? stringifyClaudeValue(entry);
    })
    .filter(Boolean)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
