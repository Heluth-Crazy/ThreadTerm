import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CARD_NAME_LENGTH,
  MAX_PINNED_CARDS,
  MAX_RECENTLY_VIEWED_CARDS,
  useTerminalStore,
} from './terminalStore';
import { HIGHLIGHT_TTL_MS } from './terminal/notificationsSlice';

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    pendingTerminalConfigurations: {},
    focusedCardId: null,
    lastActiveCardId: null,
    recentlyViewedCardIds: [],
    dockPinned: false,
    selectedProjectPath: null,
    selectedWorktreePath: null,
    selectedWorktreeLabel: null,
    projectCardOrder: {},
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
    highlightCardId: null,
    osNotificationsEnabled: true,
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

  it('binds Codex app-server thread metadata separately from CLI session metadata', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'codex' });
    s.markProviderSessionBound(id, 'codex-cli-session-1');
    s.bindCodexAppThread(id, {
      threadId: 'codex-thread-1',
      sessionId: 'codex-app-session-1',
      threadPath: '/tmp/codex-thread.jsonl',
      boundAt: 1234,
    });

    expect(useTerminalStore.getState().getCardById(id)).toMatchObject({
      providerSessionId: 'codex-cli-session-1',
      codexAppThreadId: 'codex-thread-1',
      codexAppSessionId: 'codex-app-session-1',
      codexAppThreadPath: '/tmp/codex-thread.jsonl',
      codexAppBoundAt: 1234,
    });
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
    expect(imported).toEqual([
      { id: 'codex-session-1', provider: 'codex', outcome: 'imported' },
    ]);
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

    expect(s.importProviderSessionCards([session])).toEqual([
      { id: 'claude-session-1', provider: 'claude', outcome: 'imported' },
    ]);
    expect(s.importProviderSessionCards([session])).toEqual([
      { id: 'claude-session-1', provider: 'claude', outcome: 'alreadyActive' },
    ]);
    expect(
      useTerminalStore
        .getState()
        .cards.filter((card) => card.providerSessionId === 'claude-session-1'),
    ).toHaveLength(1);
  });

  it('does not re-import provider sessions that already exist in the archive', () => {
    const s = useTerminalStore.getState();
    const session = {
      id: 'codex-session-archived',
      provider: 'codex' as const,
      projectPath: '/repo/app',
      updatedAt: 1234,
    };

    expect(s.importProviderSessionCards([session])).toEqual([
      { id: 'codex-session-archived', provider: 'codex', outcome: 'imported' },
    ]);
    const id = useTerminalStore.getState().cards[0].id;
    useTerminalStore.getState().archiveCard(id);

    expect(useTerminalStore.getState().cards).toHaveLength(0);
    expect(useTerminalStore.getState().archivedCards).toHaveLength(1);
    expect(useTerminalStore.getState().importProviderSessionCards([session])).toEqual([
      { id: 'codex-session-archived', provider: 'codex', outcome: 'archived' },
    ]);
    expect(useTerminalStore.getState().cards).toHaveLength(0);
  });

  it('imports OpenCode and Gemini bound resume cards without focusing them', () => {
    const s = useTerminalStore.getState();
    const results = s.importProviderSessionCards([
      {
        id: 'oc-1',
        provider: 'opencode',
        projectPath: '/repo/app',
        updatedAt: 10,
        projectNameHint: 'Build UI',
      },
      {
        id: 'gem-1',
        provider: 'gemini',
        projectPath: '/repo/gemini',
        updatedAt: 20,
      },
    ]);
    expect(results.map((result) => result.outcome)).toEqual(['imported', 'imported']);
    const state = useTerminalStore.getState();
    expect(state.focusedCardId).toBeNull();
    expect(state.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          terminalType: 'opencode',
          providerSessionId: 'oc-1',
          providerSessionState: 'bound',
          status: 'idle',
          projectName: 'Build UI',
        }),
        expect.objectContaining({
          terminalType: 'gemini',
          providerSessionId: 'gem-1',
          providerSessionState: 'bound',
          status: 'idle',
        }),
      ]),
    );
  });

  it('archives a card while preserving provider session binding', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'app',
      projectPath: '/repo/app',
      terminalType: 'codex',
    });
    s.markProviderSessionBound(id, 'codex-session-1');
    s.selectProject('/repo/app');
    s.focusCard(id);
    s.pinCard(id);
    s.pushNotification({
      cardId: id,
      kind: 'attention',
      title: 'Needs input',
      body: 'Please respond',
    });
    useTerminalStore.getState().archiveCard(id);
    const state = useTerminalStore.getState();

    expect(state.cards).toHaveLength(0);
    expect(state.archivedCards).toHaveLength(1);
    expect(state.archivedCards[0]).toMatchObject({
      id,
      projectPath: '/repo/app',
      terminalType: 'codex',
      providerSessionId: 'codex-session-1',
      providerSessionState: 'bound',
      status: 'idle',
      unread: false,
    });
    expect(state.focusedCardId).toBeNull();
    expect(state.lastActiveCardId).toBeNull();
    expect(state.selectedProjectPath).toBe('/repo/app');
    expect(state.pinnedCardIds).toEqual([]);
    expect(state.notifications).toEqual([]);
  });

  it('restores archived cards to the front of project order without focusing them', () => {
    const s = useTerminalStore.getState();
    const first = s.createCard({
      projectName: 'first',
      projectPath: '/repo/app',
      terminalType: 'shell',
    });
    const second = s.createCard({
      projectName: 'second',
      projectPath: '/repo/app',
      terminalType: 'shell',
    });
    s.archiveCard(first);
    s.restoreArchivedCard(first);
    const state = useTerminalStore.getState();

    expect(state.archivedCards).toHaveLength(0);
    expect(state.cards.map((card) => card.id)).toEqual([second, first]);
    expect(state.projectCardOrder['/repo/app']).toEqual([first, second]);
    expect(state.focusedCardId).toBeNull();
    expect(state.selectedProjectPath).toBe('/repo/app');
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

  it('updateCardOutput keeps ANSI controls split across flushes out of the summary', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });

    useTerminalStore.getState().updateCardOutput(id, 'before\x1b[');
    useTerminalStore.getState().updateCardOutput(id, '31mred\x1b]0;private');
    useTerminalStore.getState().updateCardOutput(id, '-title\x07after\x1b');
    useTerminalStore.getState().updateCardOutput(id, '[0mplain');

    expect(useTerminalStore.getState().getCardById(id)?.lastOutput)
      .toBe('beforeredafterplain');
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

  it('keeps the same store and cards references for an identical reply preview', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    useTerminalStore.getState().updateCardReplyPreview(id, 'same preview');
    const beforeState = useTerminalStore.getState();
    const beforeCards = beforeState.cards;
    const listener = vi.fn();
    const unsubscribe = useTerminalStore.subscribe(listener);

    useTerminalStore.getState().updateCardReplyPreview(id, 'same preview');

    expect(useTerminalStore.getState()).toBe(beforeState);
    expect(useTerminalStore.getState().cards).toBe(beforeCards);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('updates coalesced output and preview in one Zustand notification', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'repo',
      projectPath: '/tmp/repo',
      terminalType: 'shell',
    });
    const listener = vi.fn();
    const unsubscribe = useTerminalStore.subscribe(listener);

    useTerminalStore.getState().updateCardOutputAndPreview(id, 'hello\x1b[31m world', 'clean');

    const card = useTerminalStore.getState().getCardById(id);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(card?.lastOutput).toContain('hello world');
    expect(card?.lastReplyPreview).toBe('clean');
    unsubscribe();
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

describe('terminalStore — terminal configuration editing', () => {
  it('saves a pending configuration without changing the active card', () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const before = useTerminalStore.getState().getCardById(id);

    const saved = store.savePendingTerminalConfiguration(id, {
      terminalType: 'codex',
      launchMode: 'custom',
      command: 'codex --no-alt-screen',
    });

    expect(saved).toBe(true);
    expect(useTerminalStore.getState().getCardById(id)).toBe(before);
    expect(
      useTerminalStore.getState().pendingTerminalConfigurations[id],
    ).toEqual({
      terminalType: 'codex',
      launchMode: 'custom',
      command: 'codex --no-alt-screen',
    });
  });

  it('atomically applies a configuration while preserving card history and preferences', () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    store.recordUserSubmit(id, 'keep this history');
    store.updateCardOutputAndPreview(id, 'old output', 'old preview');
    store.pinCard(id);
    store.focusCard(id);
    store.setCardAutoRestartEnabled(id, true);
    store.scheduleCardAutoRestart(id, { exitCode: 7, now: 100 });
    store.pushNotification({
      cardId: id,
      kind: 'waiting',
      title: 'Needs input',
      body: 'Continue?',
    });
    store.savePendingTerminalConfiguration(id, {
      terminalType: 'codex',
      launchMode: 'custom',
      command: 'codex --no-alt-screen',
    });
    const before = useTerminalStore.getState().getCardById(id);

    const nextPtyId = store.commitTerminalConfiguration(id, {
      expectedPtyId: before?.ptyId ?? '',
      configuration: {
        terminalType: 'codex',
        launchMode: 'custom',
        command: 'codex --no-alt-screen',
      },
      nextPtyId: 'configured-pty',
      now: 500,
    });

    const state = useTerminalStore.getState();
    const card = state.getCardById(id);
    expect(nextPtyId).toBe('configured-pty');
    expect(card).toMatchObject({
      id,
      ptyId: 'configured-pty',
      terminalType: 'codex',
      command: 'codex --no-alt-screen',
      providerSessionState: 'unbound',
      status: 'idle',
      lastOutput: '',
      lastReplyPreview: '',
      unread: false,
      messageCount: 1,
      createdAt: before?.createdAt,
    });
    expect(card?.events).toHaveLength((before?.events.length ?? 0) + 1);
    expect(card?.autoRestart).toMatchObject({
      enabled: true,
      retryCount: 0,
    });
    expect(card?.autoRestart?.history[0]?.status).toBe('cancelled');
    expect(state.notifications[0]?.read).toBe(true);
    expect(state.pinnedCardIds).toContain(id);
    expect(state.focusedCardId).toBe(id);
    expect(state.pendingTerminalConfigurations[id]).toBeUndefined();
  });

  it('does not overwrite a card when the expected PTY is stale', () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    const before = useTerminalStore.getState().getCardById(id);

    expect(
      store.commitTerminalConfiguration(id, {
        expectedPtyId: 'stale-pty',
        configuration: {
          terminalType: 'claude',
          launchMode: 'default',
        },
      }),
    ).toBeNull();
    expect(useTerminalStore.getState().getCardById(id)).toBe(before);
  });

  it('adopts known worktree metadata when following a resumed session directory', () => {
    const store = useTerminalStore.getState();
    const targetId = store.createCard({
      projectName: 'source',
      projectPath: '/source',
      terminalType: 'shell',
    });
    store.createCard({
      projectName: 'destination',
      projectPath: '/destination',
      worktreePath: '/destination/feature',
      branchLabel: 'feature',
      terminalType: 'shell',
    });
    const target = useTerminalStore.getState().getCardById(targetId);

    store.commitTerminalConfiguration(targetId, {
      expectedPtyId: target?.ptyId ?? '',
      configuration: {
        terminalType: 'claude',
        launchMode: 'resume',
        providerSessionId: 'claude-session-1',
        workspaceMode: 'session',
        sessionProjectPath: '/destination/feature',
      },
      nextPtyId: 'claude-resume-pty',
      now: 700,
    });

    const state = useTerminalStore.getState();
    expect(state.getCardById(targetId)).toMatchObject({
      projectPath: '/destination',
      projectName: 'destination',
      worktreePath: '/destination/feature',
      branchLabel: 'feature',
      providerSessionId: 'claude-session-1',
      providerSessionState: 'bound',
      providerSessionBoundAt: 700,
    });
    expect(state.selectedProjectPath).toBe('/destination');
    expect(state.selectedWorktreePath).toBe('/destination/feature');
    expect(state.selectedWorktreeLabel).toBe('feature');
  });

  it('preserves Codex Chat binding only while the card remains Codex', () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'codex',
    });
    store.bindCodexAppThread(id, {
      threadId: 'chat-thread',
      sessionId: 'chat-session',
      threadPath: '/repo/thread.jsonl',
      boundAt: 123,
    });
    const originalPtyId = useTerminalStore.getState().getCardById(id)?.ptyId ?? '';

    store.commitTerminalConfiguration(id, {
      expectedPtyId: originalPtyId,
      configuration: {
        terminalType: 'codex',
        launchMode: 'resume',
        providerSessionId: 'cli-session',
        workspaceMode: 'current',
      },
      nextPtyId: 'codex-pty',
    });
    expect(useTerminalStore.getState().getCardById(id)).toMatchObject({
      codexAppThreadId: 'chat-thread',
      codexAppSessionId: 'chat-session',
    });

    store.commitTerminalConfiguration(id, {
      expectedPtyId: 'codex-pty',
      configuration: {
        terminalType: 'shell',
        launchMode: 'default',
      },
      nextPtyId: 'shell-pty',
    });
    const switched = useTerminalStore.getState().getCardById(id);
    expect(switched?.codexAppThreadId).toBeUndefined();
    expect(switched?.codexAppSessionId).toBeUndefined();
    expect(switched?.codexAppThreadPath).toBeUndefined();
    expect(switched?.codexAppBoundAt).toBeUndefined();
  });

  it('retains pending edits across archive/restore and removes them with the card', () => {
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/repo',
      terminalType: 'shell',
    });
    store.savePendingTerminalConfiguration(id, {
      terminalType: 'gemini',
      launchMode: 'default',
    });

    store.archiveCard(id);
    expect(
      useTerminalStore.getState().pendingTerminalConfigurations[id],
    ).toBeDefined();
    useTerminalStore.getState().restoreArchivedCard(id);
    expect(
      useTerminalStore.getState().pendingTerminalConfigurations[id],
    ).toBeDefined();
    useTerminalStore.getState().removeCard(id);
    expect(
      useTerminalStore.getState().pendingTerminalConfigurations[id],
    ).toBeUndefined();
  });
});

describe('terminalStore — persistence shape contract', () => {
  // slice 拆分前的安全网：锁定 partialize 输出的持久化形状。
  // 纯移动重构不得改变顶层键集合、卡片对象键集合或 persist 版本号。
  const PERSISTED_TOP_LEVEL_KEYS = [
    'cards',
    'archivedCards',
    'pendingTerminalConfigurations',
    'focusedCardId',
    'lastActiveCardId',
    'recentlyViewedCardIds',
    'dockPinned',
    'selectedProjectPath',
    'selectedWorktreePath',
    'selectedWorktreeLabel',
    'projectCardOrder',
    'pinnedCardIds',
    'notifications',
    'notificationCentreOpen',
    'osNotificationsEnabled',
    'supervisorEnabled',
  ].sort();

  // JSON.stringify 丢弃 undefined 值，故未设置的可选字段（worktreePath /
  // branchLabel / providerSessionId / providerSessionState / autoRestart）不在其中。
  const PERSISTED_CARD_KEYS = [
    'id',
    'ptyId',
    'projectPath',
    'projectName',
    'terminalType',
    'status',
    'createdAt',
    'lastActivity',
    'lastOutput',
    'lastReplyPreview',
    'messageCount',
    'events',
    'unread',
  ].sort();

  function readPersistedState() {
    // FIX-3: persist 写入在 storage 层防抖，beforeunload 会 flush 待写值。
    window.dispatchEvent(new Event('beforeunload'));
    const raw = localStorage.getItem('threadterm-terminal-store');
    expect(raw).toBeTruthy();
    return JSON.parse(raw ?? '{}') as {
      version?: number;
      state?: Record<string, unknown> & { cards?: Array<Record<string, unknown>> };
    };
  }

  it('persists exactly the partialized top-level keys and version', () => {
    localStorage.removeItem('threadterm-terminal-store');
    useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });

    const persisted = readPersistedState();
    expect(Object.keys(persisted.state ?? {}).sort()).toEqual(PERSISTED_TOP_LEVEL_KEYS);
    expect(persisted.version).toBe(20);
  });

  it('persists each card with a stable key set', () => {
    localStorage.removeItem('threadterm-terminal-store');
    useTerminalStore.getState().createCard({
      projectName: 'foo',
      projectPath: '/tmp/foo',
      terminalType: 'shell',
    });

    const persisted = readPersistedState();
    const card = persisted.state?.cards?.[0];
    expect(card).toBeTruthy();
    expect(Object.keys(card ?? {}).sort()).toEqual(PERSISTED_CARD_KEYS);
  });

  it('round-trips the complete current-version workspace state', async () => {
    localStorage.removeItem('threadterm-terminal-store');
    const store = useTerminalStore.getState();
    const liveId = store.createCard({
      projectName: 'live',
      projectPath: '/workspace/live',
      terminalType: 'shell',
    });
    const archivedId = store.createCard({
      projectName: 'history',
      projectPath: '/workspace/history',
      terminalType: 'claude',
    });
    store.renameCard(liveId, 'renamed live session');
    store.updateCardOutputAndPreview(
      liveId,
      'latest terminal output',
      'latest assistant preview',
    );
    store.pinCard(liveId);
    store.focusCard(liveId);
    store.focusCard(archivedId);
    store.archiveCard(archivedId);
    store.toggleDockPin();
    store.selectWorktree('/workspace/live', '/workspace/live-feature', 'feature');
    store.pushNotification({
      cardId: liveId,
      kind: 'waiting',
      title: 'Needs input',
      body: 'Continue?',
    });
    store.setOsNotificationsEnabled(false);
    store.setSupervisorEnabled(true);

    const persisted = readPersistedState();
    const expected = persisted.state ?? {};
    resetStore();
    await useTerminalStore.persist.rehydrate();
    const restored = useTerminalStore.getState() as unknown as Record<
      string,
      unknown
    >;

    for (const key of PERSISTED_TOP_LEVEL_KEYS) {
      expect(restored[key], `persisted key ${key}`).toEqual(expected[key]);
    }
  });

  it('round-trips a pending terminal configuration without changing card fields', async () => {
    localStorage.removeItem('threadterm-terminal-store');
    const store = useTerminalStore.getState();
    const id = store.createCard({
      projectName: 'repo',
      projectPath: '/workspace/repo',
      terminalType: 'shell',
    });
    const activeBefore = useTerminalStore.getState().getCardById(id);
    store.savePendingTerminalConfiguration(id, {
      terminalType: 'codex',
      launchMode: 'resume',
      providerSessionId: 'codex-session-1',
      workspaceMode: 'current',
    });
    readPersistedState();

    resetStore();
    await useTerminalStore.persist.rehydrate();

    expect(useTerminalStore.getState().getCardById(id)).toMatchObject({
      terminalType: activeBefore?.terminalType,
      ptyId: activeBefore?.ptyId,
    });
    expect(
      useTerminalStore.getState().getCardById(id)?.command,
    ).toBe(activeBefore?.command);
    expect(
      useTerminalStore.getState().pendingTerminalConfigurations[id],
    ).toEqual({
      terminalType: 'codex',
      launchMode: 'resume',
      providerSessionId: 'codex-session-1',
      workspaceMode: 'current',
    });
  });

  it('migrates a v18 snapshot with no pending edits to an empty pending map', async () => {
    localStorage.removeItem('threadterm-terminal-store');
    localStorage.setItem(
      'threadterm-terminal-store',
      JSON.stringify({
        version: 18,
        state: {
          cards: [],
          archivedCards: [],
          notifications: [],
        },
      }),
    );

    resetStore();
    await useTerminalStore.persist.rehydrate();

    expect(useTerminalStore.getState().pendingTerminalConfigurations).toEqual(
      {},
    );
  });

  it('restores a large current-version workspace without losing card output', async () => {
    localStorage.removeItem('threadterm-terminal-store');
    const cardIds: string[] = [];
    for (let index = 0; index < 180; index += 1) {
      const id = useTerminalStore.getState().createCard({
        projectName: `project-${index}`,
        projectPath: `/workspace/project-${index}`,
        terminalType: 'shell',
      });
      useTerminalStore
        .getState()
        .updateCardOutput(id, `card-${index}:${'界'.repeat(900)}`);
      cardIds.push(id);
    }

    const persisted = readPersistedState();
    const raw = localStorage.getItem('threadterm-terminal-store') ?? '';
    expect(raw.length).toBeGreaterThan(200_000);

    resetStore();
    await useTerminalStore.persist.rehydrate();
    const restoredCards = useTerminalStore.getState().cards;

    expect(restoredCards).toHaveLength(cardIds.length);
    expect(restoredCards.map((card) => card.id)).toEqual(cardIds);
    expect(restoredCards[0]?.lastOutput).toContain('card-0:');
    expect(restoredCards.at(-1)?.lastOutput).toContain('card-179:');
    expect(persisted.version).toBe(20);
  });
});

describe('terminalStore — renameCard', () => {
  it('renames a card to a custom display name', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'foo', projectPath: '/tmp/foo', terminalType: 'shell' });

    s.renameCard(id, 'My API server');

    expect(useTerminalStore.getState().getCardById(id)?.projectName).toBe('My API server');
  });

  it('trims surrounding whitespace', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'foo', projectPath: '/tmp/foo', terminalType: 'shell' });

    s.renameCard(id, '  spaced  ');

    expect(useTerminalStore.getState().getCardById(id)?.projectName).toBe('spaced');
  });

  it('falls back to the directory basename when the new name is blank', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'custom',
      projectPath: '/repo/my-app',
      terminalType: 'shell',
    });

    s.renameCard(id, '   ');

    expect(useTerminalStore.getState().getCardById(id)?.projectName).toBe('my-app');
  });

  it('truncates names longer than MAX_CARD_NAME_LENGTH', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({ projectName: 'foo', projectPath: '/tmp/foo', terminalType: 'shell' });

    s.renameCard(id, 'x'.repeat(MAX_CARD_NAME_LENGTH + 50));

    expect(useTerminalStore.getState().getCardById(id)?.projectName).toHaveLength(
      MAX_CARD_NAME_LENGTH,
    );
  });

  it('keeps the same store reference when the name is unchanged', () => {
    const s = useTerminalStore.getState();
    const id = s.createCard({
      projectName: 'stable',
      projectPath: '/tmp/stable',
      terminalType: 'shell',
    });
    const before = useTerminalStore.getState().getCardById(id);

    s.renameCard(id, 'stable');

    expect(useTerminalStore.getState().getCardById(id)).toBe(before);
  });

  it('ignores unknown card ids without throwing', () => {
    const s = useTerminalStore.getState();
    expect(() => s.renameCard('does-not-exist', 'whatever')).not.toThrow();
  });

  it('renames only the targeted card when several share a projectPath', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'app', projectPath: '/repo/app', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'app', projectPath: '/repo/app', terminalType: 'shell' });

    s.renameCard(a, 'frontend');

    expect(useTerminalStore.getState().getCardById(a)?.projectName).toBe('frontend');
    expect(useTerminalStore.getState().getCardById(b)?.projectName).toBe('app');
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

describe('terminalStore — session dock metadata', () => {
  it('tracks focused cards in most-recent-first order', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    const c = s.createCard({ projectName: 'c', projectPath: '/c', terminalType: 'shell' });

    s.focusCard(a);
    useTerminalStore.getState().focusCard(b);
    useTerminalStore.getState().focusCard(c);
    useTerminalStore.getState().focusCard(b);

    expect(useTerminalStore.getState().recentlyViewedCardIds).toEqual([b, c, a]);
  });

  it('caps the recent session queue', () => {
    const s = useTerminalStore.getState();
    const ids = Array.from({ length: MAX_RECENTLY_VIEWED_CARDS + 3 }, (_, index) =>
      s.createCard({
        projectName: `p${index}`,
        projectPath: `/p${index}`,
        terminalType: 'shell',
      }),
    );

    ids.forEach((id) => useTerminalStore.getState().focusCard(id));

    expect(useTerminalStore.getState().recentlyViewedCardIds).toEqual(
      ids.slice(-MAX_RECENTLY_VIEWED_CARDS).reverse(),
    );
  });

  it('removes deleted and archived cards from the recent session queue', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });
    const c = s.createCard({ projectName: 'c', projectPath: '/c', terminalType: 'shell' });
    [a, b, c].forEach((id) => useTerminalStore.getState().focusCard(id));

    useTerminalStore.getState().removeCard(b);
    expect(useTerminalStore.getState().recentlyViewedCardIds).toEqual([c, a]);

    useTerminalStore.getState().archiveCard(c);
    expect(useTerminalStore.getState().recentlyViewedCardIds).toEqual([a]);
  });

  it('toggles the dock pinned state', () => {
    expect(useTerminalStore.getState().dockPinned).toBe(false);
    useTerminalStore.getState().toggleDockPin();
    expect(useTerminalStore.getState().dockPinned).toBe(true);
    useTerminalStore.getState().toggleDockPin();
    expect(useTerminalStore.getState().dockPinned).toBe(false);
  });

  it('v15 migration defaults session dock metadata and prunes stale recent ids', async () => {
    const v15Snapshot = {
      state: {
        cards: [
          {
            id: 'live',
            ptyId: 'live',
            projectName: 'live',
            projectPath: '/live',
            terminalType: 'shell',
            status: 'running',
            createdAt: 1,
            lastActivity: 2,
            lastOutput: '',
            lastReplyPreview: '',
            messageCount: 0,
            events: [],
            unread: false,
          },
        ],
        archivedCards: [],
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        selectedWorktreePath: null,
        selectedWorktreeLabel: null,
        projectCardOrder: {},
        pinnedCardIds: [],
        recentlyViewedCardIds: ['missing', 'live', 'live'],
        notifications: [],
        notificationCentreOpen: false,
        supervisorEnabled: false,
        osNotificationsEnabled: true,
      },
      version: 15,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(v15Snapshot));

    await useTerminalStore.persist.rehydrate();

    expect(useTerminalStore.getState().dockPinned).toBe(false);
    expect(useTerminalStore.getState().recentlyViewedCardIds).toEqual(['live']);
    localStorage.removeItem('threadterm-terminal-store');
  });
});

describe('terminalStore — project card order', () => {
  it('prepends newly-created cards within their raw project path key', () => {
    const s = useTerminalStore.getState();
    const first = s.createCard({ projectName: 'mac', projectPath: '/Users/me/app', terminalType: 'shell' });
    const second = s.createCard({ projectName: 'mac', projectPath: '/Users/me/app', terminalType: 'shell' });
    const win = s.createCard({ projectName: 'win', projectPath: 'C:\\repo\\app', terminalType: 'shell' });

    expect(useTerminalStore.getState().projectCardOrder['/Users/me/app']).toEqual([
      second,
      first,
    ]);
    expect(useTerminalStore.getState().projectCardOrder['C:\\repo\\app']).toEqual([win]);
  });

  it('moves cards inside one project without affecting other projects', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    const c = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    const other = s.createCard({ projectName: 'p2', projectPath: '/p2', terminalType: 'shell' });

    useTerminalStore.getState().moveProjectCard('/p1', a, 1);

    expect(useTerminalStore.getState().getCardsForProjectView('/p1').map((card) => card.id))
      .toEqual([c, a, b]);
    expect(useTerminalStore.getState().getCardsForProjectView('/p2').map((card) => card.id))
      .toEqual([other]);
  });

  it('cleans deleted cards out of project order', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });

    useTerminalStore.getState().removeCard(a);

    expect(useTerminalStore.getState().projectCardOrder['/p1']).toEqual([b]);
    expect(useTerminalStore.getState().getCardsForProjectView('/p1').map((card) => card.id))
      .toEqual([b]);
  });

  it('uses project order for directory-view shortcuts but keeps all-view store order', () => {
    const s = useTerminalStore.getState();
    const a = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    const b = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });
    const c = s.createCard({ projectName: 'p1', projectPath: '/p1', terminalType: 'shell' });

    useTerminalStore.getState().selectProject('/p1');
    useTerminalStore.getState().jumpToIndex(0);
    expect(useTerminalStore.getState().focusedCardId).toBe(c);

    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(b);

    useTerminalStore.getState().jumpToIndex(2);
    expect(useTerminalStore.getState().focusedCardId).toBe(a);

    useTerminalStore.getState().selectProject(null);
    useTerminalStore.getState().jumpToIndex(0);
    expect(useTerminalStore.getState().focusedCardId).toBe(a);
  });

  it('stores branch labels on created worktree cards', () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'p1',
      projectPath: '/p1',
      worktreePath: '/p1-feature',
      branchLabel: 'feature/worktree-ui',
      terminalType: 'shell',
    });

    expect(useTerminalStore.getState().getCardById(id)).toMatchObject({
      worktreePath: '/p1-feature',
      branchLabel: 'feature/worktree-ui',
    });
  });

  it('selectWorktree scopes project view and selectProject clears the worktree dimension', () => {
    const s = useTerminalStore.getState();
    s.createCard({ projectName: 'root', projectPath: '/p1', terminalType: 'shell' });
    const worktree = s.createCard({
      projectName: 'feature',
      projectPath: '/p1',
      worktreePath: '/p1-feature',
      terminalType: 'shell',
    });

    useTerminalStore.getState().selectWorktree('/p1', '/p1-feature', 'feature/x');

    expect(useTerminalStore.getState().selectedProjectPath).toBe('/p1');
    expect(useTerminalStore.getState().selectedWorktreePath).toBe('/p1-feature');
    expect(useTerminalStore.getState().selectedWorktreeLabel).toBe('feature/x');
    expect(
      useTerminalStore
        .getState()
        .getCardsForProjectView('/p1', '/p1-feature')
        .map((card) => card.id),
    ).toEqual([worktree]);

    useTerminalStore.getState().selectProject('/p1');
    expect(useTerminalStore.getState().selectedProjectPath).toBe('/p1');
    expect(useTerminalStore.getState().selectedWorktreePath).toBeNull();
    expect(useTerminalStore.getState().selectedWorktreeLabel).toBeNull();
  });

  it('uses selected worktree filtering for directory-view shortcuts', () => {
    const s = useTerminalStore.getState();
    s.createCard({ projectName: 'root', projectPath: '/p1', terminalType: 'shell' });
    const first = s.createCard({
      projectName: 'feature',
      projectPath: '/p1',
      worktreePath: '/p1-feature',
      terminalType: 'shell',
    });
    const second = s.createCard({
      projectName: 'feature',
      projectPath: '/p1',
      worktreePath: '/p1-feature',
      terminalType: 'shell',
    });

    useTerminalStore.getState().selectWorktree('/p1', '/p1-feature', 'feature/x');
    useTerminalStore.getState().jumpToIndex(0);
    expect(useTerminalStore.getState().focusedCardId).toBe(second);

    useTerminalStore.getState().nextCard();
    expect(useTerminalStore.getState().focusedCardId).toBe(first);
  });

  it('clears a selected worktree after its last active card is removed', () => {
    const s = useTerminalStore.getState();
    s.createCard({ projectName: 'root', projectPath: '/p1', terminalType: 'shell' });
    const worktree = s.createCard({
      projectName: 'feature',
      projectPath: '/p1',
      worktreePath: '/p1-feature',
      terminalType: 'shell',
    });
    useTerminalStore.getState().selectWorktree('/p1', '/p1-feature', 'feature/x');

    useTerminalStore.getState().removeCard(worktree);

    expect(useTerminalStore.getState().selectedProjectPath).toBe('/p1');
    expect(useTerminalStore.getState().selectedWorktreePath).toBeNull();
    expect(useTerminalStore.getState().selectedWorktreeLabel).toBeNull();
  });

  it('v11 migration defaults projectCardOrder to an empty object', async () => {
    const v11Snapshot = {
      state: {
        cards: [],
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
        supervisorEnabled: false,
        osNotificationsEnabled: true,
      },
      version: 11,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(v11Snapshot));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().projectCardOrder).toEqual({});
    localStorage.removeItem('threadterm-terminal-store');
  });

  it('v12 migration defaults archivedCards to an empty array', async () => {
    const v12Snapshot = {
      state: {
        cards: [],
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        projectCardOrder: {},
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
        supervisorEnabled: false,
        osNotificationsEnabled: true,
      },
      version: 12,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(v12Snapshot));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().archivedCards).toEqual([]);
    localStorage.removeItem('threadterm-terminal-store');
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

  it('highlightCard sets the pulse target and auto-expires', () => {
    vi.useFakeTimers();
    try {
      const s = useTerminalStore.getState();
      const id = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });

      s.highlightCard(id);
      expect(useTerminalStore.getState().highlightCardId).toBe(id);

      vi.advanceTimersByTime(HIGHLIGHT_TTL_MS + 1);
      expect(useTerminalStore.getState().highlightCardId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a newer highlight is not cleared by the previous highlight timer', () => {
    vi.useFakeTimers();
    try {
      const s = useTerminalStore.getState();
      const a = s.createCard({ projectName: 'a', projectPath: '/a', terminalType: 'shell' });
      const b = s.createCard({ projectName: 'b', projectPath: '/b', terminalType: 'shell' });

      s.highlightCard(a);
      vi.advanceTimersByTime(HIGHLIGHT_TTL_MS / 2);
      s.highlightCard(b);

      // Past the first highlight's original deadline — b must survive.
      vi.advanceTimersByTime(HIGHLIGHT_TTL_MS / 2 + 10);
      expect(useTerminalStore.getState().highlightCardId).toBe(b);

      vi.advanceTimersByTime(HIGHLIGHT_TTL_MS);
      expect(useTerminalStore.getState().highlightCardId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('terminalStore — OS notifications', () => {
  it('defaults OS notifications to on', () => {
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(true);
  });

  it('toggles OS notifications', () => {
    useTerminalStore.getState().setOsNotificationsEnabled(false);
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(false);

    useTerminalStore.getState().setOsNotificationsEnabled(true);
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(true);
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
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
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
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
        supervisorEnabled: true,
      },
      version: 9,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(v9Snapshot));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().supervisorEnabled).toBe(true);
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(true);
    // Reset for downstream tests.
    localStorage.removeItem('threadterm-terminal-store');
  });

  it('v17 migration maps a legacy system notificationMode to enabled', async () => {
    // The desktop pet was removed; only the OS-notification preference
    // survives, as a boolean. A persisted notificationMode of 'system'
    // (OS notifications on) must map to true.
    const upgradedSnapshot = {
      state: {
        cards: [],
        focusedCardId: null,
        lastActiveCardId: null,
        selectedProjectPath: null,
        pinnedCardIds: [],
        notifications: [],
        notificationCentreOpen: false,
        supervisorEnabled: false,
        petConfig: {
          enabled: true,
          notificationMode: 'system',
          skin: 'tuxedo',
        },
      },
      version: 10,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(upgradedSnapshot));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(true);
    localStorage.removeItem('threadterm-terminal-store');
  });

  it('v17 migration maps a legacy off/pet notificationMode to disabled', async () => {
    const upgradedSnapshot = {
      state: {
        supervisorEnabled: false,
        petConfig: { enabled: true, notificationMode: 'pet' },
      },
      version: 10,
    };
    localStorage.setItem('threadterm-terminal-store', JSON.stringify(upgradedSnapshot));
    await useTerminalStore.persist.rehydrate();
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(false);
    localStorage.removeItem('threadterm-terminal-store');
  });
});
