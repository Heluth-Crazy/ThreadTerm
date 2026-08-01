/**
 * Batch 1 gate — prove attach-snapshot rehydration is lossless enough to
 * allow cold terminal surface recycling in Batch 2.
 *
 * Covers: 3000-line history, TUI/ANSI/Unicode, resize/cursor, continuous
 * output during recovery, seq interleaving, main+float dual consumers, and
 * failed recovery without creating a new session.
 */
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getPtyMock,
  getXtermMock,
  renderMinimalShell,
  renderShellProps,
  waitForConnected,
} from './Shell.testHarness';

const ptyMock = getPtyMock();
const xtermMock = getXtermMock();

function historyLines(count: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`history-line-${i}`);
  }
  return `${lines.join('\n')}\n`;
}

describe('Shell — renderer rehydration contract (Batch 1 gate)', () => {
  it('replays a full 3000-line history plus screen, cursor size, and watermark', async () => {
    const history = historyLines(3000);
    const screen = 'current-tui-screen\n';
    ptyMock.attachSnapshot.mockResolvedValueOnce({
      ptyId: 'pane-scrollback',
      data: screen,
      history,
      seq: 9001,
      rows: 40,
      cols: 120,
      cursorRow: 12,
      cursorCol: 8,
    });

    renderMinimalShell('pane-scrollback');
    await waitForConnected();

    await waitFor(() => {
      expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-scrollback');
    });

    const term = xtermMock.instances[0];
    await waitFor(() => {
      expect(term.resize).toHaveBeenCalledWith(120, 40);
      expect(term.write).toHaveBeenCalledWith(
        `${history}${screen}`,
        expect.any(Function),
      );
    });

    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-scrollback',
        9001,
        'renderer',
        expect.any(String),
      );
    });

    const snapshotWrite = term.write.mock.calls.find(
      ([data]) => typeof data === 'string' && data.includes('history-line-1'),
    );
    expect(snapshotWrite?.[0]).toContain('history-line-3000');
    expect(snapshotWrite?.[0]).toContain('current-tui-screen');
    // Exactly 3000 history markers — no silent truncation in the attach payload.
    expect((snapshotWrite?.[0] as string).match(/history-line-/g)?.length).toBe(3000);
  });

  it('preserves fullscreen TUI erase frames, Unicode, and ANSI through recovery', async () => {
    const tuiFrame =
      '\x1b[?1049h\x1b[2J\x1b[H\x1b[1;32m全屏 TUI\x1b[0m ✨\r\n' +
      '\x1b[?2026h\x1b[2J\x1b[3Jstatus\x1b[?2026l';
    ptyMock.attachSnapshot.mockResolvedValueOnce({
      ptyId: 'pane-tui',
      data: tuiFrame,
      history: 'before-alt-screen\n',
      seq: 42,
      rows: 24,
      cols: 80,
      cursorRow: 2,
      cursorCol: 1,
    });

    renderMinimalShell('pane-tui');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-tui'));

    const term = xtermMock.instances[0];
    await waitFor(() => {
      const joined = term.write.mock.calls.map(([data]) => data).join('');
      expect(joined).toContain('\x1b[?1049h');
      expect(joined).toContain('\x1b[2J');
      expect(joined).toContain('\x1b[3J');
      expect(joined).toContain('全屏 TUI');
      expect(joined).toContain('✨');
      expect(joined).toContain('before-alt-screen');
    });
  });

  it('buffers live output during snapshot recovery and only paints seq after the watermark', async () => {
    let resolveSnapshot:
      | ((value: {
          ptyId: string;
          data: string;
          history: string;
          seq: number;
          rows: number;
          cols: number;
          cursorRow: number;
          cursorCol: number;
        }) => void)
      | undefined;
    ptyMock.attachSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    renderMinimalShell('pane-interleave');
    await waitForConnected();

    const term = xtermMock.instances[0];
    term.write.mockClear();
    ptyMock.ack.mockClear();

    // Live output arrives while the attach snapshot is still in flight.
    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-interleave', data: 'covered-by-snapshot', seq: 10 });
        handler({ id: 'pane-interleave', data: 'after-snapshot-a', seq: 12 });
        handler({ id: 'pane-interleave', data: 'after-snapshot-b', seq: 13 });
      }
    });

    // Nothing live is painted until the snapshot applies (reset + pending gate).
    expect(
      term.write.mock.calls.some(
        ([data]) =>
          typeof data === 'string' &&
          (data.includes('covered-by-snapshot') || data.includes('after-snapshot')),
      ),
    ).toBe(false);

    act(() => {
      resolveSnapshot?.({
        ptyId: 'pane-interleave',
        data: 'screen@11',
        history: 'hist\n',
        seq: 11,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 1,
      });
    });

    await waitFor(() => {
      const painted = term.write.mock.calls.map(([data]) => data).join('');
      expect(painted).toContain('hist\nscreen@11');
      expect(painted).toContain('after-snapshot-a');
      expect(painted).toContain('after-snapshot-b');
      expect(painted).not.toContain('covered-by-snapshot');
    });

    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-interleave',
        13,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('keeps main and float renderer consumers independent on the same PTY', async () => {
    const main = renderMinimalShell('pane-shared', false, undefined, 'main');
    const float = render(renderShellProps('pane-shared', undefined, true, 'float'));

    await waitForConnected();
    await waitFor(() => {
      const consumerIds = ptyMock.registerOutputConsumer.mock.calls
        .filter(([ptyId]) => ptyId === 'pane-shared')
        .map(([, consumerId]) => consumerId as string);
      expect(consumerIds.some((id) => id.startsWith('renderer:main:'))).toBe(true);
      expect(consumerIds.some((id) => id.startsWith('renderer:float:'))).toBe(true);
    });

    expect(xtermMock.instances.length).toBeGreaterThanOrEqual(2);

    main.unmount();
    float.unmount();
  });

  it('does not kill the session or ACK when snapshot recovery fails', async () => {
    ptyMock.attachSnapshot.mockRejectedValueOnce(new Error('snapshot IPC failed'));
    ptyMock.kill.mockClear();
    ptyMock.ack.mockClear();

    const { unmount } = renderMinimalShell('pane-fail');

    // Existing failure UX: show reconnect strip, drop the renderer lease, keep PTY.
    const strip = await waitFor(() => {
      const el = document.querySelector('[data-testid="shell-reconnect-strip"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(strip).not.toBeNull();

    await waitFor(() => {
      expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-fail');
      expect(ptyMock.unregisterOutputConsumer).toHaveBeenCalled();
    });
    expect(ptyMock.kill).not.toHaveBeenCalled();
    expect(ptyMock.ack).not.toHaveBeenCalled();

    unmount();
  });

  it('reattaches the same pane id after unmount without killing the session', async () => {
    ptyMock.attachSnapshot.mockResolvedValue({
      ptyId: 'pane-remount',
      data: 'alive',
      history: 'h\n',
      seq: 5,
      rows: 24,
      cols: 80,
      cursorRow: 1,
      cursorCol: 1,
    });

    const first = renderMinimalShell('pane-remount');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-remount'));
    first.unmount();

    // Simulate Rust still holding the PTY after the renderer unmounted.
    // Frontend always calls pty.create(paneId) to (re)attach; Rust must keep
    // the same session rather than minting a different id.
    ptyMock.getSessionState.mockImplementation(
      (async () => ({
        id: 'pane-remount',
        status: 'running',
      })) as typeof ptyMock.getSessionState,
    );
    ptyMock.create.mockImplementation(async (id: string) => id);
    ptyMock.attachSnapshot.mockClear();
    ptyMock.create.mockClear();
    ptyMock.kill.mockClear();

    const second = renderMinimalShell('pane-remount');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-remount'));

    expect(ptyMock.create).toHaveBeenCalledWith(
      'pane-remount',
      '/tmp/proj',
      expect.any(Number),
      expect.any(Number),
    );
    await expect(ptyMock.create.mock.results[0]?.value).resolves.toBe('pane-remount');
    expect(ptyMock.kill).not.toHaveBeenCalled();
    second.unmount();
  });
});
