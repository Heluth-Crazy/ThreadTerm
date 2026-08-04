import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  type MobileWorkbenchProjection,
  type ServerMessage,
} from '@shared/mobile/bridge/protocol';
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

  it('applies mobile control result messages', () => {
    const hydrated = applyServerMessage(initialBridgeState, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'snapshot',
      notifications: [],
      cards: [
        {
          id: 'card-1',
          status: 'idle',
          projectPath: '/tmp/ThreadTerm',
          projectName: 'ThreadTerm',
          lastReplyPreview: '',
          summaryLine: null,
          hiddenLineCount: 0,
          recentOutputBytes: 0,
          ptyLive: false,
          attachable: true,
        },
      ],
    });

    const activated = applyServerMessage(hydrated, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'activate_result',
      request_id: 'req-1',
      ok: true,
      card_id: 'card-1',
    });
    const timedOut = applyServerMessage(activated, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'close_result',
      request_id: 'req-timeout',
      ok: false,
      card_id: 'card-1',
      outcome: 'timed_out',
      attempt_id: 'attempt-1',
      stage: 'agent_exit',
      message: 'Still running',
    });
    const inProgress = applyServerMessage(timedOut, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'close_result',
      request_id: 'req-progress',
      ok: true,
      card_id: 'card-1',
      outcome: 'in_progress',
      attempt_id: 'attempt-1',
      stage: 'agent_exit',
    });
    const closed = applyServerMessage(inProgress, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'close_result',
      request_id: 'req-2',
      ok: true,
      card_id: 'card-1',
      outcome: 'ended',
      attempt_id: 'attempt-1',
      stage: 'shell_exit',
    });

    expect(activated.activeCardId).toBe('card-1');
    expect(timedOut.cards).toHaveLength(1);
    expect(timedOut.lastError).toBeNull();
    expect(inProgress.cards).toHaveLength(1);
    expect(closed.cards).toEqual([]);
    expect(closed.activeCardId).toBeNull();
  });

  it('hydrates the recoverable workbench projection and clears stale data when absent', () => {
    const workbench: MobileWorkbenchProjection = {
      generatedAt: 123,
      summary: { attention: 1, normalRunning: 2, review: 0, failed: 0 },
      attentionItems: [],
      executionGroups: [],
      rules: {
        includeWaiting: true,
        includeFailed: true,
        includeCompletedReview: true,
        stalledEnabled: true,
        stalledThresholdMinutes: 15,
        stalledExcludedCount: 0,
      },
      capabilities: {
        openTerminal: true,
        respondToStructuredRequest: false,
        updateRules: false,
        updateNotificationReadState: false,
      },
    };
    const hydrated = applyServerMessage(initialBridgeState, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'snapshot',
      cards: [],
      notifications: [],
      workbench,
    });

    expect(hydrated.workbench).toEqual(workbench);

    const legacySnapshot = applyServerMessage(hydrated, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'snapshot',
      cards: [],
      notifications: [],
    });
    expect(legacySnapshot.workbench).toBeNull();
  });

  it('removes card-scoped status and output caches with a card_removed event', () => {
    const cardOne = {
      id: 'card-1',
      status: 'running' as const,
      projectPath: '/tmp/one',
      projectName: 'one',
      lastReplyPreview: 'one',
      summaryLine: 'one',
      hiddenLineCount: 0,
      recentOutputBytes: 11,
    };
    const cardTwo = {
      id: 'card-2',
      status: 'idle' as const,
      projectPath: '/tmp/two',
      projectName: 'two',
      lastReplyPreview: 'two',
      summaryLine: 'two',
      hiddenLineCount: 0,
      recentOutputBytes: 22,
    };
    const hydrated = applyServerMessage(initialBridgeState, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'snapshot',
      notifications: [],
      cards: [cardOne, cardTwo],
    });

    const removed = applyServerMessage(hydrated, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'card_removed',
      card: cardOne,
    });

    expect(removed.cards.map((card) => card.id)).toEqual(['card-2']);
    expect(removed.activeCardId).toBe('card-2');
    expect(removed.ptyStatusByCardId).toEqual({ 'card-2': 'idle' });
    expect(removed.recentOutputBytesByCardId).toEqual({ 'card-2': 22 });
  });

  // ── FIX-1 (deep-research-defect-fix / second-diagnosis 问题二) ──────────
  function hydrateOneCard(status: 'running' | 'idle' | 'waiting_for_input') {
    return applyServerMessage(initialBridgeState, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'snapshot',
      notifications: [],
      cards: [
        {
          id: 'card-1',
          status,
          projectPath: '/tmp/ThreadTerm',
          projectName: 'ThreadTerm',
          lastReplyPreview: '',
          summaryLine: null,
          hiddenLineCount: 0,
          recentOutputBytes: 0,
          ptyLive: true,
          ptyState: status,
          attachable: true,
        },
      ],
    });
  }

  it('FIX-1: exit(code=0) marks the card completed', () => {
    const exited = applyServerMessage(hydrateOneCard('running'), {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'exit',
      card_id: 'card-1',
      code: 0,
    });
    expect(exited.cards[0]?.status).toBe('completed');
    expect(exited.cards[0]?.ptyState).toBe('completed');
    expect(exited.ptyStatusByCardId['card-1']).toBe('completed');
  });

  it('FIX-1: exit(code=null) maps to idle, not completed (cross-platform parity)', () => {
    const exited = applyServerMessage(hydrateOneCard('running'), {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'exit',
      card_id: 'card-1',
      code: null,
    });
    expect(exited.cards[0]?.status).toBe('idle');
    expect(exited.cards[0]?.ptyState).toBe('idle');
    expect(exited.ptyStatusByCardId['card-1']).toBe('idle');
  });

  it('FIX-1: exit(code=137) marks the card failed', () => {
    const exited = applyServerMessage(hydrateOneCard('running'), {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'exit',
      card_id: 'card-1',
      code: 137,
    });
    expect(exited.cards[0]?.status).toBe('failed');
    expect(exited.cards[0]?.ptyState).toBe('failed');
    expect(exited.ptyStatusByCardId['card-1']).toBe('failed');
  });

  it('FIX-1: authoritative state(idle) is not flipped to completed by a later exit(null)', () => {
    const idle = applyServerMessage(hydrateOneCard('running'), {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'state',
      card_id: 'card-1',
      status: 'idle',
    });
    const afterExit = applyServerMessage(idle, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'exit',
      card_id: 'card-1',
      code: null,
    });
    expect(afterExit.cards[0]?.status).toBe('idle');
    expect(afterExit.cards[0]?.ptyState).toBe('idle');
    expect(afterExit.ptyStatusByCardId['card-1']).toBe('idle');
  });
});
