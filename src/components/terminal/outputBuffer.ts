/**
 * outputBuffer — per-card coalescing buffer between the PTY output stream and
 * the Zustand store (audit P0-2).
 *
 * Why: every PTY chunk used to trigger `updateCardOutput` +
 * `updateCardReplyPreview`, each rebuilding the full `cards` array. Everything
 * subscribed to `cards` (TerminalManager → mobile mirror serialization,
 * command palette registry, CardGrid, ProjectSidebar) re-ran per chunk, so
 * render cost grew with chunk rate × card count. Buffering chunks for
 * `flushMs` caps store writes at ~1000/flushMs per second per card while the
 * real xterm (and the headless preview emulator) still receive every chunk
 * immediately.
 *
 * Joining chunks before the store write also improves ANSI stripping:
 * escape sequences split across chunk boundaries now strip correctly.
 */

export interface OutputBufferSink {
  /** Receives the joined chunk tail for a card at flush time. */
  flushOutput: (cardId: string, joinedChunks: string) => void;
  /** Receives the latest headless preview for a card at flush time. */
  flushPreview: (cardId: string, preview: string) => void;
}

interface PendingEntry {
  chunks: string[];
  preview: string | null;
}

export interface CardOutputBuffer {
  pushChunk: (cardId: string, data: string) => void;
  pushPreview: (cardId: string, preview: string) => void;
  /** Synchronously flush one card — call before exit/status handling so
   *  downstream readers (notification snippet, reply detector) see the
   *  freshest output. */
  flushCard: (cardId: string) => void;
  /** Drop a card's pending data without flushing (card removed). */
  discardCard: (cardId: string) => void;
  /** Flush everything and cancel the timer (bridge unmount). */
  dispose: () => void;
}

export function createCardOutputBuffer(
  sink: OutputBufferSink,
  flushMs = 100,
): CardOutputBuffer {
  const pending = new Map<string, PendingEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function entryFor(cardId: string): PendingEntry {
    let entry = pending.get(cardId);
    if (!entry) {
      entry = { chunks: [], preview: null };
      pending.set(cardId, entry);
    }
    return entry;
  }

  function flushEntry(cardId: string, entry: PendingEntry): void {
    if (entry.chunks.length > 0) {
      sink.flushOutput(cardId, entry.chunks.join(''));
    }
    if (entry.preview !== null) {
      sink.flushPreview(cardId, entry.preview);
    }
  }

  function cancelTimerIfIdle(): void {
    if (pending.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flushAll(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [cardId, entry] of entries) {
      flushEntry(cardId, entry);
    }
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flushAll();
    }, flushMs);
  }

  return {
    pushChunk(cardId, data) {
      entryFor(cardId).chunks.push(data);
      schedule();
    },
    pushPreview(cardId, preview) {
      entryFor(cardId).preview = preview;
      schedule();
    },
    flushCard(cardId) {
      const entry = pending.get(cardId);
      if (!entry) return;
      pending.delete(cardId);
      cancelTimerIfIdle();
      flushEntry(cardId, entry);
    },
    discardCard(cardId) {
      pending.delete(cardId);
      cancelTimerIfIdle();
    },
    dispose() {
      flushAll();
    },
  };
}
