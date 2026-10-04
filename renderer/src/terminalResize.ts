/**
 * Coalesces PTY resize requests from a terminal view. xterm reflows at once on every layout change,
 * but the in-box ConPTY repaints the client's whole screen on each ResizePseudoConsole: a divider drag
 * sending every intermediate size left 27 stale copies of Claude's header in the scrollback, a 250 ms
 * throttle still 7, only the final size none (qa/terminal-repro.mjs, 2026-10-03). So a size is sent once
 * requests have been quiet for `quietMs` (or `maxWaitMs` after the first unsent one), at most one is in
 * flight, sends are `minIntervalMs` apart, and the latest size is always sent last.
 * No DOM dependencies: the QA harness drives this same module.
 */
export interface PtySize { cols: number; rows: number; epoch: number }

/** Quiet time before a view's new size reaches the PTY: one resize per drag, 0 stale copies (measured). */
export const RESIZE_QUIET_MS = 150;

export interface ResizeScheduler {
  /** The size the PTY should end up with; replaces any size not sent yet. */
  request(size: PtySize): void;
  /** Forget the pending and the last sent size (lease changed, or retrying a failure): the next request is sent. */
  reset(): void;
  dispose(): void;
}

interface Clock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const same = (left: PtySize | undefined, right: PtySize | undefined) =>
  Boolean(left && right && left.cols === right.cols && left.rows === right.rows && left.epoch === right.epoch);

export function createResizeScheduler(
  send: (size: PtySize) => Promise<unknown>,
  { minIntervalMs = 100, quietMs = 0, maxWaitMs = Number.POSITIVE_INFINITY, clock = systemClock }: { minIntervalMs?: number; quietMs?: number; maxWaitMs?: number; clock?: Clock } = {},
): ResizeScheduler {
  let wanted: PtySize | undefined;
  let wantedAt = 0;
  let pendingSince: number | undefined;
  let sent: PtySize | undefined;
  let sentAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let timer: unknown;
  let disposed = false;

  const pump = () => {
    if (disposed || inFlight || !wanted) return;
    if (same(wanted, sent)) {
      pendingSince = undefined;
      if (timer !== undefined) { clock.clearTimer(timer); timer = undefined; }
      return;
    }
    const now = clock.now();
    const due = Math.max(sentAt + minIntervalMs, Math.min(wantedAt + quietMs, (pendingSince ?? now) + maxWaitMs));
    if (due > now) {
      if (timer !== undefined) clock.clearTimer(timer);
      timer = clock.setTimer(() => { timer = undefined; pump(); }, due - now);
      return;
    }
    if (timer !== undefined) { clock.clearTimer(timer); timer = undefined; }
    pendingSince = undefined;
    const size = wanted;
    inFlight = true;
    sent = size;
    sentAt = clock.now();
    // A failed send is the caller's to report or retry (`reset()` + `request()`); never retried here,
    // so a persistently failing resize cannot loop.
    void send(size).catch(() => {}).finally(() => { inFlight = false; pump(); });
  };

  return {
    request(size) {
      if (same(size, wanted)) return;
      wanted = size;
      wantedAt = clock.now();
      if (!same(size, sent)) pendingSince ??= wantedAt;
      pump();
    },
    reset() {
      wanted = undefined;
      sent = undefined;
      pendingSince = undefined;
      if (timer !== undefined) { clock.clearTimer(timer); timer = undefined; }
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clock.clearTimer(timer);
      timer = undefined;
    },
  };
}
