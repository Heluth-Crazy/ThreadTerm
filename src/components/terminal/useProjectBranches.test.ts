import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchRow } from '../../lib/tauri-bridge';
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

  it('keeps the current branches visible while a refresh is loading', async () => {
    let resolveRefresh: (branches: BranchRow[]) => void = () => undefined;
    bridgeMock.overview
      .mockResolvedValueOnce([
        {
          branch: 'main',
          head: 'abc',
          isCurrent: true,
          worktreePath: '/repo/app',
          isMainWorktree: true,
          lastCommitUnix: 1,
        },
      ])
      .mockImplementationOnce(
        () =>
          new Promise<BranchRow[]>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    const { result } = renderHook(() => useProjectBranches('/repo/app'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let refreshPromise: Promise<void> | undefined;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.branches[0]?.branch).toBe('main');

    await act(async () => {
      resolveRefresh([]);
      await refreshPromise;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.branches).toEqual([]);
  });

  it('does not expose branches from the previous project while switching', async () => {
    let resolveSecondProject: (branches: BranchRow[]) => void = () => undefined;
    bridgeMock.overview
      .mockResolvedValueOnce([
        {
          branch: 'project-a',
          head: 'aaa',
          isCurrent: true,
          worktreePath: '/repo/a',
          isMainWorktree: true,
          lastCommitUnix: 1,
        },
      ])
      .mockImplementationOnce(
        () =>
          new Promise<BranchRow[]>((resolve) => {
            resolveSecondProject = resolve;
          }),
      );

    const { result, rerender } = renderHook(
      ({ projectPath }) => useProjectBranches(projectPath),
      { initialProps: { projectPath: '/repo/a' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.branches[0]?.branch).toBe('project-a');

    rerender({ projectPath: '/repo/b' });
    expect(result.current.loading).toBe(true);
    expect(result.current.branches).toEqual([]);

    await act(async () => {
      resolveSecondProject([
        {
          branch: 'project-b',
          head: 'bbb',
          isCurrent: true,
          worktreePath: '/repo/b',
          isMainWorktree: true,
          lastCommitUnix: 2,
        },
      ]);
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.branches[0]?.branch).toBe('project-b');
  });

  it('does not invoke the desktop bridge outside Tauri', async () => {
    bridgeMock.isTauriEnv.mockReturnValue(false);

    const { result } = renderHook(() => useProjectBranches('/repo/app'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.branches).toEqual([]);
    expect(bridgeMock.overview).not.toHaveBeenCalled();
  });
});
