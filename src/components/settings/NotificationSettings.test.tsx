import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { NotificationSettings } from './NotificationSettings';

const notificationMocks = vi.hoisted(() => ({
  isTauriEnv: vi.fn(() => true),
  sendOsNotification: vi.fn(),
  createNotificationTestId: vi.fn(() => 'notification-test:1'),
  register: vi.fn(),
  dispose: vi.fn(),
  activationCallback: null as (() => void) | null,
  registeredCardId: null as string | null,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock('../../lib/tauri-bridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/tauri-bridge')>();
  return { ...original, isTauriEnv: notificationMocks.isTauriEnv };
});

vi.mock('../../lib/notificationDelivery', () => ({
  createNotificationTestId: notificationMocks.createNotificationTestId,
  sendOsNotification: notificationMocks.sendOsNotification,
  notificationTestActivationRegistry: {
    register: notificationMocks.register,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  notificationMocks.isTauriEnv.mockReturnValue(true);
  notificationMocks.sendOsNotification.mockResolvedValue({
    notificationId: 'notification-test:1',
    channel: 'windows-native',
    status: 'accepted',
  });
  notificationMocks.register.mockImplementation(
    (_id: string, cardId: string | null, callback: () => void) => {
      notificationMocks.registeredCardId = cardId;
      notificationMocks.activationCallback = callback;
      return notificationMocks.dispose;
    },
  );
  notificationMocks.activationCallback = null;
  notificationMocks.registeredCardId = null;
  useTerminalStore.setState({
    osNotificationsEnabled: true,
    focusedCardId: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('NotificationSettings', () => {
  it('reports accepted as sent and a later runtime activation as clicked', async () => {
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.sendTest' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('notifications.sent'));

    act(() => notificationMocks.activationCallback?.());
    expect(screen.getByRole('status')).toHaveTextContent('notifications.clicked');
    expect(useTerminalStore.getState().focusedCardId).toBeNull();
    expect(notificationMocks.sendOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'notification-test:1',
        cardId: null,
      }),
    );
  });

  it.each([
    ['degraded', 'notifications.degraded'],
    ['disabled-by-system', 'notifications.disabledBySystem'],
    ['failed', 'notifications.failed'],
  ] as const)('shows the %s receipt state', async (status, message) => {
    notificationMocks.sendOsNotification.mockResolvedValue({
      notificationId: 'notification-test:1',
      channel: status === 'degraded' ? 'plugin' : 'unknown',
      status,
    });
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.sendTest' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message));
  });

  it('shows the typed receipt reason and identity source without claiming native acceptance', async () => {
    notificationMocks.sendOsNotification.mockResolvedValue({
      notificationId: 'notification-test:1',
      channel: 'plugin',
      status: 'degraded',
      reason: 'native-show-failed',
      identitySource: 'runtime-registration',
    });
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.sendTest' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('notifications.degraded');
      expect(screen.getByRole('status')).toHaveTextContent('notifications.reason.nativeShowFailed');
      expect(screen.getByRole('status')).toHaveTextContent(
        'notifications.identitySource.runtimeRegistration',
      );
    });
  });

  it('does not claim delivery when the OS master switch is disabled', async () => {
    useTerminalStore.setState({ osNotificationsEnabled: false });
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.sendTest' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'notifications.disabledBySystem',
    );
    expect(notificationMocks.sendOsNotification).not.toHaveBeenCalled();
  });

  it('registers a focused card as an exact runtime-only target', async () => {
    useTerminalStore.setState({ focusedCardId: 'card-focused' });
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.sendTest' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('notifications.sent'));

    expect(notificationMocks.registeredCardId).toBe('card-focused');
    expect(notificationMocks.sendOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 'card-focused' }),
    );
  });

  it('keeps clicked state when activation wins the receipt promise race', async () => {
    let resolveReceipt: ((receipt: unknown) => void) | null = null;
    notificationMocks.sendOsNotification.mockImplementation(
      () => new Promise((resolve) => {
        resolveReceipt = resolve;
      }),
    );
    render(<NotificationSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.sendTest' }));
    await waitFor(() => expect(notificationMocks.activationCallback).not.toBeNull());

    act(() => notificationMocks.activationCallback?.());
    expect(screen.getByRole('status')).toHaveTextContent('notifications.clicked');
    act(() => {
      resolveReceipt?.({
        notificationId: 'notification-test:1',
        channel: 'windows-native',
        status: 'accepted',
      });
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('notifications.clicked'));
  });

  it('cleans the previous registration on resend and unmount', async () => {
    const view = render(<NotificationSettings />);
    const button = screen.getByRole('button', { name: 'notifications.sendTest' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('notifications.sent'));
    fireEvent.click(button);
    await waitFor(() => expect(notificationMocks.dispose).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(notificationMocks.dispose).toHaveBeenCalledTimes(2);
  });
});
