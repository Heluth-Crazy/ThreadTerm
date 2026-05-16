import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TuiBlock } from './TuiBlock';
import type { TuiBlock as TuiBlockModel } from '../ansi-classifier';

const xtermMock = vi.hoisted(() => {
  const instances: Array<{
    dispose: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    rows: number;
    options: Record<string, unknown>;
  }> = [];

  const Terminal = vi.fn(function Terminal(options: Record<string, unknown>) {
    const rows =
      typeof (options as { rows?: number }).rows === 'number'
        ? ((options as { rows: number }).rows)
        : 4;
    const instance = {
      dispose: vi.fn(),
      loadAddon: vi.fn(),
      open: vi.fn(),
      refresh: vi.fn(),
      reset: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      rows,
      options: { ...options },
    };
    instances.push(instance);
    return instance;
  });

  return { Terminal, instances };
});

const fitAddonMock = vi.hoisted(() => ({
  FitAddon: vi.fn(function FitAddon() {}),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: xtermMock.Terminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: fitAddonMock.FitAddon,
}));

const theme = { background: '#000000', foreground: '#ffffff' };

function tuiBlock(data: string): TuiBlockModel {
  return {
    id: 'block-1',
    type: 'tui',
    reason: 'carriage-return',
    data,
    startedAt: 1,
    updatedAt: 1,
    lines: 3,
    cols: 40,
    complete: false,
  };
}

describe('TuiBlock', () => {
  afterEach(() => {
    cleanup();
    xtermMock.Terminal.mockClear();
    xtermMock.instances.length = 0;
    fitAddonMock.FitAddon.mockClear();
  });

  it('renders xterm by default in detail mode and appends new data without recreating', () => {
    const { rerender } = render(
      <TuiBlock block={tuiBlock('frame 1')} replayNonce={0} theme={theme} mode="detail" />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('frame 1');

    rerender(
      <TuiBlock block={tuiBlock('frame 1\nframe 2')} replayNonce={0} theme={theme} mode="detail" />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].reset).not.toHaveBeenCalled();
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('\nframe 2');
  });

  it('disposes the xterm instance when collapsed via the summary toggle in detail mode', () => {
    render(<TuiBlock block={tuiBlock('frame 1')} replayNonce={0} theme={theme} mode="detail" />);

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);

    const button = screen.getByRole('button');
    // First click collapses (and disposes), second click re-expands (creating a new instance).
    fireEvent.click(button);
    expect(xtermMock.instances[0].dispose).toHaveBeenCalledTimes(1);

    fireEvent.click(button);
    expect(xtermMock.Terminal).toHaveBeenCalledTimes(2);
  });

  it('replays the TUI into the same xterm after a viewport signal in detail mode', () => {
    const { rerender } = render(
      <TuiBlock block={tuiBlock('frame 1')} replayNonce={0} theme={theme} mode="detail" />,
    );

    rerender(
      <TuiBlock block={tuiBlock('frame 1')} replayNonce={1} theme={theme} mode="detail" />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].reset).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('frame 1');
  });

  it('forces an initial xterm refresh after open in detail mode so first paint is not skipped', async () => {
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    render(<TuiBlock block={tuiBlock('frame 1')} replayNonce={0} theme={theme} mode="detail" />);

    expect(xtermMock.instances[0].open).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].refresh).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].refresh).toHaveBeenCalledWith(
      0,
      Math.max(0, (xtermMock.instances[0].rows as number) - 1),
    );

    rafSpy.mockRestore();
  });

  it('does not set inline minWidth on the detail-mode xterm host', () => {
    const { container } = render(
      <TuiBlock block={tuiBlock('frame 1')} replayNonce={0} theme={theme} mode="detail" />,
    );

    const host = container.querySelector<HTMLDivElement>('.tui-xterm-host');
    expect(host).not.toBeNull();
    expect(host?.style.minWidth).toBe('');
  });

  it('renders xterm immediately in preview mode without a summary toggle button', () => {
    const { rerender, container } = render(
      <TuiBlock block={tuiBlock('frame 1')} replayNonce={0} theme={theme} mode="preview" />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.tui-block-preview')).not.toBeNull();
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('frame 1');

    rerender(
      <TuiBlock block={tuiBlock('frame 1\nframe 2')} replayNonce={0} theme={theme} mode="preview" />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].reset).not.toHaveBeenCalled();
    expect(xtermMock.instances[0].write).toHaveBeenLastCalledWith('\nframe 2');

    rerender(
      <TuiBlock block={tuiBlock('frame 1\nframe 2')} replayNonce={1} theme={theme} mode="preview" />,
    );

    expect(xtermMock.instances[0].reset).toHaveBeenCalledTimes(1);
  });

  it('uses snapshotCols/snapshotRows for the xterm canvas when provided', () => {
    const wide = tuiBlock('frame 1');
    wide.cols = 300;
    wide.lines = 200;

    render(
      <TuiBlock
        block={wide}
        replayNonce={0}
        theme={theme}
        mode="detail"
        snapshotCols={80}
        snapshotRows={24}
      />,
    );

    expect(xtermMock.Terminal).toHaveBeenCalledTimes(1);
    const constructorArgs = xtermMock.Terminal.mock.calls[0][0] as {
      cols: number;
      rows: number;
    };
    expect(constructorArgs.cols).toBe(80);
    expect(constructorArgs.rows).toBe(24);
  });

  it('does not call resize when snapshot dimensions stay constant across rerenders', () => {
    const { rerender } = render(
      <TuiBlock
        block={tuiBlock('frame 1')}
        replayNonce={0}
        theme={theme}
        mode="detail"
        snapshotCols={80}
        snapshotRows={24}
      />,
    );

    const instance = xtermMock.instances[0];
    expect(instance.resize).not.toHaveBeenCalled();

    rerender(
      <TuiBlock
        block={tuiBlock('frame 1\nframe 2')}
        replayNonce={0}
        theme={theme}
        mode="detail"
        snapshotCols={80}
        snapshotRows={24}
      />,
    );

    expect(instance.resize).not.toHaveBeenCalled();

    rerender(
      <TuiBlock
        block={tuiBlock('frame 1\nframe 2\nframe 3')}
        replayNonce={0}
        theme={theme}
        mode="detail"
        snapshotCols={80}
        snapshotRows={24}
      />,
    );

    expect(instance.resize).not.toHaveBeenCalled();
  });

  it('resizes the xterm only when snapshot dimensions change', () => {
    const { rerender } = render(
      <TuiBlock
        block={tuiBlock('frame 1')}
        replayNonce={0}
        theme={theme}
        mode="detail"
        snapshotCols={80}
        snapshotRows={24}
      />,
    );

    const instance = xtermMock.instances[0];

    rerender(
      <TuiBlock
        block={tuiBlock('frame 1\nframe 2')}
        replayNonce={0}
        theme={theme}
        mode="detail"
        snapshotCols={100}
        snapshotRows={30}
      />,
    );

    expect(instance.resize).toHaveBeenCalledTimes(1);
    expect(instance.resize).toHaveBeenLastCalledWith(100, 30);
  });
});
