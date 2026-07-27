import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { createTerminalOutputPipeline } from './terminalOutputPipeline';
import type {
  OutputAcknowledger,
  RendererOutputConsumer,
} from './shellRuntimeTypes';

describe('createTerminalOutputPipeline synchronized redraws', () => {
  it('keeps the Codex usage redraw byte-exact and refreshes only after DEC 2026 closes', () => {
    const writes: string[] = [];
    const refresh = vi.fn();
    const ack = vi.fn();
    const terminal = {
      buffer: {
        active: {
          type: 'alternate',
          viewportY: 0,
          baseY: 0,
        },
      },
      hasSelection: () => false,
      write: (data: string, callback?: () => void) => {
        writes.push(data);
        callback?.();
      },
    } as unknown as Terminal;
    const consumer = {
      consumerId: 'consumer-a',
    } as RendererOutputConsumer;
    const pipeline = createTerminalOutputPipeline({
      connectedPtyId: 'pty-a',
      consumerId: 'consumer-a',
      outputAcknowledger: { ack } as unknown as OutputAcknowledger,
      isStaleSetup: () => false,
      terminalRef: { current: terminal },
      outputConsumerRef: { current: consumer },
      activeRef: { current: true },
      scrolledUpRef: { current: false },
      pendingNewLinesRef: { current: 0 },
      setScrolledUp: vi.fn(),
      scrollTerminalToBottom: vi.fn(),
      scheduleNewOutputFlush: vi.fn(),
      scheduleTerminalRefresh: refresh,
    });
    pipeline.applySnapshot({ seq: 0, data: '' });

    const chunks = [
      '\x1b[?2026h',
      '\r\x1b[2K• You have 3 usage limit resets available. Run /usage to use one.',
      '\r\x1b[2KYou have 3 usage limit resets available. Run /\r\n  usage to use one.',
      '\x1b[?20',
      '26l',
    ];
    chunks.forEach((data, index) => {
      pipeline.receive({ seq: index + 1, data });
    });

    expect(writes).toEqual(chunks);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(chunks.length);
    expect(ack).toHaveBeenLastCalledWith({
      id: 'pty-a',
      throughSeq: chunks.length,
      consumerKind: 'renderer',
      consumerId: 'consumer-a',
    });
  });

  it('keeps ordinary carriage-return progress refreshes outside synchronized frames', () => {
    const refresh = vi.fn();
    const terminal = {
      buffer: {
        active: {
          type: 'alternate',
          viewportY: 0,
          baseY: 0,
        },
      },
      hasSelection: () => false,
      write: (_data: string, callback?: () => void) => callback?.(),
    } as unknown as Terminal;
    const consumer = {
      consumerId: 'consumer-a',
    } as RendererOutputConsumer;
    const pipeline = createTerminalOutputPipeline({
      connectedPtyId: 'pty-a',
      consumerId: 'consumer-a',
      outputAcknowledger: {
        ack: vi.fn(),
      } as unknown as OutputAcknowledger,
      isStaleSetup: () => false,
      terminalRef: { current: terminal },
      outputConsumerRef: { current: consumer },
      activeRef: { current: true },
      scrolledUpRef: { current: false },
      pendingNewLinesRef: { current: 0 },
      setScrolledUp: vi.fn(),
      scrollTerminalToBottom: vi.fn(),
      scheduleNewOutputFlush: vi.fn(),
      scheduleTerminalRefresh: refresh,
    });
    pipeline.applySnapshot({ seq: 0, data: '' });
    pipeline.receive({ seq: 1, data: '\rprogress 10%' });
    pipeline.receive({ seq: 2, data: '\rprogress 20%' });

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('clears an unfinished synchronized-frame gate when the sequencer resets', () => {
    const refresh = vi.fn();
    const terminal = {
      buffer: {
        active: {
          type: 'alternate',
          viewportY: 0,
          baseY: 0,
        },
      },
      hasSelection: () => false,
      write: (_data: string, callback?: () => void) => callback?.(),
    } as unknown as Terminal;
    const consumer = {
      consumerId: 'consumer-a',
    } as RendererOutputConsumer;
    const pipeline = createTerminalOutputPipeline({
      connectedPtyId: 'pty-a',
      consumerId: 'consumer-a',
      outputAcknowledger: {
        ack: vi.fn(),
      } as unknown as OutputAcknowledger,
      isStaleSetup: () => false,
      terminalRef: { current: terminal },
      outputConsumerRef: { current: consumer },
      activeRef: { current: true },
      scrolledUpRef: { current: false },
      pendingNewLinesRef: { current: 0 },
      setScrolledUp: vi.fn(),
      scrollTerminalToBottom: vi.fn(),
      scheduleNewOutputFlush: vi.fn(),
      scheduleTerminalRefresh: refresh,
    });
    pipeline.applySnapshot({ seq: 0, data: '' });
    pipeline.receive({ seq: 1, data: '\x1b[?2026h\rhidden redraw' });
    expect(refresh).not.toHaveBeenCalled();

    pipeline.reset();
    pipeline.applySnapshot({ seq: 0, data: '' });
    pipeline.receive({ seq: 1, data: '\rvisible progress' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
