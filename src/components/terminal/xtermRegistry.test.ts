import { afterEach, describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  claimTerminalActive,
  getAbsoluteCursorRow,
  getTerminal,
  readBufferRange,
  registerTerminal,
  unregisterTerminal,
} from './xtermRegistry';

interface MockLine {
  translateToString: (trimRight?: boolean) => string;
}

interface MockTerminalOptions {
  baseY: number;
  cursorY: number;
  lines: Record<number, string>;
}

function mockTerminal({ baseY, cursorY, lines }: MockTerminalOptions): Terminal {
  return {
    buffer: {
      active: {
        baseY,
        cursorY,
        getLine: (row: number): MockLine | undefined => {
          const value = lines[row];
          if (value === undefined) return undefined;
          return { translateToString: () => value };
        },
      },
    },
  } as unknown as Terminal;
}

describe('xtermRegistry', () => {
  afterEach(() => {
    unregisterTerminal('pty-1');
  });

  it('falls back to the previous terminal when the active terminal unregisters', () => {
    const main = mockTerminal({ baseY: 10, cursorY: 1, lines: {} });
    const float = mockTerminal({ baseY: 20, cursorY: 2, lines: {} });

    registerTerminal('pty-1', main);
    registerTerminal('pty-1', float);
    expect(getTerminal('pty-1')).toBe(float);

    unregisterTerminal('pty-1', float);
    expect(getTerminal('pty-1')).toBe(main);
  });

  it('lets the foreground shell claim active ownership for cursor and buffer reads', () => {
    const main = mockTerminal({
      baseY: 10,
      cursorY: 4,
      lines: {
        11: 'main output',
        12: 'main tail',
      },
    });
    const float = mockTerminal({
      baseY: 40,
      cursorY: 3,
      lines: {
        11: 'float output',
      },
    });

    registerTerminal('pty-1', main);
    registerTerminal('pty-1', float);
    claimTerminalActive('pty-1', main);

    expect(getTerminal('pty-1')).toBe(main);
    expect(getAbsoluteCursorRow('pty-1')).toBe(14);
    expect(readBufferRange('pty-1', 10, 12)).toBe('main output\nmain tail');
  });

  it('clears all registrations when unregistering without a terminal instance', () => {
    const main = mockTerminal({ baseY: 0, cursorY: 0, lines: {} });
    const float = mockTerminal({ baseY: 1, cursorY: 1, lines: {} });

    registerTerminal('pty-1', main);
    registerTerminal('pty-1', float);
    unregisterTerminal('pty-1');

    expect(getTerminal('pty-1')).toBeUndefined();
  });
});
