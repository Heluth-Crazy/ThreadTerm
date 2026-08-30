import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOverviewGrid } from '../workbench/ProjectOverviewGrid';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import type { WorkspaceTab } from '../../lib/workspace/types';
import {
  WorkspaceCatalogProvider,
  type WorkspaceCatalogController,
  type WorkspaceCatalogEntry,
} from '../workspace/useWorkspaceCatalog';
import { __resetWorkspaceSidebarDisclosureForTests } from '../workspace/useWorkspaceSidebarDisclosure';
import {
  baseBranch,
  getBranchHookMock,
  getTerminalStore,
  TestProjectSidebar as ProjectSidebar,
} from './ProjectSidebar.testHarness';

const branchHookMock = getBranchHookMock();
const useTerminalStore = getTerminalStore();

describe('ProjectSidebar navigation and branch rows', () => {
  it('moves a same-root main worktree catalog below its worktree row and activates the exact row', () => {
    __resetWorkspaceSidebarDisclosureForTests();
    const cardId = useTerminalStore.getState().createCard({
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
        branch: 'feature/catalog',
        worktreePath: '/repo/threadterm-feature',
      }),
      baseBranch({ branch: 'feature/pending', worktreePath: null }),
    ];
    const terminalTab: WorkspaceTab = {
      id: `terminal:${cardId}`,
      workspaceId: 'ws-project',
      kind: 'terminal',
      title: 'ThreadTerm',
      cardId,
      relativePath: null,
      sharedOrder: 1,
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const entryFor = (rootPath: string): WorkspaceCatalogEntry => ({
      requestedRoot: rootPath,
      rootKey: rootPath,
      workspaceId: rootPath === '/repo/threadterm' ? 'ws-project' : 'ws-feature',
      canonicalRoot: rootPath,
      tabs: rootPath === '/repo/threadterm' ? [terminalTab] : [],
      dirtyByTabId: {},
      conflictByTabId: {},
      activeTabId: rootPath === '/repo/threadterm' ? terminalTab.id : null,
      loading: false,
      error: null,
    });
    const controller: WorkspaceCatalogController = {
      mount: vi.fn(),
      unmount: vi.fn(),
      registerRoot: vi.fn(),
      unregisterRoot: vi.fn(),
      getEntry: entryFor,
      getEntries: () => [],
      getRegisteredRootKeys: () => [],
      getRevision: () => 0,
      subscribe: () => () => {},
      invalidateWorkspace: vi.fn(),
      retryRoot: vi.fn(),
      setSelectedOverlay: vi.fn(),
    };
    const onActivateWorkspaceTab = vi.fn();

    const view = render(
      <WorkspaceCatalogProvider controller={controller}>
        <ProjectSidebar onActivateWorkspaceTab={onActivateWorkspaceTab} />
      </WorkspaceCatalogProvider>,
    );

    fireEvent.click(screen.getByTitle('sidebar.expand'));
    expect(screen.queryByTestId('workspace-scope-catalog')).toBeNull();

    const worktreeToggles = screen.getAllByTestId('sidebar-worktree-disclosure-toggle');
    expect(worktreeToggles).toHaveLength(2);
    fireEvent.click(worktreeToggles[0]);
    expect(screen.getAllByTestId('sidebar-worktree-section')[0].firstElementChild)
      .toHaveClass('bg-muted/40');
    expect(screen.getAllByTestId('workspace-scope-catalog')).toHaveLength(1);
    fireEvent.click(screen.getByTestId(`workspace-catalog-row-${terminalTab.id}`));
    expect(onActivateWorkspaceTab).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-project',
        tabId: terminalTab.id,
        kind: 'terminal',
      }),
      {
        projectPath: '/repo/threadterm',
        worktreePath: '/repo/threadterm',
        worktreeLabel: 'main',
      },
    );

    fireEvent.click(worktreeToggles[1]);
    expect(screen.getAllByTestId('workspace-scope-catalog')).toHaveLength(2);
    expect(controller.registerRoot).toHaveBeenCalledWith('/repo/threadterm');
    expect(controller.registerRoot).toHaveBeenCalledWith('/repo/threadterm-feature');

    const mainWorktreeCatalog = screen.getAllByTestId('workspace-scope-catalog')[0];
    fireEvent.click(within(mainWorktreeCatalog).getByText('Files').closest('button')!);
    view.rerender(
      <WorkspaceCatalogProvider controller={controller}>
        <ProjectSidebar compact onActivateWorkspaceTab={onActivateWorkspaceTab} />
      </WorkspaceCatalogProvider>,
    );
    expect(screen.queryByTestId('workspace-scope-catalog')).toBeNull();
    view.rerender(
      <WorkspaceCatalogProvider controller={controller}>
        <ProjectSidebar isMobile onActivateWorkspaceTab={onActivateWorkspaceTab} />
      </WorkspaceCatalogProvider>,
    );
    expect(screen.queryByTestId('workspace-scope-catalog')).toBeNull();
    view.rerender(
      <WorkspaceCatalogProvider controller={controller}>
        <ProjectSidebar onActivateWorkspaceTab={onActivateWorkspaceTab} />
      </WorkspaceCatalogProvider>,
    );
    fireEvent.click(screen.getAllByTestId('sidebar-worktree-disclosure-toggle')[0]);
    const restoredFiles = within(screen.getByTestId('workspace-scope-catalog'))
      .getByText('Files')
      .closest('button');
    expect(restoredFiles).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the project catalog as the fallback and gives only materialized worktrees disclosures', () => {
    __resetWorkspaceSidebarDisclosureForTests();
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    branchHookMock.branches = [
      baseBranch({
        branch: 'feature/materialized',
        worktreePath: '/repo/threadterm-feature',
      }),
      baseBranch({ branch: 'feature/pending', worktreePath: null }),
    ];
    const controller: WorkspaceCatalogController = {
      mount: vi.fn(),
      unmount: vi.fn(),
      registerRoot: vi.fn(),
      unregisterRoot: vi.fn(),
      getEntry: (rootPath) => ({
        requestedRoot: rootPath,
        rootKey: rootPath,
        workspaceId: null,
        canonicalRoot: rootPath,
        tabs: [],
        dirtyByTabId: {},
        conflictByTabId: {},
        activeTabId: null,
        loading: false,
        error: null,
      }),
      getEntries: () => [],
      getRegisteredRootKeys: () => [],
      getRevision: () => 0,
      subscribe: () => () => {},
      invalidateWorkspace: vi.fn(),
      retryRoot: vi.fn(),
      setSelectedOverlay: vi.fn(),
    };

    render(
      <WorkspaceCatalogProvider controller={controller}>
        <ProjectSidebar onActivateWorkspaceTab={vi.fn()} />
      </WorkspaceCatalogProvider>,
    );

    fireEvent.click(screen.getByTitle('sidebar.expand'));
    expect(screen.getAllByTestId('workspace-scope-catalog')).toHaveLength(1);
    expect(screen.getByTestId('workspace-catalog-category-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-catalog-category-files')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-catalog-category-changes')).toBeInTheDocument();
    // The pending branch intentionally has no catalog disclosure.
    expect(screen.getAllByTestId('sidebar-worktree-disclosure-toggle')).toHaveLength(1);
  });

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

  it('uses sibling native controls and stable disclosure panels for project and worktree catalogs', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    branchHookMock.branches = [
      baseBranch({
        branch: 'feature/catalog',
        worktreePath: '/repo/threadterm-feature',
      }),
    ];

    render(<ProjectSidebar onActivateWorkspaceTab={vi.fn()} />);

    const projectSection = screen.getByTestId('sidebar-project-section');
    expect(projectSection.querySelector('button button')).toBeNull();

    const projectDisclosure = screen.getByTestId('sidebar-disclosure-toggle');
    const projectPanelId = projectDisclosure.getAttribute('aria-controls');
    expect(projectDisclosure).toHaveAttribute('aria-expanded', 'false');
    expect(projectPanelId).toBeTruthy();
    expect(document.getElementById(projectPanelId!)).toHaveAttribute('hidden');

    fireEvent.click(projectDisclosure);
    expect(projectDisclosure).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(projectPanelId!)).not.toHaveAttribute('hidden');

    const worktreeDisclosure = screen.getByTestId('sidebar-worktree-disclosure-toggle');
    const worktreePanelId = worktreeDisclosure.getAttribute('aria-controls');
    expect(worktreeDisclosure).toHaveAttribute('aria-expanded', 'false');
    expect(worktreePanelId).toBeTruthy();
    expect(document.getElementById(worktreePanelId!)).toHaveAttribute('hidden');

    fireEvent.click(worktreeDisclosure);
    expect(worktreeDisclosure).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(worktreePanelId!)).not.toHaveAttribute('hidden');
  });

  it('locks horizontal list scrolling only while a project drag is active', async () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });

    render(<ProjectSidebar />);
    const projectList = screen.getByText('Project filter').closest('nav');
    const dragHandle = screen.getByTestId('sidebar-project-drag-handle');
    expect(projectList).not.toBeNull();

    projectList!.scrollLeft = 12;
    fireEvent.keyDown(dragHandle, { code: 'Space', key: ' ' });
    projectList!.scrollLeft = 80;
    projectList!.scrollTop = 40;
    fireEvent.scroll(projectList!);
    expect(projectList!.scrollLeft).toBe(12);
    expect(projectList!.scrollTop).toBe(40);

    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
    await waitFor(() => expect(dragHandle).not.toHaveAttribute('aria-pressed', 'true'));
    projectList!.scrollLeft = 80;
    fireEvent.scroll(projectList!);
    expect(projectList!.scrollLeft).toBe(80);
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
    fireEvent.click(
      within(screen.getByTestId('workbench-pinned-empty')).getByRole('button'),
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
