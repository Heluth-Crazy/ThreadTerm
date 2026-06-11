import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PET_CONFIG, MAX_PINNED_CARDS, useTerminalStore } from './terminalStore';
import { MAX_BLOCKS_PER_CARD } from '../types/terminal';

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    blocks: {},
    collapsedBlockIds: [],
    selectedBlockId: {},
    bookmarks: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
    petConfig: DEFAULT_PET_CONFIG,
    supervisorEnabled: false,
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

  it('imports provider session metadata as bound cards without focusing them', () => {
    const s = useTerminalStore.getState();
    const existingId = s.createCard({
      projectName: 'app',
      projectPath: '/repo/app',
      terminalType: 'shell',
    });
    s.selectProject('/repo/app');
    s.focusCard(existingId);

    const imported = s.importProviderSessionCards([
      {
        id: 'codex-session-1',
        provider: 'codex',
        projectPath: '/repo/app',
        updatedAt: 1234,
      },
    ]);

    const state = useTerminalStore.getState();
    const card = state.cards.find((candidate) => candidate.providerSessionId === 'codex-session-1');
    expect(imported).toBe(1);
    expect(card).toMatchObject({
      ptyId: 'codex-session-1',
      projectName: 'app',
      projectPath: '/repo/app',
      terminalType: 'codex',
      providerSessionState: 'bound',
      status: 'idle',
      lastActivity: 1234,
    });
    expect(card?.command).toBeUndefined();
    expect(state.focusedCardId).toBe(existingId);
    expect(state.selectedProjectPath).toBe('/repo/app');
  });

  it('imports provider session metadata idempotently by provider and session id', () => {
    const s = useTerminalStore.getState();
    const session = {
      id: 'claude-session-1',
      provider: 'claude' as const,
      projectPath: '/repo/app',
      updatedAt: 1234,
    };

    expect(s.importProviderSessionCards([session])).toBe(1);
    expect(s.importProviderSessionCards([session])).toBe(0);
    expect(
      useTerminalStore
        .getState()
        .cards.filter((card) => card.providerSessionId === 'claude-session-1'),
    ).toHaveLength(1);
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

  it('persists pending auto restart attempts as cancelled metadata only', () => {
    localStorage.removeItem('threadterm-terminal-store');
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });
    s.setCardAutoRestartEnabled(id, true);
    s.scheduleCardAutoRestart(id, { exitCode: 1, now: 1000 });

    const inMemory = useTerminalStore.getState().getCardById(id)?.autoRestart;
    expect(inMemory?.history[0]?.status).toBe('pending');

    // FIX-3: persist writes are debounced at the storage layer
    // (see ./throttledStorage). A real tab close/hide flushes the pending
    // write; simulate that here so we can assert the *persisted* shape.
    // The persisted-content contract below is unchanged by FIX-3.
    window.dispatchEvent(new Event('beforeunload'));

    const raw = localStorage.getItem('threadterm-terminal-store');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw ?? '{}') as {
      state?: { cards?: Array<{ id: string; autoRestart?: { history?: Array<{ status: string }> } }> };
    };
    const persistedCard = persisted.state?.cards?.find((card) => card.id === id);

    expect(persistedCard?.autoRestart?.history?.[0]?.status).toBe('cancelled');
    expect(JSON.stringify(persistedCard?.autoRestart)).not.toContain('Timeout');
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

  it('recordBlockFinished caps output at MAX_BLOCK_OUTPUT_LENGTH', () => {
    const big = 'x'.repeat(10_000);
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.recordBlockStarted({
      cardId: id,
      blockId: 'b1',
      command: 'foo',
      cwd: '/',
      startedAt: 0,
      bufferStart: 0,
    });
    s.recordBlockFinished({
      cardId: id,
      blockId: 'b1',
      exitCode: 0,
      finishedAt: 1,
      durationMs: 1,
      output: big,
    });
    const stored = useTerminalStore.getState().blocks[id][0];
    expect(stored.output?.length).toBe(4000);
  });

  it('recordBlockFinished stores short output verbatim', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.recordBlockStarted({
      cardId: id,
      blockId: 'b1',
      command: 'foo',
      cwd: '/',
      startedAt: 0,
      bufferStart: 0,
    });
    s.recordBlockFinished({
      cardId: id,
      blockId: 'b1',
      exitCode: 0,
      finishedAt: 1,
      durationMs: 1,
      output: 'hello\nworld',
    });
    expect(useTerminalStore.getState().blocks[id][0].output).toBe('hello\nworld');
  });

  it('defaults missing legacy blocks state to an empty record', () => {
    useTerminalStore.setState({ blocks: undefined as never });

    useTerminalStore.getState().ensureBlocksState();

    expect(useTerminalStore.getState().blocks).toEqual({});
  });

  it('evicts oldest blocks past MAX_BLOCKS_PER_CARD (audit P2-4)', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });

    for (let i = 0; i < MAX_BLOCKS_PER_CARD + 5; i++) {
      s.recordBlockStarted({
        cardId: id,
        blockId: `b-${i}`,
        command: `cmd ${i}`,
        cwd: '/',
        startedAt: i,
        bufferStart: i,
      });
    }

    const blocks = useTerminalStore.getState().blocks[id];
    expect(blocks).toHaveLength(MAX_BLOCKS_PER_CARD);
    expect(blocks[0].id).toBe('b-5'); // b-0..b-4 evicted FIFO
    expect(blocks[blocks.length - 1].id).toBe(`b-${MAX_BLOCKS_PER_CARD + 4}`);
  });

  it('eviction drops collapsed/bookmark/selection references to evicted blocks', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });

    s.recordBlockStarted({
      cardId: id,
      blockId: 'b-0',
      command: 'cmd 0',
      cwd: '/',
      startedAt: 0,
      bufferStart: 0,
    });
    s.toggleBlockCollapsed('b-0');
    s.addBookmark({ blockId: 'b-0', cardId: id, command: 'cmd 0', cwd: '/' });
    s.selectBlock(id, 'b-0');

    for (let i = 1; i <= MAX_BLOCKS_PER_CARD; i++) {
      s.recordBlockStarted({
        cardId: id,
        blockId: `b-${i}`,
        command: `cmd ${i}`,
        cwd: '/',
        startedAt: i,
        bufferStart: i,
      });
    }

    const state = useTerminalStore.getState();
    expect(state.blocks[id].some((b) => b.id === 'b-0')).toBe(false);
    expect(state.collapsedBlockIds).not.toContain('b-0');
    expect(state.bookmarks.some((b) => b.blockId === 'b-0')).toBe(false);
    expect(state.selectedBlockId[id]).toBeNull();
  });

  it('eviction leaves references to surviving blocks intact', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });

    for (let i = 0; i < MAX_BLOCKS_PER_CARD; i++) {
      s.recordBlockStarted({
        cardId: id,
        blockId: `b-${i}`,
        command: `cmd ${i}`,
        cwd: '/',
        startedAt: i,
        bufferStart: i,
      });
    }
    const survivorId = `b-${MAX_BLOCKS_PER_CARD - 1}`;
    s.toggleBlockCollapsed(survivorId);
    s.addBookmark({ blockId: survivorId, cardId: id, command: 'x', cwd: '/' });

    // Push one more — evicts only b-0.
    s.recordBlockStarted({
      cardId: id,
      blockId: 'b-extra',
      command: 'extra',
      cwd: '/',
      startedAt: 999,
      bufferStart: 999,
    });

    const state = useTerminalStore.getState();
    expect(state.collapsedBlockIds).toContain(survivorId);
    expect(state.bookmarks.some((b) => b.blockId === survivorId)).toBe(true);
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

describe('terminalStore — desktop pet config', () => {
  it('defaults desktop pet to opt-in system notifications', () => {
    expect(useTerminalStore.getState().petConfig).toEqual(DEFAULT_PET_CONFIG);
  });

  it('updates and clamps desktop pet size', () => {
    const store = useTerminalStore.getState();

    store.updatePetConfig({ enabled: true, notificationMode: 'both', size: 999 });

    expect(useTerminalStore.getState().petConfig).toMatchObject({
      enabled: true,
      notificationMode: 'both',
      size: 120,
    });
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

describe('terminalStore — block UI state', () => {
  it('toggles a block collapsed state', () => {
    const s = useTerminalStore.getState();
    s.toggleBlockCollapsed('blk-1');
    expect(useTerminalStore.getState().collapsedBlockIds).toEqual(['blk-1']);
    s.toggleBlockCollapsed('blk-1');
    expect(useTerminalStore.getState().collapsedBlockIds).toEqual([]);
  });

  it('records the selected block per card', () => {
    const s = useTerminalStore.getState();
    s.selectBlock('card-1', 'blk-1');
    s.selectBlock('card-2', 'blk-7');
    expect(useTerminalStore.getState().selectedBlockId).toEqual({
      'card-1': 'blk-1',
      'card-2': 'blk-7',
    });
    s.selectBlock('card-1', null);
    expect(useTerminalStore.getState().selectedBlockId).toEqual({
      'card-1': null,
      'card-2': 'blk-7',
    });
  });

  it('removeCard cleans up collapsedBlockIds and selectedBlockId for the removed card', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    // Inject blocks for the card
    useTerminalStore.setState((state) => ({
      blocks: {
        ...state.blocks,
        [id]: [
          { id: 'blk-a', cardId: id, cwd: '/a', command: 'ls', startedAt: 0, bufferStart: 0, state: 'success' },
          { id: 'blk-b', cardId: id, cwd: '/a', command: 'pwd', startedAt: 0, bufferStart: 1, state: 'failed' },
        ],
      },
    }));
    s.toggleBlockCollapsed('blk-a');
    s.toggleBlockCollapsed('blk-b');
    s.toggleBlockCollapsed('blk-z'); // unrelated, must survive
    s.selectBlock(id, 'blk-a');

    s.removeCard(id);

    const after = useTerminalStore.getState();
    expect(after.collapsedBlockIds).toEqual(['blk-z']);
    expect(after.selectedBlockId).not.toHaveProperty(id);
  });
});

describe('terminalStore — bookmarks', () => {
  it('addBookmark creates a bookmark with id, blockId, cardId and createdAt', () => {
    const s = useTerminalStore.getState();
    const cardId = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.addBookmark({ blockId: 'blk-1', cardId, command: 'ls', cwd: '/a' });
    const after = useTerminalStore.getState().bookmarks;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ blockId: 'blk-1', cardId, command: 'ls', cwd: '/a' });
    expect(after[0].id).toBeTruthy();
    expect(typeof after[0].createdAt).toBe('number');
  });

  it('addBookmark refuses to insert a duplicate (same blockId)', () => {
    const s = useTerminalStore.getState();
    s.addBookmark({ blockId: 'blk-1', cardId: 'c1', command: 'ls', cwd: '/a' });
    s.addBookmark({ blockId: 'blk-1', cardId: 'c1', command: 'ls', cwd: '/a' });
    expect(useTerminalStore.getState().bookmarks).toHaveLength(1);
  });

  it('removeBookmark drops the entry', () => {
    const s = useTerminalStore.getState();
    s.addBookmark({ blockId: 'blk-1', cardId: 'c1', command: 'ls', cwd: '/a' });
    const id = useTerminalStore.getState().bookmarks[0].id;
    useTerminalStore.getState().removeBookmark(id);
    expect(useTerminalStore.getState().bookmarks).toHaveLength(0);
  });

  it('isBookmarked returns true after adding', () => {
    const s = useTerminalStore.getState();
    expect(s.isBookmarked('blk-x')).toBe(false);
    s.addBookmark({ blockId: 'blk-x', cardId: 'c1', command: 'pwd', cwd: '/' });
    expect(useTerminalStore.getState().isBookmarked('blk-x')).toBe(true);
  });

  it('removeCard drops bookmarks belonging to deleted card', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    s.addBookmark({ blockId: 'blk-1', cardId: id, command: 'ls', cwd: '/a' });
    s.addBookmark({ blockId: 'blk-2', cardId: 'other-card', command: 'pwd', cwd: '/' });
    useTerminalStore.getState().removeCard(id);
    const after = useTerminalStore.getState().bookmarks;
    expect(after).toHaveLength(1);
    expect(after[0].blockId).toBe('blk-2');
  });
});

describe('terminalStore — AI Supervisor master switch (PRD D3)', () => {
  it('defaults supervisorEnabled to false', () => {
    expect(useTerminalStore.getState().supervisorEnabled).toBe(false);
  });

  it('setSupervisorEnabled toggles the master switch', () => {
    const setSupervisorEnabled = useTerminalStore.getState().setSupervisorEnabled;
    setSupervisorEnabled(true);
    expect(useTerminalStore.getState().supervisorEnabled).toBe(true);
    setSupervisorEnabled(false);
    expect(useTerminalStore.getState().supervisorEnabled).toBe(false);
  });

  it('v8 → v9 migration defaults supervisorEnabled to false', async () => {
    // Simulate a v8 persisted snapshot (no supervisorEnabled field).
    const v8Snapshot = {
      state: {
        cards: [],
        blocks: {},
        bookmarks: [],
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
        aiExplainDefaultProvider: 'claude',
        bottomBarHidden: false,
      },
      version: 8,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(v8Snapshot));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().supervisorEnabled).toBe(false);
  });

  it('v9 snapshot with supervisorEnabled=true is preserved', async () => {
    const v9Snapshot = {
      state: {
        cards: [],
        blocks: {},
        bookmarks: [],
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
        aiExplainDefaultProvider: 'claude',
        bottomBarHidden: false,
        supervisorEnabled: true,
      },
      version: 9,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(v9Snapshot));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().supervisorEnabled).toBe(true);
    expect(useTerminalStore.getState().petConfig).toEqual(DEFAULT_PET_CONFIG);
    // Reset for downstream tests.
    localStorage.removeItem('threadterm-terminal-store');
  });

  it('v11 migration resets notificationMode to both but keeps other pet fields', async () => {
    // An upgraded user persisted the old default notificationMode 'system'
    // (plus their own skin/size). The new two-toggle model means a stale
    // 'system' would suppress the pet bubble forever, so the migration must
    // force notificationMode back to 'both' while preserving everything else.
    const upgradedSnapshot = {
      state: {
        cards: [],
        blocks: {},
        bookmarks: [],
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
        aiExplainDefaultProvider: 'claude',
        bottomBarHidden: false,
        supervisorEnabled: false,
        petConfig: {
          enabled: true,
          notificationMode: 'system',
          defaultPosition: 'leftBottom',
          size: 110,
          idleTranslucent: false,
          expanded: false,
          lastPosition: { x: 42, y: 84 },
          skin: 'tuxedo',
        },
      },
      version: 10,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(upgradedSnapshot));
    await useTerminalStore.persist.rehydrate();
    const petConfig = useTerminalStore.getState().petConfig;
    expect(petConfig.notificationMode).toBe('both');
    // Other user choices survive the forced reset.
    expect(petConfig.skin).toBe('tuxedo');
    expect(petConfig.size).toBe(110);
    expect(petConfig.defaultPosition).toBe('leftBottom');
    expect(petConfig.lastPosition).toEqual({ x: 42, y: 84 });
    expect(petConfig.enabled).toBe(true);
    localStorage.removeItem('threadterm-terminal-store');
  });
});
