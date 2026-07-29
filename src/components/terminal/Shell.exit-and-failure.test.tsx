import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  emitExit,
  getPtyMock,
  getXtermMock,
  renderMinimalShell,
  waitForConnected,
} from './Shell.testHarness';

const ptyMock = getPtyMock();
const xtermMock = getXtermMock();

describe('Shell — exit handling (P1-2)', () => {
  it('appends an exit banner without clearing the screen and shows the exit strip', async () => {
    renderMinimalShell();
    await waitForConnected();

    const term = xtermMock.instances[0];
    term.clear.mockClear();

    act(() => {
      emitExit({ id: 'pane-1', code: 1 });
    });

    const banner = term.write.mock.calls
      .map((call) => call[0] as string)
      .find((data) => data.includes('shell.exitBannerCode'));
    expect(banner).toBeDefined();
    expect(banner).toContain('\x1b[31m'); // red — non-zero exit
    expect(term.clear).not.toHaveBeenCalled();
    expect(await screen.findByTestId('shell-exit-strip')).toBeInTheDocument();
  });

  it('does not auto-respawn after exit until the user clicks restart', async () => {
    renderMinimalShell();
    await waitForConnected();
    expect(ptyMock.create).toHaveBeenCalledTimes(1);

    act(() => {
      emitExit({ id: 'pane-1', code: 0 });
    });
    await screen.findByTestId('shell-exit-strip');

    // The autoConnect effect re-ran on the isConnected flip; the exit gate
    // must have blocked the silent respawn.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ptyMock.create).toHaveBeenCalledTimes(1);

    const term = xtermMock.instances[0];
    fireEvent.click(screen.getByText('shell.restartSession'));
    expect(term.clear).toHaveBeenCalled();
    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByTestId('shell-exit-strip')).not.toBeInTheDocument(),
    );
  });

  it('ignores exits from other panes', async () => {
    renderMinimalShell();
    await waitForConnected();

    act(() => {
      emitExit({ id: 'other-pane', code: 1 });
    });
    expect(screen.queryByTestId('shell-exit-strip')).not.toBeInTheDocument();
  });
});

describe('Shell — connection failure surfacing (P1-4)', () => {
  it('shows the reconnect strip with the error when the PTY cannot be created', async () => {
    ptyMock.isTauri.value = false; // connectPty throws shell.ptyDesktopOnly

    renderMinimalShell();

    const strip = await screen.findByTestId('shell-reconnect-strip');
    expect(strip).toHaveTextContent('shell.connectionError');
    expect(screen.getByText('shell.retryNow')).toBeInTheDocument();
  });

  it('retry button reconnects immediately and clears the strip on success', async () => {
    ptyMock.isTauri.value = false;
    renderMinimalShell();
    await screen.findByTestId('shell-reconnect-strip');

    ptyMock.isTauri.value = true;
    fireEvent.click(screen.getByText('shell.retryNow'));

    await waitFor(() => expect(ptyMock.create).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId('shell-reconnect-strip')).not.toBeInTheDocument(),
    );
  });

  it('unregisters the renderer and reports failure when snapshot attach rejects', async () => {
    ptyMock.attachSnapshot.mockRejectedValueOnce(new Error('snapshot IPC failed'));

    renderMinimalShell();

    expect(await screen.findByTestId('shell-reconnect-strip')).toBeInTheDocument();
    const [ptyId, consumerId] = ptyMock.registerOutputConsumer.mock.calls[0];
    await waitFor(() => {
      expect(ptyMock.unregisterOutputConsumer).toHaveBeenCalledWith(ptyId, consumerId);
    });
    expect(ptyMock.ack).not.toHaveBeenCalled();
  });
});
