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

    fireEvent.click(screen.getByText('改动'));
    fireEvent.click(await screen.findByText('App.tsx'));

    expect(await screen.findByDisplayValue('changed')).toBeInTheDocument();
    expect(bridgeMocks.gitTextDiff).toHaveBeenCalledWith('/tmp/repo', 'src/App.tsx');
    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
  });

  it('lets the session dock temporarily take priority over the workspace panel', async () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(id);

    render(<TerminalManager />);

    expect(await screen.findByText('README.md')).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTitle('显示最近会话'));

    const dock = screen.getByTestId('session-dock');
    expect(dock).toHaveAttribute('aria-hidden', 'false');
    expect(dock.closest('aside')).not.toBeNull();
    expect(screen.queryByText('README.md')).toBeNull();

    fireEvent.mouseLeave(dock);

    await waitFor(() => {
      expect(screen.queryByTestId('session-dock')).toBeNull();
    });
    expect(await screen.findByText('README.md')).toBeInTheDocument();
  });

  it('keeps workspace tabs isolated per focused session', async () => {
    bridgeMocks.invoke.mockImplementation((_command: string, args: { path: string }) => {
      const name = args.path === '/tmp/other' ? 'OTHER.md' : 'README.md';
      return Promise.resolve([
        {
          name,
          path: `${args.path}/${name}`,
          isDir: false,
          isHidden: false,
        },
      ]);
    });
    bridgeMocks.readFile.mockImplementation((_rootPath: string, path: string) =>
      Promise.resolve({
        path,
        contents: path.includes('OTHER.md') ? 'other file' : 'repo file',
        sizeBytes: 9,
        modifiedUnixMs: 10,
      }),
    );

    const store = useTerminalStore.getState();
    const repoId = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    const otherId = store.createCard({
      projectName: 'other',
      projectPath: '/tmp/other',
      terminalType: 'shell',
    });
    store.focusCard(repoId);
    useTerminalStore.setState({ recentlyViewedCardIds: [otherId, repoId] });

    render(<TerminalManager />);

    fireEvent.click(await screen.findByText('README.md'));
    expect(await screen.findByDisplayValue('repo file')).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTitle('显示最近会话'));
    fireEvent.keyDown(window, { key: '1' });

    expect(await screen.findByText('OTHER.md')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('repo file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'README.md' })).toBeNull();
    expect(screen.getAllByTestId('mock-shell').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('session-dock')).toBeNull();

    fireEvent.mouseEnter(screen.getByTitle('显示最近会话'));
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(await screen.findByRole('button', { name: '终端' })).toHaveClass('bg-primary/15');
    expect(
      document.querySelector('[data-terminal-context-menu="true"][title="/tmp/repo/README.md"]'),
    ).not.toBeNull();
  });

  it('supports workspace tab context close actions without closing the terminal tab', async () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(id);

    render(<TerminalManager />);

    fireEvent.click(await screen.findByText('README.md'));
    expect(await screen.findByDisplayValue('old')).toBeInTheDocument();

    fireEvent.click(screen.getByText('改动'));
    fireEvent.click(await screen.findByText('App.tsx'));
    expect(await screen.findByDisplayValue('changed')).toBeInTheDocument();

    const getWorkspaceTab = (title: string) => {
      const tab = document.querySelector<HTMLElement>(
        `[data-terminal-context-menu="true"][title="${title}"]`,
      );
      expect(tab).not.toBeNull();
      return tab!;
    };

    fireEvent.contextMenu(getWorkspaceTab('/tmp/repo/README.md'));
    expect(screen.getByTestId('workspace-tab-context-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭除当前' }));

    expect(await screen.findByDisplayValue('old')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();
    expect(
      document.querySelector('[data-terminal-context-menu="true"][title="src/App.tsx"]'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: '终端' })).toBeInTheDocument();

    fireEvent.contextMenu(getWorkspaceTab('/tmp/repo/README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭所有' }));

    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '终端' })).toBeNull();
  });
});
