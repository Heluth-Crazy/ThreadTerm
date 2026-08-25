import { describe, expect, it, vi } from 'vitest';
import type {
  CompletionSignal,
  NotificationEntry,
  NotificationRouting,
} from '../types/terminal';
import { NOTIFICATION_READ_RETENTION_MS } from '../types/terminal';
import {
  CompletionCoordinator,
  retainNotificationHistory,
  sanitizeNotificationSummary,
} from './notificationLedger';

function notification(overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id: 'notification-1',
    cardId: 'card-1',
    at: 10_000,
    kind: 'completed',
    title: 'Task complete',
    body: 'The task completed.',
    read: false,
    ...overrides,
  };
}

function signal(overrides: Partial<CompletionSignal> = {}): CompletionSignal {
  return {
    cardId: 'card-1',
    episodeKey: 'card-1:episode-1',
    fingerprint: 'signal-1',
    source: 'agent_cli_prompt',
    confidence: 'compatible',
    outcome: 'completed',
    at: 10_000,
    summary: 'Prompt returned',
    ...overrides,
  };
}

function buildEntry(routing: NotificationRouting): NotificationEntry {
  return notification({
    kind: routing.signalSource === 'codex_chat' ? 'completed' : 'attention',
    title: routing.signalSource ?? 'completion',
    body: routing.fingerprint ?? '',
    routing,
  });
}

describe('notification ledger semantics', () => {
  it('sanitizes ANSI/control output and caps summaries at 160 characters', () => {
    const summary = sanitizeNotificationSummary(
      `\u001b[31mDone\u001b[0m\n\n${'x'.repeat(200)}\u0007`,
    );

    expect(summary).toBe(`Done ${'x'.repeat(155)}`);
    expect(summary).toHaveLength(160);
  });

  it('retains every unread entry while bounding only recent read history', () => {
    const now = 100_000;
    const unread = Array.from({ length: 125 }, (_, index) =>
      notification({ id: `unread-${index}`, at: index, read: false }),
    );
    const read = Array.from({ length: 125 }, (_, index) =>
      notification({
        id: `read-${index}`,
        at: now - index * 10,
        read: true,
      }),
    );
    const oldRead = notification({
      id: 'old-read',
      at: now - NOTIFICATION_READ_RETENTION_MS - 1,
      read: true,
    });

    const retained = retainNotificationHistory([...unread, oldRead, ...read], now);

    expect(retained.filter((entry) => !entry.read)).toHaveLength(unread.length);
    expect(retained.filter((entry) => entry.read)).toHaveLength(100);
    expect(retained.some((entry) => entry.id === 'old-read')).toBe(false);
    expect(retained.some((entry) => entry.id === 'read-99')).toBe(true);
    expect(retained.some((entry) => entry.id === 'read-100')).toBe(false);
  });

  it('removes expired/excess reads without reordering the global ledger', () => {
    const now = 100_000;
    const notifications = [
      notification({ id: 'new-unread', at: now, read: false }),
      notification({ id: 'new-read', at: now - 1, read: true }),
      notification({ id: 'middle-unread', at: now - 2, read: false }),
      notification({ id: 'middle-read', at: now - 3, read: true }),
      notification({
        id: 'expired-read',
        at: now - NOTIFICATION_READ_RETENTION_MS - 1,
        read: true,
      }),
    ];

    expect(retainNotificationHistory(notifications, now).map((entry) => entry.id)).toEqual([
      'new-unread',
      'new-read',
      'middle-unread',
      'middle-read',
    ]);
  });

  it('inserts, upgrades once by precedence, and ignores duplicate evidence', () => {
    const coordinator = new CompletionCoordinator();
    const inserted = coordinator.ingest(signal(), [], buildEntry);

    expect(inserted.kind).toBe('inserted');
    if (inserted.kind !== 'inserted') return;
    expect(inserted.entry.routing?.signalSource).toBe('agent_cli_prompt');

    const build = vi.fn(buildEntry);
    const upgraded = coordinator.ingest(
      signal({
        source: 'codex_chat',
        confidence: 'authoritative',
        fingerprint: 'turn-1',
      }),
      [inserted.entry],
      build,
    );

    expect(upgraded.kind).toBe('upgraded');
    expect(build).toHaveBeenCalledTimes(1);
    if (upgraded.kind !== 'upgraded') return;
    expect(upgraded.entry.id).toBe(inserted.entry.id);
    expect(upgraded.entry.routing?.signalSource).toBe('codex_chat');
    expect(upgraded.entry.kind).toBe('completed');

    const duplicate = coordinator.ingest(
      signal({ source: 'agent_cli_idle', fingerprint: 'idle-1' }),
      [upgraded.entry],
      buildEntry,
    );
    expect(duplicate.kind).toBe('ignored');
    if (duplicate.kind === 'ignored') {
      expect(duplicate.entry?.id).toBe(inserted.entry.id);
    }
  });

  it('does not reopen acknowledged episodes and keeps later episodes independent', () => {
    const coordinator = new CompletionCoordinator();
    const acknowledged = notification({
      read: true,
      routing: {
        origin: 'reply',
        family: 'completion',
        episodeKey: 'card-1:episode-1',
        fingerprint: 'prompt-1',
        signalSource: 'agent_cli_prompt',
        confidence: 'compatible',
      },
    });

    const late = coordinator.ingest(
      signal({ source: 'codex_chat', confidence: 'authoritative' }),
      [acknowledged],
      buildEntry,
    );
    expect(late.kind).toBe('ignored');

    const nextEpisode = coordinator.ingest(
      signal({ episodeKey: 'card-1:episode-2', fingerprint: 'prompt-2' }),
      [acknowledged],
      buildEntry,
    );
    expect(nextEpisode.kind).toBe('inserted');
  });
});
