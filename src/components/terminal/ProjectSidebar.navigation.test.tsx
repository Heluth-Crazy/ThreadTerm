import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  baseBranch,
  getBranchHookMock,
  getTerminalStore,
  TestProjectSidebar as ProjectSidebar,
} from './ProjectSidebar.testHarness';

const branchHookMock = getBranchHookMock();
const useTerminalStore = getTerminalStore();

describe('ProjectSidebar navigation and branch rows', () => {
  it('keeps primary navigation limited to Workbench, All terminals, and New terminal', () => {
    const onSelectPrimaryView = vi.fn();
    const onCreateTerminal = vi.fn();

    render(
      <ProjectSidebar
        primaryView="workbench"
        onSelectPrimaryView={onSelectPrimaryView}
        onCreateTerminal={onCreateTerminal}
      />,
    );

    const primaryNavigation = screen.getByRole('group', {
      name: 'Primary navigation',
    });
    expect(within(primaryNavigation).getAllByRole('button')).toHaveLength(3);

    fireEvent.click(within(primaryNavigation).getByText('Workbench'));
    fireEvent.click(within(primaryNavigation).getByText('All terminals'));
    fireEvent.click(within(primaryNavigation).getByText('New terminal'));

    expect(onSelectPrimaryView).toHaveBeenNthCalledWith(1, 'workbench');
    expect(onSelectPrimaryView).toHaveBeenNthCalledWith(2, 'terminals');
    expect(onCreateTerminal).toHaveBeenCalledTimes(1);
  });

  it('opens a shell terminal with the selected existing branch worktree path from the row action', () => {
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
        upstream: 'origin/main',
      }),
      baseBranch({
        branch: 'feature/worktree-ui',
        head: '2222222222222222222222222222222222222222',
        worktreePath: '/repo/threadterm-feature',
        lastCommitUnix: 2,
      }),
    ];

    render(<ProjectSidebar />);
    fireEvent.click(screen.getByTitle('sidebar.expand'));
    const terminalActions = screen.getAllByLabelText('sidebar.openWorktreeTerminal');
    fireEvent.click(terminalActions[1]);

    const cards = useTerminalStore.getState().cards;
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      worktreePath: '/repo/threadterm-feature',
      branchLabel: 'feature/worktree-ui',
      terminalType: 'shell',
    });
    expect(useTerminalStore.getState().focusedCardId).toBe(cards[1].id);
    expect(useTerminalStore.getState().selectedWorktreePath).toBe('/repo/threadterm-feature');
    expect(useTerminalStore.getState().selectedWorktreeLabel).toBe('feature/worktree-ui');
  });

  it('selects an existing branch worktree when the branch row body is clicked', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    branchHookMock.branches = [
      baseBranch({
        branch: 'feature/worktree-ui',
        head: '2222222222222222222222222222222222222222',
        worktreePath: '/repo/threadterm-feature',
        lastCommitUnix: 2,
      }),
    ];

    render(<ProjectSidebar />);
    fireEvent.click(screen.getByTitle('sidebar.expand'));
    fireEvent.click(screen.getByTitle('feature/worktree-ui — /repo/threadterm-feature'));

    expect(useTerminalStore.getState().cards).toHaveLength(1);
    expect(useTerminalStore.getState().selectedProjectPath).toBe('/repo/threadterm');
    expect(useTerminalStore.getState().selectedWorktreePath).toBe('/repo/threadterm-feature');
    expect(useTerminalStore.getState().selectedWorktreeLabel).toBe('feature/worktree-ui');
  });

  it('does not render a branch tree toggle for non-git projects', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });

    render(<ProjectSidebar />);

    expect(screen.queryByTitle('sidebar.expand')).toBeNull();
    expect(screen.queryByText('sidebar.branches')).toBeNull();
  });

  it('keeps a fixed disclosure column for expandable and leaf rows', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    useTerminalStore.getState().createCard({
      projectName: 'Plain',
      projectPath: '/repo/plain',
      terminalType: 'shell',
    });
    branchHookMock.branchesByPath = {
      '/repo/threadterm': [
        baseBranch({
          branch: 'main',
          isCurrent: true,
          worktreePath: '/repo/threadterm',
          isMainWorktree: true,
        }),
      ],
      '/repo/plain': [],
    };

    render(<ProjectSidebar />);

    const disclosureColumns = screen.getAllByTestId('sidebar-disclosure-column');
    expect(disclosureColumns).toHaveLength(3);
    expect(disclosureColumns.every((column) => column.className.includes('w-4'))).toBe(true);
    expect(screen.getAllByTestId('sidebar-disclosure-placeholder')).toHaveLength(2);
    expect(screen.getAllByTestId('sidebar-disclosure-toggle')).toHaveLength(1);
  });

});
