import type { ChatItem } from "@threadterm/protocol";

/** Provider readers can deliver several cumulative snapshots together. Pace
 * their rendering while keeping the item's final update behind its text. */
export const CODEX_STREAM_INTERVAL_MS = 32;
const MAX_PENDING_SNAPSHOTS = 32;

type Timer = ReturnType<typeof setTimeout>;
type Deliver = (item: ChatItem) => void;

export function isStreamingChatItem(item: ChatItem): boolean {
  return item.role === "assistant"
    && item.parts.some((part) => part.status === "streaming" || part.status === "running");
}

export interface CodexStreamQueue {
  push(item: ChatItem): void;
  dispose(): void;
}

export function createCodexStreamQueue(
  deliver: Deliver,
  intervalMs = CODEX_STREAM_INTERVAL_MS,
): CodexStreamQueue {
  // Only cumulative snapshots of a streaming item are paced here. Approvals,
  // completions and tool cards are canonical state, so they are delivered
  // immediately and never wait behind the animation budget.
  let pending: ChatItem[] = [];
  let timer: Timer | undefined;
  let disposed = false;
  const activeItemIds = new Set<string>();

  const deliverQueued = (item: ChatItem) => {
    deliver(item);
    if (!isStreamingChatItem(item)) activeItemIds.delete(item.id);
  };

  // A burst must never discard final state. Cumulative snapshots for one item
  // supersede one another once the animation queue reaches its bound.
  const relieve = () => {
    if (pending.length <= MAX_PENDING_SNAPSHOTS) return;
    const latest = new Map<string, ChatItem>();
    for (const item of pending) latest.set(item.id, item);
    pending = [...latest.values()];
    while (pending.length > MAX_PENDING_SNAPSHOTS) deliverQueued(pending.shift()!);
  };

  const schedule = () => {
    if (timer === undefined && pending.length) timer = setTimeout(flush, intervalMs);
  };

  const flush = () => {
    timer = undefined;
    if (disposed) return;
    const next = pending.shift();
    if (!next) return;
    deliverQueued(next);
    schedule();
  };

  return {
    push(item) {
      if (disposed) return;
      // A snapshot for an item that is not animating is a canonical state
      // change: paint it now, even while another item streams.
      if (!isStreamingChatItem(item) && !activeItemIds.has(item.id)) {
        deliver(item);
        return;
      }
      activeItemIds.add(item.id);
      pending.push(item);
      relieve();
      if (timer === undefined) {
        // Paint the first frame immediately, then keep a short cooldown so a
        // burst of IPC events cannot synchronously replace it again.
        flush();
        if (timer === undefined && !disposed) timer = setTimeout(flush, intervalMs);
      }
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
      activeItemIds.clear();
    },
  };
}
