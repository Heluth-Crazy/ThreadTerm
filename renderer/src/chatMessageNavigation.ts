import type { ChatItem } from '@threadterm/protocol';

export type MessageDestination = { id: string; preview: string; createdAt: string; turnId?: string; additions?: number; deletions?: number };
/** Cached turn statistics can be supplied by F1; navigation never fetches them. */
export function messageDestinations(items: readonly ChatItem[], stats?: ReadonlyMap<string, { additions: number; deletions: number }>): MessageDestination[] {
  return items.filter(item => item.role === 'user').map(item => ({
    id: item.id, createdAt: item.createdAt, turnId: item.turnId,
    preview: item.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').split(/\r?\n/).find(line => line.trim())?.trim() ?? '',
    ...(item.turnId ? stats?.get(item.turnId) : undefined),
  }));
}

export function messageWindow(count: number, scrollTop: number, rowHeight = 60, visibleRows = 7) {
  if (count <= 200) return { start: 0, end: count, before: 0, after: 0 };
  const start = Math.max(0, Math.min(count - 1, Math.floor(scrollTop / rowHeight) - 2));
  const end = Math.min(count, start + visibleRows + 4);
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight };
}
