import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectWorktreeCache, useProjectWorktrees } from './useProjectWorktrees';

const bridgeMock = vi.hoisted(() => ({
  isTauriEnv: vi.fn(() => true),
  list: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: bridgeMock.isTauriEnv,
  git: {
    worktrees: {
      list: bridgeMock.list,
    },
  },
}));

describe('useProjectWorktrees', () => {
  beforeEach(() => {
    clearProjectWorktreeCache();
    bridgeMock.isTauriEnv.mockReturnValue(true);
    bridgeMock.list.mockReset();
  });

  it('loads and caches worktrees by project path', async () => {
    bridgeMock.list.mockResolvedValueOnce([
      {
        path: '/repo/app',
        head: 'abc',
        branch: 'main',
        isMain: true,
        isDetached: false,
        isBare: false,
        isLocked: false,
      },
    ]);

    const first = renderHook(() => useProjectWorktrees('/repo/app'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.worktrees).toHaveLength(1);
    expect(bridgeMock.list).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useProjectWorktrees('/repo/app'));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.worktrees).toHaveLength(1);
    expect(bridgeMock.list).toHaveBeenCalledTimes(1);
  });

  it('refresh bypasses the cache', async () => {
    bridgeMock.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          path: '/repo/feature',
          head: 'def',
          branch: 'feature',
          isMain: false,
          isDetached: false,
          isBare: false,
          isLocked: false,
        },
      ]);

    const { result } = renderHook(() => useProjectWorktrees('/repo/app'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.worktrees).toHaveLength(1);
    expect(bridgeMock.list).toHaveBeenCalledTimes(2);
  });

  it('does not invoke the desktop bridge outside Tauri', async () => {
    bridgeMock.isTauriEnv.mockReturnValue(false);

    const { result } = renderHook(() => useProjectWorktrees('/repo/app'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.worktrees).toEqual([]);
    expect(bridgeMock.list).not.toHaveBeenCalled();
  });
});
