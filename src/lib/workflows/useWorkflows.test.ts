import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import type { DiscoveryResult } from './discoverWorkflows';

const loadAllWorkflowsMock = vi.fn<
  (focusedProjectCwd: string | null) => Promise<DiscoveryResult>
>();
const pushNotificationMock = vi.fn();

vi.mock('./tauriFs', () => ({
  loadAllWorkflows: (...args: unknown[]) =>
    loadAllWorkflowsMock(...(args as [string | null])),
}));

vi.mock('../../stores/terminalStore', () => ({
  useTerminalStore: (selector: (s: unknown) => unknown) =>
    selector({
      cards: [],
      focusedCardId: null,
      selectedProjectPath: null,
      pushNotification: pushNotificationMock,
    }),
}));

import { useWorkflows } from './useWorkflows';

beforeEach(() => {
  loadAllWorkflowsMock.mockReset();
  pushNotificationMock.mockReset();
});

describe('useWorkflows', () => {
  it('exposes discovered workflows after load resolves', async () => {
    loadAllWorkflowsMock.mockResolvedValueOnce({
      workflows: [
        {
          name: 'alpha',
          command: 'echo a',
          source: 'global',
          filePath: '/g/a.yaml',
        },
      ],
      errors: [],
    });

    const { result } = renderHook(() => useWorkflows());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflows[0].name).toBe('alpha');
    expect(result.current.errors).toEqual([]);
    expect(pushNotificationMock).not.toHaveBeenCalled();
  });

  it('pipes discovery errors into pushNotification once per (path, reason)', async () => {
    loadAllWorkflowsMock.mockResolvedValue({
      workflows: [],
      errors: [
        {
          source: 'global',
          filePath: '/g/bad.yaml',
          reason: 'parse-failed',
          message: 'invalid yaml',
        },
      ],
    });

    const { result, rerender } = renderHook(() => useWorkflows());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(pushNotificationMock).toHaveBeenCalledTimes(1);
    expect(pushNotificationMock.mock.calls[0][0].kind).toBe('failed');
    expect(pushNotificationMock.mock.calls[0][0].body).toContain('/g/bad.yaml');

    // Force a rerender; same error must not produce another notification.
    rerender();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(pushNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a catastrophic loadAllWorkflows rejection', async () => {
    loadAllWorkflowsMock.mockRejectedValueOnce(new Error('plugin not registered'));

    const { result } = renderHook(() => useWorkflows());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workflows).toEqual([]);
    expect(result.current.errors).toHaveLength(1);
    expect(result.current.errors[0].message).toBe('plugin not registered');
    expect(pushNotificationMock).toHaveBeenCalledTimes(1);
  });
});
