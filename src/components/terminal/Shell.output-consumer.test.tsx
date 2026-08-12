import { act, render, screen, waitFor } from '@testing-library/react';
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

describe('Shell — PTY output consumer lifecycle', () => {
  it('accepts input and renders output on the first PTY connection', async () => {
    renderMinimalShell('first-pane');
    await waitForConnected();
    const term = xtermMock.instances[0];

    act(() => {
      for (const handler of term.dataHandlers) handler('echo ready\r');
    });
    await waitFor(() => {
      expect(ptyMock.input).toHaveBeenCalledWith('first-pane', 'echo ready\r');
    });

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'first-pane', data: 'ready\r\n', seq: 1 });
      }
    });
    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith('ready\r\n', expect.any(Function));
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'first-pane',
        1,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('registers a unique renderer consumer and unregisters it on unmount', async () => {
    const { unmount } = renderMinimalShell();
    await waitForConnected();

    const [, consumerId] = ptyMock.registerOutputConsumer.mock.calls[0];
    expect(consumerId).toMatch(/^renderer:main:/);
    expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
      'pane-1',
      expect.any(String),
    );

    unmount();
    await waitFor(() => {
      expect(ptyMock.unregisterOutputConsumer).toHaveBeenCalledWith(
        'pane-1',
        consumerId,
      );
    });
  });

  it('acks renderer output only after xterm reports the write drained', async () => {
    renderMinimalShell();
    await waitForConnected();
    const term = xtermMock.instances[0];
    let drainWrite: (() => void) | undefined;
    term.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      drainWrite = callback;
    });
    ptyMock.ack.mockClear();

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-1', data: 'render me', seq: 5 });
      }
    });
    expect(ptyMock.ack).not.toHaveBeenCalled();

    act(() => drainWrite?.());
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-1',
        5,
        'renderer',
        expect.any(String),
      );
    });
  });

  it('preserves synchronized ED2/ED3 frames without stalling renderer acknowledgements', async () => {
    renderMinimalShell();
    await waitForConnected();
    await waitFor(() => expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-1'));
    const term = xtermMock.instances[0];
    expect(term.options.scrollOnEraseInDisplay).toBe(false);
    term.write.mockClear();
    ptyMock.ack.mockClear();

    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-1', data: '\x1b[?2026hframe', seq: 1 });
        handler({ id: 'pane-1', data: '\x1b[2J\x1b[3J', seq: 2 });
        handler({ id: 'pane-1', data: 'done\x1b[?2026l\x1b[2J', seq: 3 });
      }
    });

    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-1',
        3,
        'renderer',
        expect.any(String),
      );
    });
    expect(term.write.mock.calls.map(([data]) => data).join('')).toBe(
      '\x1b[?2026hframe\x1b[2J\x1b[3Jdone\x1b[?2026l\x1b[2J',
    );
  });

  it('uses a float-scoped consumer and restores its lease immediately when reactivated', async () => {
    const { rerender } = renderMinimalShell('pane-float', false, undefined, 'float');
    await waitForConnected();
    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
        'pane-float',
        expect.stringMatching(/^renderer:float:/),
      );
    });

    const [, consumerId] = ptyMock.registerOutputConsumer.mock.calls[0];
    ptyMock.registerOutputConsumer.mockClear();
    ptyMock.attachSnapshot.mockClear();
    ptyMock.ack.mockClear();

    rerender(renderShellProps('pane-float', undefined, true, 'float'));

    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith('pane-float', consumerId);
    });
    expect(ptyMock.attachSnapshot).not.toHaveBeenCalled();
    expect(ptyMock.ack).not.toHaveBeenCalled();
  });

  it('does not keep renewing a renderer lease while the whole window is hidden', async () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const { unmount } = renderMinimalShell('pane-background');

    try {
      await waitForConnected();
      const heartbeatHandler = intervalSpy.mock.calls.find(
        ([, delay]) => delay === 5_000,
      )?.[0];
      const heartbeat =
        typeof heartbeatHandler === 'function' ? heartbeatHandler : undefined;
      expect(heartbeat).toBeDefined();
      ptyMock.registerOutputConsumer.mockClear();

      visibilityState = 'hidden';
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        heartbeat?.();
      });

      expect(ptyMock.registerOutputConsumer).not.toHaveBeenCalled();
    } finally {
      unmount();
      intervalSpy.mockRestore();
      visibilitySpy.mockRestore();
    }
  });

  it('restores the current terminal screen after the whole window was hidden past its lease', async () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    let now = 1_000;
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibilityState);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { unmount } = renderMinimalShell('pane-long-background');

    try {
      await waitForConnected();
      await waitFor(() =>
        expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-long-background'),
      );
      const term = xtermMock.instances[0];
      term.clear.mockClear();
      term.write.mockClear();
      term.resize.mockClear();
      ptyMock.attachSnapshot.mockClear();
      ptyMock.registerOutputConsumer.mockClear();
      ptyMock.ack.mockClear();

      visibilityState = 'hidden';
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      now += 30_000;
      ptyMock.attachSnapshot.mockResolvedValueOnce({
        ptyId: 'pane-long-background',
        data: 'current screen',
        history: 'recent history\n',
        seq: 19,
        rows: 32,
        cols: 104,
        cursorRow: 4,
        cursorCol: 7,
      });

      visibilityState = 'visible';
      act(() => document.dispatchEvent(new Event('visibilitychange')));

      await waitFor(() => {
        expect(ptyMock.attachSnapshot).toHaveBeenCalledWith('pane-long-background');
        expect(term.clear).toHaveBeenCalledTimes(1);
        expect(term.resize).toHaveBeenCalledWith(104, 32);
        expect(term.write).toHaveBeenCalledWith(
          'recent history\ncurrent screen',
          expect.any(Function),
        );
      });
      await waitFor(() => {
        expect(ptyMock.ack).toHaveBeenCalledWith(
          'pane-long-background',
          19,
          'renderer',
          expect.any(String),
        );
      });
    } finally {
      unmount();
      nowSpy.mockRestore();
      visibilitySpy.mockRestore();
    }
  });
});
