import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchRow, WorktreeInfo } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import { ProjectSidebar } from './ProjectSidebar';

const branchHookMock = vi.hoisted(() => ({
  clearBranchCache: vi.fn(),
  refresh: vi.fn<() => Promise<void>>(),
  branches: [] as BranchRow[],
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
  useProjectBranches: () => ({
    branches: branchHookMock.branches,
    loading: false,
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
    worktreeHookMock.clearWorktreeCache.mockReset();
    gitBridgeMock.addWorktree.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens a shell terminal with the selected existing branch worktree path', () => {
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
    fireEvent.click(screen.getByTitle('feature/worktree-ui — /repo/threadterm-feature'));

    const cards = useTerminalStore.getState().cards;
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      worktreePath: '/repo/threadterm-feature',
      terminalType: 'shell',
    });
    expect(useTerminalStore.getState().focusedCardId).toBe(cards[1].id);
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

  it('creates a worktree for a branch without one, then opens a terminal there', async () => {
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
    fireEvent.click(screen.getByText('feature/no-tree'));

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
      terminalType: 'shell',
    });
  });
});
