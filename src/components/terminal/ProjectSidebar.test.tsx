import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchRow, WorktreeInfo } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import { ProjectSidebar } from './ProjectSidebar';
import { parsePendingWorktreePath } from '../../lib/worktreePaths';

const branchHookMock = vi.hoisted(() => ({
  clearBranchCache: vi.fn(),
  refresh: vi.fn<() => Promise<void>>(),
  branches: [] as BranchRow[],
  branchesByPath: {} as Record<string, BranchRow[]>,
  loadingByPath: {} as Record<string, boolean>,
}));

const worktreeHookMock = vi.hoisted(() => ({
  clearWorktreeCache: vi.fn(),
}));

const gitBridgeMock = vi.hoisted(() => ({
  addWorktree: vi.fn<() => Promise<WorktreeInfo>>(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  git: {
    worktrees: {
      add: gitBridgeMock.addWorktree,
    },
  },
}));

vi.mock('../../lib/localDirectory', () => ({
  openLocalDirectory: vi.fn(),
}));

vi.mock('./useProjectBranches', () => ({
  clearProjectBranchCache: branchHookMock.clearBranchCache,
  useProjectBranches: (projectPath: string) => ({
    branches: branchHookMock.branchesByPath[projectPath] ?? branchHookMock.branches,
    loading: branchHookMock.loadingByPath[projectPath] ?? false,
    error: null,
    refresh: branchHookMock.refresh,
  }),
}));

vi.mock('./useProjectWorktrees', () => ({
  clearProjectWorktreeCache: worktreeHookMock.clearWorktreeCache,
}));

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    blocks: {},
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
    projectCardOrder: {},
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
  });
}

function baseBranch(overrides: Partial<BranchRow>): BranchRow {
  return {
    branch: 'main',
    head: '1111111111111111111111111111111111111111',
    isCurrent: false,
    worktreePath: null,
    isMainWorktree: false,
    lastCommitUnix: 1,
    upstream: null,
    ...overrides,
  };
}

describe('ProjectSidebar branch worktrees', () => {
  beforeEach(() => {
    resetStore();
    branchHookMock.clearBranchCache.mockReset();
    branchHookMock.refresh.mockReset();
    branchHookMock.refresh.mockResolvedValue(undefined);
    branchHookMock.branches = [];
    branchHookMock.branchesByPath = {};
    branchHookMock.loadingByPath = {};
    worktreeHookMock.clearWorktreeCache.mockReset();
    gitBridgeMock.addWorktree.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('aligns its header boundary with the app content top bar', () => {
    render(<ProjectSidebar />);

    const header = screen.getByText('sidebar.projects').parentElement;

    expect(header).toHaveClass('h-[53px]', 'shrink-0');
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
