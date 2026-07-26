import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { NotificationBridge } from './NotificationBridge';

const notificationMocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
  sendNotification: vi.fn(),
  unregister: vi.fn(),
  onAction: vi.fn(() =>
    Promise.resolve({
      unregister: notificationMocks.unregister,
    }),
  ),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: notificationMocks.isPermissionGranted,
  requestPermission: notificationMocks.requestPermission,
  sendNotification: notificationMocks.sendNotification,
  onAction: notificationMocks.onAction,
}));

vi.mock('../../lib/tauri-bridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/tauri-bridge')>();
  return {
    ...original,
    isTauriEnv: () => true,
    invoke: notificationMocks.invoke,
  };
});

describe('NotificationBridge OS coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    useTerminalStore.setState({
      cards: [],
      notifications: [],
      osNotificationsEnabled: true,
      focusedCardId: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps all in-app evidence but sends only the highest-priority interaction toast', async () => {
    render(<NotificationBridge />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      const push = useTerminalStore.getState().pushNotification;
      push({
        cardId: 'card-a',
        kind: 'waiting',
        title: 'PTY',
        body: 'prompt',
        routing: {
          origin: 'pty',
          family: 'interaction',
          episodeKey: 'interaction:card-a:1',
          fingerprint: 'prompt',
        },
      });
      push({
        cardId: 'card-a',
        kind: 'attention',
        title: 'Supervisor',
        body: 'prompt',
        routing: {
          origin: 'supervisor',
          family: 'interaction',
          episodeKey: 'interaction:card-a:1',
          fingerprint: 'rule:prompt',
        },
      });
      push({
        cardId: 'card-a',
        kind: 'attention',
        title: 'Codex',
        body: 'prompt',
        routing: {
          origin: 'codex_request',
          family: 'interaction',
          episodeKey: 'interaction:card-a:1',
          fingerprint: 'request-1',
        },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(notificationMocks.invoke).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().notifications).toHaveLength(3);
    expect(notificationMocks.invoke).toHaveBeenCalledWith(
      'notification_send_os',
      expect.objectContaining({
        title: 'Codex',
        cardId: 'card-a',
      }),
    );
  });

  it('cancels a pending interaction toast when the bridge unmounts', async () => {
    const view = render(<NotificationBridge />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId: 'card-a',
        kind: 'waiting',
        title: 'PTY',
        body: 'prompt',
        routing: {
          origin: 'pty',
          family: 'interaction',
          episodeKey: 'interaction:card-a:1',
          fingerprint: 'prompt',
        },
      });
    });
    view.unmount();
    act(() => {
      vi.runAllTimers();
    });

    expect(notificationMocks.invoke).not.toHaveBeenCalled();
  });
});
