import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getPtyMock,
  getXtermMock,
  renderMinimalShell,
  renderShellProps,
  waitForConnected,
} from './Shell.testHarness';
import {
  fitAddonFor,
  installGeometry,
  installManualSurfaceScheduler,
} from './Shell.surfaceRecovery.testHarness';
import {
  TERMINAL_GEOMETRY_INVALIDATED_EVENT,
  TERMINAL_SURFACE_SHOWN_EVENT,
} from './terminalSurfaceEvents';

const ptyMock = getPtyMock();
const xtermMock = getXtermMock();

describe('Shell — Windows surface recovery and hidden rendering (O-04 / C-03p)', () => {
  it('uses ordinary pointer clicks only to focus, without a full surface recovery', async () => {
    const view = renderMinimalShell('pane-focus-only');
    await waitForConnected();
    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    term.focus.mockClear();
    fitAddon?.fit.mockClear();
    ptyMock.resize.mockClear();

    fireEvent.mouseDown(view.container.firstElementChild as Element);

    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(fitAddon?.fit).not.toHaveBeenCalled();
    expect(ptyMock.resize).not.toHaveBeenCalled();
  });

  it('reasserts shared PTY geometry once after another renderer invalidates the local cache', async () => {
    const { spy: rectSpy } = installGeometry(800, 600);
    const { unmount } = renderMinimalShell('pane-shared-geometry');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.resize).toHaveBeenCalled());

    const term = xtermMock.instances[0];
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.resize.mockClear();
    const scheduler = installManualSurfaceScheduler();

    try {
      // An invalidation for another PTY must not defeat this Shell's local
      // resize dedupe cache.
      act(() => {
        window.dispatchEvent(new CustomEvent(TERMINAL_GEOMETRY_INVALIDATED_EVENT, {
          detail: { ptyId: 'another-pane' },
        }));
        window.dispatchEvent(new CustomEvent(TERMINAL_SURFACE_SHOWN_EVENT, {
          detail: { focus: false },
        }));
      });
      scheduler.runNextFrame();
      expect(ptyMock.resize).not.toHaveBeenCalled();

      // The matching invalidation means the float renderer may have changed
      // the backend geometry even though this xterm stayed at 24x80.
      act(() => {
        window.dispatchEvent(new CustomEvent(TERMINAL_GEOMETRY_INVALIDATED_EVENT, {
          detail: { ptyId: 'pane-shared-geometry' },
        }));
        window.dispatchEvent(new CustomEvent(TERMINAL_SURFACE_SHOWN_EVENT, {
          detail: { focus: false },
        }));
      });
      scheduler.runNextFrame();

      expect(ptyMock.resize).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledWith('pane-shared-geometry', 24, 80);
      expect(term.focus).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
      expect(scheduler.timeouts).toHaveLength(0);
    } finally {
      unmount();
      scheduler.restore();
      rectSpy.mockRestore();
    }
  });

  it('recovers from 0x0 once and does not repeat geometry, resize, scroll, or refresh work', async () => {
    const { geometry, spy: rectSpy } = installGeometry(0, 0);
    const { rerender, unmount } = render(renderShellProps('pane-recovery', undefined, false));
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-recovery'));

    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    expect(fitAddon).toBeDefined();
    fitAddon?.fit.mockClear();
    term.refresh.mockClear();
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.resize.mockClear();

    const scheduler = installManualSurfaceScheduler();
    try {
      rerender(renderShellProps('pane-recovery', undefined, true));
      expect(scheduler.frames).toHaveLength(1);
      expect(scheduler.timeouts).toHaveLength(4);
      const themeRefreshCount = term.refresh.mock.calls.length;

      // The first frame still sees Windows WebView2's transient zero-sized host.
      scheduler.runNextFrame();
      expect(fitAddon?.fit).not.toHaveBeenCalled();
      expect(ptyMock.resize).not.toHaveBeenCalled();
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount);

      geometry.width = 800;
      geometry.height = 600;
      scheduler.runTimeout(60);

      expect(fitAddon?.fit).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledWith('pane-recovery', 24, 80);
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount + 1);

      // Later focus retries may run, but geometry/viewport work is settled.
      scheduler.runTimeout(180);
      scheduler.runTimeout(400);
      scheduler.runTimeout(800);
      expect(fitAddon?.fit).toHaveBeenCalledTimes(1);
      expect(ptyMock.resize).toHaveBeenCalledTimes(1);
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount + 1);
    } finally {
      unmount();
      scheduler.restore();
      rectSpy.mockRestore();
    }
  });

  it('cancels pending recovery generations when inactive and on unmount', async () => {
    const { spy: rectSpy } = installGeometry(0, 0);
    const { rerender, unmount } = render(renderShellProps('pane-cancel', undefined, false));
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-cancel'));

    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    fitAddon?.fit.mockClear();
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    const scheduler = installManualSurfaceScheduler();

    try {
      rerender(renderShellProps('pane-cancel', undefined, true));
      expect(scheduler.frames).toHaveLength(1);
      expect(scheduler.timeouts).toHaveLength(4);

      rerender(renderShellProps('pane-cancel', undefined, false));
      expect(scheduler.frames).toHaveLength(0);
      expect(scheduler.timeouts).toHaveLength(0);
      expect(fitAddon?.fit).not.toHaveBeenCalled();
      expect(term.focus).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();

      rerender(renderShellProps('pane-cancel', undefined, true));
      expect(scheduler.frames).toHaveLength(1);
      expect(scheduler.timeouts).toHaveLength(4);
      unmount();
      expect(scheduler.frames).toHaveLength(0);
      expect(scheduler.timeouts).toHaveLength(0);
      expect(fitAddon?.fit).not.toHaveBeenCalled();
      expect(term.focus).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    } finally {
      scheduler.restore();
      rectSpy.mockRestore();
    }
  });

  it('coalesces 100 carriage-return chunks into one refresh in the same frame', async () => {
    renderMinimalShell('pane-cr');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-cr'));

    const term = xtermMock.instances[0];
    term.refresh.mockClear();
    ptyMock.ack.mockClear();
    const scheduler = installManualSurfaceScheduler();

    try {
      act(() => {
        for (let seq = 1; seq <= 100; seq += 1) {
          for (const handler of ptyMock.outputHandlers) {
            handler({ id: 'pane-cr', data: `progress ${seq}\r`, seq });
          }
        }
      });

      expect(term.write).toHaveBeenCalledTimes(100);
      expect(term.refresh).not.toHaveBeenCalled();
      expect(scheduler.requestFrame).toHaveBeenCalledTimes(1);
      expect(scheduler.frames).toHaveLength(1);

      scheduler.runNextFrame();
      expect(term.refresh).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.restore();
    }

    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenLastCalledWith(
        'pane-cr',
        100,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('keeps hidden xterm writes and drain ACKs but suppresses display effects until reactivated', async () => {
    const { rerender, container } = render(renderShellProps('pane-hidden', undefined, false));
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-hidden'));

    const term = xtermMock.instances[0];
    const fitAddon = fitAddonFor(term);
    const host = container.querySelector('.threadterm-xterm-host');
    expect(host).not.toBeNull();
    const querySelectorSpy = vi.spyOn(host as HTMLElement, 'querySelector');
    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 40;
    term.refresh.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.ack.mockClear();

    let drainWrite: (() => void) | undefined;
    term.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      drainWrite = callback;
    });

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-hidden', data: 'hidden progress\rhidden done\n', seq: 7 });
      }
    });

    expect(term.write).toHaveBeenCalledWith(
      'hidden progress\rhidden done\n',
      expect.any(Function),
    );
    expect(ptyMock.ack).not.toHaveBeenCalled();
    expect(querySelectorSpy).not.toHaveBeenCalled();
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    expect(term.refresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();

    act(() => drainWrite?.());
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-hidden',
        7,
        'renderer',
        expect.any(String),
      );
    });
    expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();

    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      toJSON: () => ({}),
    } as DOMRect);
    fitAddon?.fit.mockClear();
    term.focus.mockClear();
    term.scrollToBottom.mockClear();
    term.refresh.mockClear();

    try {
      rerender(renderShellProps('pane-hidden', undefined, true));
      const themeRefreshCount = term.refresh.mock.calls.length;
      await waitFor(() => expect(fitAddon?.fit).toHaveBeenCalledTimes(1));
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(term.refresh).toHaveBeenCalledTimes(themeRefreshCount + 1);
      expect(term.focus).toHaveBeenCalled();
      expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();
    } finally {
      rectSpy.mockRestore();
      querySelectorSpy.mockRestore();
    }
  });
});
