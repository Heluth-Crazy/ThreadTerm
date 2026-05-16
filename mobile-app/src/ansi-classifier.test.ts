import { describe, expect, it } from 'vitest';
import {
  AnsiStreamClassifier,
  TUI_BLOCK_MAX_BYTES,
  detectTuiSignal,
  isChatChunk,
} from './ansi-classifier';

describe('AnsiStreamClassifier', () => {
  it('keeps pure SGR text as chat blocks', () => {
    const classifier = new AnsiStreamClassifier();
    classifier.push('\x1b[32mHello\x1b[0m world\n', 0);

    expect(classifier.getBlocks()).toMatchObject([
      {
        type: 'chat',
        data: '\x1b[32mHello\x1b[0m world\n',
      },
    ]);
    expect(isChatChunk('\x1b[31mOK\x1b[0m\n')).toBe(true);
  });

  it('wraps alternate screen output into one TUI block until exit', () => {
    const classifier = new AnsiStreamClassifier();
    classifier.push('\x1b[?1049h\x1b[1;1H┌ Menu ┐', 0);
    classifier.push('\x1b[2;1H│ item │\x1b[?1049l', 50);

    expect(classifier.getBlocks()).toMatchObject([
      {
        type: 'tui',
        reason: 'alternate-screen',
        complete: true,
      },
    ]);
  });

  it('detects cursor up, absolute cursor, erase line, carriage return, and box drawing signals', () => {
    expect(detectTuiSignal('\x1b[1A')).toBe('cursor-up');
    expect(detectTuiSignal('\x1b[12;4H')).toBe('absolute-cursor');
    expect(detectTuiSignal('\x1b[K')).toBe('erase-line');
    expect(detectTuiSignal('Reconnecting...\r')).toBe('carriage-return');
    expect(detectTuiSignal('┌────┐\n')).toBe('box-drawing');
  });

  it('keeps transient TUI chunks open until a safe frame delay passes', () => {
    const classifier = new AnsiStreamClassifier();
    classifier.push('Reconnecting... 1/5\r\x1b[K', 0);
    classifier.push('Reconnecting... 2/5\n', 80);

    expect(classifier.getBlocks()[0]).toMatchObject({
      type: 'tui',
      complete: false,
    });

    classifier.flush(281);
    expect(classifier.getBlocks()[0]).toMatchObject({
      type: 'tui',
      complete: true,
    });
  });

  it('completes a TUI block once it exceeds the size cap and starts a new block on next push', () => {
    const classifier = new AnsiStreamClassifier();
    // Open an alt-screen TUI block so the sticky state engages.
    classifier.push('\x1b[?1049h', 0);

    // First chunk grows the block past the size cap. It is still appended into
    // the original block because the cap check runs on the existing size BEFORE
    // appending; this matches a realistic streaming scenario where one chunk
    // crosses the threshold.
    const firstChunkBytes = TUI_BLOCK_MAX_BYTES + 5_000;
    classifier.push('A'.repeat(firstChunkBytes), 10);

    let blocks = classifier.getBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'tui', complete: false });
    expect((blocks[0] as { data: string }).data.length).toBeGreaterThanOrEqual(
      TUI_BLOCK_MAX_BYTES,
    );

    // Next chunk sees the over-cap block, completes it, and starts a fresh block.
    classifier.push('B'.repeat(10_000), 20);

    blocks = classifier.getBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'tui', complete: true });
    expect(blocks[1]).toMatchObject({ type: 'tui', complete: false });
    expect((blocks[1] as { data: string }).data.length).toBe(10_000);
  });

  it('starts a new chat block after a completed safe-frame TUI block', () => {
    const classifier = new AnsiStreamClassifier();
    classifier.push('Working\r\x1b[KDone\n', 0);
    classifier.flush(250);
    classifier.push('Final answer\n', 260);

    expect(classifier.getBlocks()).toMatchObject([
      { type: 'tui', complete: true },
      { type: 'chat', data: 'Final answer\n' },
    ]);
  });
});
