import type { ChatItem } from '@threadterm/protocol';

export function upsertChatItem(items: ChatItem[], next: ChatItem): ChatItem[] {
  const index = items.findIndex(item => item.id === next.id);
  return index < 0 ? [...items, next] : items.map((item, i) => i === index ? next : item);
}

/** Snapshot and outbox revision are read in one runtime transaction. */
export function restoreChat(snapshot: { items: ChatItem[]; revision: number }, buffered: { seq: number; item: ChatItem }[]) {
  return buffered.filter(event => event.seq > snapshot.revision).sort((a, b) => a.seq - b.seq)
    .reduce((items, event) => upsertChatItem(items, event.item), snapshot.items);
}
