import type { ChatItem, ChatPart, SubagentInfo, SubagentStatus } from '@threadterm/protocol';

type Copy = (en: string, zh: string) => string;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function isSubagentPart(part: ChatPart): boolean {
  return part.type === 'subagent';
}

export function subagentStatus(info: Pick<SubagentInfo, 'status'>): SubagentStatus {
  return ['running', 'completed', 'failed', 'cancelled'].includes(info.status) ? info.status : 'unknown';
}

/** Persisted history may have only a name/key; never infer a running status. */
export function subagentInfo(part: ChatPart): SubagentInfo | undefined {
  if (!isSubagentPart(part)) return undefined;
  const data = part.data && typeof part.data === 'object' && !Array.isArray(part.data) ? part.data as Partial<SubagentInfo> : {};
  const key = text(data.key) || text(part.toolId);
  if (!key) return undefined;
  return { ...data, key, provider: text(data.provider) || '', status: subagentStatus({ status: data.status || part.status as SubagentStatus }),
    transcript: data.transcript === 'live' || data.transcript === 'native' ? data.transcript : 'none' };
}

export function subagentTitle(info: SubagentInfo, copy: Copy): string {
  const description = text(info.description);
  if (description) return [text(info.agentType), description].filter(Boolean).join(' · ');
  const name = text(info.name);
  if (info.provider === 'codex' && name?.startsWith('/')) return name.split('/').filter(Boolean).at(-1) || name;
  return name || text(info.agentType) || copy('Subagent', '子代理');
}

/** Keep the compact card preview readable without making it a second Markdown renderer. */
export function stripInlineMarkdown(value: string): string {
  let result = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  let previous: string;
  do {
    previous = result;
    result = result
      .replace(/(^|[^\w])(\*{1,3}|~{2})(?=\S)([\s\S]*?\S)\2(?=$|[^\w])/g, '$1$3')
      .replace(/(^|[^\w])(_{1,3})(?=\S)([\s\S]*?\S)\2(?=$|[^\w])/g, '$1$3');
  } while (result !== previous);
  return result
    .replace(/^\s{0,3}#{1,6}\s+/gm, '');
}

export function subagentToolCount(count: number, copy: Copy): string {
  return copy(`${count} ${count === 1 ? 'tool' : 'tools'}`, `${count} 个工具`);
}

export function elapsedMs(info: SubagentInfo, now = Date.now()): number | undefined {
  const start = Date.parse(info.startedAt || '');
  const end = info.status === 'running' ? now : Date.parse(info.endedAt || '');
  if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  const duration = info.usage?.durationMs;
  return typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, duration) : undefined;
}

/** Updated rows replace snapshots in place; new rows append in server seq order. */
export function mergeTranscript(prev: readonly ChatItem[], items: readonly ChatItem[]): ChatItem[] {
  const result = new Map(prev.map(item => [item.id, item]));
  for (const item of items) result.set(item.id, item);
  return [...result.values()];
}

/** Avoid repeating the Task disclosure when the transcript begins with its prompt. */
export function withoutPromptEcho(items: readonly ChatItem[], prompt: string | undefined): ChatItem[] {
  if (!prompt || items[0]?.role !== 'user') return [...items];
  const leading = items[0];
  const textParts = leading.parts.filter(part => part.type === 'text');
  const hasAttachments = textParts.some(part => part.fileReferences?.length || (part.data && typeof part.data === 'object' && !Array.isArray(part.data) && Array.isArray((part.data as { images?: unknown }).images)));
  if (textParts.length !== leading.parts.length || hasAttachments) return [...items];
  const content = textParts.map(part => part.text || '').join('');
  return content.trim() === prompt.trim() ? items.slice(1) : [...items];
}

/** Keep only card parts, retaining the canonical creation order of chat items. */
export function subagentItemsOf(items: readonly ChatItem[]): ChatItem[] {
  return items.flatMap(item => {
    const parts = item.parts.filter(isSubagentPart);
    return parts.length ? [{ ...item, parts }] : [];
  });
}
