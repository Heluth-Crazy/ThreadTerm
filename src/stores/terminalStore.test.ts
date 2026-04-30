import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PINNED_CARDS, useTerminalStore } from './terminalStore';

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    blocks: {},
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
  });
}

beforeEach(resetStore);

describe('terminalStore — card lifecycle', () => {
  it('creates a card with default metadata', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });

    const card = useTerminalStore.getState().getCardById(id);
    expect(card).toBeDefined();
    expect(card?.projectName).toBe('foo');
    expect(card?.status).toBe('idle');
    expect(card?.events).toHaveLength(1);
    expect(card?.events[0]?.kind).toBe('created');
    expect(card?.providerSessionId).toBeUndefined();
    expect(card?.providerSessionState).toBeUndefined();
  });

  it('creates Claude cards with a generated provider session id', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'claude',
    });

    const card = useTerminalStore.getState().getCardById(id);
    expect(card?.providerSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(card?.providerSessionState).toBe('unbound');
  });

  it('creates Codex cards as provider-session unbound', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'codex',
    });

    const card = useTerminalStore.getState().getCardById(id);
    expect(card?.providerSessionId).toBeUndefined();
    expect(card?.providerSessionState).toBe('unbound');
  });

  it('binds provider session metadata without replacing the original bound timestamp', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'codex' });
    s.markProviderSessionBound(id, 'codex-session-1');
    const first = useTerminalStore.getState().getCardById(id);

    s.markProviderSessionBound(id, 'codex-session-1');
    const second = useTerminalStore.getState().getCardById(id);

    expect(second?.providerSessionId).toBe('codex-session-1');
    expect(second?.providerSessionState).toBe('bound');
    expect(second?.providerSessionBoundAt).toBe(first?.providerSessionBoundAt);
    expect(second?.providerSessionLastResumeAt).toBeGreaterThanOrEqual(
      first?.providerSessionLastResumeAt ?? 0,
    );
  });

  it('updates and clears an AI intent label', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'foo', projectPath: '/tmp/foo', terminalType: 'codex' });

    s.updateCardAiIntent(id, 'review');
    expect(useTerminalStore.getState().getCardById(id)?.aiIntent).toBe('review');

    useTerminalStore.getState().updateCardAiIntent(id, null);
    expect(useTerminalStore.getState().getCardById(id)?.aiIntent).toBeUndefined();
  });

  it('updateCardOutput strips ANSI and retains only the tail', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });
    // 3 kB of ascii + colour codes
    const chunk = '\x1b[31mhello\x1b[0m\n'.repeat(200);
    useTerminalStore.getState().updateCardOutput(id, chunk);
    const out = useTerminalStore.getState().getCardById(id)?.lastOutput ?? '';
    expect(out.includes('\x1b')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(2000);
  });

  it('updateCardOutput strips OSC titles, 2-byte ESC and control chars', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });
    // OSC title, charset selection, DECSET, single control chars
    const chunk =
      '\x1b]0;my title\x07' + // OSC set title (terminated by BEL)
      '\x1b(B' +              // ESC ( B — ASCII charset
      '\x1b=' +                // keypad mode
      '\x1b[?25l' +            // DECSET hide cursor
      'hello\x00world\x08!\x7f\n';
    useTerminalStore.getState().updateCardOutput(id, chunk);
    const out = useTerminalStore.getState().getCardById(id)?.lastOutput ?? '';
    expect(out).toBe('helloworld!\n');
  });

  it('recordUserSubmit increments message count and appends a user-input event', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });

    useTerminalStore.getState().recordUserSubmit(id, 'sent input');

    const card = useTerminalStore.getState().getCardById(id);
    const lastEvent = card?.events[card.events.length - 1];
    expect(card?.messageCount).toBe(1);
    expect(lastEvent?.kind).toBe('user-input');
    expect(lastEvent?.summary).toBe('sent input');
  });

  it('removeCard drops related notifications', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });
    s.pushNotification({
      cardId: id,
      kind: 'waiting',
      title: 'needs input',
      body: 'y/n?',
    });
    expect(useTerminalStore.getState().notifications).toHaveLength(1);
    useTerminalStore.getState().removeCard(id);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
  });

  it('removeCard drops related command blocks', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });
    s.recordBlockStarted({
      cardId: id,
      blockId: 'block-1',
      command: 'npm test',
      cwd: '/tmp/foo',
      startedAt: 1_000,
      bufferStart: 4,
    });

    useTerminalStore.getState().removeCard(id);

    expect(useTerminalStore.getState().blocks[id]).toBeUndefined();
  });
});

describe('terminalStore command blocks', () => {
  it('starts and finishes command blocks by card id', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'foo', projectPath: '/tmp/foo', terminalType: 'shell' });

    s.recordBlockStarted({
      cardId: id,
      blockId: 'block-1',
      command: 'npm test',
      cwd: '/tmp/foo',
      startedAt: 1_000,
      bufferStart: 12,
    });

    expect(useTerminalStore.getState().blocks[id]).toEqual([
      {
        id: 'block-1',
        cardId: id,
        command: 'npm test',
        cwd: '/tmp/foo',
        startedAt: 1_000,
        bufferStart: 12,
        state: 'running',
      },
    ]);

    s.recordBlockFinished({
      cardId: id,
      blockId: 'block-1',
      exitCode: 1,
      finishedAt: 1_250,
      durationMs: 250,
      bufferEnd: 18,
    });

    expect(useTerminalStore.getState().blocks[id]?.[0]).toMatchObject({
      finishedAt: 1_250,
      exitCode: 1,
      durationMs: 250,
      bufferEnd: 18,
      state: 'failed',
    });
  });

  it('defaults missing legacy blocks state to an empty record', () => {
    useTerminalStore.setState({ blocks: undefined as never });

    useTerminalStore.getState().ensureBlocksState();

    expect(useTerminalStore.getState().blocks).toEqual({});
  });
});

describe('terminalStore — focus & switching', () => {
  it('focusCard remembers previous focus as lastActive', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });

    useTerminalStore.getState().focusCard(a);
    useTerminalStore.getState().focusCard(b);

    expect(useTerminalStore.getState().focusedCardId).toBe(b);
    expect(useTerminalStore.getState().lastActiveCardId).toBe(a);
  });

  it('switchToLast returns to the previous card', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });

    useTerminalStore.getState().focusCard(a);
    useTerminalStore.getState().focusCard(b);
    useTerminalStore.getState().switchToLast();
    expect(useTerminalStore.getState().focusedCardId).toBe(a);
  });

  it('nextCard / prevCard cycle through cards', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    const c = s.createCard({ projectName: 'c', projectPath: '/c', terminalType: 'shell' });

    useTerminalStore.getState().focusCard(a);
    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(b);
    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(c);
    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(a);
    useTerminalStore.getState().prevCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(c);
  });

  it('jumpToIndex ignores out-of-range indices', () => {
    const s = useTerminalStore.getState();
    s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    useTerminalStore.getState().jumpToIndex(5);
    expect(useTerminalStore.getState().focusedCardId).toBeNull();
  });
});

describe('terminalStore — pinned cards', () => {
  it('pins a card and reports it as pinned', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    expect(useTerminalStore.getState().isPinned(a)).toBe(false);
    expect(useTerminalStore.getState().pinCard(a)).toBe(true);
    expect(useTerminalStore.getState().isPinned(a)).toBe(true);
    expect(useTerminalStore.getState().pinnedCardIds).toEqual([a]);
  });

  it('pinCard is idempotent — re-pinning succeeds and does not duplicate', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    expect(useTerminalStore.getState().pinCard(a)).toBe(true);
    expect(useTerminalStore.getState().pinCard(a)).toBe(true);
    expect(useTerminalStore.getState().pinnedCardIds).toEqual([a]);
  });

  it('pinCard rejects when MAX_PINNED_CARDS is full', () => {
    const s = useTerminalStore.getState();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PINNED_CARDS; i++) {
      ids.push(
        s.createCard({ projectName: `p${i}`, projectPath: `/p${i}`, terminalType: 'shell' }),
      );
    }
    ids.forEach((id) => expect(useTerminalStore.getState().pinCard(id)).toBe(true));

    const overflow = s.createCard({
      projectName: 'overflow',
      projectPath: '/overflow',
      terminalType: 'shell',
    });
    expect(useTerminalStore.getState().pinCard(overflow)).toBe(false);
    expect(useTerminalStore.getState().pinnedCardIds).toHaveLength(MAX_PINNED_CARDS);
    expect(useTerminalStore.getState().isPinned(overflow)).toBe(false);
  });

  it('unpinCard removes the id; movePinned reorders', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    const c = s.createCard({ projectName: 'c', projectPath: '/c', terminalType: 'shell' });
    [a, b, c].forEach((id) => s.pinCard(id));
    expect(useTerminalStore.getState().pinnedCardIds).toEqual([a, b, c]);

    // Move c → front
    useTerminalStore.getState().movePinned(c, 0);
    expect(useTerminalStore.getState().pinnedCardIds).toEqual([c, a, b]);

    useTerminalStore.getState().unpinCard(a);
    expect(useTerminalStore.getState().pinnedCardIds).toEqual([c, b]);
    expect(useTerminalStore.getState().isPinned(a)).toBe(false);
  });

  it('removeCard cleans up the pinned list', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    s.pinCard(a);
    s.pinCard(b);
    useTerminalStore.getState().removeCard(a);
    expect(useTerminalStore.getState().pinnedCardIds).toEqual([b]);
  });

  it('getPinnedCards returns cards in pinned order, skipping missing', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    s.pinCard(b);
    s.pinCard(a);
    const names = useTerminalStore
      .getState()
      .getPinnedCards()
      .map((c) => c.projectName);
    expect(names).toEqual(['b', 'a']);
  });
});

describe('terminalStore — notifications', () => {
  it('push flags the card as unread', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(true);
  });

  it('focusing a card clears its unread flag', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });
    useTerminalStore.getState().focusCard(id);
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(true);
  });

  it('focusing an already-focused card still clears unread state', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.focusCard(id);
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });

    useTerminalStore.getState().focusCard(id);

    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(true);
  });

  it('markNotificationRead clears the card unread flag when it was the last unread notification', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const notification = s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });

    s.markNotificationRead(notification.id);

    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
    expect(useTerminalStore.getState().notifications[0]?.read).toBe(true);
  });

  it('markAllNotificationsRead does exactly that', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });
    s.pushNotification({ cardId: id, kind: 'failed', title: 't2', body: 'b2' });
    useTerminalStore.getState().markAllNotificationsRead();
    expect(useTerminalStore.getState().getUnreadCount()).toBe(0);
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
  });

  it('clearNotifications clears card unread flags', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });

    s.clearNotifications();

    expect(useTerminalStore.getState().notifications).toHaveLength(0);
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
  });
});

describe('terminalStore — project sidebar', () => {
  it('selectProject updates filter and exits focus mode', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    s.createCard({ projectName: 'p2', projectPath: '/p2', terminalType: 'shell' });
    useTerminalStore.getState().focusCard(a);
    expect(useTerminalStore.getState().focusedCardId).toBe(a);

    useTerminalStore.getState().selectProject('/p2');
    expect(useTerminalStore.getState().selectedProjectPath).toBe('/p2');
    // focus should be cleared so the user lands on the filtered grid
    expect(useTerminalStore.getState().focusedCardId).toBeNull();
  });

  it('removing the last card of a project resets the filter', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    s.createCard({ projectName: 'p2', projectPath: '/p2', terminalType: 'shell' });
    useTerminalStore.getState().selectProject('/p1');
    useTerminalStore.getState().removeCard(a);
    // selected project had only card a — should fall back to "All"
    expect(useTerminalStore.getState().selectedProjectPath).toBeNull();
  });

  it('removing a card from a multi-card project keeps the filter', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    useTerminalStore.getState().selectProject('/p1');
    useTerminalStore.getState().removeCard(a);
    expect(useTerminalStore.getState().selectedProjectPath).toBe('/p1');
  });
});

describe('terminalStore — purgeReadNotifications', () => {
  it('removes read notifications older than the cutoff and keeps unread', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });

    // Directly construct the notifications to control `at`.
    const now = Date.now();
    useTerminalStore.setState({
      notifications: [
        { id: 'old-read',    at: now - 3 * 3_600_000, read: true,  cardId: id, kind: 'waiting', title: 'old read',    body: '' },
        { id: 'old-unread',  at: now - 3 * 3_600_000, read: false, cardId: id, kind: 'waiting', title: 'old unread',  body: '' },
        { id: 'fresh-read',  at: now - 10_000,        read: true,  cardId: id, kind: 'waiting', title: 'fresh read',  body: '' },
        { id: 'fresh-unread',at: now - 10_000,        read: false, cardId: id, kind: 'waiting', title: 'fresh unread',body: '' },
      ],
    });

    const removed = useTerminalStore.getState().purgeReadNotifications(2 * 60 * 60_000);
    expect(removed).toBe(1);
    const ids = useTerminalStore.getState().notifications.map((n) => n.id).sort();
    expect(ids).toEqual(['fresh-read', 'fresh-unread', 'old-unread']);
  });

  it('returns 0 when nothing matches the cutoff', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.pushNotification({ cardId: id, kind: 'waiting', title: 't', body: 'b' });
    const removed = useTerminalStore.getState().purgeReadNotifications(10);
    expect(removed).toBe(0);
  });
});
