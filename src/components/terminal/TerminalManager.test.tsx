import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalManager } from './TerminalManager';

const settingsWindowMocks = vi.hoisted(() => ({
  openSettingsWindow: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../lib/settingsWindow', () => ({
  openSettingsWindow: settingsWindowMocks.openSettingsWindow,
}));

vi.mock('../Shell', () => ({
  default: () => <div data-testid="mock-shell" />,
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
    try {
      localStorage.removeItem('threadterm-shortcut-hint-dismissed');
    } catch {
      /* localStorage absent in some envs */
    }
    settingsWindowMocks.openSettingsWindow.mockClear();
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
});
