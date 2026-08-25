import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  notificationFeedbackBus,
  resetNotificationActivationRelayForTests,
} from '../../lib/notificationDelivery';
import { NotificationBridge } from './NotificationBridge';

const bridgeMocks = vi.hoisted(() => {
  type ActivationHandler = (event: {
    payload?: { notificationId?: string; cardId?: string };
  }) => void;
  const mocks = {
    invoke: vi.fn(),
    listen: vi.fn(),
    unlisten: vi.fn(),
    activationHandler: null as ActivationHandler | null,
    isPermissionGranted: vi.fn(() => Promise.resolve(true)),
    requestPermission: vi.fn(() => Promise.resolve<'granted'>('granted')),
  };
  mocks.listen.mockImplementation(
    (_event: string, handler: ActivationHandler) => {
      mocks.activationHandler = handler;
      return Promise.resolve(mocks.unlisten);
    },
  );
  return mocks;
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: bridgeMocks.listen,
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: bridgeMocks.isPermissionGranted,
  requestPermission: bridgeMocks.requestPermission,
}));

vi.mock('../../lib/tauri-bridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/tauri-bridge')>();
  return {
    ...original,
    isTauriEnv: () => true,
    invoke: bridgeMocks.invoke,
  };
});

function notificationInvokes(): Array<[string, Record<string, unknown> | undefined]> {
  return bridgeMocks.invoke.mock.calls.filter(
    ([command]) => command === 'notification_send_os',
  ) as Array<[string, Record<string, unknown> | undefined]>;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('NotificationBridge OS coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    bridgeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'notification_drain_pending_activations') return [];
      return {
        notificationId: null,
        channel: 'plugin',
        status: 'accepted',
      };
    });
    bridgeMocks.activationHandler = null;
    resetNotificationActivationRelayForTests();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    notificationFeedbackBus.clear();
    useTerminalStore.setState({
      cards: [],
      archivedCards: [],
      notifications: [],
      osNotificationsEnabled: true,
      osNotificationPreviewEnabled: true,
      focusedCardId: null,
      notificationCentreOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
    notificationFeedbackBus.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initializes listener and drain before subscribing OS dispatch', async () => {
    render(<NotificationBridge />);
    await flushEffects();

    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId: 'card-a',
        kind: 'completed',
        title: 'done',
        body: 'summary',
      });
    });
    await flushEffects();

    const listenOrder = bridgeMocks.listen.mock.invocationCallOrder[0];
    const sendOrder = bridgeMocks.invoke.mock.invocationCallOrder.find(
      (_, index) => bridgeMocks.invoke.mock.calls[index]?.[0] === 'notification_send_os',
    );
    expect(listenOrder).toBeDefined();
    expect(sendOrder).toBeDefined();
    expect(listenOrder).toBeLessThan(sendOrder!);
    expect(notificationInvokes()).toHaveLength(1);
  });

  it('keeps all in-app evidence but sends only the highest-priority interaction toast', async () => {
    render(<NotificationBridge />);
    await flushEffects();

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

    expect(notificationInvokes()).toHaveLength(1);
    expect(useTerminalStore.getState().notifications).toHaveLength(3);
    expect(notificationInvokes()[0][1]).toEqual(
      expect.objectContaining({ title: 'Codex', cardId: 'card-a' }),
    );
  });

  it('keeps same-card native deliveries independently addressable', async () => {
    render(<NotificationBridge />);
    await flushEffects();

    act(() => {
      const push = useTerminalStore.getState().pushNotification;
      push({ cardId: 'card-a', kind: 'completed', title: 'first', body: '' });
      push({ cardId: 'card-a', kind: 'failed', title: 'second', body: '' });
    });
    await flushEffects();

    const ids = notificationInvokes()
      .map(([, args]) => args?.notificationId)
      .filter((id): id is string => typeof id === 'string');
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('omits task output when the system preview preference is disabled', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    useTerminalStore.setState({ osNotificationPreviewEnabled: false });
    render(<NotificationBridge />);
    await flushEffects();

    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId,
        kind: 'completed',
        title: 'done',
        body: '\u001b[31msecret output\u001b[0m',
      });
    });
    await flushEffects();

    const body = notificationInvokes()[0][1]?.body;
    expect(body).toContain('ThreadTerm');
    expect(body).not.toContain('secret output');
  });

  it('trusts only event IDs and reports an unknown activation without acknowledging', async () => {
    render(<NotificationBridge />);
    await flushEffects();

    act(() => {
      bridgeMocks.activationHandler?.({ payload: { cardId: 'card-a' } });
    });
    await flushEffects();

    expect(useTerminalStore.getState().notificationCentreOpen).toBe(false);
    expect(notificationFeedbackBus.getSnapshot()).toBeNull();

    act(() => {
      bridgeMocks.activationHandler?.({ payload: { notificationId: 'missing-event' } });
    });
    await flushEffects();

    expect(useTerminalStore.getState().notificationCentreOpen).toBe(true);
    expect(notificationFeedbackBus.getSnapshot()).toEqual(
      expect.objectContaining({
        kind: 'stale',
        feedbackKey: 'notifications.targetNavigationFailed',
      }),
    );
  });

  it('coalesces the same ID delivered by event and pending drain', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const entry = useTerminalStore.getState().pushNotification({
      cardId,
      kind: 'completed',
      title: 'done',
      body: '',
    });
    bridgeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'notification_drain_pending_activations') return [entry.id];
      if (command === 'window_focus_main') return undefined;
      return { notificationId: entry.id, channel: 'windows-native', status: 'accepted' };
    });

    render(<NotificationBridge />);
    await flushEffects();
    act(() => {
      bridgeMocks.activationHandler?.({ payload: { notificationId: entry.id } });
    });
    await flushEffects();

    expect(
      bridgeMocks.invoke.mock.calls.filter(([command]) => command === 'window_focus_main'),
    ).toHaveLength(1);
    expect(useTerminalStore.getState().notifications.find((n) => n.id === entry.id)?.read).toBe(true);
  });

  it('keeps a deferred drain alive across StrictMode effect replay', async () => {
    const cardId = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const entry = useTerminalStore.getState().pushNotification({
      cardId,
      kind: 'completed',
      title: 'strict-mode done',
      body: '',
    });
    const drainControl: { resolve?: (ids: string[]) => void } = {};
    bridgeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'notification_drain_pending_activations') {
        return new Promise<string[]>((resolve) => {
          drainControl.resolve = resolve;
        });
      }
      if (command === 'window_focus_main') return undefined;
      return { notificationId: entry.id, channel: 'windows-native', status: 'accepted' };
    });

    render(
      <StrictMode>
        <NotificationBridge />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    drainControl.resolve?.([entry.id]);
    await flushEffects();

    expect(
      bridgeMocks.invoke.mock.calls.filter(([command]) => command === 'window_focus_main'),
    ).toHaveLength(1);
    expect(useTerminalStore.getState().notifications.find((n) => n.id === entry.id)?.read).toBe(true);
  });

  it('fails closed when activation listener setup fails', async () => {
    bridgeMocks.listen.mockRejectedValueOnce(new Error('listener unavailable'));
    render(<NotificationBridge />);
    await flushEffects();

    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId: 'card-a',
        kind: 'completed',
        title: 'not dispatchable',
        body: 'must remain in-app',
      });
    });
    await flushEffects();

    expect(notificationInvokes()).toHaveLength(0);
  });

  it('does not dispatch a pending interaction after unmount', async () => {
    const view = render(<NotificationBridge />);
    await flushEffects();
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
    act(() => vi.runAllTimers());
    expect(notificationInvokes()).toHaveLength(0);
  });
});
