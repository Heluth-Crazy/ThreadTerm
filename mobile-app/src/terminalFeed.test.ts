import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  type ServerMessage,
} from '@shared/mobile/bridge/protocol';
import {
  disposeTerminalFeed,
  getTerminalFeedBacklog,
  getTerminalFeedMemoryUsage,
  observeTerminalFeedSnapshot,
  pushTerminalFeedMessage,
  resetTerminalFeed,
  retainTerminalFeedCards,
  subscribeTerminalFeed,
  TERMINAL_FEED_CARD_BUDGET_BYTES,
  TERMINAL_FEED_GLOBAL_BUDGET_BYTES,
  type TerminalFeedMessage,
  type TerminalFeedOutput,
  type TerminalFeedSnapshot,
} from './terminalFeed';

const snapshot = (
  seq: number,
  data = 'snapshot',
  cardId = 'card-1',
  runtimeId?: string,
  streamSeq?: number,
): TerminalFeedSnapshot => ({
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'terminal_snapshot',
  snapshot: {
    cardId,
    data,
    seq,
    runtimeId,
    streamSeq,
    rows: 24,
    cols: 80,
    cursorRow: 1,
    cursorCol: 1,
    history: '',
  },
});

const output = (
  seq: number,
  data: string,
  cardId = 'card-1',
  runtimeId?: string,
  streamSeq?: number,
): TerminalFeedOutput => ({
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'terminal_output',
  card_id: cardId,
  data,
  seq,
  runtimeId,
  streamSeq,
});

const metadataSnapshot = (
  runtimeId: string,
  streamSeq: number,
  cardIds: string[] = [],
): Extract<ServerMessage, { kind: 'snapshot' }> => ({
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'snapshot',
  cards: cardIds.map((id) => ({
    id,
    projectName: id,
    projectPath: `D:\\${id}`,
    worktreePath: `D:\\${id}`,
    branch: null,
    status: 'running',
    ptyState: 'running',
    ptyLive: true,
    recentOutputBytes: 0,
    lastActivity: 1,
    createdAt: 1,
    summaryLine: null,
    lastReplyPreview: '',
    hiddenLineCount: 0,
    terminalType: 'custom',
    command: null,
    aiIntent: null,
    isPinned: false,
    archivedAt: null,
  })),
  notifications: [],
  runtimeId,
  streamSeq,
});

afterEach(() => {
  resetTerminalFeed();
});

describe('terminalFeed snapshot and output ordering', () => {
  it('retains newer output when a lagging snapshot arrives', () => {
    pushTerminalFeedMessage(snapshot(10));
    pushTerminalFeedMessage(output(11, ' newer'));
    pushTerminalFeedMessage(output(12, ' newest'));

    pushTerminalFeedMessage(snapshot(11, 'lagging snapshot'));

    expect(getTerminalFeedBacklog('card-1')).toEqual([
      snapshot(11, 'lagging snapshot'),
      output(12, ' newest'),
    ]);
  });

  it('drops stale and duplicate output already covered by the card snapshot', () => {
    pushTerminalFeedMessage(snapshot(20, 'ready'));
    pushTerminalFeedMessage(output(19, 'stale'));
    pushTerminalFeedMessage(output(21, 'A'));
    pushTerminalFeedMessage(output(21, 'duplicate'));

    expect(getTerminalFeedBacklog('card-1')).toEqual([
      snapshot(20, 'ready'),
      output(21, 'A'),
    ]);
  });

  it('does not mistake normal cross-card PTY sequence gaps for lost mobile frames', () => {
    observeTerminalFeedSnapshot(metadataSnapshot('runtime-a', 0, ['card-1', 'card-2']));

    const first = pushTerminalFeedMessage(output(10, 'A', 'card-1', 'runtime-a', 1));
    const second = pushTerminalFeedMessage(output(25, 'B', 'card-2', 'runtime-a', 2));

    expect(first.needsResync).toBe(false);
    expect(second.needsResync).toBe(false);
    expect(getTerminalFeedBacklog('card-2')).toEqual([
      output(25, 'B', 'card-2', 'runtime-a', 2),
    ]);
  });
});

describe('terminalFeed bounded memory', () => {
  it('counts UTF-8 bytes rather than JavaScript character count', () => {
    pushTerminalFeedMessage(output(1, '界'));

    expect(getTerminalFeedMemoryUsage().totalOutputBytes).toBe(3);
  });

  it('keeps each card within 4 MiB and exposes one explicit truncation marker', () => {
    const twoMiB = 'x'.repeat(2 * 1024 * 1024);
    pushTerminalFeedMessage(snapshot(1, 'ready'));
    pushTerminalFeedMessage(output(2, twoMiB));
    pushTerminalFeedMessage(output(3, twoMiB));
    pushTerminalFeedMessage(output(4, twoMiB));

    const usage = getTerminalFeedMemoryUsage();
    const backlog = getTerminalFeedBacklog('card-1');
    expect(usage.cards['card-1'].outputBytes).toBeLessThanOrEqual(
      TERMINAL_FEED_CARD_BUDGET_BYTES,
    );
    expect(backlog.filter((message) => message.kind === 'history_truncated')).toHaveLength(1);
    expect(backlog.at(-1)).toEqual(output(4, twoMiB));
  });

  it('keeps all cards together within 32 MiB and trims the least-recent card first', () => {
    const twoMiB = 'x'.repeat(2 * 1024 * 1024);
    for (let cardIndex = 1; cardIndex <= 9; cardIndex += 1) {
      const cardId = `card-${cardIndex}`;
      pushTerminalFeedMessage(output(cardIndex * 10, twoMiB, cardId));
      pushTerminalFeedMessage(output(cardIndex * 10 + 1, twoMiB, cardId));
    }

    const usage = getTerminalFeedMemoryUsage();
    expect(usage.totalOutputBytes).toBeLessThanOrEqual(
      TERMINAL_FEED_GLOBAL_BUDGET_BYTES,
    );
    expect(usage.cards['card-1'].truncated).toBe(true);
    expect(usage.cards['card-9'].outputBytes).toBe(4 * 1024 * 1024);
  });

  it('releases memory when cards are removed or omitted by the latest card list', () => {
    pushTerminalFeedMessage(output(1, 'one', 'card-1'));
    pushTerminalFeedMessage(output(2, 'two', 'card-2'));

    disposeTerminalFeed('card-1');
    expect(getTerminalFeedMemoryUsage().cards['card-1']).toBeUndefined();

    retainTerminalFeedCards([]);
    expect(getTerminalFeedMemoryUsage()).toMatchObject({
      totalOutputBytes: 0,
      cards: {},
    });
  });
});

describe('terminalFeed runtime recovery', () => {
  it('requests one resync when a mobile frame is missing', () => {
    observeTerminalFeedSnapshot(metadataSnapshot('runtime-a', 5, ['card-1']));

    const gap = pushTerminalFeedMessage(output(10, 'A', 'card-1', 'runtime-a', 7));
    const whilePending = pushTerminalFeedMessage(
      output(11, 'B', 'card-1', 'runtime-a', 9),
    );

    expect(gap.needsResync).toBe(true);
    expect(whilePending.needsResync).toBe(false);
    expect(getTerminalFeedMemoryUsage().resyncPending).toBe(true);
  });

  it('drops duplicate transport frames and resumes from the explicit resync baseline', () => {
    observeTerminalFeedSnapshot(metadataSnapshot('runtime-a', 5, ['card-1']));
    pushTerminalFeedMessage(output(10, 'A', 'card-1', 'runtime-a', 6));

    const duplicate = pushTerminalFeedMessage(
      output(11, 'duplicate', 'card-1', 'runtime-a', 6),
    );
    expect(duplicate).toMatchObject({ accepted: false, duplicateTransport: true });

    pushTerminalFeedMessage(output(12, 'gap', 'card-1', 'runtime-a', 8));
    const recovered = observeTerminalFeedSnapshot(
      metadataSnapshot('runtime-a', 8, ['card-1']),
    );
    const next = pushTerminalFeedMessage(output(13, 'next', 'card-1', 'runtime-a', 9));

    expect(recovered.resyncCompleted).toBe(true);
    expect(next).toMatchObject({ accepted: true, needsResync: false });
  });

  it('clears stale output on desktop restart while preserving live subscriptions', () => {
    const listener = vi.fn();
    subscribeTerminalFeed('card-1', listener);
    observeTerminalFeedSnapshot(metadataSnapshot('runtime-a', 0, ['card-1']));
    pushTerminalFeedMessage(snapshot(10, 'OLD', 'card-1', 'runtime-a', 0));
    pushTerminalFeedMessage(output(11, ' old tail', 'card-1', 'runtime-a', 1));

    const restart = observeTerminalFeedSnapshot(
      metadataSnapshot('runtime-b', 0, ['card-1']),
    );
    pushTerminalFeedMessage(snapshot(1, 'NEW', 'card-1', 'runtime-b', 0));

    expect(restart.runtimeChanged).toBe(true);
    expect(getTerminalFeedBacklog('card-1')).toEqual([
      snapshot(1, 'NEW', 'card-1', 'runtime-b', 0),
    ]);
    expect(listener).toHaveBeenLastCalledWith(
      snapshot(1, 'NEW', 'card-1', 'runtime-b', 0),
    );
  });
});

describe('terminalFeed subscriptions', () => {
  it('delivers accepted increments in order and ignores another card', () => {
    const listener = vi.fn();
    subscribeTerminalFeed('card-1', listener);

    pushTerminalFeedMessage(snapshot(1, 'ready'));
    pushTerminalFeedMessage(output(2, 'A'));
    pushTerminalFeedMessage(output(3, 'B', 'card-2'));

    expect(listener.mock.calls.map(([message]) => message as TerminalFeedMessage)).toEqual([
      snapshot(1, 'ready'),
      output(2, 'A'),
    ]);
  });

  it('re-delivers only early output that survives a later snapshot boundary', () => {
    const listener = vi.fn();
    subscribeTerminalFeed('card-1', listener);

    pushTerminalFeedMessage(output(2, 'covered'));
    pushTerminalFeedMessage(output(5, 'survivor'));
    pushTerminalFeedMessage(snapshot(3, 'SNAP'));

    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      output(2, 'covered'),
      output(5, 'survivor'),
      snapshot(3, 'SNAP'),
      output(5, 'survivor'),
    ]);
  });

  it('stops delivery after unsubscribe while preserving replay backlog', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalFeed('card-1', listener);

    pushTerminalFeedMessage(snapshot(1, 'ready'));
    unsubscribe();
    pushTerminalFeedMessage(output(2, 'A'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTerminalFeedBacklog('card-1')).toEqual([
      snapshot(1, 'ready'),
      output(2, 'A'),
    ]);
  });

  it('keeps three high-frequency interleaved streams isolated through card removal', () => {
    const cardIds = ['card-1', 'card-2', 'card-3'];
    const listeners = Object.fromEntries(
      cardIds.map((cardId) => [cardId, vi.fn()]),
    );
    const expected = Object.fromEntries(
      cardIds.map((cardId) => [cardId, [] as TerminalFeedOutput[]]),
    );
    const perCardSeq = Object.fromEntries(cardIds.map((cardId) => [cardId, 0]));

    observeTerminalFeedSnapshot(metadataSnapshot('runtime-a', 0, cardIds));
    for (const cardId of cardIds) {
      subscribeTerminalFeed(cardId, listeners[cardId]);
    }

    for (let streamSeq = 1; streamSeq <= 300; streamSeq += 1) {
      const cardId = cardIds[(streamSeq - 1) % cardIds.length];
      perCardSeq[cardId] += 1;
      const message = output(
        perCardSeq[cardId],
        `${cardId}:${perCardSeq[cardId]}|`,
        cardId,
        'runtime-a',
        streamSeq,
      );
      expected[cardId].push(message);
      expect(pushTerminalFeedMessage(message)).toMatchObject({
        accepted: true,
        needsResync: false,
      });
    }

    for (const cardId of cardIds) {
      expect(
        listeners[cardId].mock.calls.map(([message]) => message),
      ).toEqual(expected[cardId]);
      expect(getTerminalFeedBacklog(cardId)).toEqual(expected[cardId]);
    }
    expect(getTerminalFeedMemoryUsage()).toMatchObject({
      runtimeId: 'runtime-a',
      lastStreamSeq: 300,
      resyncPending: false,
    });

    disposeTerminalFeed('card-2');
    retainTerminalFeedCards(['card-1', 'card-3']);
    const next = output(101, 'card-1:101|', 'card-1', 'runtime-a', 301);
    pushTerminalFeedMessage(next);

    expect(getTerminalFeedMemoryUsage().cards['card-2']).toBeUndefined();
    expect(listeners['card-2']).toHaveBeenCalledTimes(100);
    expect(listeners['card-1']).toHaveBeenLastCalledWith(next);
  });
});
