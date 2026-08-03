import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOverviewGrid } from '../workbench/ProjectOverviewGrid';
import { useWorkbenchStore } from '../../stores/workbenchStore';
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

  it('does not mark Workbench or All terminals active while Workspace is visible', () => {
    render(<ProjectSidebar primaryView="workspace" />);

    const primaryNavigation = screen.getByRole('group', {
      name: 'Primary navigation',
    });
    expect(within(primaryNavigation).getByText('Workbench').closest('button')).not.toHaveAttribute(
      'aria-current',
    );
    expect(
      within(primaryNavigation).getByText('All terminals').closest('button'),
    ).not.toHaveAttribute('aria-current');
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

  it('funnels project and worktree row navigation through the coordinator callbacks', () => {
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
    const onSelectProject = vi.fn();
    const onSelectWorktree = vi.fn();

    render(
      <ProjectSidebar
        onSelectProject={onSelectProject}
        onSelectWorktree={onSelectWorktree}
      />,
    );

    fireEvent.click(
      within(screen.getByTestId('sidebar-project-section')).getByText('ThreadTerm'),
    );
    expect(onSelectProject).toHaveBeenCalledWith('/repo/threadterm');
    expect(useTerminalStore.getState().selectedProjectPath).toBeNull();

    fireEvent.click(screen.getByTitle('sidebar.expand'));
    fireEvent.click(screen.getByTitle('feature/worktree-ui — /repo/threadterm-feature'));
    expect(onSelectWorktree).toHaveBeenCalledWith(
      '/repo/threadterm',
      '/repo/threadterm-feature',
      'feature/worktree-ui',
    );
    expect(useTerminalStore.getState().selectedWorktreePath).toBeNull();

    fireEvent.click(screen.getByText('All projects'));
    expect(onSelectProject).toHaveBeenLastCalledWith(null);
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

  it('keeps the sidebar and Workbench project overview in one shared order', () => {
    useTerminalStore.getState().createCard({
      projectName: 'Alpha',
      projectPath: '/repo/alpha',
      terminalType: 'shell',
    });
    useTerminalStore.getState().createCard({
      projectName: 'Beta',
      projectPath: '/repo/beta',
      terminalType: 'shell',
    });
    useWorkbenchStore.setState({
      projectOrder: ['/repo/alpha', '/repo/beta'],
    });
    const onSelectProject = vi.fn();

    render(
      <>
        <ProjectSidebar />
        <ProjectOverviewGrid
          projects={[
            {
              projectName: 'Alpha',
              projectPath: '/repo/alpha',
              followedCount: 0,
              runningCount: 1,
              attentionCount: 0,
              reviewCount: 0,
              failedCount: 0,
            },
            {
              projectName: 'Beta',
              projectPath: '/repo/beta',
              followedCount: 0,
              runningCount: 1,
              attentionCount: 0,
              reviewCount: 0,
              failedCount: 0,
            },
          ]}
          onSelectProject={onSelectProject}
        />
      </>,
    );

    const projectPaths = (testId: string) =>
      screen
        .getAllByTestId(testId)
        .map((row) => row.getAttribute('data-project-path'));

    expect(projectPaths('sidebar-project-section')).toEqual([
      '/repo/alpha',
      '/repo/beta',
    ]);
    expect(projectPaths('workbench-project-row')).toEqual([
      '/repo/alpha',
      '/repo/beta',
    ]);
    expect(screen.getAllByTestId('sidebar-project-drag-handle')).toHaveLength(2);
    expect(screen.getAllByTestId('workbench-project-drag-handle')).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId('sidebar-project-drag-handle')[0]);
    fireEvent.click(screen.getAllByTestId('workbench-project-drag-handle')[0]);
    expect(useTerminalStore.getState().selectedProjectPath).toBeNull();
    expect(onSelectProject).not.toHaveBeenCalled();

    act(() => {
      useWorkbenchStore
        .getState()
        .moveProject('/repo/beta', '/repo/alpha', [
          '/repo/alpha',
          '/repo/beta',
        ]);
    });

    expect(projectPaths('sidebar-project-section')).toEqual([
      '/repo/beta',
      '/repo/alpha',
    ]);
    expect(projectPaths('workbench-project-row')).toEqual([
      '/repo/beta',
      '/repo/alpha',
    ]);
  });

});
