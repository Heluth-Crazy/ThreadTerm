import {
  StrictMode,
  useLayoutEffect,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { NotificationPresentationProvider } from './NotificationPresentationProvider';
import { NotificationToastStack } from './NotificationToastStack';

const resolveTarget = vi.hoisted(() => vi.fn());

vi.mock('./notificationTarget', () => ({
  resolveNotificationTarget: resolveTarget,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => {
      const safeProps = { ...props } as Record<string, unknown>;
      delete safeProps.layout;
      delete safeProps.initial;
      delete safeProps.animate;
      delete safeProps.exit;
      delete safeProps.transition;
      return <div {...safeProps}>{children}</div>;
    },
  },
  useReducedMotion: () => false,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: unknown) => {
        if (options && typeof options === 'object' && 'defaultValue' in options) {
          const value = (options as { defaultValue: string }).defaultValue;
          const title = (options as { title?: string }).title;
          return title ? value.replace('{{title}}', title) : value;
        }
        return key;
      },
    }),
  };
});

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    notifications: [],
    notificationCentreOpen: false,
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
    pinnedCardIds: [],
    pendingFocusCardId: null,
    pendingLocateCardId: null,
    pendingArchivedNotificationTarget: null,
    highlightCardId: null,
  });
}

function renderStack(props: { blocked?: boolean } = {}) {
  return render(
    <NotificationPresentationProvider>
      <div data-testid="surface">
        <NotificationToastStack {...props} />
      </div>
    </NotificationPresentationProvider>,
  );
}

function EmitBeforePresentationSubscription() {
  useLayoutEffect(() => {
    useTerminalStore.getState().pushNotification({
      cardId: 'card-1',
      at: Date.now(),
      kind: 'waiting',
      title: 'layout event',
      body: 'committed before provider subscription',
    });
  }, []);
  return null;
}

function toastNodes() {
  return screen.getAllByTestId(/^notification-toast-(?!stack$)/);
}

function pushNotification(
  cardId: string,
  id: string,
  at: number,
  body = `body-${id}`,
) {
  // Stable ids make order and exact target assertions independent of uid().
  useTerminalStore.getState().pushNotification({
    cardId,
    at,
    kind: 'completed',
    title: `title-${id}`,
    body,
  });
  const notifications = useTerminalStore.getState().notifications;
  const created = notifications[0];
  if (!created) throw new Error('notification was not inserted');
  // The store intentionally owns ids. Tests use the generated id and expose
  // it through the returned ledger snapshot rather than mutating the entry.
  return created;
}

beforeEach(() => {
  resetStore();
  resolveTarget.mockReset();
  resolveTarget.mockResolvedValue({ accepted: true, kind: 'active' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('NotificationToastStack presentation bridge', () => {
  it('seeds hydrated entries without replaying them, then presents foreground additions', async () => {
    const historical = pushNotification('card-1', 'history', 1);
    renderStack();
    expect(screen.queryByTestId(`notification-toast-${historical.id}`)).not.toBeInTheDocument();

    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId: 'card-1',
        at: 2,
        kind: 'waiting',
        title: 'new event',
        body: 'new body',
      });
    });
    await waitFor(() => expect(screen.getByTestId('notification-toast-stack')).toBeInTheDocument());
    expect(toastNodes()).toHaveLength(1);
  });

  it('holds background additions and catches up exactly once on focus', async () => {
    const focus = vi.mocked(document.hasFocus);
    renderStack();
    act(() => {
      focus.mockReturnValue(false);
      fireEvent.blur(window);
      pushNotification('card-1', 'one', 1);
      pushNotification('card-1', 'two', 2);
      pushNotification('card-1', 'three', 3);
    });
    expect(screen.queryByTestId('notification-toast-stack')).not.toBeInTheDocument();

    act(() => {
      focus.mockReturnValue(true);
      fireEvent.focus(window);
    });
    await waitFor(() => expect(toastNodes()).toHaveLength(3));
    act(() => fireEvent.focus(window));
    expect(toastNodes()).toHaveLength(3);
  });

  it('keeps four visible in FIFO order and promotes the oldest queued item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    renderStack();
    const entries: ReturnType<typeof pushNotification>[] = [];
    act(() => {
      for (let index = 0; index < 10; index += 1) {
        entries.push(pushNotification('card-1', `event-${index}`, 1_000 + index));
      }
    });
    const visible = toastNodes();
    expect(visible).toHaveLength(4);
    expect(visible.map((node) => node.getAttribute('data-notification-id'))).toEqual(
      entries.slice(0, 4).map((entry) => entry.id),
    );

    act(() => vi.advanceTimersByTime(10_000));
    expect(toastNodes()).toHaveLength(4);
    expect(screen.getByTestId(`notification-toast-${entries[4].id}`)).toBeInTheDocument();
  });

  it('renders sanitized summaries and active source labels in oldest-at-bottom DOM order', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectPath: '/repo',
      projectName: 'repo',
      terminalType: 'codex',
    });
    renderStack();
    const longBody = `${'x'.repeat(200)}\u001b[2K`;
    let first: ReturnType<typeof pushNotification> | undefined;
    let second: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      first = pushNotification(cardId, 'first', 10, '\u001b[31mfirst\u001b[0m');
      second = pushNotification(cardId, 'second', 20, longBody);
    });
    if (!first || !second) throw new Error('source notifications were not inserted');
    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId,
        at: 30,
        kind: 'attention',
        title: 'third',
        body: 'third',
      });
    });
    await waitFor(() => expect(toastNodes()).toHaveLength(3));
    const ids = toastNodes().map((node) =>
      node.getAttribute('data-notification-id'),
    );
    expect(ids[0]).toBe(first.id);
    expect(ids[1]).toBe(second.id);
    expect(screen.getAllByText(/repo · Codex/)).toHaveLength(3);
    expect(screen.queryByText(/\u001b/)).not.toBeInTheDocument();
    const summary = within(screen.getByTestId(`notification-toast-${second.id}`)).getByText(/^x+$/);
    expect(summary.textContent?.length).toBeLessThanOrEqual(160);
  });

  it('closes without acknowledging and forwards the exact event/card pair', async () => {
    renderStack();
    let first: ReturnType<typeof pushNotification> | undefined;
    let second: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      first = pushNotification('card-1', 'first', 1);
      second = pushNotification('card-1', 'second', 2);
    });
    if (!first || !second) throw new Error('target notifications were not inserted');
    const firstEntry = first;
    const secondEntry = second;
    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId: 'card-1',
        at: 3,
        kind: 'attention',
        title: 'third',
        body: 'third',
      });
    });
    await waitFor(() => expect(toastNodes()).toHaveLength(3));

    const firstToast = screen.getByTestId(`notification-toast-${firstEntry.id}`);
    fireEvent.click(within(firstToast).getByRole('button', { name: 'Dismiss notification' }));
    expect(useTerminalStore.getState().notifications.find((n) => n.id === firstEntry.id)?.read).toBe(false);

    fireEvent.click(within(screen.getByTestId(`notification-toast-${secondEntry.id}`)).getByRole('button', {
      name: /Open notification/,
    }));
    await waitFor(() => expect(resolveTarget).toHaveBeenCalledWith(secondEntry.id, 'card-1'));
  });

  it('shows localized target feedback while preserving error unread state and scopes missing ack', async () => {
    renderStack();
    let errorEntry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      errorEntry = pushNotification('card-1', 'error', Date.now());
    });
    if (!errorEntry) throw new Error('error notification was not inserted');
    resolveTarget.mockResolvedValueOnce({
      kind: 'error',
      accepted: false,
      feedbackKey: 'notifications.targetNavigationFailed',
    });
    fireEvent.click(
      within(screen.getByTestId(`notification-toast-${errorEntry.id}`)).getByRole('button', {
        name: /Open notification/,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('notification-toast-feedback')).toHaveTextContent(
      'notifications.targetNavigationFailed',
    ));
    expect(useTerminalStore.getState().notifications.find((n) => n.id === errorEntry?.id)?.read).toBe(false);

    let missingEntry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      missingEntry = pushNotification('card-1', 'missing', Date.now());
    });
    if (!missingEntry) throw new Error('missing notification was not inserted');
    resolveTarget.mockImplementationOnce(async (id: string) => {
      useTerminalStore.getState().markNotificationRead(id);
      return {
        kind: 'missing',
        accepted: false,
        acknowledged: true,
        feedbackKey: 'notifications.targetUnavailable',
      };
    });
    fireEvent.click(
      within(screen.getByTestId(`notification-toast-${missingEntry.id}`)).getByRole('button', {
        name: /Open notification/,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('notification-toast-feedback')).toHaveTextContent(
      'notifications.targetUnavailable',
    ));
    expect(useTerminalStore.getState().notifications.find((n) => n.id === missingEntry?.id)?.read).toBe(true);
    expect(useTerminalStore.getState().notifications.find((n) => n.id === errorEntry?.id)?.read).toBe(false);
  });

  it('hides while the notification centre is open and does not duplicate under StrictMode', async () => {
    const view = render(
      <StrictMode>
        <NotificationPresentationProvider>
          <NotificationToastStack />
        </NotificationPresentationProvider>
      </StrictMode>,
    );
    let entry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      entry = pushNotification('card-1', 'strict', 1);
    });
    if (!entry) throw new Error('notification was not inserted');
    await waitFor(() => expect(toastNodes()).toHaveLength(1));
    act(() => useTerminalStore.getState().toggleNotificationCentre(true));
    expect(screen.queryByTestId('notification-toast-stack')).not.toBeInTheDocument();
    act(() => useTerminalStore.getState().toggleNotificationCentre(false));
    expect(screen.getByTestId(`notification-toast-${entry.id}`)).toBeInTheDocument();
    view.unmount();
  });

  it('catches a commit made between controller seed and provider subscription', async () => {
    render(
      <NotificationPresentationProvider>
        <EmitBeforePresentationSubscription />
        <NotificationToastStack />
      </NotificationPresentationProvider>,
    );
    await waitFor(() => expect(toastNodes()).toHaveLength(1));
  });

  it('keeps blocker pause after centre close and window focus changes', async () => {
    vi.useFakeTimers();
    const view = renderStack({ blocked: true });
    let entry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      entry = pushNotification('card-1', 'combined-blocker', Date.now());
    });
    if (!entry) throw new Error('blocked notification was not inserted');
    act(() => {
      useTerminalStore.getState().toggleNotificationCentre(true);
      fireEvent.blur(window);
      fireEvent.focus(window);
      useTerminalStore.getState().toggleNotificationCentre(false);
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.queryByTestId('notification-toast-stack')).not.toBeInTheDocument();

    view.rerender(
      <NotificationPresentationProvider>
        <div data-testid="surface">
          <NotificationToastStack blocked={false} />
        </div>
      </NotificationPresentationProvider>,
    );
    expect(screen.getByTestId(`notification-toast-${entry.id}`)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(9_999));
    expect(screen.getByTestId(`notification-toast-${entry.id}`)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId(`notification-toast-${entry.id}`)).not.toBeInTheDocument();
  });

  it('keeps the stack inside a positioned main column before the right rail sibling', async () => {
    render(
      <NotificationPresentationProvider>
        <div data-testid="terminal-area" className="relative flex">
          <div
            data-testid="terminal-main-content-column"
            className="relative flex min-w-0 flex-1"
          >
            <NotificationToastStack />
          </div>
          <aside data-testid="right-rail" className="w-80 shrink-0" />
        </div>
      </NotificationPresentationProvider>,
    );
    let entry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      entry = pushNotification('card-1', 'anchored', Date.now());
    });
    if (!entry) throw new Error('anchored notification was not inserted');
    await waitFor(() => expect(screen.getByTestId(`notification-toast-${entry?.id}`)).toBeInTheDocument());
    const mainColumn = screen.getByTestId('terminal-main-content-column');
    const stack = screen.getByTestId('notification-toast-stack');
    expect(mainColumn).toHaveClass('relative');
    expect(mainColumn).toContainElement(stack);
    expect(mainColumn.nextElementSibling).toBe(screen.getByTestId('right-rail'));
    expect(mainColumn.nextElementSibling).not.toContainElement(stack);
  });

  it('keeps in-app presentation independent from the OS notification preference', async () => {
    useTerminalStore.setState({ osNotificationsEnabled: false });
    renderStack();
    let entry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      entry = pushNotification('card-1', 'os-disabled', Date.now());
    });
    if (!entry) throw new Error('notification was not inserted');
    await waitFor(() => expect(screen.getByTestId(`notification-toast-${entry?.id}`)).toBeInTheDocument());
  });

  it('pauses on modal/blocking state and resumes after hover/focus leaves', async () => {
    vi.useFakeTimers();
    renderStack({ blocked: true });
    act(() => pushNotification('card-1', 'blocked', 1));
    expect(screen.queryByTestId('notification-toast-stack')).not.toBeInTheDocument();

    cleanup();
    resetStore();
    renderStack();
    let entry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      entry = pushNotification('card-1', 'hovered', 2);
    });
    if (!entry) throw new Error('notification was not inserted');
    const toast = screen.getByTestId(`notification-toast-${entry.id}`);
    fireEvent.mouseEnter(toast);
    fireEvent.focus(within(toast).getByRole('button', { name: /Open notification/ }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByTestId(`notification-toast-${entry.id}`)).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    fireEvent.blur(within(toast).getByRole('button', { name: /Open notification/ }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByTestId(`notification-toast-${entry.id}`)).not.toBeInTheDocument();
  });

  it('removes immediately when the ledger acknowledges or clears an event', async () => {
    renderStack();
    let entry: ReturnType<typeof pushNotification> | undefined;
    act(() => {
      entry = pushNotification('card-1', 'ack', 1);
    });
    if (!entry) throw new Error('ack notification was not inserted');
    const acknowledgedEntry = entry;
    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId: 'card-1',
        at: 2,
        kind: 'completed',
        title: 'another',
        body: 'another',
      });
    });
    await waitFor(() => expect(screen.getByTestId(`notification-toast-${acknowledgedEntry.id}`)).toBeInTheDocument());
    act(() => useTerminalStore.getState().markNotificationRead(acknowledgedEntry.id));
    await waitFor(() => expect(screen.queryByTestId(`notification-toast-${acknowledgedEntry.id}`)).not.toBeInTheDocument());
    act(() => useTerminalStore.getState().clearNotifications());
    expect(screen.queryByTestId('notification-toast-stack')).not.toBeInTheDocument();
  });
});
