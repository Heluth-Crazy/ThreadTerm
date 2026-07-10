import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode, HTMLAttributes } from 'react';
import { NotificationCenter } from './NotificationCenter';
import { useTerminalStore } from '../../stores/terminalStore';
import { useOverlayStore } from '../../stores/overlayStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    aside: ({ children, ...props }: HTMLAttributes<HTMLElement>) => (
      <aside {...props}>{children}</aside>
    ),
  },
  useReducedMotion: () => true,
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

function resetStores() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: true,
    pendingFocusCardId: null,
    pendingLocateCardId: null,
    highlightCardId: null,
  });
  useOverlayStore.setState({ floatOpen: false, floatCardId: null, lightweightMode: false });
  useSupervisorStore.setState({
    alerts: [],
    telemetry: { triggered: 0, clicked: 0, acted: 0 },
  });
}

beforeEach(resetStores);

afterEach(() => {
  cleanup();
});

describe('NotificationCenter source labels & degradation', () => {
  it('shows the full source label for a live card', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'codex',
    });
    useTerminalStore.getState().updateCardAiIntent(id, 'fix');
    s.pushNotification({ cardId: id, kind: 'waiting', title: 'needs input', body: '' });

    render(<NotificationCenter />);

    // formatCardSourceLabel falls back to terminalTypeMeta labels via the
    // mocked t (returns defaultValue) — "repo · Codex · fix".
    expect(screen.getByText(/repo · Codex · fix/)).toBeInTheDocument();
  });

  it('labels system entries as system source, not as a closed card', () => {
    useTerminalStore.getState().pushNotification({
      cardId: 'system:worktrees',
      kind: 'completed',
      title: 'worktree created',
      body: '',
    });

    render(<NotificationCenter />);

    expect(screen.getByText(/notifications.systemSource/)).toBeInTheDocument();
    expect(screen.queryByText('notifications.cardClosed')).toBeNull();
  });

  it('shows the closed-card label when the source card is gone', () => {
    useTerminalStore.getState().pushNotification({
      cardId: 'gone-card',
      kind: 'failed',
      title: 'late failure',
      body: '',
    });

    render(<NotificationCenter />);

    expect(screen.getByText('notifications.cardClosed')).toBeInTheDocument();
  });

  it('clicking a degraded entry marks it read instead of no-op', () => {
    const entry = useTerminalStore.getState().pushNotification({
      cardId: 'gone-card',
      kind: 'failed',
      title: 'late failure',
      body: '',
    });

    render(<NotificationCenter />);
    fireEvent.click(screen.getByText('late failure'));

    const state = useTerminalStore.getState();
    expect(state.notifications.find((n) => n.id === entry.id)?.read).toBe(true);
    // Drawer stays open — nothing to navigate to.
    expect(state.notificationCentreOpen).toBe(true);
  });

  it('clicking a live entry emits a locate request and closes the drawer', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'completed', title: 'done', body: '' });

    render(<NotificationCenter />);
    fireEvent.click(screen.getByText('done'));

    const state = useTerminalStore.getState();
    expect(state.pendingLocateCardId).toBe(id);
    expect(state.notificationCentreOpen).toBe(false);
  });
});
