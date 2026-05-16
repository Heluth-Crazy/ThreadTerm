import { describe, expect, it } from 'vitest';
import { BRIDGE_PROTOCOL_VERSION, type ServerMessage } from '@shared/mobile/bridge/protocol';
import { applyServerMessage, initialBridgeState } from './messages';
import { fallbackTheme } from '../theme';

describe('mobile bridge message reducer', () => {
  it('hydrates cards from snapshot and selects the first active card', () => {
    const message: ServerMessage = {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'snapshot',
      notifications: [],
      cards: [
        {
          id: 'card-1',
          status: 'running',
          projectPath: '/tmp/ThreadTerm',
          projectName: 'ThreadTerm',
          lastReplyPreview: 'ready',
          summaryLine: 'ready',
          hiddenLineCount: 0,
          recentOutputBytes: 42,
        },
      ],
    };

    const state = applyServerMessage(initialBridgeState, message);

    expect(state.activeCardId).toBe('card-1');
    expect(state.ptyStatusByCardId['card-1']).toBe('running');
    expect(state.recentOutputBytesByCardId['card-1']).toBe(42);
  });

  it('dispatches websocket theme messages into theme state', () => {
    const message: ServerMessage = {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'theme',
      ...fallbackTheme,
    };

    const state = applyServerMessage(initialBridgeState, message);

    expect(state.theme).toEqual(fallbackTheme);
  });

  it('keeps card status and notifications visible from incremental messages', () => {
    const hydrated = applyServerMessage(initialBridgeState, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'snapshot',
      notifications: [],
      cards: [
        {
          id: 'card-1',
          status: 'running',
          projectPath: '/tmp/ThreadTerm',
          projectName: 'ThreadTerm',
          lastReplyPreview: 'ready',
          summaryLine: 'ready',
          hiddenLineCount: 0,
          recentOutputBytes: 42,
        },
      ],
    });

    const waiting = applyServerMessage(hydrated, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'state',
      card_id: 'card-1',
      status: 'waiting_for_input',
    });
    const notified = applyServerMessage(waiting, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'notification',
      entry: {
        id: 'n-1',
        cardId: 'card-1',
        kind: 'waiting',
        message: 'Input requested',
        createdAt: 123,
      },
    });

    expect(notified.cards[0]?.status).toBe('waiting_for_input');
    expect(notified.notifications[0]?.message).toBe('Input requested');
  });
});
