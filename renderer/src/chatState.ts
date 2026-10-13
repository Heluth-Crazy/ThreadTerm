import type { ChatItem, ChatUiState } from '@threadterm/protocol';

/** Live UI events and options reads are complete snapshots, never patches. */
export function chatUiFromEvent(data: Partial<ChatUiState>): ChatUiState {
  const options = Array.isArray(data.options) ? data.options : [];
  return {
    options,
    commands: Array.isArray(data.commands) ? data.commands : [],
    inputCapabilities: data.inputCapabilities && typeof data.inputCapabilities === 'object' && !Array.isArray(data.inputCapabilities) ? data.inputCapabilities : {},
    loadState: data.loadState ?? (options.length ? 'ready' : 'empty'),
    ...(data.error !== undefined ? { error: data.error } : {}),
    ...(data.piTrust !== undefined ? { piTrust: data.piTrust } : {}),
  };
}

export interface ChatResync {
  sessionId: string;
  generation: number;
  buffered: { seq: number; item: ChatItem }[];
}

export function beginResync(sessionId: string, generation: number, previous?: ChatResync): ChatResync {
  return { sessionId, generation, buffered: previous?.sessionId === sessionId ? previous.buffered : [] };
}

/** state.changed revisions fence duplicate repair notices from repeated outbox delivery. */
export function nextRepairRevision(previous: number, incoming: unknown): number | undefined {
  return typeof incoming === 'number' && Number.isSafeInteger(incoming) && incoming > previous ? incoming : undefined;
}

/** Undefined snapshots retain current items and replay all buffered live events. */
export function completeResync(
  resync: ChatResync | undefined,
  sessionId: string,
  generation: number,
  current: ChatItem[],
  snapshot?: { items: ChatItem[]; revision: number },
): ChatItem[] | undefined {
  if (!resync || resync.sessionId !== sessionId || resync.generation !== generation) return undefined;
  return restoreChat(snapshot ?? { items: current, revision: -1 }, resync.buffered);
}

export function upsertChatItem(items: ChatItem[], next: ChatItem): ChatItem[] {
  const index = items.findIndex(item => item.id === next.id);
  return index < 0 ? [...items, next] : items.map((item, i) => i === index ? next : item);
}

/** Snapshot and outbox revision are read in one runtime transaction. */
export function restoreChat(snapshot: { items: ChatItem[]; revision: number }, buffered: { seq: number; item: ChatItem }[]) {
  return buffered.filter(event => event.seq > snapshot.revision).sort((a, b) => a.seq - b.seq)
    .reduce((items, event) => upsertChatItem(items, event.item), snapshot.items);
}
