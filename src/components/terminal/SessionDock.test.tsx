import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionDock } from './SessionDock';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const labels: Record<string, string> = {
    'dock.title': 'Recent sessions',
    'dock.shortcut': 'Cmd/Ctrl+E',
    'dock.close': 'Close session dock',
    'dock.empty': 'No recent sessions',
    'dock.current': 'Current',
    'card.justNow': 'just now',
    'types.shell': 'Shell',
    'types.codex': 'Codex',
    'status.running': 'Running',
    'status.waiting': 'Waiting',
    'status.idle': 'Idle',
  };
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: unknown) => {
        if (key === 'card.ago' && opts && typeof opts === 'object' && 'time' in opts) {
          return `${(opts as { time: string }).time} ago`;
        }
        if (typeof opts === 'string') return opts;
        if (opts && typeof opts === 'object' && 'defaultValue' in opts) {
          return (opts as { defaultValue: string }).defaultValue;
        }
        return labels[key] ?? key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

function makeCard(overrides: Partial<TerminalCard>): TerminalCard {
  return {
    id: 'card-a',
    ptyId: 'card-a',
    projectPath: '/repo/a',
    projectName: 'Alpha',
    terminalType: 'shell',
    status: 'idle',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

beforeEach(() => {
  const a = makeCard({
    id: 'card-a',
    ptyId: 'card-a',
    projectName: 'Alpha',
    projectPath: '/repo/alpha',
    branchLabel: 'main',
    status: 'running',
  });
  const b = makeCard({
    id: 'card-b',
    ptyId: 'card-b',
    projectName: 'Beta',
    projectPath: '/repo/beta',
    worktreePath: '/repo/beta-feature',
    terminalType: 'codex',
    status: 'waiting',
  });
  useTerminalStore.setState({
    cards: [a, b],
    focusedCardId: 'card-a',
    recentlyViewedCardIds: ['card-b', 'card-a'],
    dockPinned: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('SessionDock', () => {
  it('renders recent cards in store order and marks the current card', () => {
    render(
      <SessionDock
        visible={true}
        onClose={vi.fn()}
      />,
    );

    const rows = screen.getAllByTestId(/session-dock-row-/);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Beta')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Waiting')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Alpha')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Current')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Running')).toBeInTheDocument();
  });

  it('focuses a clicked card and closes the dock', () => {
    const onClose = vi.fn();
    render(
      <SessionDock
        visible={true}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('session-dock-row-card-b'));

    expect(useTerminalStore.getState().focusedCardId).toBe('card-b');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('selects recent sessions with number and arrow keyboard shortcuts', () => {
    const onClose = vi.fn();
    render(
      <SessionDock
        visible={true}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: '1' });
    expect(useTerminalStore.getState().focusedCardId).toBe('card-b');
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(useTerminalStore.getState().focusedCardId).toBe('card-a');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('captures handled keyboard shortcuts before terminal input', () => {
    const onClose = vi.fn();
    const parentKeyDown = vi.fn();
    window.addEventListener('keydown', parentKeyDown);
    render(
      <SessionDock
        visible={true}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    window.removeEventListener('keydown', parentKeyDown);
  });

  it('renders an empty state and calls close from the header button', () => {
    useTerminalStore.setState({ recentlyViewedCardIds: [] });
    const onClose = vi.fn();
    render(
      <SessionDock
        visible={true}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('No recent sessions')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close session dock'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
