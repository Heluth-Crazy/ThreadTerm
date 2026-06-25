import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { ProjectSidebar } from './ProjectSidebar';

const worktreeHookMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  worktrees: [] as Array<{
    path: string;
    head: string;
    branch?: string | null;
    isMain: boolean;
    isDetached: boolean;
    isBare: boolean;
    isLocked: boolean;
  }>,
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
}));

vi.mock('../../lib/localDirectory', () => ({
  openLocalDirectory: vi.fn(),
}));

vi.mock('./useProjectWorktrees', () => ({
  useProjectWorktrees: () => ({
    worktrees: worktreeHookMock.worktrees,
    loading: false,
    error: null,
    refresh: worktreeHookMock.refresh,
  }),
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

describe('ProjectSidebar worktrees', () => {
  beforeEach(() => {
    resetStore();
    worktreeHookMock.refresh.mockReset();
    worktreeHookMock.worktrees = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('opens a shell terminal with the selected worktree path', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    worktreeHookMock.worktrees = [
      {
        path: '/repo/threadterm',
        head: '1111111',
        branch: 'main',
        isMain: true,
        isDetached: false,
        isBare: false,
        isLocked: false,
      },
      {
        path: '/repo/threadterm-feature',
        head: '2222222',
        branch: 'feature/worktree-ui',
        isMain: false,
        isDetached: false,
        isBare: false,
        isLocked: false,
      },
    ];

    render(<ProjectSidebar />);
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

  it('hides the project root worktree row', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    worktreeHookMock.worktrees = [
      {
        path: '/repo/threadterm',
        head: '1111111',
        branch: 'main',
        isMain: true,
        isDetached: false,
        isBare: false,
        isLocked: false,
      },
    ];

    render(<ProjectSidebar />);

    expect(screen.queryByText('sidebar.worktrees')).toBeNull();
  });
});
