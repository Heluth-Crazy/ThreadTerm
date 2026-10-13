import type { ChatItem, ChatPart, ChatPlanData, ChatPlanEntry, ChatPlanEntryPriority, ChatPlanEntryStatus } from '@threadterm/protocol';

export interface ChatPlanState {
  part: ChatPart;
  data: ChatPlanData;
  itemId: string;
  turnId?: string;
  /** True when the part arrived from a live turn, not a reloaded import. */
  live: boolean;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const PLAN_STATUSES: ChatPlanEntryStatus[] = ['pending', 'in_progress', 'completed'];
const PLAN_PRIORITIES: ChatPlanEntryPriority[] = ['high', 'medium', 'low'];

function planEntry(value: unknown): ChatPlanEntry | undefined {
  const raw = record(value);
  const content = text(raw.content);
  if (!content) return undefined;
  const status = PLAN_STATUSES.includes(raw.status as ChatPlanEntryStatus) ? raw.status as ChatPlanEntryStatus : 'pending';
  const priority = PLAN_PRIORITIES.includes(raw.priority as ChatPlanEntryPriority) ? raw.priority as ChatPlanEntryPriority : undefined;
  return priority ? { content, status, priority } : { content, status };
}

/** Total, shape-based normalization: malformed data yields no plan, never a throw. */
export function planDataOf(part: ChatPart | undefined): ChatPlanData | undefined {
  if (!part || part.type !== 'plan') return undefined;
  const raw = record(part.data);
  if (!Array.isArray(raw.entries)) return undefined;
  const entries = raw.entries.map(planEntry).filter((entry): entry is ChatPlanEntry => Boolean(entry));
  if (!entries.length && raw.entries.length) return undefined;
  const explanation = text(raw.explanation);
  return explanation ? { entries, explanation } : { entries };
}

/** The newest plan part anywhere in the transcript; older plans are not listed. */
export function latestPlan(items: readonly ChatItem[]): ChatPlanState | undefined {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex]!;
    for (let partIndex = item.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = item.parts[partIndex]!;
      const data = planDataOf(part);
      if (data) return data.entries.length ? { part, data, itemId: item.id, turnId: item.turnId, live: item.turnOrigin !== 'history' } : undefined;
    }
  }
  return undefined;
}

/** Loaded plans stay closed; a later live update opens even if its turn has just ended. */
export function shouldAutoOpenPlan(plan: ChatPlanState | undefined, previous: ChatPlanState | undefined, alreadyOpened: boolean, historyReady = true): boolean {
  return Boolean(historyReady && !alreadyOpened && plan?.live && plan.part !== previous?.part);
}

export function planProgress(entries: readonly ChatPlanEntry[]): { done: number; total: number } {
  return { done: entries.filter(entry => entry.status === 'completed').length, total: entries.length };
}

export function planPriorityLabel(priority: ChatPlanEntryPriority, copy: (en: string, zh: string) => string): string {
  if (priority === 'high') return copy('High', '高');
  if (priority === 'medium') return copy('Medium', '中');
  return copy('Low', '低');
}

export function planEntryLabel(entry: ChatPlanEntry, copy: (en: string, zh: string) => string): string {
  const status = entry.status === 'completed' ? copy('Completed', '已完成') : entry.status === 'in_progress' ? copy('In progress', '进行中') : copy('Pending', '待处理');
  const priority = entry.priority ? ` · ${planPriorityLabel(entry.priority, copy)}` : '';
  return `${status}${priority}: ${entry.content}`;
}
