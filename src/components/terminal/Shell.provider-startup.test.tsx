import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PtyCreateSessionV2Result } from '../../types/ptyStartup';
import { getPtyMock, renderProviderShell } from './Shell.testHarness';

const ptyMock = getPtyMock();

describe('Shell Provider startup ownership', () => {
  it('listens before v2 create, reconciles an early sent event, and never inputs the Provider command', async () => {
    ptyMock.onStartupState.mockImplementationOnce(async (callback: (snapshot: {
      ptyId: string; generation: string; revision: number; state: 'sent';
    }) => void) => {
      callback({ ptyId: 'provider-pane', generation: 'generation-1', revision: 1, state: 'sent' });
      return () => false;
    });

    renderProviderShell();

    await waitFor(() => expect(ptyMock.createSessionV2).toHaveBeenCalledTimes(1));
    expect(ptyMock.onStartupState.mock.invocationCallOrder[0])
      .toBeLessThan(ptyMock.createSessionV2.mock.invocationCallOrder[0]);
    expect(ptyMock.createSessionV2).toHaveBeenCalledWith(expect.objectContaining({
      id: 'provider-pane',
      startup: expect.objectContaining({ kind: 'provider', command: 'provider --start' }),
    }));
    expect(ptyMock.input).not.toHaveBeenCalledWith('provider-pane', 'provider --start\r');
  });

  it('disposes the startup observer and ignores a stale generation callback', async () => {
    const unlisten = vi.fn();
    ptyMock.onStartupState.mockImplementationOnce(async (callback) => {
      ptyMock.startupHandlers.add(callback);
      return () => {
        unlisten();
        return ptyMock.startupHandlers.delete(callback);
      };
    });
    const { unmount } = renderProviderShell('stale-provider-pane');

    await waitFor(() => expect(ptyMock.startupHandlers.size).toBe(1));
    const staleHandler = Array.from(ptyMock.startupHandlers)[0];
    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(ptyMock.startupHandlers.size).toBe(0);
    ptyMock.getStartupState.mockClear();
    act(() => {
      staleHandler?.({
        ptyId: 'stale-provider-pane', generation: 'generation-1', revision: 2, state: 'sent',
      });
    });
    expect(ptyMock.getStartupState).not.toHaveBeenCalled();
  });

  it('does not reconcile a v2 response that arrives after unmount', async () => {
    let resolveCreate: ((result: PtyCreateSessionV2Result) => void) | undefined;
    ptyMock.createSessionV2.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));

    const { unmount } = renderProviderShell('deferred-provider-pane');
    await waitFor(() => expect(ptyMock.createSessionV2).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      resolveCreate?.({
        ptyId: 'deferred-provider-pane',
        generation: 'generation-1',
        disposition: 'created',
        shellFamily: 'posix',
        descriptorDisposition: 'accepted',
        startup: {
          ptyId: 'deferred-provider-pane', generation: 'generation-1', revision: 0, state: 'waiting',
        },
      });
    });
    expect(ptyMock.registerOutputConsumer).not.toHaveBeenCalled();
  });
});
