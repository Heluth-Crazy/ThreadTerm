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
  let pending: ChatItem[] = [];
  let timer: Timer | undefined;
  let disposed = false;
  const activeItemIds = new Set<string>();
  const lastDelivered = new Map<string, string>();

  const deliverNow = (item: ChatItem) => {
    const signature = snapshotSignature(item);
    if (lastDelivered.get(item.id) === signature) return;
    lastDelivered.set(item.id, signature);
    deliver(item);
  };

  const schedule = () => {
    if (timer === undefined && pending.length) timer = setTimeout(flush, intervalMs);
  };

  const flush = () => {
    timer = undefined;
    if (disposed) return;
    const next = pending.shift();
    if (!next) return;
    deliverNow(next);
    if (!isStreamingChatItem(next)) activeItemIds.delete(next.id);
    schedule();
  };

  return {
    push(item) {
      if (disposed) return;
      const streaming = isStreamingChatItem(item);
      const followsStream = activeItemIds.has(item.id);
      const hasQueuedStream = pending.length > 0 || timer !== undefined;
      if (!streaming && !followsStream && !hasQueuedStream) {
        deliverNow(item);
        return;
      }
      const previous = pending[pending.length - 1];
      const signature = snapshotSignature(item);
      if (lastDelivered.get(item.id) === signature || (previous?.id === item.id && snapshotSignature(previous) === signature)) return;
      activeItemIds.add(item.id);
      pending.push(item);
      // An unbounded burst can otherwise make the final state take many
      // seconds to arrive. The first frame is delivered immediately below;
      // retain only a bounded tail when the provider sends a very large burst.
      if (pending.length > MAX_PENDING_SNAPSHOTS) pending = pending.slice(-MAX_PENDING_SNAPSHOTS);
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
    },
  };
}
