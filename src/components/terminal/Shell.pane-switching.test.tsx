import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  getPtyMock,
  getXtermMock,
  renderMinimalShell,
  renderShellProps,
  waitForConnected,
} from './Shell.testHarness';

const ptyMock = getPtyMock();
const xtermMock = getXtermMock();

describe('Shell — pane switching', () => {
  it('detaches the old PTY and connects the new pane without killing the old session', async () => {
    const { rerender } = renderMinimalShell('pane-1', true, 'first');
    await waitForConnected();
    await waitFor(() => expect(ptyMock.input).toHaveBeenCalledWith('pane-1', 'first\r'));
    const oldOutputHandler = Array.from(ptyMock.outputHandlers)[0];
    const term = xtermMock.instances[0];
    term.write.mockClear();

    rerender(renderShellProps('pane-2', 'second'));

    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledWith('pane-2', '/tmp/proj', 24, 80));
    await waitFor(() => expect(ptyMock.input).toHaveBeenCalledWith('pane-2', 'second\r'));
    expect(ptyMock.kill).not.toHaveBeenCalled();

    act(() => {
      oldOutputHandler?.({ id: 'pane-1', data: 'old output', seq: 1 });
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-2', data: 'new output', seq: 1 });
      }
    });

    expect(term.write).not.toHaveBeenCalledWith('old output', expect.any(Function));
    expect(term.write).toHaveBeenCalledWith('new output', expect.any(Function));
    await waitFor(() =>
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-2',
        1,
        'renderer',
        expect.any(String),
      ),
    );
  });

  it('ignores a stale connect that resolves after the pane changed', async () => {
    let resolveFirstCreate: ((id: string) => void) | null = null;
    ptyMock.create
      .mockImplementationOnce(
        (id: string) =>
          new Promise<string>((resolve) => {
            resolveFirstCreate = () => resolve(id);
          }),
      )
      .mockImplementationOnce(async (id: string) => id);

    const { rerender } = renderMinimalShell('pane-1', true, 'first');
    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledWith('pane-1', '/tmp/proj', 24, 80));

    rerender(renderShellProps('pane-2', 'second'));
    act(() => {
      resolveFirstCreate?.('pane-1');
    });

    await waitFor(() => expect(ptyMock.create).toHaveBeenCalledWith('pane-2', '/tmp/proj', 24, 80));
    await waitFor(() => expect(ptyMock.input).toHaveBeenCalledWith('pane-2', 'second\r'));
    expect(ptyMock.input).not.toHaveBeenCalledWith('pane-1', 'first\r');
  });

  it('does not let a stale listener setup dispose the new pane consumer', async () => {
    let resolveFirstOutputListener: (() => void) | undefined;
    ptyMock.onOutput.mockImplementationOnce(
      (callback: (payload: { id: string; data: string; seq: number }) => void) => {
        ptyMock.outputHandlers.add(callback);
        return new Promise<() => boolean>((resolve) => {
          resolveFirstOutputListener = () =>
            resolve(() => ptyMock.outputHandlers.delete(callback));
        });
      },
    );

    const { rerender } = renderMinimalShell('pane-1');
    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
        'pane-1',
        expect.any(String),
      );
      expect(ptyMock.onOutput).toHaveBeenCalledTimes(1);
    });

    rerender(renderShellProps('pane-2'));
    await waitFor(() => {
      expect(ptyMock.registerOutputConsumer).toHaveBeenCalledWith(
        'pane-2',
        expect.any(String),
      );
      expect(ptyMock.exitHandlers.size).toBeGreaterThan(0);
    });
    const pane2ConsumerId = ptyMock.registerOutputConsumer.mock.calls.find(
      ([id]) => id === 'pane-2',
    )?.[1];

    act(() => resolveFirstOutputListener?.());
    await waitFor(() => {
      expect(ptyMock.unregisterOutputConsumer).not.toHaveBeenCalledWith(
        'pane-2',
        pane2ConsumerId,
      );
    });

    ptyMock.ack.mockClear();
    act(() => {
      for (const handler of ptyMock.outputHandlers) {
        handler({ id: 'pane-2', data: 'still-live', seq: 9 });
      }
    });
    await waitFor(() => {
      expect(ptyMock.ack).toHaveBeenCalledWith(
        'pane-2',
        9,
        'renderer',
        pane2ConsumerId,
      );
    });
  });
});
