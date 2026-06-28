import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalManager } from './TerminalManager';

const settingsWindowMocks = vi.hoisted(() => ({
  openSettingsWindow: vi.fn().mockResolvedValue(true),
}));

const bridgeMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  gitStatus: vi.fn(),
  gitTextDiff: vi.fn(),
  addWorktree: vi.fn(),
  listRecent: vi.fn(),
  syncCards: vi.fn(),
  onSpawnCard: vi.fn(),
  onActivateCard: vi.fn(),
  onRemoveCard: vi.fn(),
  onRenameCard: vi.fn(),
  resolveSpawn: vi.fn(),
  resolveActivate: vi.fn(),
  resolveClose: vi.fn(),
  resolveRenameCard: vi.fn(),
  invokeSupervisorEnable: vi.fn(),
  subscribeSupervisorAlert: vi.fn(),
  tokenStatsCompute: vi.fn(),
  tokenStatsCancel: vi.fn(),
  tokenStatsOnProgress: vi.fn(),
  tokenStatsOnDone: vi.fn(),
  tokenStatsOnError: vi.fn(),
}));

vi.mock('../../lib/settingsWindow', () => ({
  openSettingsWindow: settingsWindowMocks.openSettingsWindow,
}));

vi.mock('../../lib/tauri-bridge', () => ({
  invoke: (...args: unknown[]) => bridgeMocks.invoke(...args),
  isTauriEnv: () => false,
  providerSessions: {
    listRecent: (...args: unknown[]) => bridgeMocks.listRecent(...args),
  },
  mobileBridge: {
    status: () => Promise.resolve({ running: false }),
    syncCards: (...args: unknown[]) => bridgeMocks.syncCards(...args),
    onSpawnCard: (...args: unknown[]) => bridgeMocks.onSpawnCard(...args),
    onActivateCard: (...args: unknown[]) => bridgeMocks.onActivateCard(...args),
    onRemoveCard: (...args: unknown[]) => bridgeMocks.onRemoveCard(...args),
    onRenameCard: (...args: unknown[]) => bridgeMocks.onRenameCard(...args),
    resolveSpawn: (...args: unknown[]) => bridgeMocks.resolveSpawn(...args),
    resolveActivate: (...args: unknown[]) => bridgeMocks.resolveActivate(...args),
    resolveClose: (...args: unknown[]) => bridgeMocks.resolveClose(...args),
    resolveRenameCard: (...args: unknown[]) => bridgeMocks.resolveRenameCard(...args),
  },
  git: {
    worktrees: {
      add: (...args: unknown[]) => bridgeMocks.addWorktree(...args),
    },
    changes: {
      status: (...args: unknown[]) => bridgeMocks.gitStatus(...args),
      textDiff: (...args: unknown[]) => bridgeMocks.gitTextDiff(...args),
    },
  },
  workspaceFiles: {
    read: (...args: unknown[]) => bridgeMocks.readFile(...args),
    write: (...args: unknown[]) => bridgeMocks.writeFile(...args),
  },
  tokenStats: {
    compute: (...args: unknown[]) => bridgeMocks.tokenStatsCompute(...args),
    cancel: (...args: unknown[]) => bridgeMocks.tokenStatsCancel(...args),
    onProgress: (...args: unknown[]) => bridgeMocks.tokenStatsOnProgress(...args),
    onDone: (...args: unknown[]) => bridgeMocks.tokenStatsOnDone(...args),
    onError: (...args: unknown[]) => bridgeMocks.tokenStatsOnError(...args),
  },
  invokeSupervisorEnable: (...args: unknown[]) => bridgeMocks.invokeSupervisorEnable(...args),
  subscribeSupervisorAlert: (...args: unknown[]) => bridgeMocks.subscribeSupervisorAlert(...args),
}));

vi.mock('../Shell', () => ({
  default: () => <div data-testid="mock-shell" />,
}));

vi.mock('../files/WorkspaceCodeEditor', () => ({
  WorkspaceCodeEditor: ({ value }: { value: string }) => (
    <textarea aria-label="code editor" readOnly value={value} />
  ),
  WorkspaceMergeDiffEditor: ({
    baseValue,
    currentValue,
  }: {
    baseValue: string;
    currentValue: string;
  }) => (
    <div>
      <pre>{baseValue}</pre>
      <textarea aria-label="diff editor" readOnly value={currentValue} />
    </div>
  ),
}));

vi.mock('./CardGrid', () => ({
  CardGrid: () => <div data-testid="mock-card-grid" />,
}));

vi.mock('./CreateTerminalDialog', () => ({
  CreateTerminalDialog: () => null,
}));

vi.mock('./ProjectSidebar', () => ({
  ProjectSidebar: () => <aside data-testid="mock-project-sidebar" />,
}));

vi.mock('../Settings', () => ({
  default: () => null,
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

describe('TerminalManager shortcut hint layout', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    try {
      localStorage.removeItem('threadterm-shortcut-hint-dismissed');
    } catch {
      /* localStorage absent in some envs */
    }
    bridgeMocks.invoke.mockResolvedValue([
      { name: 'README.md', path: '/tmp/repo/README.md', isDir: false, isHidden: false },
    ]);
    bridgeMocks.readFile.mockResolvedValue({
      path: '/tmp/repo/README.md',
      contents: 'old',
      sizeBytes: 3,
      modifiedUnixMs: 10,
    });
    bridgeMocks.writeFile.mockResolvedValue({
      path: '/tmp/repo/README.md',
      contents: 'new',
      sizeBytes: 3,
      modifiedUnixMs: 20,
    });
    bridgeMocks.gitStatus.mockResolvedValue([
      {
        path: 'src/App.tsx',
        absolutePath: '/tmp/repo/src/App.tsx',
        repositoryRoot: '/tmp/repo',
        staged: null,
        unstaged: 'M',
        isUntracked: false,
      },
    ]);
    bridgeMocks.gitTextDiff.mockResolvedValue({
      path: 'src/App.tsx',
      repositoryRoot: '/tmp/repo',
      isBinary: false,
      sections: [
        {
          kind: 'unstaged',
          baseLabel: 'Index',
          currentLabel: 'Working tree',
          baseContents: 'old',
          currentContents: 'changed',
          editable: true,
          currentModifiedUnixMs: 10,
        },
      ],
    });
    bridgeMocks.invokeSupervisorEnable.mockResolvedValue(undefined);
    bridgeMocks.subscribeSupervisorAlert.mockResolvedValue(() => {});
    bridgeMocks.tokenStatsCompute.mockResolvedValue(undefined);
    bridgeMocks.tokenStatsCancel.mockResolvedValue(undefined);
    bridgeMocks.tokenStatsOnProgress.mockResolvedValue(() => {});
    bridgeMocks.tokenStatsOnDone.mockResolvedValue(() => {});
    bridgeMocks.tokenStatsOnError.mockResolvedValue(() => {});
  });

  it('opens the native settings window from the toolbar gear', () => {
    render(<TerminalManager />);

    fireEvent.click(screen.getByTitle('设置（⌘/Ctrl + ,）'));

    expect(settingsWindowMocks.openSettingsWindow).toHaveBeenCalledWith('shortcuts');
  });

  it('keeps the shortcut hint above the focused terminal footer', async () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    useTerminalStore.getState().focusCard(id);

    render(<TerminalManager />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    });

    const hint = screen.getByText(/Ctrl\+Tab/).closest('div');
    expect(hint).toHaveClass('bottom-10');
    expect(hint).not.toHaveClass('bottom-3');
    // Stage 5 fix — anchored left so the right-side BlockInspector /
    // Bookmarks panel can't visually overlap the hint.
    expect(hint).toHaveClass('left-3');
  });

  it('hides the shortcut hint after the dismiss button is clicked', async () => {
    useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });

    render(<TerminalManager />);

    await waitFor(() => screen.getByTestId('shortcut-hint-dismiss'));
    fireEvent.click(screen.getByTestId('shortcut-hint-dismiss'));
    expect(screen.queryByTestId('shortcut-hint-dismiss')).toBeNull();
    expect(screen.queryByText(/Ctrl\+Tab/)).toBeNull();
  });

  it('keeps the hint hidden after dismiss + remount (localStorage persisted)', async () => {
    useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });

    const { unmount } = render(<TerminalManager />);
    await waitFor(() => screen.getByTestId('shortcut-hint-dismiss'));
    fireEvent.click(screen.getByTestId('shortcut-hint-dismiss'));
    unmount();

    render(<TerminalManager />);
    expect(screen.queryByTestId('shortcut-hint-dismiss')).toBeNull();
  });

  it('restores archived cards from the selected project toolbar panel', async () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'codex',
    });
    store.selectProject('/tmp/repo');
    store.archiveCard(id);

    render(<TerminalManager />);

    fireEvent.click(screen.getByTitle('显示当前项目的归档卡片'));
    expect(screen.getByText('/tmp/repo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));

    await waitFor(() => {
      expect(useTerminalStore.getState().cards.map((card) => card.id)).toEqual([id]);
    });
    expect(useTerminalStore.getState().archivedCards).toHaveLength(0);
  });

  it('opens selected workspace files in a main-content tab while keeping the terminal mounted', async () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(id);

    render(<TerminalManager />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('文件 / 改动'));
    fireEvent.click(await screen.findByText('README.md'));

    expect(await screen.findByDisplayValue('old')).toBeInTheDocument();
    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '终端' })).toBeInTheDocument();
  });

  it('opens selected workspace changes as main-content diff tabs', async () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(id);

    render(<TerminalManager />);

    fireEvent.click(screen.getByTitle('文件 / 改动'));
    fireEvent.click(screen.getByText('改动'));
    fireEvent.click(await screen.findByText('App.tsx'));

    expect(await screen.findByDisplayValue('changed')).toBeInTheDocument();
    expect(bridgeMocks.gitTextDiff).toHaveBeenCalledWith('/tmp/repo', 'src/App.tsx');
    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
  });
});
