import { describe, expect, it } from 'vitest';
import { TerminalWriteQueue } from './writeQueue';
import { shouldFocusAfterSurfaceReady } from './presentation';

describe('terminal-host write ACK ordering', () => {
  it('calls completion only after the corresponding xterm write completes', () => {
    const callbacks: Array<() => void> = [];
    const terminal = { write: (_data: Uint8Array, callback: () => void) => callbacks.push(callback) };
    const queue = new TerminalWriteQueue(terminal);
    let acked = false;
    queue.write(new Uint8Array([1]), () => { acked = true; });
    expect(acked).toBe(false);
    callbacks.shift()?.();
    expect(acked).toBe(true);
  });

  it('does not report drained until the retained tail write completes', () => {
    const callbacks: Array<() => void> = [];
    const terminal = { write: (_data: Uint8Array, callback: () => void) => callbacks.push(callback) };
    const queue = new TerminalWriteQueue(terminal);
    const order: string[] = [];
    queue.write(new Uint8Array([1]), () => order.push('tail-written'));
    queue.whenDrained(() => order.push('drained'));
    expect(order).toEqual([]);
    callbacks.shift()?.();
    expect(order).toEqual(['tail-written', 'drained']);
  });

  it('does not focus for a background presentation; focus is an explicit ready-time branch', () => {
    expect(shouldFocusAfterSurfaceReady('background')).toBe(false);
    expect(shouldFocusAfterSurfaceReady('focused')).toBe(true);
  });

  it('drops queued deltas before applying a replacement snapshot', () => {
    const writes: number[] = [];
    const callbacks: Array<() => void> = [];
    const terminal = { write: (data: Uint8Array, callback: () => void) => {
      writes.push(data[0]);
      callbacks.push(callback);
    } };
    const queue = new TerminalWriteQueue(terminal);
    queue.write(new Uint8Array([1]), () => {});
    queue.write(new Uint8Array([2]), () => {});
    let reset = false;
    queue.replaceAll([new Uint8Array([3])], () => { reset = true; }, () => {});
    callbacks.shift()?.();
    expect(reset).toBe(true);
    expect(writes).toEqual([1, 3]);
  });

  it('does not drain past an asynchronous resync replacement snapshot', () => {
    const writes: number[] = [];
    const callbacks: Array<() => void> = [];
    const terminal = { write: (data: Uint8Array, callback: () => void) => {
      writes.push(data[0]);
      callbacks.push(callback);
    } };
    const queue = new TerminalWriteQueue(terminal);
    const order: string[] = [];
    queue.write(new Uint8Array([1]), () => order.push('old-write-finished'));
    queue.replaceAll(
      [new Uint8Array([9])],
      () => order.push('reset'),
      () => order.push('snapshot-written'),
    );
    queue.whenDrained(() => order.push('close'));

    callbacks.shift()?.();
    expect(writes).toEqual([1, 9]);
    expect(order).toEqual(['old-write-finished', 'reset']);
    callbacks.shift()?.();
    expect(order).toEqual(['old-write-finished', 'reset', 'snapshot-written', 'close']);
  });
});
