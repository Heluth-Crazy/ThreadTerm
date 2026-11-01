import type { OutputChunk } from '@threadterm/protocol';

type Consumer = (chunk: OutputChunk) => void | Promise<void>;
type ConsumerErrorHandler = (error: Error) => void;

/** How one view behaves when it cannot keep up with live output. */
export interface ConsumerOptions {
  /** Bytes this view may hold queued before it is switched to lagging catch-up. */
  limit?: number;
  /**
   * Re-read durable history from this view's own delivered cursor up to the
   * group's live cursor, then return.  Called only after the view's in-flight
   * delivery has settled, and only while the view is lagging.
   */
  catchUp?: () => Promise<void>;
  /** Reports a catch-up failure; the owner of the transport owns recovery. */
  onError?: ConsumerErrorHandler;
}

interface EnqueuedChunk {
  chunk: OutputChunk;
  onError?: ConsumerErrorHandler;
}

interface ConsumerState {
  consumer: Consumer;
  queue: EnqueuedChunk[];
  queuedBytes: number;
  limit: number;
  catchUp?: () => Promise<void>;
  onError?: ConsumerErrorHandler;
  /** A delivery loop is awaiting this view right now. */
  draining: boolean;
  /** Output was dropped for this view; it must catch up from durable history. */
  lagging: boolean;
  /** A frame arrived while the loop was busy, so the loop must look again. */
  wake: boolean;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * One upstream output cursor, many local views.
 *
 * Every view owns an ordered queue and its own delivery loop, so a view which
 * stops acknowledging output (a hung, frozen or paused window) only stalls
 * itself: other views keep receiving this session's bytes, and the transport
 * keeps paying credit.  `publish` returns as soon as each view has accepted the
 * chunk into its queue, never after a view has finished rendering it.
 *
 * A view which falls more than `limit` bytes behind is switched to lagging: its
 * backlog is dropped and it catches up from durable history (byte exact, trimmed
 * by cursor) once its in-flight delivery settles.  Nothing is ever skipped
 * silently; the catch-up callback reports a durable gap itself.
 */
export class OutputFanout {
  private readonly consumers = new Map<string, ConsumerState>();

  add(id: string, consumer: Consumer, options: ConsumerOptions = {}): () => void {
    this.consumers.set(id, {
      consumer,
      queue: [],
      queuedBytes: 0,
      limit: options.limit ?? Number.POSITIVE_INFINITY,
      catchUp: options.catchUp,
      onError: options.onError,
      draining: false,
      lagging: false,
      wake: false,
    });
    return () => {
      const state = this.consumers.get(id);
      if (!state) return;
      this.consumers.delete(id);
      state.queue.length = 0;
      state.queuedBytes = 0;
    };
  }

  get size(): number { return this.consumers.size; }

  /** Bytes currently queued across all views (a lagging view holds none). */
  get pendingBytes(): number {
    let total = 0;
    for (const state of this.consumers.values()) total += state.queuedBytes;
    return total;
  }

  /**
   * Enqueues the chunk for every view and returns immediately.  `onError`
   * receives delivery failures of this exact frame, so the caller can attribute
   * them to the transport which supplied it.
   */
  publish(chunk: OutputChunk, onError?: ConsumerErrorHandler): void {
    for (const state of this.consumers.values()) {
      if (!state.lagging) {
        // A chunk already being delivered is not counted: the cap bounds the
        // backlog behind a view, so the peak is the cap plus one frame.
        if (state.queue.length > 0 && state.queuedBytes + chunk.data.byteLength > state.limit) {
          state.lagging = true;
          state.queue.length = 0;
          state.queuedBytes = 0;
        } else {
          state.queue.push({ chunk, onError });
          state.queuedBytes += chunk.data.byteLength;
        }
      }
      this.start(state);
    }
  }

  dispose(): void {
    for (const state of this.consumers.values()) {
      state.queue.length = 0;
      state.queuedBytes = 0;
    }
    this.consumers.clear();
  }

  private start(state: ConsumerState): void {
    if (state.draining) { state.wake = true; return; }
    if (state.queue.length === 0 && !state.lagging) return;
    state.draining = true;
    state.wake = false;
    void this.drain(state);
  }

  private async drain(state: ConsumerState): Promise<void> {
    try {
      for (;;) {
        if (state.lagging) {
          // Catch-up starts only once this view's in-flight delivery has
          // settled, so it can never overlap delivery of the same bytes.
          if (!(await this.recover(state))) break;
          continue;
        }
        const item = state.queue.shift();
        if (!item) break;
        state.queuedBytes -= item.chunk.data.byteLength;
        try { await state.consumer(item.chunk); }
        catch (error) { item.onError?.(asError(error)); }
      }
    } finally {
      state.draining = false;
    }
    // Frames which arrived while the loop was awaiting this view still need it,
    // and a failed catch-up is retried by the next frame rather than a timer.
    if (state.wake || state.queue.length > 0) this.start(state);
  }

  /** Returns true once the view has caught up and may rejoin live delivery. */
  private async recover(state: ConsumerState): Promise<boolean> {
    if (state.catchUp) {
      try { await state.catchUp(); }
      catch (error) { state.onError?.(asError(error)); return false; }
    }
    state.lagging = false;
    return true;
  }
}
