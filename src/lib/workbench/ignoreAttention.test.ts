import { describe, expect, it } from 'vitest';
import type { NotificationEntry } from '../../types/terminal';
import type { AttentionItem } from './types';
import {
  ignoredAttentionEpisodeFromItem,
  isAttentionItemIgnored,
  MAX_IGNORED_ATTENTION_EPISODES,
  normalizeIgnoredAttention,
  notificationIdsAcknowledgedByIgnore,
  retainIgnoredAttention,
} from './ignoreAttention';

const item: AttentionItem = {
  id: 'notification:note-2',
  cardId: 'card-1',
  kind: 'review',
  severity: 'info',
  sourceKind: 'notification',
  sourceId: 'note-2',
  occurredAt: 1_000,
  projectPath: '/repo',
  projectName: 'Repo',
  terminalType: 'shell',
  title: 'Done',
  reasonCode: 'completed_unread',
  capability: {
    openRequest: false,
    openTerminal: true,
    openNotification: true,
    openEvidence: false,
  },
};

function notification(
  id: string,
  patch: Partial<NotificationEntry> = {},
): NotificationEntry {
  return {
    id,
    cardId: 'card-1',
    kind: 'completed',
    at: 1_000,
    title: id,
    body: id,
    read: false,
    ...patch,
  };
}

describe('ignoreAttention', () => {
  it.each(['waiting_input', 'failed', 'review'] as const)(
    'hides the current %s episode including its terminal-state fallback',
    (kind) => {
      const episode = { ...item, kind };
      const ignored = [ignoredAttentionEpisodeFromItem(episode, 1_500)];
      const fallback: AttentionItem = {
        ...episode,
        id: 'terminal_state:card-1',
        sourceKind: 'terminal_state',
        sourceId: 'card-1',
        occurredAt: 1_200,
        capability: {
          ...item.capability,
          openNotification: false,
        },
      };

      expect(isAttentionItemIgnored(episode, ignored)).toBe(true);
      expect(isAttentionItemIgnored(fallback, ignored)).toBe(true);
      expect(
        isAttentionItemIgnored({ ...episode, occurredAt: 1_501 }, ignored),
      ).toBe(false);
    },
  );

  it('keeps a later structured request independent from an ignored one', () => {
    const approval: AttentionItem = {
      ...item,
      id: 'structured_request:req-1',
      kind: 'approval',
      sourceKind: 'structured_request',
      sourceId: 'req-1',
      reasonCode: 'structured_approval',
      capability: {
        ...item.capability,
        openRequest: true,
      },
    };
    const ignored = [ignoredAttentionEpisodeFromItem(approval, 2_000)];
    expect(isAttentionItemIgnored(approval, ignored)).toBe(true);
    expect(
      isAttentionItemIgnored({ ...approval, sourceId: 'req-2', id: 'structured_request:req-2' }, ignored),
    ).toBe(false);
  });

  it('normalizes, caps, and drops entries for cards that no longer exist', () => {
    expect(normalizeIgnoredAttention([{ cardId: '', kind: 'review' }, 42])).toEqual(
      [],
    );

    const entries = Array.from(
      { length: MAX_IGNORED_ATTENTION_EPISODES + 5 },
      (_, index) =>
        ignoredAttentionEpisodeFromItem(
          { ...item, cardId: `card-${index}`, sourceId: `note-${index}` },
          index,
        ),
    );
    expect(retainIgnoredAttention(entries)).toHaveLength(
      MAX_IGNORED_ATTENTION_EPISODES,
    );
    expect(
      retainIgnoredAttention(
        [
          ignoredAttentionEpisodeFromItem(item, 1),
          ignoredAttentionEpisodeFromItem({ ...item, cardId: 'card-gone' }, 2),
        ],
        ['card-1'],
      ),
    ).toEqual([expect.objectContaining({ cardId: 'card-1' })]);
  });

  it('acknowledges unread completion notifications for the ignored card only', () => {
    expect(
      notificationIdsAcknowledgedByIgnore(item, [
        notification('note-1'),
        notification('note-2'),
        notification('other-card', { cardId: 'card-2' }),
        notification('already-read', { read: true }),
        notification('failed-note', { kind: 'failed' }),
      ]),
    ).toEqual(['note-2', 'note-1']);
  });

  it('does not acknowledge notifications when ignoring a stalled watch item', () => {
    const stalled: AttentionItem = {
      ...item,
      id: 'terminal_state:card-1',
      kind: 'stalled',
      sourceKind: 'terminal_state',
      sourceId: 'card-1',
      reasonCode: 'stalled_running',
      capability: {
        ...item.capability,
        openNotification: false,
      },
    };
    expect(
      notificationIdsAcknowledgedByIgnore(stalled, [notification('note-2')]),
    ).toEqual([]);
  });
});
