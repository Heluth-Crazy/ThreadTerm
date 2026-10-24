import type { ChatItem } from "@threadterm/protocol";

/**
 * Codex can deliver several cumulative snapshots in one runtime poll. Keeping
 * those snapshots in a short queue gives the renderer a chance to paint each
 * intermediate state instead of replacing it with the final snapshot in one
 * React batch.
 */
export const CODEX_STREAM_INTERVAL_MS = 32;
const MAX_PENDING_SNAPSHOTS = 32;

type Timer = ReturnType<typeof setTimeout>;
type Deliver = (item: ChatItem) => void;

export function isStreamingChatItem(item: ChatItem): boolean {
  return item.role === "assistant"
    && item.parts.some((part) => part.status === "streaming" || part.status === "running");
}

function snapshotSignature(item: ChatItem): string {
  // Chat items are small cumulative snapshots. A stable signature prevents a
  // repeated runtime event from consuming a visible streaming frame.
  return JSON.stringify(item);
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
  const lastDelivered = new Map<string, string>();
  // Signature of the newest queued snapshot per item, so an older repeated
  // frame cannot extend the queue.
  const queuedSignatures = new Map<string, string>();

  const deliverNow = (item: ChatItem) => {
    const signature = snapshotSignature(item);
    if (lastDelivered.get(item.id) === signature) return;
    lastDelivered.set(item.id, signature);
    deliver(item);
  };

  const dropQueued = (item: ChatItem) => {
    if (!pending.some((entry) => entry.id === item.id)) queuedSignatures.delete(item.id);
  };

  const deliverQueued = (item: ChatItem) => {
    dropQueued(item);
    deliverNow(item);
    if (!isStreamingChatItem(item)) activeItemIds.delete(item.id);
  };

  // A burst of frames must never discard state. Collapse superseded snapshots
  // of one item first (latest snapshot wins, first appearance order kept) and
  // then deliver the oldest frames immediately instead of dropping them.
  const relieve = () => {
    if (pending.length <= MAX_PENDING_SNAPSHOTS) return;
    const latest = new Map<string, ChatItem>();
    for (const item of pending) latest.set(item.id, item);
    pending = [...latest.values()];
    for (const [id, item] of latest) queuedSignatures.set(id, snapshotSignature(item));
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
      const signature = snapshotSignature(item);
      if (lastDelivered.get(item.id) === signature || queuedSignatures.get(item.id) === signature) return;
      // A snapshot for an item that is not animating is a canonical state
      // change: paint it now, even while another item streams.
      if (!isStreamingChatItem(item) && !activeItemIds.has(item.id)) {
        deliverNow(item);
        return;
      }
      activeItemIds.add(item.id);
      queuedSignatures.set(item.id, signature);
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
      lastDelivered.clear();
      queuedSignatures.clear();
    },
  };
}
