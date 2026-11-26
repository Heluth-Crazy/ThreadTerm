import type { ChatItem } from "@threadterm/protocol";

/** Provider readers can deliver several cumulative snapshots together. Pace
 * their rendering while keeping the item's final update behind its text. */
export const CODEX_STREAM_INTERVAL_MS = 32;
/** Every snapshot is the whole item, so a newer one supersedes the older ones. Up to this many wait for the animation;
 * beyond it the oldest are dropped. At 32 a reply streaming 50 deltas/s was shown 0.35–0.67 s after the runtime had it
 * (11-26 I/O measurement); at 3 it trails by about three intervals. */
const MAX_PENDING_SNAPSHOTS = 3;

type Timer = ReturnType<typeof setTimeout>;
type Deliver = (item: ChatItem) => void;
/** A snapshot and when it was queued. */
type Queued = { item: ChatItem; at: number };

export function isStreamingChatItem(item: ChatItem): boolean {
  return item.role === "assistant"
    && item.parts.some((part) => part.status === "streaming" || part.status === "running");
}

/** Only an assistant reply made of text and thinking that is still streaming may wait while hidden. Tool cards,
 * approvals, plans and errors always paint at once. */
function parkable(item: ChatItem): boolean {
  return item.role === "assistant" && item.parts.length > 0
    && item.parts.every((part) => part.type === "text" || part.type === "thinking")
    && item.parts.some((part) => part.status === "streaming");
}

export interface CodexStreamQueue {
  push(item: ChatItem): void;
  /** The view is visible again: paint the newest snapshot of every item that streamed while it was hidden. */
  reveal(): void;
  dispose(): void;
}

/** `hidden` says whether the view is out of sight (a background tab, a minimized window). A hidden view still paints
 * every new item and every canonical change at once; only the streaming text of a reply it already shows waits for
 * `reveal` (see `parkable`), so a hidden chat does not re-render that reply 30 times a second. */
export function createCodexStreamQueue(
  deliver: Deliver,
  intervalMs = CODEX_STREAM_INTERVAL_MS,
  hidden: () => boolean = () => false,
): CodexStreamQueue {
  // Only cumulative snapshots of a streaming item are paced here. Approvals,
  // completions and tool cards are canonical state, so they are delivered
  // immediately and never wait behind the animation budget.
  let pending: Queued[] = [];
  let timer: Timer | undefined;
  let disposed = false;
  const activeItemIds = new Set<string>();
  // Ids the view has painted at least once: only those may be parked, so an item's first appearance keeps its order.
  const shownItemIds = new Set<string>();
  const parked = new Map<string, ChatItem>();

  const paint = (item: ChatItem) => {
    shownItemIds.add(item.id);
    deliver(item);
  };

  const deliverQueued = (item: ChatItem) => {
    paint(item);
    if (!isStreamingChatItem(item)) activeItemIds.delete(item.id);
  };

  // A burst must never discard final state. Cumulative snapshots for one item
  // supersede one another once the animation queue reaches its bound.
  const relieve = () => {
    if (pending.length <= MAX_PENDING_SNAPSHOTS) return;
    const latest = new Map<string, Queued>();
    for (const entry of pending) latest.set(entry.item.id, entry);
    pending = [...latest.values()];
    while (pending.length > MAX_PENDING_SNAPSHOTS) deliverQueued(pending.shift()!.item);
  };
  // Events arrive one by one as the runtime commits them. When painting falls behind them (a long transcript), a
  // snapshot that has already waited a whole interval while a newer one of the same item is queued is skipped: the
  // reply catches up instead of trailing by the backlog. Its newer snapshot carries everything it had. Only items the
  // view already shows: an item's first snapshot fixes where it appears, so it is never skipped.
  const catchUp = () => {
    const now = Date.now();
    while (pending.length > 1 && now - pending[0].at > intervalMs && shownItemIds.has(pending[0].item.id)
      && pending.some((entry, index) => index > 0 && entry.item.id === pending[0].item.id)) pending.shift();
  };

  const schedule = () => {
    if (timer === undefined && pending.length) timer = setTimeout(flush, intervalMs);
  };

  const flush = () => {
    timer = undefined;
    if (disposed) return;
    catchUp();
    const next = pending.shift();
    if (!next) return;
    deliverQueued(next.item);
    schedule();
  };

  return {
    push(item) {
      if (disposed) return;
      if (parkable(item) && shownItemIds.has(item.id) && hidden()) {
        // Supersedes the parked and queued snapshots of this item; nothing is painted until the view is shown.
        parked.set(item.id, item);
        pending = pending.filter((entry) => entry.item.id !== item.id);
        return;
      }
      // Any newer snapshot, canonical or streaming, supersedes a parked one.
      parked.delete(item.id);
      // A snapshot for an item that is not animating is a canonical state
      // change: paint it now, even while another item streams.
      if (!isStreamingChatItem(item) && !activeItemIds.has(item.id)) {
        paint(item);
        return;
      }
      activeItemIds.add(item.id);
      pending.push({ item, at: Date.now() });
      relieve();
      if (timer === undefined) {
        // Paint the first frame immediately, then keep a short cooldown so a
        // burst of IPC events cannot synchronously replace it again.
        flush();
        if (timer === undefined && !disposed) timer = setTimeout(flush, intervalMs);
      }
    },
    reveal() {
      if (disposed || !parked.size) return;
      const caughtUp = [...parked.values()];
      parked.clear();
      for (const item of caughtUp) deliverQueued(item);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
      activeItemIds.clear();
      shownItemIds.clear();
      parked.clear();
    },
  };
}
