import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatBlock } from './ChatBlock';
import type { ChatBlock as ChatBlockModel } from '../ansi-classifier';

const xtermMock = vi.hoisted(() => {
  const instances: Array<{
    dispose: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
  }> = [];

  const Terminal = vi.fn(function Terminal(options: Record<string, unknown>) {
    const instance = {
      dispose: vi.fn(),
      open: vi.fn(),
      reset: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      options: { ...options },
    };
    instances.push(instance);
    return instance;
  });

  return { Terminal, instances };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: xtermMock.Terminal,
}));

const theme = { background: '#000000', foreground: '#ffffff' };

function chatBlock(data: string): ChatBlockModel {
  return {
    id: 'block-1',
    type: 'chat',
    data,
    startedAt: 1,
    updatedAt: 1,
  };
}

describe('ChatBlock', () => {
  afterEach(() => {
    cleanup();
    xtermMock.Terminal.mockClear();
    xtermMock.instances.length = 0;
  });

  it('keeps the xterm instance and writes only appended data', () => {
    const { rerender } = render(<ChatBlock block={chatBlock('hello')} replayNonce={0} theme={theme} />);

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('hello');

    rerender(<ChatBlock block={chatBlock('hello world')} replayNonce={0} theme={theme} />);

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].reset).not.toHaveBeenCalled();
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith(' world');
  });

  it('resets the existing terminal when data is replaced', () => {
    const { rerender } = render(<ChatBlock block={chatBlock('old output')} replayNonce={0} theme={theme} />);

    rerender(<ChatBlock block={chatBlock('new output')} replayNonce={0} theme={theme} />);

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].reset).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('new output');
  });

  it('replays the existing transcript into the same xterm after a viewport signal', () => {
    const { rerender } = render(<ChatBlock block={chatBlock('stable output')} replayNonce={0} theme={theme} />);

    rerender(<ChatBlock block={chatBlock('stable output')} replayNonce={1} theme={theme} />);

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].reset).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('stable output');
  });
});
