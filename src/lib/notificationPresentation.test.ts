import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEntry } from '../types/terminal';
import {
  createNotificationPresentationController,
  NOTIFICATION_PRESENTATION_ACTIVE_MS,
  NOTIFICATION_DELIVERY_DECISION_TIMEOUT_MS,
  type NotificationPresentationController,
} from './notificationPresentation';

function notification(
  id: string,
  at: number,
  overrides: Partial<NotificationEntry> = {},
): NotificationEntry {
  return {
    id,
    cardId: 'card-1',
    at,
    kind: 'completed',
    title: `Title ${id}`,
    body: `Body ${id}`,
    read: false,
    ...overrides,
  };
}

function ids(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id);
}

describe('notification presentation coordinator', () => {
  let controller: NotificationPresentationController | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    controller?.dispose();
    controller = null;
    vi.useRealTimers();
  });

  it('seeds hydrated IDs without replaying them, then presents a new foreground event', () => {
    const historical = notification('historical', 100);
    controller = createNotificationPresentationController({
      initialNotifications: [historical],
    });

    expect(controller.getSnapshot().visible).toHaveLength(0);
    expect(controller.getSnapshot().queued).toHaveLength(0);
    expect(controller.getSnapshot().background).toHaveLength(0);

    const fresh = notification('fresh', 200);
    controller.ingestSnapshot([fresh, historical]);

    expect(ids(controller.getSnapshot().visible)).toEqual(['fresh']);
    expect(controller.getSnapshot().visible[0]?.entry).toEqual(fresh);
  });

  it('holds three background events and catches them up exactly once on focus restore', () => {
    controller = createNotificationPresentationController({ windowFocused: false });
    controller.ingestSnapshot([
      notification('newest', 300),
      notification('middle', 200),
      notification('oldest', 100),
    ]);

    expect(ids(controller.getSnapshot().visible)).toEqual([]);
    expect(ids(controller.getSnapshot().background)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
    expect(controller.getSnapshot().paused).toBe(true);

    controller.setWindowFocused(true);
    expect(ids(controller.getSnapshot().visible)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
    expect(controller.getSnapshot().background).toHaveLength(0);

    controller.setWindowFocused(false);
    controller.setWindowFocused(true);
    expect(ids(controller.getSnapshot().visible)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('keeps an accepted background native delivery for one catch-up even if focus returns first', () => {
    controller = createNotificationPresentationController({
      windowFocused: false,
      awaitDelivery: true,
    });
    controller.ingestSnapshot([notification('native-background', 100)]);
    controller.setWindowFocused(true);
    controller.resolveDelivery('native-background', true);
    expect(ids(controller.getSnapshot().visible)).toEqual(['native-background']);
    controller.setWindowFocused(false);
    controller.setWindowFocused(true);
    expect(ids(controller.getSnapshot().visible)).toEqual(['native-background']);
  });

  it('shows an immediate fallback when native delivery is degraded', () => {
    controller = createNotificationPresentationController({ awaitDelivery: true });
    controller.ingestSnapshot([notification('degraded', 100)]);
    controller.resolveDelivery('degraded', false);
    expect(ids(controller.getSnapshot().visible)).toEqual(['degraded']);
  });

  it('falls back when a Windows delivery receipt never arrives and clears the timer', () => {
    controller = createNotificationPresentationController({ awaitDelivery: true });
    controller.ingestSnapshot([notification('missing-receipt', 100)]);
    expect(controller.getSnapshot().visible).toEqual([]);
    vi.advanceTimersByTime(NOTIFICATION_DELIVERY_DECISION_TIMEOUT_MS);
    expect(ids(controller.getSnapshot().visible)).toEqual(['missing-receipt']);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes a foreground fallback when a native accepted receipt arrives after the timeout', () => {
    controller = createNotificationPresentationController({ awaitDelivery: true });
    controller.ingestSnapshot([notification('late-native', 100)]);

    vi.advanceTimersByTime(NOTIFICATION_DELIVERY_DECISION_TIMEOUT_MS);
    expect(ids(controller.getSnapshot().visible)).toEqual(['late-native']);

    controller.resolveDelivery('late-native', true);
    expect(controller.getSnapshot().visible).toEqual([]);
    expect(controller.getSnapshot().queued).toEqual([]);
  });

  it('converts newest-first bursts into an oldest-first four-slot FIFO', () => {
    controller = createNotificationPresentationController();
    const entries = Array.from({ length: 10 }, (_, index) =>
      notification(`event-${index + 1}`, (index + 1) * 100),
    );

    controller.ingestSnapshot([...entries].reverse());

    expect(ids(controller.getSnapshot().visible)).toEqual([
      'event-1',
      'event-2',
      'event-3',
      'event-4',
    ]);
    expect(ids(controller.getSnapshot().queued)).toEqual([
      'event-5',
      'event-6',
      'event-7',
      'event-8',
      'event-9',
      'event-10',
    ]);

    vi.advanceTimersByTime(NOTIFICATION_PRESENTATION_ACTIVE_MS);
    expect(ids(controller.getSnapshot().visible)).toEqual([
      'event-5',
      'event-6',
      'event-7',
      'event-8',
    ]);
    expect(ids(controller.getSnapshot().queued)).toEqual(['event-9', 'event-10']);

    vi.advanceTimersByTime(NOTIFICATION_PRESENTATION_ACTIVE_MS);
    expect(ids(controller.getSnapshot().visible)).toEqual(['event-9', 'event-10']);
    expect(controller.getSnapshot().queued).toHaveLength(0);
  });

  it('reverses equal-timestamp newest-first batches before assigning FIFO admission order', () => {
    controller = createNotificationPresentationController();
    const entries = Array.from({ length: 6 }, (_, index) =>
      notification(`same-time-${index + 1}`, 500),
    );

    controller.ingestSnapshot([...entries].reverse());

    expect(ids(controller.getSnapshot().visible)).toEqual([
      'same-time-1',
      'same-time-2',
      'same-time-3',
      'same-time-4',
    ]);
    expect(ids(controller.getSnapshot().queued)).toEqual(['same-time-5', 'same-time-6']);

    vi.advanceTimersByTime(NOTIFICATION_PRESENTATION_ACTIVE_MS);
    expect(ids(controller.getSnapshot().visible)).toEqual(['same-time-5', 'same-time-6']);
  });

  it('auto-collapses after ten seconds of active time without acknowledging the entry', () => {
    controller = createNotificationPresentationController();
    const entry = notification('timed', 100);
    controller.ingestSnapshot([entry]);

    vi.advanceTimersByTime(NOTIFICATION_PRESENTATION_ACTIVE_MS - 1);
    expect(ids(controller.getSnapshot().visible)).toEqual(['timed']);
    vi.advanceTimersByTime(1);

    expect(controller.getSnapshot().visible).toHaveLength(0);
    expect(entry.read).toBe(false);
  });

  it('pauses and resumes the active timer for window focus and global blocking state', () => {
    controller = createNotificationPresentationController();
    controller.ingestSnapshot([notification('paused', 100)]);

    vi.advanceTimersByTime(4_000);
    controller.setWindowFocused(false);
    vi.advanceTimersByTime(20_000);
    expect(ids(controller.getSnapshot().visible)).toEqual(['paused']);

    controller.setWindowFocused(true);
    vi.advanceTimersByTime(5_999);
    expect(ids(controller.getSnapshot().visible)).toEqual(['paused']);
    vi.advanceTimersByTime(1);
    expect(controller.getSnapshot().visible).toHaveLength(0);

    controller.ingestSnapshot([notification('blocked', 200)]);
    vi.advanceTimersByTime(3_000);
    controller.setGlobalPresentationState({ paused: true, hidden: true });
    vi.advanceTimersByTime(20_000);
    expect(ids(controller.getSnapshot().visible)).toEqual(['blocked']);
    expect(controller.getSnapshot()).toMatchObject({ paused: true, hidden: true });

    controller.setGlobalPresentationState({ paused: false, hidden: false });
    vi.advanceTimersByTime(6_999);
    expect(ids(controller.getSnapshot().visible)).toEqual(['blocked']);
    vi.advanceTimersByTime(1);
    expect(controller.getSnapshot().visible).toHaveLength(0);
  });

  it('treats hidden as an independent timer pause and resumes with remaining active time', () => {
    controller = createNotificationPresentationController();
    controller.ingestSnapshot([notification('hidden', 100)]);

    vi.advanceTimersByTime(3_000);
    controller.setGlobalHidden(true);
    expect(controller.getSnapshot()).toMatchObject({ paused: true, hidden: true });
    vi.advanceTimersByTime(20_000);
    expect(ids(controller.getSnapshot().visible)).toEqual(['hidden']);

    controller.setGlobalHidden(false);
    expect(controller.getSnapshot()).toMatchObject({ paused: false, hidden: false });
    vi.advanceTimersByTime(6_999);
    expect(ids(controller.getSnapshot().visible)).toEqual(['hidden']);
    vi.advanceTimersByTime(1);
    expect(controller.getSnapshot().visible).toHaveLength(0);
  });

  it('pauses an individual item while hovered or keyboard-focused', () => {
    controller = createNotificationPresentationController();
    controller.ingestSnapshot([notification('interactive', 100)]);

    vi.advanceTimersByTime(2_000);
    controller.setItemHover('interactive', true);
    vi.advanceTimersByTime(20_000);
    expect(ids(controller.getSnapshot().visible)).toEqual(['interactive']);

    controller.setItemHover('interactive', false);
    vi.advanceTimersByTime(2_000);
    controller.setItemKeyboardFocus('interactive', true);
    vi.advanceTimersByTime(20_000);
    expect(ids(controller.getSnapshot().visible)).toEqual(['interactive']);

    controller.setItemKeyboardFocus('interactive', false);
    vi.advanceTimersByTime(5_999);
    expect(ids(controller.getSnapshot().visible)).toEqual(['interactive']);
    vi.advanceTimersByTime(1);
    expect(controller.getSnapshot().visible).toHaveLength(0);
  });

  it('updates content in place, supports diffs, and never requeues a duplicate ID', () => {
    controller = createNotificationPresentationController();
    const first = notification('same-id', 100);
    controller.ingestSnapshot([first]);

    const updated = notification('same-id', 100, { body: '\u001b[31mupdated\u001b[0m' });
    controller.ingestSnapshot([updated]);
    expect(ids(controller.getSnapshot().visible)).toEqual(['same-id']);
    expect(controller.getSnapshot().visible[0]?.summary).toBe('updated');

    controller.ingestDiff({
      added: [notification('diff-id', 200)],
      updated: [notification('same-id', 100, { body: 'latest' })],
    });
    expect(ids(controller.getSnapshot().visible)).toEqual(['same-id', 'diff-id']);
    expect(controller.getSnapshot().visible[0]?.summary).toBe('latest');

    controller.ingestDiff({ removedIds: ['same-id'] });
    expect(ids(controller.getSnapshot().visible)).toEqual(['diff-id']);
    controller.ingestDiff({ added: [updated] });
    expect(ids(controller.getSnapshot().visible)).toEqual(['diff-id']);
  });

  it('closes presentation without ack and removes externally acknowledged or deleted items immediately', () => {
    controller = createNotificationPresentationController();
    const first = notification('first', 100);
    const second = notification('second', 200);
    controller.ingestSnapshot([second, first]);

    controller.close('first');
    expect(ids(controller.getSnapshot().visible)).toEqual(['second']);
    expect(first.read).toBe(false);

    controller.ingestSnapshot([first, second]);
    expect(ids(controller.getSnapshot().visible)).toEqual(['second']);

    controller.acknowledge('second');
    expect(controller.getSnapshot().visible).toHaveLength(0);
    controller.ingestSnapshot([first, { ...second, read: true }]);
    expect(controller.getSnapshot().visible).toHaveLength(0);

    controller.ingestSnapshot([first]);
    expect(controller.getSnapshot().visible).toHaveLength(0);
    controller.clear();
    expect(controller.getSnapshot()).toMatchObject({ visible: [], queued: [], background: [] });
  });

  it('keeps snapshots immutable and notifies subscribers for committed changes', () => {
    controller = createNotificationPresentationController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.ingestSnapshot([notification('subscribed', 100)]);

    const snapshot = controller.getSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.visible)).toBe(true);
    expect(Object.isFrozen(snapshot.visible[0])).toBe(true);
    expect(controller.getServerSnapshot()).toBe(snapshot);

    unsubscribe();
    controller.ingestDiff({ updated: [notification('subscribed', 100, { body: 'new' })] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('disposes timers, listeners, and runtime state without touching ledger entries', () => {
    controller = createNotificationPresentationController();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.ingestSnapshot([notification('dispose-me', 100)]);
    expect(vi.getTimerCount()).toBe(1);

    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(NOTIFICATION_PRESENTATION_ACTIVE_MS * 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().visible).toHaveLength(0);
    controller.ingestSnapshot([notification('after-dispose', 200)]);
    expect(controller.getSnapshot().visible).toHaveLength(0);
  });
});
