import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getPtyMock,
  getXtermMock,
  PROJECT,
  renderMinimalShell,
  TestShell as Shell,
  waitForConnected,
} from './Shell.testHarness';

const ptyMock = getPtyMock();
const xtermMock = getXtermMock();

describe('Shell — scroll-to-bottom indicator (P0-1)', () => {
  it('appears when the viewport leaves the bottom and scrolls back on click', async () => {
    renderMinimalShell();
    await waitForConnected();

    const term = xtermMock.instances[0];
    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 40; // scrolled up

    act(() => {
      for (const handler of term.scrollHandlers) handler();
    });

    const indicator = await screen.findByTestId('shell-scroll-to-bottom');
    fireEvent.click(indicator);
    expect(term.scrollToBottom).toHaveBeenCalled();

    // Returning to the bottom hides the indicator.
    term.buffer.active.viewportY = 100;
    act(() => {
      for (const handler of term.scrollHandlers) handler();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument(),
    );
  });

  it('does not repeat a programmatic scroll while live output already follows the bottom', async () => {
    renderMinimalShell('pane-live-bottom');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-live-bottom'));

    const term = xtermMock.instances[0];
    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 100;
    term.write.mockClear();
    term.scrollToBottom.mockClear();
    ptyMock.ack.mockClear();

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-live-bottom', data: 'resumed output\n', seq: 1 });
      }
    });

    expect(term.write).toHaveBeenCalledWith('resumed output\n', expect.any(Function));
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-live-bottom',
        1,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('scrolls to the bottom when the terminal becomes active', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      top: 0,
      left: 0,
      right: 640,
      bottom: 360,
      toJSON: () => ({}),
    } as DOMRect);
    try {
      const { rerender } = render(
        <Shell
          selectedProject={PROJECT}
          initialCommand={undefined}
          minimal={true}
          autoConnect={true}
          paneId="pane-active"
          active={false}
          preservePtyOnUnmount={true}
          autoReconnectOnExit={false}
          onDisconnect={undefined}
          onInitialCommandSent={undefined}
          onUserSubmit={undefined}
        />,
      );
      await waitForConnected();

      const term = xtermMock.instances[0];
      term.buffer.active.baseY = 100;
      term.buffer.active.viewportY = 40;
      act(() => {
        for (const handler of term.scrollHandlers) handler();
      });
      // Hidden terminals intentionally avoid DOM/React display effects. The
      // active transition below performs the authoritative viewport recovery.
      expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument();

      term.scrollToBottom.mockClear();

      rerender(
        <Shell
          selectedProject={PROJECT}
          initialCommand={undefined}
          minimal={true}
          autoConnect={true}
          paneId="pane-active"
          active={true}
          preservePtyOnUnmount={true}
          autoReconnectOnExit={false}
          onDisconnect={undefined}
          onInitialCommandSent={undefined}
          onUserSubmit={undefined}
        />,
      );

      await waitFor(() => expect(term.scrollToBottom).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.queryByTestId('shell-scroll-to-bottom')).not.toBeInTheDocument(),
      );
    } finally {
      rectSpy.mockRestore();
    }
  });

});
