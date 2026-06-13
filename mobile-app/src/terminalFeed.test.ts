import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL_VERSION } from '@shared/mobile/bridge/protocol';
import {
  getTerminalFeedBacklog,
  pushTerminalFeedMessage,
  resetTerminalFeed,
  subscribeTerminalFeed,
  type TerminalFeedMessage,
} from './terminalFeed';

const snapshot = (seq: number, data = 'snapshot', cardId = 'card-1'): TerminalFeedMessage => ({
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'terminal_snapshot',
  snapshot: {
    cardId,
    data,
    seq,
    rows: 24,
    cols: 80,
    cursorRow: 1,
    cursorCol: 1,
    history: '',
  },
});

const output = (seq: number, data: string, cardId = 'card-1'): TerminalFeedMessage => ({
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'terminal_output',
  card_id: cardId,
  data,
  seq,
});

afterEach(() => {
  resetTerminalFeed();
});

// Bucket semantics carried over verbatim from the retired
// terminalTranscript.appendTerminalMessage (issue-5 / backpressure D1 era).
describe('terminalFeed push semantics', () => {
  it('retains newer output when a lag snapshot arrives behind the stream', () => {
    pushTerminalFeedMessage(snapshot(10));
    pushTerminalFeedMessage(output(11, ' newer'));
    pushTerminalFeedMessage(output(12, ' newest'));

    pushTerminalFeedMessage(snapshot(11, 'lagging snapshot'));

    expect(getTerminalFeedBacklog('card-1')).toEqual([
      snapshot(11, 'lagging snapshot'),
      output(12, ' newest'),
    ]);
  });

  it('drops stale output already covered by the latest snapshot', () => {
    pushTerminalFeedMessage(snapshot(20, 'ready'));

    pushTerminalFeedMessage(output(19, 'stale'));

    expect(getTerminalFeedBacklog('card-1')).toEqual([snapshot(20, 'ready')]);
  });

  it('preserves the latest snapshot when a card emits more than the transcript cap', () => {
    pushTerminalFeedMessage(snapshot(1, 'ready'));

    for (let index = 0; index < 2100; index += 1) {
      pushTerminalFeedMessage(output(index + 2, `chunk-${index}`));
    }

    const backlog = getTerminalFeedBacklog('card-1');
    expect(backlog).toHaveLength(2000);
    expect(backlog[0]).toEqual(snapshot(1, 'ready'));
    expect(backlog[backlog.length - 1]).toEqual(output(2101, 'chunk-2099'));
  });

  it('caps retained outputs even before any snapshot arrives', () => {
    for (let index = 0; index < 2100; index += 1) {
      pushTerminalFeedMessage(output(index + 1, `chunk-${index}`));
    }

    const backlog = getTerminalFeedBacklog('card-1');
    expect(backlog).toHaveLength(2000);
    expect(backlog[0]).toEqual(output(101, 'chunk-100'));
    expect(backlog[backlog.length - 1]).toEqual(output(2100, 'chunk-2099'));
  });

  it('de-dups outputs whose seq was already recorded', () => {
    pushTerminalFeedMessage(snapshot(1, 'ready'));
    pushTerminalFeedMessage(output(2, 'A'));

    pushTerminalFeedMessage(output(2, 'A-duplicate'));
    pushTerminalFeedMessage(output(1, 'out-of-order'));

    expect(getTerminalFeedBacklog('card-1')).toEqual([snapshot(1, 'ready'), output(2, 'A')]);
  });

  it('isolates buckets per card', () => {
    pushTerminalFeedMessage(snapshot(1, 'one', 'card-1'));
    pushTerminalFeedMessage(output(2, 'A', 'card-1'));
    pushTerminalFeedMessage(snapshot(9, 'two', 'card-2'));

    // card-2's snapshot must not prune or replace card-1's transcript.
    expect(getTerminalFeedBacklog('card-1')).toEqual([
      snapshot(1, 'one', 'card-1'),
      output(2, 'A', 'card-1'),
    ]);
    expect(getTerminalFeedBacklog('card-2')).toEqual([snapshot(9, 'two', 'card-2')]);
    expect(getTerminalFeedBacklog('card-3')).toEqual([]);
  });
});

describe('terminalFeed subscriptions', () => {
  it('delivers accepted increments to the card subscriber in order', () => {
    const listener = vi.fn();
    subscribeTerminalFeed('card-1', listener);

    pushTerminalFeedMessage(snapshot(1, 'ready'));
    pushTerminalFeedMessage(output(2, 'A'));
    pushTerminalFeedMessage(output(3, 'B'));

    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      snapshot(1, 'ready'),
      output(2, 'A'),
      output(3, 'B'),
    ]);
  });

  it('does not notify for stale or duplicate outputs', () => {
    const listener = vi.fn();
    subscribeTerminalFeed('card-1', listener);

    pushTerminalFeedMessage(snapshot(10, 'ready'));
    pushTerminalFeedMessage(output(11, 'A'));
    pushTerminalFeedMessage(output(9, 'covered-by-snapshot'));
    pushTerminalFeedMessage(output(11, 'duplicate'));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalledWith(output(9, 'covered-by-snapshot'));
    expect(listener).not.toHaveBeenCalledWith(output(11, 'duplicate'));
  });

  it('does not notify a subscriber of another card', () => {
    const listener = vi.fn();
    subscribeTerminalFeed('card-2', listener);

    pushTerminalFeedMessage(snapshot(1, 'ready', 'card-1'));
    pushTerminalFeedMessage(output(2, 'A', 'card-1'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('re-delivers retained outputs after a snapshot lands (pre-snapshot early output)', () => {
    // MainTerminal skips outputs that arrive before the first snapshot (no
    // source dimensions yet) but the bucket keeps them. The old array-replay
    // model re-applied them once the snapshot landed; the feed must therefore
    // re-deliver survivors right after the snapshot so live subscribers can
    // catch up. Subscribers that already wrote them no-op via their seq guard.
    const listener = vi.fn();
    subscribeTerminalFeed('card-1', listener);

    pushTerminalFeedMessage(output(5, 'EARLY'));
    pushTerminalFeedMessage(snapshot(1, 'SNAP'));

    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      output(5, 'EARLY'),
      snapshot(1, 'SNAP'),
      output(5, 'EARLY'),
    ]);
  });

  it('re-delivers only outputs that survive the snapshot seq boundary', () => {
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

  it('stops delivery after unsubscribe while keeping the bucket for backlog', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalFeed('card-1', listener);

    pushTerminalFeedMessage(snapshot(1, 'ready'));
    unsubscribe();
    pushTerminalFeedMessage(output(2, 'A'));

    expect(listener).toHaveBeenCalledTimes(1);
    // The transcript survives unsubscribe so a remounted surface can replay.
    expect(getTerminalFeedBacklog('card-1')).toEqual([snapshot(1, 'ready'), output(2, 'A')]);
  });
});
