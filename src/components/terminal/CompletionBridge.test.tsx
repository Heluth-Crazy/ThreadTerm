import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeChatEventPayload,
} from '../../lib/claudeChat/api';
import type { CodexAppNotificationPayload } from '../../lib/tauri-bridge';
import type { TerminalCard } from '../../types/terminal';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  CompletionBridge,
  completionSignalFromClaudePayload,
  completionSignalFromCodexPayload,
} from './CompletionBridge';

type CodexHandler = (payload: CodexAppNotificationPayload) => void;
type ClaudeHandler = (payload: ClaudeChatEventPayload) => void;

const bridgeMocks = vi.hoisted(() => ({
  codexHandlers: [] as Array<(payload: unknown) => void>,
  claudeHandlers: [] as Array<(payload: unknown) => void>,
  codexUnlisteners: [] as Array<ReturnType<typeof vi.fn>>,
  claudeUnlisteners: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  codexApp: {
    onNotification: vi.fn((handler: (payload: unknown) => void) => {
      bridgeMocks.codexHandlers.push(handler);
      const unlisten = vi.fn();
      bridgeMocks.codexUnlisteners.push(unlisten);
      return Promise.resolve(unlisten);
    }),
  },
}));

vi.mock('../../lib/claudeChat/api', () => ({
  claudeChat: {
    onEvent: vi.fn((handler: (payload: unknown) => void) => {
      bridgeMocks.claudeHandlers.push(handler);
      const unlisten = vi.fn();
      bridgeMocks.claudeUnlisteners.push(unlisten);
      return Promise.resolve(unlisten);
    }),
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

function makeCard(id: string, terminalType: 'codex' | 'claude'): TerminalCard {
  return {
    id,
    ptyId: id,
    projectPath: `/repo/${id}`,
    projectName: id,
    terminalType,
    status: 'idle',
    createdAt: 1_700_000_000_000,
    lastActivity: 1_700_000_000_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 1,
    events: [],
    unread: false,
  };
}

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    notifications: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
  });
}

function emitCodex(payload: CodexAppNotificationPayload) {
  for (const handler of bridgeMocks.codexHandlers as CodexHandler[]) handler(payload);
}

function emitClaude(payload: ClaudeChatEventPayload) {
  for (const handler of bridgeMocks.claudeHandlers as ClaudeHandler[]) handler(payload);
}

beforeEach(() => {
  cleanup();
  resetStore();
  bridgeMocks.codexHandlers.length = 0;
  bridgeMocks.claudeHandlers.length = 0;
  bridgeMocks.codexUnlisteners.length = 0;
  bridgeMocks.claudeUnlisteners.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('CompletionBridge', () => {
  it('keeps structured listeners application-scoped and singleton', async () => {
    const view = render(
      <>
        <CompletionBridge />
        <CompletionBridge />
      </>,
    );

    await waitFor(() => {
      expect(bridgeMocks.codexHandlers).toHaveLength(1);
      expect(bridgeMocks.claudeHandlers).toHaveLength(1);
    });

    view.unmount();
    await waitFor(() => {
      expect(bridgeMocks.codexUnlisteners[0]).toHaveBeenCalledTimes(1);
      expect(bridgeMocks.claudeUnlisteners[0]).toHaveBeenCalledTimes(1);
    });
  });

  it('ingests hidden-view Codex and Claude results once per episode', async () => {
    const codexCard = makeCard('codex-card', 'codex');
    const claudeCard = makeCard('claude-card', 'claude');
    useTerminalStore.setState({ cards: [codexCard, claudeCard] });
    render(<CompletionBridge />);

    await waitFor(() => {
      expect(bridgeMocks.codexHandlers).toHaveLength(1);
      expect(bridgeMocks.claudeHandlers).toHaveLength(1);
    });

    emitCodex({
      cardId: codexCard.id,
      method: 'turn/completed',
      params: {
        threadId: 'thread-codex',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [{ type: 'agentMessage', text: 'Codex finished' }],
        },
      },
      raw: null,
    });
    emitCodex({
      cardId: codexCard.id,
      method: 'turn/completed',
      params: {
        threadId: 'thread-codex',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [{ type: 'agentMessage', text: 'Codex finished' }],
        },
      },
      raw: null,
    });
    emitClaude({
      ev: 'session.event',
      cardId: claudeCard.id,
      message: {
        type: 'result',
        subtype: 'success',
        uuid: 'result-1',
        result: 'Claude finished',
      },
    });

    const notifications = useTerminalStore.getState().notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      cardId: claudeCard.id,
      kind: 'completed',
      body: 'Claude finished',
      routing: {
        signalSource: 'claude_chat',
        confidence: 'authoritative',
      },
    });
    expect(notifications[1]).toMatchObject({
      cardId: codexCard.id,
      kind: 'completed',
      body: 'Codex finished',
      routing: {
        signalSource: 'codex_chat',
        confidence: 'authoritative',
      },
    });
  });

  it('maps explicit structured failure states without masquerading as success', () => {
    const card = makeCard('codex-card', 'codex');
    const signal = completionSignalFromCodexPayload(
      {
        cardId: card.id,
        method: 'turn/completed',
        params: {
          threadId: 'thread-codex',
          turn: { id: 'turn-failed', status: 'failed', error: 'provider failed' },
        },
        raw: null,
      },
      [card],
      42,
    );

    expect(signal).toMatchObject({
      cardId: card.id,
      outcome: 'failed',
      source: 'codex_chat',
      confidence: 'authoritative',
      at: 42,
    });
    expect(signal?.summary).toBe('provider failed');
    expect(completionSignalFromClaudePayload(
      {
        ev: 'session.event',
        cardId: card.id,
        message: { type: 'result', subtype: 'error', is_error: true, error: 'bad result' },
      },
      [card],
      43,
    )?.outcome).toBe('failed');
  });
});
