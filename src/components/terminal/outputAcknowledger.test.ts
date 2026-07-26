import { describe, expect, it, vi } from 'vitest';
import { createOutputAcknowledger, type OutputAckRequest } from './outputAcknowledger';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const request = (throughSeq: number): OutputAckRequest => ({
  id: 'pty-1',
  throughSeq,
  consumerKind: 'renderer',
  consumerId: 'main-1',
});

describe('createOutputAcknowledger', () => {
  it('coalesces newer cumulative ACKs while one IPC call is in flight', async () => {
    const first = deferred();
    const send = vi
      .fn<(value: OutputAckRequest) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const acknowledger = createOutputAcknowledger(send);

    acknowledger.ack(request(10));
    acknowledger.ack(request(11));
    acknowledger.ack(request(15));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    first.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([value]) => value.throughSeq)).toEqual([10, 15]);
  });

  it('retries a failed ACK without requiring a later output event', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(value: OutputAckRequest) => Promise<void>>()
      .mockRejectedValueOnce(new Error('IPC dropped'))
      .mockResolvedValue(undefined);
    const acknowledger = createOutputAcknowledger(send, 50);

    acknowledger.ack(request(20));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith(request(20));

    acknowledger.dispose();
    vi.useRealTimers();
  });

  it('cancels scheduled retries when disposed', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const acknowledger = createOutputAcknowledger(send, 50);

    acknowledger.ack(request(30));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    acknowledger.dispose();
    first.reject(new Error('IPC dropped'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('discards one PTY and ignores its late in-flight completion after replacement', async () => {
    const oldSend = deferred();
    const send = vi
      .fn<(value: OutputAckRequest) => Promise<void>>()
      .mockReturnValueOnce(oldSend.promise)
      .mockResolvedValue(undefined);
    const acknowledger = createOutputAcknowledger(send);

    acknowledger.ack(request(30));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    acknowledger.discard('pty-1');
    expect(acknowledger.getDiagnostics().pendingCount).toBe(0);

    acknowledger.ack(request(40));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    oldSend.resolve();
    await Promise.resolve();

    expect(send.mock.calls.map(([value]) => value.throughSeq)).toEqual([30, 40]);
    acknowledger.dispose();
  });

  it('cancels a per-PTY retry timer when that runtime is discarded', async () => {
    vi.useFakeTimers();
    const send = vi.fn<(value: OutputAckRequest) => Promise<void>>().mockRejectedValue(
      new Error('IPC dropped'),
    );
    const acknowledger = createOutputAcknowledger(send, 50);

    acknowledger.ack(request(50));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    acknowledger.discard('pty-1');
    await vi.advanceTimersByTimeAsync(100);

    expect(send).toHaveBeenCalledTimes(1);
    expect(acknowledger.getDiagnostics().pendingCount).toBe(0);
    acknowledger.dispose();
    vi.useRealTimers();
  });

  it('keeps one retry chain and catches up to the newest ACK after repeated failures', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(value: OutputAckRequest) => Promise<void>>()
      .mockRejectedValueOnce(new Error('IPC dropped 1'))
      .mockRejectedValueOnce(new Error('IPC dropped 2'))
      .mockRejectedValueOnce(new Error('IPC dropped 3'))
      .mockResolvedValue(undefined);
    const acknowledger = createOutputAcknowledger(send, 50);

    acknowledger.ack(request(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    acknowledger.ack(request(20));
    acknowledger.ack(request(40));

    await vi.advanceTimersByTimeAsync(49);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(request(40));

    await vi.advanceTimersByTimeAsync(50);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.map(([value]) => value.throughSeq)).toEqual([
      10,
      40,
      40,
      40,
    ]);
    await vi.waitFor(() =>
      expect(acknowledger.getDiagnostics().pendingCount).toBe(0),
    );

    acknowledger.dispose();
    vi.useRealTimers();
  });

  it('retries one PTY without delaying ACKs for another PTY', async () => {
    vi.useFakeTimers();
    let failedPtyAttempts = 0;
    const send = vi.fn(async (value: OutputAckRequest) => {
      if (value.id === 'pty-1' && failedPtyAttempts < 2) {
        failedPtyAttempts += 1;
        throw new Error('PTY 1 IPC dropped');
      }
    });
    const acknowledger = createOutputAcknowledger(send, 50);
    const secondPtyRequest = (throughSeq: number): OutputAckRequest => ({
      ...request(throughSeq),
      id: 'pty-2',
    });

    acknowledger.ack(request(10));
    acknowledger.ack(secondPtyRequest(5));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    acknowledger.ack(secondPtyRequest(8));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenLastCalledWith(secondPtyRequest(8));

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() =>
      expect(acknowledger.getDiagnostics().pendingCount).toBe(0),
    );
    expect(
      send.mock.calls
        .filter(([value]) => value.id === 'pty-1')
        .map(([value]) => value.throughSeq),
    ).toEqual([10, 10, 10]);
    expect(
      send.mock.calls
        .filter(([value]) => value.id === 'pty-2')
        .map(([value]) => value.throughSeq),
    ).toEqual([5, 8]);

    acknowledger.dispose();
    vi.useRealTimers();
  });
});
