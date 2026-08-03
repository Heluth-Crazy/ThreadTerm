import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  emitExit,
  getPtyMock,
  getXtermMock,
  PROJECT,
  TestShell as Shell,
  waitForConnected,
} from './Shell.testHarness';

const ptyMock = getPtyMock();
const xtermMock = getXtermMock();

describe('Shell — Agent history resume progress', () => {
  it('dispatches a custom command without trimming or reordering it', async () => {
    render(
      <Shell
        selectedProject={PROJECT}
        initialCommand={'  tool --name="two words" --flag  '}
        minimal={true}
        autoConnect={true}
        paneId="pane-exact-command"
        active={true}
        preservePtyOnUnmount={true}
        suppressInitialCommandWhenPtyExists={false}
        resumeLoading={false}
        autoReconnectOnExit={false}
      />,
    );

    await waitFor(() =>
      expect(ptyMock.input).toHaveBeenCalledWith(
        'pane-exact-command',
        '  tool --name="two words" --flag  \r',
      ),
    );
  });

  it('keeps writing and acknowledging hidden history before revealing the final screen', async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
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

    try {
      const { container } = render(
        <Shell
          selectedProject={PROJECT}
          initialCommand="claude --resume session-a"
          minimal={true}
          autoConnect={true}
          paneId="pane-resume"
          active={true}
          preservePtyOnUnmount={true}
          suppressInitialCommandWhenPtyExists={true}
          resumeLoading={true}
          autoReconnectOnExit={false}
        />,
      );

      await waitFor(() =>
        expect(ptyMock.input).toHaveBeenCalledWith(
          'pane-resume',
          'claude --resume session-a\r',
        ),
      );
      const resumeOverlay = await screen.findByTestId('resume-loading-overlay');
      await waitFor(() => expect(resumeOverlay).toBeVisible());
      expect(
        container.querySelector('.threadterm-xterm-host'),
      ).toBeInTheDocument();

      const term = xtermMock.instances[0];
      const sendTerminalData = (
        term.onData.mock.calls as unknown as Array<[
          (data: string) => void,
        ]>
      )[0]?.[0];
      act(() => sendTerminalData?.('blocked while restoring\r'));
      expect(ptyMock.input).not.toHaveBeenCalledWith(
        'pane-resume',
        'blocked while restoring\r',
      );

      term.write.mockClear();
      term.scrollToBottom.mockClear();
      ptyMock.resize.mockClear();
      ptyMock.ack.mockClear();
      const startupOutput = 'agent bootstrap\r\n'.repeat(20);
      act(() => {
        for (const handler of ptyMock.outputHandlers) {
          handler({
            id: 'pane-resume',
            data: startupOutput,
            seq: 1,
          });
        }
      });

      expect(term.write).toHaveBeenCalledWith(
        startupOutput,
        expect.any(Function),
      );
      await waitFor(() =>
        expect(ptyMock.ack).toHaveBeenCalledWith(
          'pane-resume',
          1,
          'renderer',
          expect.any(String),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(screen.getByTestId('resume-loading-overlay')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'data-state',
        'determinate',
      );
      expect(
        Number(screen.getByRole('progressbar').getAttribute('aria-valuenow')),
      ).toBeLessThan(75);

      const restoredOutput =
        'delayed restored conversation with final prompt\r\n'.repeat(100);
      act(() => {
        for (const handler of ptyMock.outputHandlers) {
          handler({
            id: 'pane-resume',
            data: restoredOutput,
            seq: 2,
          });
        }
      });
      await waitFor(() =>
        expect(ptyMock.ack).toHaveBeenCalledWith(
          'pane-resume',
          2,
          'renderer',
          expect.any(String),
        ),
      );
      await waitFor(
        () => expect(resumeOverlay).not.toBeVisible(),
        { timeout: 4_000 },
      );
      expect(term.scrollToBottom).not.toHaveBeenCalled();
      expect(ptyMock.resize).not.toHaveBeenCalled();

      act(() => sendTerminalData?.('allowed after restore\r'));
      await waitFor(() =>
        expect(ptyMock.input).toHaveBeenCalledWith(
          'pane-resume',
          'allowed after restore\r',
        ),
      );
      await waitFor(() =>
        expect(
          screen.queryByTestId('resume-loading-overlay'),
        ).not.toBeInTheDocument(),
      );
    } finally {
      rectSpy.mockRestore();
    }
  }, 10_000);

  it('skips the progress overlay and resume command when attaching an existing PTY', async () => {
    ptyMock.getSessionState.mockImplementationOnce(
      async () => undefined as never,
    );

    render(
      <Shell
        selectedProject={PROJECT}
        initialCommand="gemini --resume session-existing"
        minimal={true}
        autoConnect={true}
        paneId="pane-existing"
        active={true}
        preservePtyOnUnmount={true}
        suppressInitialCommandWhenPtyExists={true}
        resumeLoading={true}
        autoReconnectOnExit={false}
      />,
    );

    await waitForConnected();
    await new Promise((resolve) => setTimeout(resolve, 240));

    expect(screen.queryByTestId('resume-loading-overlay')).not.toBeInTheDocument();
    expect(ptyMock.input).not.toHaveBeenCalledWith(
      'pane-existing',
      'gemini --resume session-existing\r',
    );
  });

  it('reveals the original exit state immediately when resume fails', async () => {
    render(
      <Shell
        selectedProject={PROJECT}
        initialCommand="opencode --session missing"
        minimal={true}
        autoConnect={true}
        paneId="pane-resume-exit"
        active={true}
        preservePtyOnUnmount={true}
        suppressInitialCommandWhenPtyExists={true}
        resumeLoading={true}
        autoReconnectOnExit={false}
      />,
    );

    await waitFor(() =>
      expect(ptyMock.input).toHaveBeenCalledWith(
        'pane-resume-exit',
        'opencode --session missing\r',
      ),
    );
    expect(await screen.findByTestId('resume-loading-overlay')).toBeInTheDocument();

    act(() => {
      emitExit({ id: 'pane-resume-exit', code: 1 });
    });

    expect(
      screen.queryByTestId('resume-loading-overlay'),
    ).not.toBeInTheDocument();
    expect(await screen.findByTestId('shell-exit-strip')).toBeInTheDocument();
  });
});
