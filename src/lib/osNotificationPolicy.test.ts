import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEntry, NotificationRouting } from '../types/terminal';
import {
  OS_NOTIFICATION_COALESCE_MS,
  OsNotificationCoordinator,
  buildInteractionEpisodeKey,
  shouldDispatchOsNotification,
  type OsNotificationEnvironment,
} from './osNotificationPolicy';

function notification(
  id: string,
  overrides: Partial<NotificationEntry> = {},
): NotificationEntry {
  return {
    id,
    cardId: 'card-a',
    at: 1,
    kind: 'waiting',
    title: 'Needs input',
    body: 'Continue?',
    read: false,
    ...overrides,
  };
}

function interactionRouting(
  origin: NotificationRouting['origin'],
  episodeKey: string,
  fingerprint: string,
): NotificationRouting {
  return {
    origin,
    family: 'interaction',
    episodeKey,
    fingerprint,
  };
}

describe('shouldDispatchOsNotification', () => {
  const background: OsNotificationEnvironment = {
    enabled: true,
    foreground: false,
    focusedCardId: null,
  };

  it('keeps completion toasts background-only', () => {
    const completed = notification('completed', { kind: 'completed' });

    expect(shouldDispatchOsNotification(completed, background)).toBe(true);
    expect(
      shouldDispatchOsNotification(completed, {
        ...background,
        foreground: true,
      }),
    ).toBe(false);
  });

  it('suppresses a foreground signal for the card already in focus', () => {
    const waiting = notification('waiting');

    expect(
      shouldDispatchOsNotification(waiting, {
        ...background,
        foreground: true,
        focusedCardId: 'card-a',
      }),
    ).toBe(false);
    expect(
      shouldDispatchOsNotification(waiting, {
        ...background,
        foreground: true,
        focusedCardId: 'card-b',
      }),
    ).toBe(true);
  });

  it('keeps worktree success in-app only and failure background-only', () => {
    const success = notification('success', {
      cardId: 'system:worktrees',
      kind: 'completed',
    });
    const failure = notification('failure', {
      cardId: 'system:worktrees',
      kind: 'failed',
    });

    expect(shouldDispatchOsNotification(success, background)).toBe(false);
    expect(shouldDispatchOsNotification(failure, background)).toBe(true);
    expect(
      shouldDispatchOsNotification(failure, {
        ...background,
        foreground: true,
      }),
    ).toBe(false);
  });

  it('honours the OS notification preference before every other rule', () => {
    expect(
      shouldDispatchOsNotification(notification('disabled'), {
        ...background,
        enabled: false,
      }),
    ).toBe(false);
  });
});

describe('OsNotificationCoordinator', () => {
  let environment: OsNotificationEnvironment;
  let dispatched: NotificationEntry[];
  let coordinator: OsNotificationCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    environment = {
      enabled: true,
      foreground: false,
      focusedCardId: null,
    };
    dispatched = [];
    coordinator = new OsNotificationCoordinator({
      getEnvironment: () => environment,
      dispatch: (entry) => {
        dispatched.push(entry);
      },
    });
  });

  afterEach(() => {
    coordinator.dispose();
    vi.useRealTimers();
  });

  it('coalesces one interaction to Codex over Supervisor over PTY', () => {
    const episodeKey = buildInteractionEpisodeKey('card-a', 2);
    coordinator.accept(
      notification('pty', {
        routing: interactionRouting('pty', episodeKey, 'prompt'),
      }),
    );
    coordinator.accept(
      notification('supervisor', {
        routing: interactionRouting('supervisor', episodeKey, 'rule:prompt'),
      }),
    );
    coordinator.accept(
      notification('codex', {
        routing: interactionRouting('codex_request', episodeKey, 'request-1'),
      }),
    );

    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(OS_NOTIFICATION_COALESCE_MS);
    expect(dispatched.map((entry) => entry.id)).toEqual(['codex']);
  });

  it('preserves distinct structured Codex requests in one generation', () => {
    const episodeKey = buildInteractionEpisodeKey('card-a', 2);
    coordinator.accept(
      notification('codex-1', {
        routing: interactionRouting('codex_request', episodeKey, 'request-1'),
      }),
    );
    coordinator.accept(
      notification('codex-2', {
        routing: interactionRouting('codex_request', episodeKey, 'request-2'),
      }),
    );

    vi.runAllTimers();
    expect(dispatched.map((entry) => entry.id)).toEqual(['codex-1', 'codex-2']);
  });

  it('dedupes an exact prompt but rearms on fingerprint or generation change', () => {
    const episode0 = buildInteractionEpisodeKey('card-a', 0);
    const episode1 = buildInteractionEpisodeKey('card-a', 1);
    coordinator.accept(
      notification('prompt-a-1', {
        routing: interactionRouting('pty', episode0, 'prompt-a'),
      }),
    );
    vi.runAllTimers();
    coordinator.accept(
      notification('prompt-a-redraw', {
        routing: interactionRouting('pty', episode0, 'prompt-a'),
      }),
    );
    coordinator.accept(
      notification('prompt-b', {
        routing: interactionRouting('pty', episode0, 'prompt-b'),
      }),
    );
    vi.runAllTimers();
    coordinator.accept(
      notification('prompt-a-next-submit', {
        routing: interactionRouting('pty', episode1, 'prompt-a'),
      }),
    );
    vi.runAllTimers();

    expect(dispatched.map((entry) => entry.id)).toEqual([
      'prompt-a-1',
      'prompt-b',
      'prompt-a-next-submit',
    ]);
  });

  it('rechecks focus at delayed flush time', () => {
    const episodeKey = buildInteractionEpisodeKey('card-a', 3);
    coordinator.accept(
      notification('pending', {
        routing: interactionRouting('pty', episodeKey, 'prompt'),
      }),
    );
    environment = {
      ...environment,
      foreground: true,
      focusedCardId: 'card-a',
    };

    vi.runAllTimers();
    expect(dispatched).toEqual([]);
  });

  it('cancels pending timers on dispose', () => {
    coordinator.accept(
      notification('pending', {
        routing: interactionRouting(
          'pty',
          buildInteractionEpisodeKey('card-a', 4),
          'prompt',
        ),
      }),
    );

    coordinator.dispose();
    vi.runAllTimers();
    expect(dispatched).toEqual([]);
  });
});
