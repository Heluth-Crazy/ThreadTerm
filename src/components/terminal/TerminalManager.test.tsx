import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { __resetMetadataCacheForTests } from '../../stores/agentSessionMetadataCache';
import { clearWorkspaceLoadCaches } from '../files/workspaceLoadCache';
import { localWorkspaceAuthority } from '../../lib/workspace/localAuthority';
import { TerminalManager } from './TerminalManager';

const settingsWindowMocks = vi.hoisted(() => ({
  openSettingsWindow: vi.fn().mockResolvedValue(true),
}));

const nativeDialogMocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  isTauriEnv: vi.fn(),
  invoke: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  gitStatus: vi.fn(),
  gitTextDiff: vi.fn(),
  addWorktree: vi.fn(),
  listRecent: vi.fn(),
  resolveMetadata: vi.fn(),
  bridgeStatus: vi.fn(),
  bridgeHasSubscribers: vi.fn(),
  syncCards: vi.fn(),
  syncState: vi.fn(),
  onSpawnCard: vi.fn(),
  onActivateCard: vi.fn(),
  onRemoveCard: vi.fn(),
  onRenameCard: vi.fn(),
  resolveSpawn: vi.fn(),
  resolveActivate: vi.fn(),
  resolveClose: vi.fn(),
  resolveRenameCard: vi.fn(),
  ptyGracefulShutdown: vi.fn(),
  ptyCancelGracefulShutdown: vi.fn(),
  ptyKill: vi.fn(),
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

vi.mock('../../lib/nativeDialog', () => ({
  confirmDialog: (...args: unknown[]) => nativeDialogMocks.confirmDialog(...args),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main' }),
}));

vi.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    activeThemeTokens: {
      app: {
        background: '#10151d',
        card: '#151b24',
        primary: '#4f8bd6',
        foreground: '#e8edf5',
      },
    },
  }),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  invoke: (...args: unknown[]) => bridgeMocks.invoke(...args),
  isTauriEnv: () => bridgeMocks.isTauriEnv(),
  pty: {
    kill: (...args: unknown[]) => bridgeMocks.ptyKill(...args),
    gracefulShutdown: (...args: unknown[]) => bridgeMocks.ptyGracefulShutdown(...args),
    cancelGracefulShutdown: (...args: unknown[]) =>
      bridgeMocks.ptyCancelGracefulShutdown(...args),
    create: vi.fn().mockResolvedValue(undefined),
    input: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
  },
  providerSessions: {
    listRecent: (...args: unknown[]) => bridgeMocks.listRecent(...args),
    resolveMetadata: (...args: unknown[]) => bridgeMocks.resolveMetadata(...args),
  },
  mobileBridge: {
    status: (...args: unknown[]) => bridgeMocks.bridgeStatus(...args),
    syncCards: (...args: unknown[]) => bridgeMocks.syncCards(...args),
    syncState: (...args: unknown[]) => bridgeMocks.syncState(...args),
    onSpawnCard: (...args: unknown[]) => bridgeMocks.onSpawnCard(...args),
    onActivateCard: (...args: unknown[]) => bridgeMocks.onActivateCard(...args),
    onRemoveCard: (...args: unknown[]) => bridgeMocks.onRemoveCard(...args),
    onRenameCard: (...args: unknown[]) => bridgeMocks.onRenameCard(...args),
    resolveSpawn: (...args: unknown[]) => bridgeMocks.resolveSpawn(...args),
    resolveActivate: (...args: unknown[]) => bridgeMocks.resolveActivate(...args),
    resolveClose: (...args: unknown[]) => bridgeMocks.resolveClose(...args),
    resolveRenameCard: (...args: unknown[]) => bridgeMocks.resolveRenameCard(...args),
  },
  mobileBridgeHasSubscribers: (...args: unknown[]) =>
    bridgeMocks.bridgeHasSubscribers(...args),
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

vi.mock('./Shell', () => ({
  default: () => <div data-testid="mock-shell" />,
}));

vi.mock('../files/WorkspaceCodeEditor', () => ({
  WorkspaceCodeEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string) => void;
  }) => (
    <div>
      <textarea
        aria-label="code editor"
        value={value}
        onChange={(event) => onChange?.(event.currentTarget.value)}
      />
      <input aria-label="editor local state" defaultValue="editor-local-initial" />
    </div>
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
  ProjectSidebar: ({
    primaryView,
    onSelectPrimaryView,
    onSelectProject,
    onSelectWorktree,
  }: {
    primaryView?: 'workbench' | 'terminals' | 'workspace';
    onSelectPrimaryView?: (view: 'workbench' | 'terminals' | 'workspace') => void;
    onSelectProject?: (projectPath: string | null) => void;
    onSelectWorktree?: (
      projectPath: string,
      worktreePath: string,
      label?: string | null,
    ) => void;
  }) => (
    <aside data-testid="mock-project-sidebar">
      <span data-testid="mock-primary-view">{primaryView}</span>
      <button type="button" onClick={() => onSelectPrimaryView?.('workbench')}>
        open workbench
      </button>
      <button type="button" onClick={() => onSelectPrimaryView?.('terminals')}>
        open all terminals
      </button>
      <button type="button" onClick={() => onSelectProject?.('/tmp/repo')}>
        select repo project
      </button>
      <button type="button" onClick={() => onSelectProject?.(null)}>
        select all projects
      </button>
      <button
        type="button"
        onClick={() => onSelectWorktree?.('/tmp/repo', '/tmp/repo-feature', 'feature')}
      >
        select repo worktree
      </button>
    </aside>
  ),
}));

vi.mock('../Settings', () => ({
  default: () => null,
}));

function resetStore() {
  __resetMetadataCacheForTests();
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    projectCardOrder: {},
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
    pendingLocateCardId: null,
    recentlyViewedCardIds: [],
    dockPinned: false,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
  });
}

describe('TerminalManager shortcut hint layout', () => {
  beforeEach(() => {
    resetStore();
    clearWorkspaceLoadCaches();
    localWorkspaceAuthority.reset();
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
    bridgeMocks.isTauriEnv.mockReturnValue(false);
    bridgeMocks.onSpawnCard.mockResolvedValue(() => {});
    bridgeMocks.onActivateCard.mockResolvedValue(() => {});
    bridgeMocks.onRemoveCard.mockResolvedValue(() => {});
    bridgeMocks.onRenameCard.mockResolvedValue(() => {});
    bridgeMocks.bridgeStatus.mockResolvedValue({ running: false });
    bridgeMocks.bridgeHasSubscribers.mockResolvedValue(false);
    bridgeMocks.syncCards.mockResolvedValue(undefined);
    bridgeMocks.syncState.mockResolvedValue(undefined);
    bridgeMocks.resolveSpawn.mockResolvedValue(undefined);
    bridgeMocks.resolveActivate.mockResolvedValue(undefined);
    bridgeMocks.resolveClose.mockResolvedValue(undefined);
    bridgeMocks.resolveRenameCard.mockResolvedValue(undefined);
    bridgeMocks.ptyGracefulShutdown.mockImplementation(
      (_id: string, attemptId: string) =>
        Promise.resolve({
          attemptId,
          outcome: 'graceful',
          stage: 'shellExit',
        }),
    );
    bridgeMocks.ptyCancelGracefulShutdown.mockResolvedValue(true);
    bridgeMocks.ptyKill.mockResolvedValue(undefined);
    bridgeMocks.resolveMetadata.mockResolvedValue([]);
    nativeDialogMocks.confirmDialog.mockResolvedValue(false);
  });

  it('opens the native settings window from the toolbar gear', () => {
    render(<TerminalManager />);

    fireEvent.click(screen.getByTitle('设置（⌘/Ctrl + ,）'));

    expect(settingsWindowMocks.openSettingsWindow).toHaveBeenCalledWith('shortcuts');
  });

  it('opens mobile access as a full-width main content view from the toolbar', async () => {
    render(<TerminalManager />);

    fireEvent.click(screen.getByTitle('移动端'));

    const view = await screen.findByTestId('mobile-access-view');
    const content = view.firstElementChild;

    expect(content).toHaveClass('w-full');
    expect(content).not.toHaveClass('max-w-3xl');
  });

  it('syncs cards, notifications, and the global Workbench projection atomically', async () => {
    bridgeMocks.isTauriEnv.mockReturnValue(true);
    bridgeMocks.bridgeStatus.mockResolvedValue({ running: true });
    bridgeMocks.bridgeHasSubscribers.mockResolvedValue(true);
    const store = useTerminalStore.getState();
    const cardId = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      worktreePath: '/tmp/repo/.worktrees/mobile',
      branchLabel: 'mobile',
      terminalType: 'codex',
    });
    store.updateCardStatus(cardId, 'waiting');
    store.pushNotification({
      cardId,
      kind: 'waiting',
      title: 'Waiting for input',
      body: 'Choose an option',
    });

    render(<TerminalManager />);

    await waitFor(() => {
      expect(bridgeMocks.syncState).toHaveBeenCalled();
    });
    const [cards, notifications, workbench] = bridgeMocks.syncState.mock.calls.at(-1) ?? [];

    expect(cards).toEqual([
      expect.objectContaining({
        id: cardId,
        branchLabel: 'mobile',
        worktreePath: '/tmp/repo/.worktrees/mobile',
      }),
    ]);
    expect(notifications).toEqual([
      expect.objectContaining({
        cardId,
        title: 'Waiting for input',
        body: 'Choose an option',
        read: false,
      }),
    ]);
    expect(workbench).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({ attention: 1 }),
        executionGroups: [
          expect.objectContaining({
            worktreePath: '/tmp/repo/.worktrees/mobile',
            cardIds: [cardId],
          }),
        ],
      }),
    );
    expect(bridgeMocks.syncCards).not.toHaveBeenCalled();
  });

  it('publishes the latest mobile state within one second during continuous terminal activity', async () => {
    vi.useFakeTimers();
    bridgeMocks.isTauriEnv.mockReturnValue(true);
    bridgeMocks.bridgeStatus.mockResolvedValue({ running: true });
    bridgeMocks.bridgeHasSubscribers.mockResolvedValue(true);
    const store = useTerminalStore.getState();
    const cardId = store.createCard({
      projectName: 'streaming-repo',
      projectPath: '/tmp/streaming-repo',
      terminalType: 'codex',
    });
    const view = render(<TerminalManager />);

    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(bridgeMocks.bridgeHasSubscribers).toHaveBeenCalled();
      bridgeMocks.syncState.mockClear();

      for (let index = 0; index < 12; index += 1) {
        act(() => {
          useTerminalStore.getState().updateCardOutput(cardId, `chunk-${index}`);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(90);
        });
      }

      expect(bridgeMocks.syncState).toHaveBeenCalled();
      expect(bridgeMocks.syncState.mock.calls.at(-1)?.[0]).toEqual([
        expect.objectContaining({
          id: cardId,
          lastReplyPreview: expect.stringContaining('chunk-11'),
        }),
      ]);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('uses Workbench as the default page and navigates to All terminals without remounting it', async () => {
    render(<TerminalManager />);

    expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
    expect(screen.getByTestId('workbench-view').closest('[aria-hidden]')).toHaveAttribute(
      'aria-hidden',
      'false',
    );
    expect(screen.getByTestId('mock-card-grid').closest('[aria-hidden]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'open all terminals' }));

    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('terminals');
      expect(screen.getByTestId('mock-card-grid').closest('[aria-hidden]')).toHaveAttribute(
        'aria-hidden',
        'false',
      );
    });
    expect(screen.getByTestId('workbench-view')).toBeInTheDocument();
  });

  it('returns a focused terminal to the Workbench when it was opened there', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });

    render(<TerminalManager />);

    act(() => {
      useTerminalStore.getState().focusCard(id);
    });
    expect(await screen.findByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workspace');

    fireEvent.click(screen.getByTitle('返回网格（⌘/Ctrl+Shift+M）'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
      expect(screen.getByTestId('workbench-view').closest('[aria-hidden]')).toHaveAttribute(
        'aria-hidden',
        'false',
      );
    });
    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
  });

  it('returns a focused terminal to All terminals when it was opened there', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });

    render(<TerminalManager />);
    fireEvent.click(screen.getByRole('button', { name: 'open all terminals' }));

    act(() => {
      useTerminalStore.getState().focusCard(id);
    });
    expect(await screen.findByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workspace');

    fireEvent.click(screen.getByTitle('返回网格（⌘/Ctrl+Shift+M）'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('terminals');
      expect(screen.getByTestId('mock-card-grid').closest('[aria-hidden]')).toHaveAttribute(
        'aria-hidden',
        'false',
      );
    });
    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
  });

  it('switches a project between Workbench and Workspace in one click and keeps its tabs', async () => {
    useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    render(<TerminalManager />);

    fireEvent.click(screen.getByRole('button', { name: 'select repo project' }));
    expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
    expect(screen.getByTestId('desktop-context-view-switch')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-context-view-workbench')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByTestId('desktop-context-view-workspace'));
    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workspace');
      expect(screen.getByTestId('workspace-home')).toBeInTheDocument();
    });
    expect(screen.getByTestId('desktop-context-view-workspace')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(await screen.findByText('README.md'));
    expect(await screen.findByDisplayValue('old')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('desktop-context-view-workbench'));
    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
      expect(screen.getByTestId('workbench-view').closest('[aria-hidden]')).toHaveAttribute(
        'aria-hidden',
        'false',
      );
    });
    expect(useTerminalStore.getState().selectedProjectPath).toBe('/tmp/repo');

    fireEvent.click(screen.getByTestId('desktop-context-view-workspace'));
    expect(await screen.findByDisplayValue('old')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'select repo project' }));
    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
    });
  });

  it('opens a selected worktree Workspace and keeps that scope when returning to Workbench', async () => {
    useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      worktreePath: '/tmp/repo-feature',
      branchLabel: 'feature',
      terminalType: 'shell',
    });
    render(<TerminalManager />);

    fireEvent.click(screen.getByRole('button', { name: 'select repo worktree' }));
    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workspace');
      expect(screen.getByTestId('workspace-home')).toBeInTheDocument();
    });
    expect(useTerminalStore.getState().selectedWorktreePath).toBe('/tmp/repo-feature');

    fireEvent.click(screen.getByTestId('desktop-context-view-workbench'));
    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
    });
    expect(useTerminalStore.getState().selectedProjectPath).toBe('/tmp/repo');
    expect(useTerminalStore.getState().selectedWorktreePath).toBe('/tmp/repo-feature');

    fireEvent.click(screen.getByRole('button', { name: 'select all projects' }));
    expect(screen.queryByTestId('desktop-context-view-switch')).toBeNull();
    expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
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
    // Anchored left so the right-side panel can't visually overlap the hint.
    expect(hint).toHaveClass('left-3');
  });

  it('hides the shortcut hint after the dismiss button is clicked', async () => {
    useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });

    render(<TerminalManager />);
    fireEvent.click(screen.getByRole('button', { name: 'open all terminals' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'open all terminals' }));
    await waitFor(() => screen.getByTestId('shortcut-hint-dismiss'));
    fireEvent.click(screen.getByTestId('shortcut-hint-dismiss'));
    unmount();

    render(<TerminalManager />);
    fireEvent.click(screen.getByRole('button', { name: 'open all terminals' }));
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
    // Terminal view stays mounted (hidden) while a file tab is active.
    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-home')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-terminal')).toBeInTheDocument();
  });

  it('uses all six bound native identities in both production workspace home and top tabs', async () => {
    bridgeMocks.isTauriEnv.mockReturnValue(true);
    const store = useTerminalStore.getState();
    const providers = [
      { id: 'claude', icon: '[data-agent-icon="claude"]' },
      { id: 'codex', icon: '[data-agent-icon="codex"]' },
      { id: 'opencode', icon: '[data-agent-icon="opencode"]' },
      { id: 'gemini', icon: '[data-agent-icon="gemini"]' },
      { id: 'kimi', icon: '[data-agent-icon="kimi"]' },
      { id: 'grok', icon: '[data-agent-icon="grok"]' },
    ] as const;
    const cardIds = providers.map(({ id }) => {
      const cardId = store.createCard({
        projectName: `ThreadTerm ${id}`,
        projectPath: '/tmp/repo',
        terminalType: id,
        command: `${id} --secret-command`,
      });
      store.markProviderSessionBound(cardId, `${id}-session-1234567890`);
      return cardId;
    });
    store.focusCard(cardIds[0]);
    bridgeMocks.resolveMetadata.mockImplementation(async ({ keys }) =>
      keys.map((key: { provider: string; sessionId: string; projectPath: string }) => ({
        key,
        state: 'found',
        summary: {
          provider: key.provider,
          id: key.sessionId,
          projectPath: key.projectPath,
          nativeTitle: `Native ${key.provider} title`,
          titleKind: 'explicit',
          resumable: true,
        },
        warning: null,
      })),
    );

    render(<TerminalManager />);

    await waitFor(() => {
      expect(screen.getByTestId('workspace-tab-terminal')).toHaveTextContent(
        'Native claude title',
      );
    });
    fireEvent.click(screen.getByTestId('workspace-tab-home'));
    for (const [{ id, icon }, cardId] of providers.map((provider, index) => [
      provider,
      cardIds[index],
    ] as const)) {
      const homeRow = await screen.findByTestId(`workspace-home-terminal-${cardId}`);
      expect(homeRow).toHaveTextContent(`Native ${id} title`);
      expect(homeRow).toHaveTextContent(`ThreadTerm ${id}`);
      expect(homeRow.querySelector(icon)).not.toBeNull();

      fireEvent.click(homeRow);
      let terminalTab: HTMLElement | undefined;
      await waitFor(() => {
        terminalTab = screen
          .getAllByTestId('workspace-tab-terminal')
          .find((tab) => tab.textContent?.includes(`Native ${id} title`));
        expect(terminalTab).toBeDefined();
      });
      expect(terminalTab?.querySelector(icon)).not.toBeNull();
      expect(terminalTab?.title).toContain(`Native ${id} title`);
      expect(terminalTab?.title).toContain(`ThreadTerm ${id}`);
      expect(terminalTab?.title).toContain('…67890');
      expect(terminalTab?.title).not.toContain(`${id}-session-1234567890`);
      expect(terminalTab?.title).not.toContain('secret-command');
      expect(homeRow.title).toBe(terminalTab?.title);
      fireEvent.click(screen.getByTestId('workspace-tab-home'));
    }
    expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.resolveMetadata.mock.calls[0]?.[0].keys).toHaveLength(6);
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

    act(() => {
      useTerminalStore.setState({ dockPinned: true });
    });

    const dock = await screen.findByTestId('session-dock');
    expect(dock).toHaveAttribute('aria-hidden', 'false');
    expect(dock.closest('aside')).not.toBeNull();
    expect(screen.queryByText('README.md')).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });

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

    act(() => {
      useTerminalStore.setState({ dockPinned: true });
    });
    expect(await screen.findByTestId('session-dock')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`session-dock-row-${otherId}`));

    expect(await screen.findByText('OTHER.md')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('repo file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'README.md' })).toBeNull();
    expect(screen.getAllByTestId('mock-shell').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('session-dock')).toBeNull();

    act(() => {
      useTerminalStore.setState({ dockPinned: true });
    });
    expect(await screen.findByTestId('session-dock')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`session-dock-row-${repoId}`));

    // Switching back restores the worktree's shared file tab metadata.
    await waitFor(() => {
      expect(
        document.querySelector('[data-terminal-context-menu="true"][title="README.md"]'),
      ).not.toBeNull();
    });
    expect(screen.getByTestId('workspace-tab-home')).toBeInTheDocument();
  });

  it('retains dirty editor drafts across terminal switches in the same worktree', async () => {
    const store = useTerminalStore.getState();
    const firstId = store.createCard({
      projectName: 'first',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    const secondId = store.createCard({
      projectName: 'second',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(firstId);

    render(<TerminalManager />);

    fireEvent.click(await screen.findByText('README.md'));
    const firstEditor = await screen.findByLabelText('code editor');
    fireEvent.change(firstEditor, { target: { value: 'dirty draft from first card' } });

    await waitFor(() => {
      expect(screen.getByLabelText('code editor')).toHaveValue('dirty draft from first card');
    });

    // Shared worktree: file tab is still listed after another terminal is focused.
    act(() => {
      useTerminalStore.getState().focusCard(secondId);
    });
    expect(
      await screen.findAllByRole('button', { name: 'README.md' }),
    ).not.toHaveLength(0);
    expect(screen.getByLabelText('code editor')).toHaveValue('dirty draft from first card');
  });

  it('keeps dirty worktree drafts when ending a terminal', async () => {
    const store = useTerminalStore.getState();
    const cardId = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(cardId);
    render(<TerminalManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }));
    fireEvent.change(await screen.findByLabelText('code editor'), {
      target: { value: 'unsaved draft' },
    });

    let removed = false;
    await act(async () => {
      removed = await window.__terminalManager!.requestRemoveCard(cardId);
    });

    // Ending a terminal does not require discarding durable worktree drafts.
    expect(removed).toBe(true);
    expect(nativeDialogMocks.confirmDialog).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cards.some((card) => card.id === cardId)).toBe(false);
    expect(screen.getAllByRole('button', { name: 'README.md' }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workspace');
    expect(screen.queryByTestId('workspace-scope-loading')).not.toBeInTheDocument();
  });

  it('archives a terminal without deleting shared file tabs', async () => {
    const store = useTerminalStore.getState();
    const cardId = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(cardId);
    render(<TerminalManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }));
    fireEvent.change(await screen.findByLabelText('code editor'), {
      target: { value: 'keep me' },
    });

    let archived = false;
    await act(async () => {
      archived = await window.__terminalManager!.requestArchiveCard(cardId);
    });

    expect(archived).toBe(true);
    expect(nativeDialogMocks.confirmDialog).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cards).toHaveLength(0);
    expect(useTerminalStore.getState().archivedCards.map((card) => card.id)).toEqual([cardId]);
    // Shared file tab remains in the worktree workspace.
    expect(screen.getAllByRole('button', { name: 'README.md' }).length).toBeGreaterThan(0);
  });

  it('removes a clean card without prompting', async () => {
    const store = useTerminalStore.getState();
    const cardId = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(cardId);
    render(<TerminalManager />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workspace');
    });

    let removed = false;
    await act(async () => {
      removed = await window.__terminalManager!.requestRemoveCard(cardId);
    });

    expect(removed).toBe(true);
    expect(nativeDialogMocks.confirmDialog).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().cards).toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByTestId('mock-primary-view')).toHaveTextContent('workbench');
    });
    expect(screen.queryByTestId('workspace-scope-loading')).not.toBeInTheDocument();
  });

  it('mobile close ends the terminal and keeps the shared file draft', async () => {
    bridgeMocks.isTauriEnv.mockReturnValue(true);
    const store = useTerminalStore.getState();
    const cardId = store.createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    store.focusCard(cardId);
    render(<TerminalManager />);

    await waitFor(() => expect(bridgeMocks.onRemoveCard).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }));
    fireEvent.change(await screen.findByLabelText('code editor'), {
      target: { value: 'mobile-safe draft' },
    });
    const onRemove = bridgeMocks.onRemoveCard.mock.calls[0]?.[0] as
      | ((payload: { requestId: string; cardId: string }) => Promise<void>)
      | undefined;
    expect(onRemove).toBeTypeOf('function');

    await act(async () => {
      await onRemove?.({ requestId: 'close-1', cardId });
    });

    expect(bridgeMocks.ptyGracefulShutdown).toHaveBeenCalledWith(
      cardId,
      expect.stringMatching(/^shutdown:/),
      'generic',
    );
    expect(bridgeMocks.ptyKill).not.toHaveBeenCalled();
    expect(bridgeMocks.resolveClose).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'close-1',
        ok: true,
        cardId,
        outcome: 'ended',
        stage: 'shell_exit',
      }),
    );
    expect(useTerminalStore.getState().cards.some((card) => card.id === cardId)).toBe(false);
    expect(screen.getAllByRole('button', { name: 'README.md' }).length).toBeGreaterThan(0);
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

    fireEvent.contextMenu(getWorkspaceTab('README.md'));
    expect(screen.getByTestId('workspace-tab-context-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭除当前' }));

    expect(await screen.findByDisplayValue('old')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'README.md' })).toBeInTheDocument();
    expect(
      document.querySelector('[data-terminal-context-menu="true"][title="src/App.tsx"]'),
    ).toBeNull();
    // Close-others also closes other terminal tabs (home stays fixed).
    expect(screen.queryByTestId('workspace-tab-terminal')).toBeNull();

    fireEvent.contextMenu(getWorkspaceTab('README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭所有' }));

    // All closable tabs go away; home remains and the shell can stay mounted.
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-tab-file')).toBeNull();
    });
    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-home')).toBeInTheDocument();
  });
});
