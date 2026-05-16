import { describe, expect, it } from 'vitest';
import { BRIDGE_PROTOCOL_VERSION } from '@shared/mobile/bridge/protocol';
import { appendTerminalMessage, type TerminalTranscriptMessage } from './terminalTranscript';

const snapshot = (seq: number, data = 'snapshot'): TerminalTranscriptMessage => ({
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'terminal_snapshot',
  snapshot: {
    cardId: 'card-1',
    data,
    seq,
    rows: 24,
    cols: 80,
    cursorRow: 1,
    cursorCol: 1,
    history: '',
  },
});

const output = (seq: number, data: string): TerminalTranscriptMessage => ({
  protocol_version: BRIDGE_PROTOCOL_VERSION,
  kind: 'terminal_output',
  card_id: 'card-1',
  data,
  seq,
});

describe('terminal transcript source of truth', () => {
  it('retains newer output when a lag snapshot arrives behind the stream', () => {
    const current = [snapshot(10), output(11, ' newer'), output(12, ' newest')];

    const next = appendTerminalMessage(current, snapshot(11, 'lagging snapshot'));

    expect(next).toEqual([snapshot(11, 'lagging snapshot'), output(12, ' newest')]);
  });

  it('drops stale output already covered by the latest snapshot', () => {
    const current = [snapshot(20, 'ready')];

    expect(appendTerminalMessage(current, output(19, 'stale'))).toBe(current);
  });
});
