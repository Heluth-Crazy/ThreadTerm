import type { OutputChunk } from '@threadterm/protocol';

type Consumer = (chunk: OutputChunk) => void | Promise<void>;

/** One upstream output cursor, many local views; credit waits for every view. */
export class OutputFanout {
  private readonly consumers = new Map<string, Consumer>();
  add(id: string, consumer: Consumer): () => void { this.consumers.set(id, consumer); return () => this.consumers.delete(id); }
  get size(): number { return this.consumers.size; }
  async publish(chunk: OutputChunk): Promise<void> {
    const pending = [...this.consumers.values()].map((consumer) => Promise.resolve().then(() => consumer(chunk)));
    await Promise.all(pending);
  }
  dispose(): void { this.consumers.clear(); }
}
