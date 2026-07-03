import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CardGrid } from './CardGrid';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { pendingWorktreePath } from '../../lib/worktreePaths';

vi.mock('framer-motion', () => ({
  motion: {
    button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
  },
  useReducedMotion: () => false,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: unknown) => {
        if (opts && typeof opts === 'object' && 'defaultValue' in opts) {
          return (opts as { defaultValue: string }).defaultValue;
        }
        return key;
      },
    }),
  };
});

vi.mock('./TerminalCard', () => ({
  TerminalCardComponent: ({
    card,
    dragHandle,
    onArchive,
  }: {
    card: TerminalCard;
    dragHandle?: React.ReactNode;
    onArchive?: () => void;
  }) => (
    <div data-testid="terminal-card">
      {dragHandle}
      <span data-testid="terminal-card-name">{card.projectName}</span>
      <span data-testid="terminal-card-worktree">{card.worktreePath ?? card.projectPath}</span>
      {onArchive && (
        <button type="button" onClick={onArchive}>
          archive {card.projectName}
        </button>
      )}
    </div>
  ),
}));

function resetStore() {
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
    osNotificationsEnabled: true,
    supervisorEnabled: false,
  });
}

beforeEach(resetStore);

afterEach(() => {
  cleanup();
});

describe('CardGrid project ordering', () => {
  it('does not show drag handles in the all-terminals view', () => {
    useTerminalStore.getState().createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });

    render(<CardGrid />);

    expect(screen.queryByLabelText(/Drag to reorder card/)).toBeNull();
  });

  it('shows drag handles in a selected project view', () => {
    const store = useTerminalStore.getState();
    store.createCard({ projectName: 'First', projectPath: '/repo/threadterm', terminalType: 'shell' });
    store.createCard({ projectName: 'Second', projectPath: '/repo/threadterm', terminalType: 'shell' });
    useTerminalStore.getState().selectProject('/repo/threadterm');

    render(<CardGrid />);

    expect(screen.getAllByLabelText(/Drag to reorder card/)).toHaveLength(2);
    expect(screen.getAllByTestId('terminal-card-name').map((node) => node.textContent)).toEqual([
      'Second',
      'First',
    ]);
  });

  it('filters selected project cards by selected worktree path', () => {
    const store = useTerminalStore.getState();
    store.createCard({
      projectName: 'Root',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    store.createCard({
      projectName: 'Feature',
      projectPath: '/repo/threadterm',
      worktreePath: '/repo/threadterm-feature',
      terminalType: 'shell',
    });
    store.selectWorktree('/repo/threadterm', '/repo/threadterm-feature', 'feature/worktree-ui');

    render(<CardGrid />);

    expect(screen.getAllByTestId('terminal-card-name').map((node) => node.textContent)).toEqual([
      'Feature',
    ]);
    expect(screen.queryByLabelText(/Drag to reorder card/)).toBeNull();
    expect(screen.getByLabelText('Show the whole project to reorder')).toBeInTheDocument();
  });

  it('creates a shell card in the selected worktree from the new terminal tile', () => {
    const store = useTerminalStore.getState();
    store.createCard({
      projectName: 'Feature',
      projectPath: '/repo/threadterm',
      worktreePath: '/repo/threadterm-feature',
      terminalType: 'shell',
    });
    store.selectWorktree('/repo/threadterm', '/repo/threadterm-feature', 'feature/worktree-ui');
    const onCreateTerminal = vi.fn();

    render(<CardGrid onCreateTerminal={onCreateTerminal} />);
    fireEvent.click(screen.getByRole('button', { name: /app.newTerminal/ }));

    expect(onCreateTerminal).toHaveBeenCalledWith({
      projectPath: '/repo/threadterm',
      projectName: 'Feature',
      worktreePath: '/repo/threadterm-feature',
      branchLabel: 'feature/worktree-ui',
      terminalType: 'shell',
    });
  });

  it('uses the pending branch empty state to request worktree creation', () => {
    const pendingPath = pendingWorktreePath('/repo/threadterm', 'feature/new');
    useTerminalStore.setState({
      selectedProjectPath: '/repo/threadterm',
      selectedWorktreePath: pendingPath,
      selectedWorktreeLabel: 'feature/new',
    });
    const onCreateWorktreeTerminal = vi.fn();

    render(<CardGrid onCreateWorktreeTerminal={onCreateWorktreeTerminal} />);
    fireEvent.click(screen.getByRole('button', { name: 'grid.createWorktreeHere' }));

    expect(onCreateWorktreeTerminal).toHaveBeenCalledWith({
      projectPath: '/repo/threadterm',
      branch: 'feature/new',
      branchLabel: 'feature/new',
    });
  });

  it('archives cards from the grid without deleting the archived snapshot', async () => {
    const store = useTerminalStore.getState();
    store.createCard({
      projectName: 'ThreadTerm',
      projectPath: '/repo/threadterm',
      terminalType: 'shell',
    });
    store.selectProject('/repo/threadterm');

    render(<CardGrid />);

    fireEvent.click(screen.getByRole('button', { name: 'archive ThreadTerm' }));

    await waitFor(() => expect(screen.queryByTestId('terminal-card')).toBeNull());
    expect(useTerminalStore.getState().cards).toHaveLength(0);
    expect(useTerminalStore.getState().archivedCards).toHaveLength(1);
  });
});
