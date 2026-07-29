import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  baseBranch,
  getBranchHookMock,
  getGitBridgeMock,
  getTerminalStore,
  getWorktreeHookMock,
  parsePendingWorktreePathForTest as parsePendingWorktreePath,
  TestProjectSidebar as ProjectSidebar,
} from './ProjectSidebar.testHarness';

const branchHookMock = getBranchHookMock();
const gitBridgeMock = getGitBridgeMock();
const useTerminalStore = getTerminalStore();
const worktreeHookMock = getWorktreeHookMock();

describe('ProjectSidebar worktree actions', () => {
  it('selects a pending branch worktree when a branch without worktree is clicked', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    branchHookMock.branches = [
      baseBranch({
        branch: 'feature/no-tree',
        head: '3333333333333333333333333333333333333333',
        lastCommitUnix: 2,
      }),
    ];

    render(<ProjectSidebar />);
    fireEvent.click(screen.getByTitle('sidebar.expand'));
    fireEvent.click(screen.getByText('feature/no-tree'));

    expect(gitBridgeMock.addWorktree).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().selectedProjectPath).toBe('/repo/threadterm');
    expect(useTerminalStore.getState().selectedWorktreeLabel).toBe('feature/no-tree');
    expect(parsePendingWorktreePath(useTerminalStore.getState().selectedWorktreePath)).toEqual({
      projectPath: '/repo/threadterm',
      branch: 'feature/no-tree',
    });
  });

  it('creates a worktree for a branch without one, then opens a terminal there from the row action', async () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    branchHookMock.branches = [
      baseBranch({
        branch: 'main',
        isCurrent: true,
        worktreePath: '/repo/threadterm',
        isMainWorktree: true,
      }),
      baseBranch({
        branch: 'feature/no-tree',
        head: '3333333333333333333333333333333333333333',
        lastCommitUnix: 2,
      }),
    ];
    gitBridgeMock.addWorktree.mockResolvedValueOnce({
      path: '/repo/threadterm-worktrees/feature-no-tree',
      head: '3333333333333333333333333333333333333333',
      branch: 'feature/no-tree',
      isMain: false,
      isDetached: false,
      isBare: false,
      isLocked: false,
    });

    render(<ProjectSidebar />);
    fireEvent.click(screen.getByTitle('sidebar.expand'));
    fireEvent.click(screen.getByLabelText('Create worktree and open terminal'));

    await waitFor(() => expect(gitBridgeMock.addWorktree).toHaveBeenCalledTimes(1));
    expect(gitBridgeMock.addWorktree).toHaveBeenCalledWith('/repo/threadterm', 'feature/no-tree');
    expect(branchHookMock.clearBranchCache).toHaveBeenCalledTimes(1);
    expect(worktreeHookMock.clearWorktreeCache).toHaveBeenCalledTimes(1);
    expect(branchHookMock.refresh).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(useTerminalStore.getState().cards).toHaveLength(2));
    expect(useTerminalStore.getState().cards[1]).toMatchObject({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      worktreePath: '/repo/threadterm-worktrees/feature-no-tree',
      branchLabel: 'feature/no-tree',
      terminalType: 'shell',
    });
    expect(useTerminalStore.getState().selectedWorktreePath).toBe(
      '/repo/threadterm-worktrees/feature-no-tree',
    );
  });
});
