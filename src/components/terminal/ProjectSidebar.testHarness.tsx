import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { BranchRow, WorktreeInfo } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import { ProjectSidebar } from './ProjectSidebar';
import { parsePendingWorktreePath } from '../../lib/worktreePaths';

export function TestProjectSidebar(
  props: Parameters<typeof ProjectSidebar>[0],
) {
  return <ProjectSidebar {...props} />;
}

export function getTerminalStore() {
  return useTerminalStore;
}

export function parsePendingWorktreePathForTest(path: string | null) {
  return parsePendingWorktreePath(path);
}

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

export function getBranchHookMock() {
  return branchHookMock;
}

export function getWorktreeHookMock() {
  return worktreeHookMock;
}

export function getGitBridgeMock() {
  return gitBridgeMock;
}

export function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
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
  useWorkbenchStore.setState({ projectOrder: [] });
}

export function baseBranch(overrides: Partial<BranchRow>): BranchRow {
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
