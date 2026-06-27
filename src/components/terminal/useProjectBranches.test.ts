import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProjectBranchCache, useProjectBranches } from './useProjectBranches';

const bridgeMock = vi.hoisted(() => ({
  isTauriEnv: vi.fn(() => true),
  overview: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: bridgeMock.isTauriEnv,
  git: {
    branches: {
      overview: bridgeMock.overview,
    },
  },
}));

describe('useProjectBranches', () => {
  beforeEach(() => {
    clearProjectBranchCache();
    bridgeMock.isTauriEnv.mockReturnValue(true);
    bridgeMock.overview.mockReset();
  });

  it('loads and caches branches by project path', async () => {
    bridgeMock.overview.mockResolvedValueOnce([
      {
        branch: 'main',
        head: 'abc',
        isCurrent: true,
        worktreePath: '/repo/app',
        isMainWorktree: true,
        lastCommitUnix: 1,
        upstream: 'origin/main',
      },
    ]);

    const first = renderHook(() => useProjectBranches('/repo/app'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.branches).toHaveLength(1);
    expect(bridgeMock.overview).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useProjectBranches('/repo/app'));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.branches).toHaveLength(1);
    expect(bridgeMock.overview).toHaveBeenCalledTimes(1);
  });

  it('refresh bypasses the cache', async () => {
    bridgeMock.overview
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          branch: 'feature',
          head: 'def',
          isCurrent: false,
          worktreePath: null,
          isMainWorktree: false,
          lastCommitUnix: 2,
          upstream: null,
        },
      ]);

    const { result } = renderHook(() => useProjectBranches('/repo/app'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.branches).toHaveLength(1);
    expect(bridgeMock.overview).toHaveBeenCalledTimes(2);
  });

  it('does not invoke the desktop bridge outside Tauri', async () => {
    bridgeMock.isTauriEnv.mockReturnValue(false);

    const { result } = renderHook(() => useProjectBranches('/repo/app'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.branches).toEqual([]);
    expect(bridgeMock.overview).not.toHaveBeenCalled();
  });
});
