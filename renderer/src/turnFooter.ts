import type { ChatContextUsage, ChatItem } from '@threadterm/protocol';
import { formatChatDuration } from './chatPresentation';

export type FooterSegment = { kind: 'duration' | 'model' | 'in' | 'out' | 'cache'; text: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const token = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function compactTokens(value: number): string {
  return value < 1_000 ? String(value) : `${Number((value / 1_000).toFixed(1))}k`;
}

/** Only use this turn's saved usage. Session context totals and current model are never fallbacks. */
export function turnFooterSegments(items: readonly ChatItem[], elapsedMs: number | undefined, zh: boolean): FooterSegment[] {
  const segments: FooterSegment[] = [];
  if (elapsedMs !== undefined) segments.push({ kind: 'duration', text: zh ? formatChatDuration(elapsedMs, true) : `Worked for ${formatChatDuration(elapsedMs, false)}` });
  const model = items.find(item => item.turnModel)?.turnModel;
  if (model) segments.push({ kind: 'model', text: model });
  const saved = [...items].reverse().find(item => item.turnUsage)?.turnUsage;
  const part = items.flatMap(item => item.parts).filter(part => part.type === 'usage').at(-1);
  const raw = record(part?.data);
  const usage: ChatContextUsage = saved ?? {
    inputTokens: token(raw.inputTokens ?? raw.input_tokens ?? raw.prompt_tokens),
    outputTokens: token(raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens),
    cacheReadTokens: token(raw.cacheReadTokens ?? raw.cache_read_input_tokens ?? raw.cached_input_tokens),
    cacheWriteTokens: token(raw.cacheWriteTokens ?? raw.cache_creation_input_tokens),
  };
  const input = token(usage.inputTokens), output = token(usage.outputTokens);
  if (input !== undefined) segments.push({ kind: 'in', text: `${compactTokens(input)} ${zh ? '输入' : 'in'}` });
  if (output !== undefined) segments.push({ kind: 'out', text: `${compactTokens(output)} ${zh ? '输出' : 'out'}` });
  const read = token(usage.cacheReadTokens), write = token(usage.cacheWriteTokens);
  if (read !== undefined || write !== undefined) segments.push({ kind: 'cache', text: `${compactTokens((read ?? 0) + (write ?? 0))} ${zh ? '缓存' : 'cache'}` });
  return segments;
}

export function turnReview(items: readonly ChatItem[]): ChatItem['turnReview'] {
  return [...items].reverse().find(item => item.turnReview)?.turnReview;
}

/** Cache lives in the owning Chat pane; failed loads are retryable, in-flight loads are shared. */
export function createTurnChangesCache<T>() {
  const values = new Map<string, Promise<T>>();
  return {
    load(key: string, fetch: () => Promise<T>): Promise<T> {
      const prior = values.get(key);
      if (prior) return prior;
      const pending = Promise.resolve().then(fetch).catch(error => { values.delete(key); throw error; });
      values.set(key, pending);
      return pending;
    },
  };
}
