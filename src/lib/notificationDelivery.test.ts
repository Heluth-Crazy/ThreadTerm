import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildNotificationBody,
  installNotificationActivationChannel,
  NotificationActivationDedupe,
  notificationFeedbackBus,
  notificationReceiptBus,
  notificationTestActivationRegistry,
  normalizeNotificationReceipt,
  notificationActivationReady,
  resetNotificationActivationRelayForTests,
  sendOsNotification,
  subscribeNotificationActivations,
} from './notificationDelivery';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  listen: vi.fn(),
  unlisten: vi.fn(),
  activationHandler: null as ((event: { payload?: { notificationId?: string } }) => void) | null,
}));

vi.mock('./tauri-bridge', () => ({
  invoke: mocks.invoke,
  isTauriEnv: mocks.isTauriEnv,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

describe('notification delivery adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload?: { notificationId?: string } }) => void) => {
        mocks.activationHandler = handler;
        return Promise.resolve(mocks.unlisten);
      },
    );
    mocks.invoke.mockResolvedValue({
      notificationId: 'event-1',
      channel: 'windows-native',
      status: 'accepted',
      targetExists: true,
    });
    notificationFeedbackBus.clear();
    notificationReceiptBus.clear();
    resetNotificationActivationRelayForTests();
    notificationTestActivationRegistry.clear();
  });

  afterEach(() => {
    notificationFeedbackBus.clear();
    notificationReceiptBus.clear();
    resetNotificationActivationRelayForTests();
    notificationTestActivationRegistry.clear();
  });

  it('normalizes typed receipts and preserves event identity', () => {
    expect(
      normalizeNotificationReceipt(
        { channel: 'plugin', status: 'degraded', targetExists: false },
        'event-1',
      ),
    ).toEqual({
      notificationId: 'event-1',
      channel: 'plugin',
      status: 'degraded',
      targetExists: false,
    });
  });

  it('builds preview bodies from sanitized bounded summaries', () => {
    const body = buildNotificationBody({
      sourceLabel: 'repo · Codex',
      summary: '\u001b[31m  output\nline  \u001b[0m',
      previewEnabled: true,
    });
    expect(body).toBe('ThreadTerm · repo · Codex\noutput line');
    expect(
      buildNotificationBody({
        sourceLabel: 'repo · Codex',
        summary: 'private task output',
        previewEnabled: false,
      }),
    ).toBe('ThreadTerm · repo · Codex');
  });

  it('returns accepted and degraded/disabled receipts through one adapter', async () => {
    const receiptListener = vi.fn();
    const unsubscribe = notificationReceiptBus.subscribe(receiptListener);
    const accepted = await sendOsNotification({
      notificationId: 'event-1',
      cardId: 'card-1',
      title: 'Done',
      body: 'body',
    });
    expect(accepted).toEqual({
      notificationId: 'event-1',
      channel: 'windows-native',
      status: 'accepted',
      targetExists: true,
    });

    mocks.invoke.mockResolvedValue({
      notificationId: 'event-2',
      channel: 'plugin',
      status: 'degraded',
      targetExists: false,
    });
    expect(
      await sendOsNotification({
        notificationId: 'event-2',
        title: 'Done',
        body: 'body',
      }),
    ).toMatchObject({ notificationId: 'event-2', channel: 'plugin', status: 'degraded' });

    mocks.isTauriEnv.mockReturnValue(false);
    expect(
      await sendOsNotification({ notificationId: null, title: 'Done', body: 'body' }),
    ).toEqual({ notificationId: null, channel: 'browser', status: 'disabled-by-system' });
    expect(receiptListener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('redacts invoke failures to ID/status/channel only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.invoke.mockRejectedValue(new Error('secret task output should not be logged'));
    const receipt = await sendOsNotification({
      notificationId: 'event-1',
      title: 'secret title',
      body: 'secret body',
    });
    expect(receipt).toEqual({ notificationId: 'event-1', channel: 'unknown', status: 'failed' });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret task output');
    warn.mockRestore();
  });

  it('installs listener before draining pending activation IDs', async () => {
    const order: string[] = [];
    mocks.listen.mockImplementation(
      (_event: string, handler: (event: { payload?: { notificationId?: string } }) => void) => {
        order.push('listen');
        mocks.activationHandler = handler;
        return Promise.resolve(() => order.push('unlisten'));
      },
    );
    mocks.invoke.mockImplementation(async (command: string) => {
      order.push(command);
      return ['event-1'];
    });
    const received: string[] = [];
    const cleanup = await installNotificationActivationChannel({
      onNotificationId: (id) => {
        received.push(id);
      },
    });
    expect(order.slice(0, 2)).toEqual(['listen', 'notification_drain_pending_activations']);
    expect(received).toEqual(['event-1']);
    cleanup();
    // The process-scoped relay intentionally keeps one native listener alive;
    // cleanup releases only this React/consumer lease.
    expect(order).not.toContain('unlisten');
  });

  it('deduplicates event plus drain IDs and allows bounded rearm after clear', () => {
    const dedupe = new NotificationActivationDedupe();
    expect(dedupe.accept('event-1')).toBe(true);
    expect(dedupe.accept('event-1')).toBe(false);
    for (let index = 0; index < 512; index += 1) {
      expect(dedupe.accept(`event-${index + 2}`)).toBe(true);
    }
    expect(dedupe.accept('event-1')).toBe(false);
    dedupe.clear();
    expect(dedupe.accept('event-1')).toBe(true);
  });

  it('keeps a deferred drain alive across an unsubscribe/resubscribe lease', async () => {
    const drainControl: { resolve?: (ids: string[]) => void } = {};
    mocks.invoke.mockImplementation(
      async (command: string) =>
        command === 'notification_drain_pending_activations'
          ? new Promise<string[]>((resolve) => {
              drainControl.resolve = resolve;
            })
          : undefined,
    );
    const first = vi.fn();
    const unsubscribeFirst = subscribeNotificationActivations({ onNotificationId: first });
    const ready = notificationActivationReady();
    await Promise.resolve();
    unsubscribeFirst();
    const second = vi.fn();
    const unsubscribeSecond = subscribeNotificationActivations({ onNotificationId: second });
    drainControl.resolve?.(['strict-event']);
    await ready;
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('strict-event');
    unsubscribeSecond();
  });

  it('publishes runtime-only feedback and consumes ephemeral settings activations', () => {
    const listener = vi.fn();
    const unsubscribe = notificationFeedbackBus.subscribe(listener);
    notificationFeedbackBus.publish({
      notificationId: 'event-1',
      cardId: 'card-1',
      kind: 'stale',
      feedbackKey: 'notifications.targetNavigationFailed',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(notificationFeedbackBus.getSnapshot()?.notificationId).toBe('event-1');
    unsubscribe();

    const clicked = vi.fn();
    const dispose = notificationTestActivationRegistry.register('test-1', 'card-1', clicked);
    expect(notificationTestActivationRegistry.consume('test-1')?.cardId).toBe('card-1');
    expect(notificationTestActivationRegistry.consume('test-1')).toBeUndefined();
    dispose();
  });
});
