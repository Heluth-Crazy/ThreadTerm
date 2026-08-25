import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode, HTMLAttributes } from 'react';
import { NotificationCenter } from './NotificationCenter';
import { registerArchivedNotificationNavigation } from './notificationTarget';
import { useTerminalStore } from '../../stores/terminalStore';
import { useOverlayStore } from '../../stores/overlayStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import { notificationFeedbackBus } from '../../lib/notificationDelivery';

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
    pendingArchivedNotificationTarget: null,
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
  notificationFeedbackBus.clear();
  vi.restoreAllMocks();
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

  it('clicking a degraded entry marks it read and shows localized feedback', async () => {
    const entry = useTerminalStore.getState().pushNotification({
      cardId: 'gone-card',
      kind: 'failed',
      title: 'late failure',
      body: '',
    });

    render(<NotificationCenter />);
    await act(async () => {
      fireEvent.click(screen.getByText('late failure'));
      await Promise.resolve();
    });

    const state = useTerminalStore.getState();
    expect(state.notifications.find((n) => n.id === entry.id)?.read).toBe(true);
    // Drawer stays open — nothing to navigate to.
    expect(state.notificationCentreOpen).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('notifications.targetUnavailable');

    act(() => useTerminalStore.getState().toggleNotificationCentre(false));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    act(() => useTerminalStore.getState().toggleNotificationCentre(true));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('clicking a live entry emits a locate request and closes the drawer', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'completed', title: 'done', body: '' });

    render(<NotificationCenter />);
    await act(async () => {
      fireEvent.click(screen.getByText('done'));
      await Promise.resolve();
    });

    const state = useTerminalStore.getState();
    expect(state.pendingLocateCardId).toBe(id);
    expect(state.notificationCentreOpen).toBe(false);
  });

  it('clears stale runtime feedback after an accepted click', async () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'completed', title: 'fresh done', body: '' });
    notificationFeedbackBus.publish({
      notificationId: 'old-event',
      cardId: id,
      kind: 'stale',
      feedbackKey: 'notifications.targetNavigationFailed',
    });

    render(<NotificationCenter />);
    await act(async () => {
      fireEvent.click(screen.getByText('fresh done'));
      await Promise.resolve();
    });

    expect(notificationFeedbackBus.getSnapshot()).toBeNull();
    expect(useTerminalStore.getState().notificationCentreOpen).toBe(false);
  });

  it('clears runtime feedback when the centre is explicitly closed', () => {
    notificationFeedbackBus.publish({
      notificationId: 'old-event',
      cardId: 'gone-card',
      kind: 'stale',
      feedbackKey: 'notifications.targetNavigationFailed',
    });
    render(<NotificationCenter />);

    const headerButtons = screen.getAllByRole('button');
    fireEvent.click(headerButtons[headerButtons.length - 1]);

    expect(notificationFeedbackBus.getSnapshot()).toBeNull();
    expect(useTerminalStore.getState().notificationCentreOpen).toBe(false);
  });

  it('awaits archived navigation before closing and acknowledging the centre entry', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const entry = s.pushNotification({ cardId, kind: 'completed', title: 'archived done', body: '' });
    s.archiveCard(cardId);
    const unregister = registerArchivedNotificationNavigation(async () => undefined);

    render(<NotificationCenter />);
    await act(async () => {
      fireEvent.click(screen.getByText('archived done'));
      await Promise.resolve();
    });
    unregister();

    expect(useTerminalStore.getState().notificationCentreOpen).toBe(false);
    expect(useTerminalStore.getState().notifications.find((n) => n.id === entry.id)?.read).toBe(true);
  });

  it('keeps unexpected navigation errors unread and shows localized feedback', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'codex' });
    const entry = s.pushNotification({ cardId, kind: 'completed', title: 'error target', body: '' });
    const recycleToMain = vi
      .spyOn(useOverlayStore.getState(), 'recycleToMain')
      .mockImplementation(() => {
        throw new Error('navigation failed');
      });

    render(<NotificationCenter />);
    await act(async () => {
      fireEvent.click(screen.getByText('error target'));
      await Promise.resolve();
    });

    expect(useTerminalStore.getState().notifications.find((n) => n.id === entry.id)?.read).toBe(false);
    expect(useTerminalStore.getState().notificationCentreOpen).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('notifications.targetNavigationFailed');
    recycleToMain.mockRestore();
  });

  it('marks only the clicked terminal notifications through the per-terminal bulk action', () => {
    const s = useTerminalStore.getState();
    const firstCardId = s.createCard({ projectName: 'first', projectPath: '/first', terminalType: 'shell' });
    const secondCardId = s.createCard({ projectName: 'second', projectPath: '/second', terminalType: 'shell' });
    s.pushNotification({ cardId: firstCardId, kind: 'waiting', title: 'first input', body: '' });
    s.pushNotification({ cardId: firstCardId, kind: 'completed', title: 'first done', body: '' });
    s.pushNotification({ cardId: secondCardId, kind: 'waiting', title: 'second input', body: '' });

    render(<NotificationCenter />);
    const firstRow = screen.getByText('first done').closest('li');
    const bulkButton = firstRow?.querySelector(
      'button[aria-label="notifications.markTerminalRead"]',
    );
    expect(bulkButton).not.toBeNull();
    fireEvent.click(bulkButton!);

    const notifications = useTerminalStore.getState().notifications;
    expect(notifications.filter((n) => n.cardId === firstCardId).every((n) => n.read)).toBe(true);
    expect(notifications.find((n) => n.cardId === secondCardId)?.read).toBe(false);
  });

  it('acknowledges one of two same-card events without affecting the other', async () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'repo', projectPath: '/repo', terminalType: 'shell' });
    const first = s.pushNotification({ cardId, kind: 'completed', title: 'first event', body: '' });
    const second = useTerminalStore.getState().pushNotification({
      cardId,
      kind: 'failed',
      title: 'second event',
      body: '',
    });

    render(<NotificationCenter />);
    await act(async () => {
      fireEvent.click(screen.getByText('first event'));
      await Promise.resolve();
    });

    const notifications = useTerminalStore.getState().notifications;
    expect(notifications.find((n) => n.id === first.id)?.read).toBe(true);
    expect(notifications.find((n) => n.id === second.id)?.read).toBe(false);
  });
});
