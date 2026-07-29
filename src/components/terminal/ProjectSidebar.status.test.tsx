import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  baseBranch,
  getBranchHookMock,
  getTerminalStore,
  TestProjectSidebar as ProjectSidebar,
} from './ProjectSidebar.testHarness';

const branchHookMock = getBranchHookMock();
const useTerminalStore = getTerminalStore();

describe('ProjectSidebar attention counts and refresh state', () => {
  it('shows scoped attention counts on project and worktree rows', () => {
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
    ];

    render(
      <ProjectSidebar
        getProjectAttentionCount={(projectPath) =>
          projectPath === '/repo/threadterm' ? 2 : 0
        }
        getWorktreeAttentionCount={(projectPath, worktreePath) =>
          projectPath === '/repo/threadterm' &&
          worktreePath === '/repo/threadterm'
            ? 1
            : 0
        }
      />,
    );

    expect(screen.getByTestId('sidebar-project-attention-count')).toHaveTextContent('2');
    fireEvent.click(screen.getByTitle('sidebar.expand'));
    expect(screen.getByTestId('sidebar-worktree-attention-count')).toHaveTextContent('1');
  });

  it('moves branch refresh into the project row auxiliary actions', () => {
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
    ];

    render(<ProjectSidebar />);
    fireEvent.click(screen.getByTitle('sidebar.refreshWorktrees'));
    fireEvent.click(screen.getByTitle('sidebar.expand'));

    expect(branchHookMock.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('sidebar.branches')).toBeNull();
  });

  it('shows and clears the branch refresh spinner when loading changes', () => {
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
    ];

    const view = render(<ProjectSidebar />);
    const refreshButton = screen.getByTitle('sidebar.refreshWorktrees');
    expect(refreshButton.querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin');

    branchHookMock.loadingByPath['/repo/threadterm'] = true;
    view.rerender(<ProjectSidebar />);
    expect(refreshButton.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');

    branchHookMock.loadingByPath['/repo/threadterm'] = false;
    view.rerender(<ProjectSidebar />);
    expect(refreshButton.querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin');
  });

  it('keeps branch action icons visible without hover and marks the current branch inline', () => {
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

    render(<ProjectSidebar />);
    fireEvent.click(screen.getByTitle('sidebar.expand'));

    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByLabelText('sidebar.openWorktreeTerminal')).toHaveClass('opacity-60');
    expect(screen.getByLabelText('Create worktree and open terminal')).toHaveClass('opacity-60');
  });

});
