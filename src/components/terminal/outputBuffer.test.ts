import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCardOutputBuffer } from './outputBuffer';

describe('createCardOutputBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSink() {
    return {
      flushOutput: vi.fn(),
      flushPreview: vi.fn(),
    };
  }

  it('coalesces a chunk burst into a single joined flush after flushMs', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);

    buffer.pushChunk('a', 'one');
    buffer.pushChunk('a', 'two');
    buffer.pushChunk('a', 'three');
    expect(sink.flushOutput).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(sink.flushOutput).toHaveBeenCalledTimes(1);
    expect(sink.flushOutput).toHaveBeenCalledWith('a', 'onetwothree');
  });

  it('keeps only the latest preview per card', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);

    buffer.pushPreview('a', 'stale');
    buffer.pushPreview('a', 'fresh');
    vi.advanceTimersByTime(100);

    expect(sink.flushPreview).toHaveBeenCalledTimes(1);
    expect(sink.flushPreview).toHaveBeenCalledWith('a', 'fresh');
  });

  it('delivers output and preview through one combined flush when available', () => {
    const flushCardUpdate = vi.fn();
    const buffer = createCardOutputBuffer({ flushCardUpdate }, 100);

    buffer.pushChunk('a', 'one');
    buffer.pushChunk('a', 'two');
    buffer.pushPreview('a', 'preview');
    vi.advanceTimersByTime(100);

    expect(flushCardUpdate).toHaveBeenCalledTimes(1);
    expect(flushCardUpdate).toHaveBeenCalledWith('a', 'onetwo', 'preview');
    expect(buffer.getDiagnostics()).toMatchObject({ pendingCardCount: 0 });
  });

  it('flushes cards independently of each other', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);

    buffer.pushChunk('a', 'A');
    buffer.pushChunk('b', 'B');
    vi.advanceTimersByTime(100);

    expect(sink.flushOutput).toHaveBeenCalledWith('a', 'A');
    expect(sink.flushOutput).toHaveBeenCalledWith('b', 'B');
  });

  it('flushCard drains one card synchronously and leaves others pending', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);

    buffer.pushChunk('a', 'A');
    buffer.pushChunk('b', 'B');
    buffer.flushCard('a');

    expect(sink.flushOutput).toHaveBeenCalledTimes(1);
    expect(sink.flushOutput).toHaveBeenCalledWith('a', 'A');

    vi.advanceTimersByTime(100);
    expect(sink.flushOutput).toHaveBeenCalledWith('b', 'B');
  });

  it('flushCard on an empty buffer is a no-op', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);
    buffer.flushCard('missing');
    expect(sink.flushOutput).not.toHaveBeenCalled();
  });

  it('discardCard drops pending data without flushing', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);

    buffer.pushChunk('a', 'A');
    buffer.discardCard('a');
    vi.advanceTimersByTime(200);

    expect(sink.flushOutput).not.toHaveBeenCalled();
  });

  it('dispose flushes everything pending immediately', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);

    buffer.pushChunk('a', 'A');
    buffer.pushPreview('a', 'preview');
    buffer.dispose();

    expect(sink.flushOutput).toHaveBeenCalledWith('a', 'A');
    expect(sink.flushPreview).toHaveBeenCalledWith('a', 'preview');
  });

  it('a new burst after a flush schedules a fresh timer', () => {
    const sink = makeSink();
    const buffer = createCardOutputBuffer(sink, 100);

    buffer.pushChunk('a', 'first');
    vi.advanceTimersByTime(100);
    buffer.pushChunk('a', 'second');
    vi.advanceTimersByTime(100);

    expect(sink.flushOutput).toHaveBeenCalledTimes(2);
    expect(sink.flushOutput).toHaveBeenLastCalledWith('a', 'second');
  });
});
