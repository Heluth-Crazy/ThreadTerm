export interface WriteableTerminal {
  write(data: Uint8Array, callback: () => void): void;
}

/** Keeps xterm writes ordered; its completion is the only point at which ACK is safe. */
export class TerminalWriteQueue {
  private pending: Array<{ data: Uint8Array | null; onWritten: () => void }> = [];
  private writing = false;
  private idleCallbacks: Array<() => void> = [];

  constructor(private readonly terminal: WriteableTerminal) {}

  write(data: Uint8Array, onWritten: () => void): void {
    if (data.length === 0) {
      onWritten();
      return;
    }
    this.pending.push({ data, onWritten });
    this.drain();
  }

  writeAll(parts: readonly Uint8Array[], onWritten: () => void): void {
    const nonEmpty = parts.filter((part) => part.length > 0);
    if (nonEmpty.length === 0) {
      onWritten();
      return;
    }
    let remaining = nonEmpty.length;
    for (const part of nonEmpty) {
      this.write(part, () => {
        remaining -= 1;
        if (remaining === 0) onWritten();
      });
    }
  }

  /** Runs after every write already queued (including its xterm callback) has completed. */
  whenDrained(callback: () => void): void {
    this.idleCallbacks.push(callback);
    this.drain();
  }

  /**
   * Drops queued deltas and resets immediately before a replacement snapshot.
   * An already-running xterm write cannot be cancelled, so the reset is queued
   * after it; no stale queued delta can follow the replacement snapshot.
   */
  replaceAll(parts: readonly Uint8Array[], reset: () => void, onWritten: () => void): void {
    this.pending = [];
    const nonEmpty = parts.filter((part) => part.length > 0);
    this.pending.push({ data: null, onWritten: reset });
    if (nonEmpty.length === 0) {
      this.pending.push({ data: null, onWritten });
    } else {
      let remaining = nonEmpty.length;
      for (const part of nonEmpty) {
        this.pending.push({
          data: part,
          onWritten: () => {
            remaining -= 1;
            if (remaining === 0) onWritten();
          },
        });
      }
    }
    this.drain();
  }

  private drain(): void {
    if (this.writing) return;
    const next = this.pending.shift();
    if (!next) {
      const callbacks = this.idleCallbacks.splice(0);
      callbacks.forEach((callback) => callback());
      return;
    }
    this.writing = true;
    if (next.data === null) {
      this.writing = false;
      next.onWritten();
      this.drain();
      return;
    }
    this.terminal.write(next.data, () => {
      this.writing = false;
      next.onWritten();
      this.drain();
    });
  }
}
