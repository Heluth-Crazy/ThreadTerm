import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ClaudeChatView } from './ClaudeChatView';
import { useClaudeChatStore } from '../../stores/claudeChatStore';
import type { TerminalCard } from '../../types/terminal';

const claudeMock = vi.hoisted(() => ({
  eventListener: null as null | ((payload: unknown) => void),
  requestListener: null as null | ((payload: unknown) => void),
  disconnectedListener: null as null | ((payload: unknown) => void),
  probe: vi.fn(),
  start: vi.fn(),
  send: vi.fn(),
  interrupt: vi.fn(),
  decide: vi.fn(),
  stop: vi.fn(),
  history: vi.fn(),
}));

const terminalStoreMock = vi.hoisted(() => ({
  recordUserSubmit: vi.fn(),
  markProviderSessionBound: vi.fn(),
  updateCardReplyPreview: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const t = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return {
    useTranslation: () => ({ t }),
  };
});

vi.mock('../../stores/terminalStore', () => ({
  useTerminalStore: (
    selector: (state: typeof terminalStoreMock) => unknown,
  ) => selector(terminalStoreMock),
}));

vi.mock('../../lib/claudeChat/api', () => ({
  claudeChat: {
    probe: claudeMock.probe,
    start: claudeMock.start,
    send: claudeMock.send,
    interrupt: claudeMock.interrupt,
    decide: claudeMock.decide,
    stop: claudeMock.stop,
    history: claudeMock.history,
    onEvent: vi.fn(async (listener: (payload: unknown) => void) => {
      claudeMock.eventListener = listener;
      return vi.fn();
    }),
    onRequest: vi.fn(async (listener: (payload: unknown) => void) => {
      claudeMock.requestListener = listener;
      return vi.fn();
    }),
    onDisconnected: vi.fn(async (listener: (payload: unknown) => void) => {
      claudeMock.disconnectedListener = listener;
      return vi.fn();
    }),
  },
}));

function makeCard(): TerminalCard {
  return {
    id: 'claude-card',
    ptyId: 'claude-card',
    projectPath: 'D:/project/threadterm',
    projectName: 'ThreadTerm',
    terminalType: 'claude',
    providerSessionState: 'unbound',
    status: 'idle',
    createdAt: 1_700_000_000_000,
    lastActivity: 1_700_000_000_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
  };
}

beforeEach(() => {
  cleanup();
  useClaudeChatStore.setState({ sessions: {} });
  claudeMock.eventListener = null;
  claudeMock.requestListener = null;
  claudeMock.disconnectedListener = null;
  claudeMock.probe.mockReset().mockResolvedValue({ ok: true });
  claudeMock.start.mockReset().mockResolvedValue({ sessionId: null });
  claudeMock.send.mockReset().mockResolvedValue(undefined);
  claudeMock.interrupt.mockReset().mockResolvedValue(undefined);
  claudeMock.decide.mockReset().mockResolvedValue(undefined);
  claudeMock.stop.mockReset().mockResolvedValue(undefined);
  claudeMock.history.mockReset().mockResolvedValue({ totalMessages: 0, messages: [] });
  terminalStoreMock.recordUserSubmit.mockReset();
  terminalStoreMock.markProviderSessionBound.mockReset();
  terminalStoreMock.updateCardReplyPreview.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ClaudeChatView', () => {
  it('starts a card, sends a message, and renders the assistant response', async () => {
    render(<ClaudeChatView card={makeCard()} />);

    await waitFor(() =>
      expect(claudeMock.start).toHaveBeenCalledWith({
        cardId: 'claude-card',
        cwd: 'D:/project/threadterm',
        sessionId: null,
      }),
    );

    const composer = screen.getByPlaceholderText('Message Claude…');
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: 'Find the bug' } });
    fireEvent.click(screen.getByTitle('Send'));

    await waitFor(() =>
      expect(claudeMock.send).toHaveBeenCalledWith(
        'claude-card',
        'Find the bug',
      ),
    );
    expect(terminalStoreMock.recordUserSubmit).toHaveBeenCalledWith(
      'claude-card',
      'Find the bug',
    );
    expect(screen.getByText('Find the bug')).toBeInTheDocument();

    act(() => {
      claudeMock.eventListener?.({
        ev: 'session.event',
        cardId: 'claude-card',
        message: {
          type: 'assistant',
          message: {
            id: 'message-1',
            content: [{ type: 'text', text: 'The issue is here.' }],
          },
        },
      });
    });
    expect(screen.getByText('The issue is here.')).toBeInTheDocument();
    expect(terminalStoreMock.updateCardReplyPreview).toHaveBeenCalledWith(
      'claude-card',
      'The issue is here.',
    );
  });

  it('hydrates persisted history before resuming a bound card', async () => {
    claudeMock.history.mockResolvedValue({
      totalMessages: 1_250,
      messages: [
        {
          type: 'assistant',
          message: {
            id: 'historical-message',
            content: [{ type: 'text', text: 'Persisted answer' }],
          },
        },
      ],
    });
    const card = {
      ...makeCard(),
      providerSessionId: 'session-history',
      providerSessionState: 'bound' as const,
    };

    render(<ClaudeChatView card={card} />);

    await waitFor(() =>
      expect(claudeMock.history).toHaveBeenCalledWith('session-history', 'D:/project/threadterm', 2_000),
    );
    expect(await screen.findByText('Persisted answer')).toBeInTheDocument();
    expect(claudeMock.start).toHaveBeenCalledWith({
      cardId: 'claude-card',
      cwd: 'D:/project/threadterm',
      sessionId: 'session-history',
    });
  });

  it('mounts at most 160 history rows while keeping older pages reachable', async () => {
    const messages = Array.from({ length: 1_001 }, (_, index) => ({
      type: 'assistant',
      message: {
        id: `message-${index}`,
        content: [{ type: 'text', text: `reply-${index}` }],
      },
    }));
    const store = useClaudeChatStore.getState();
    store.hydrateHistory('claude-card', messages, messages.length);
    store.markStarted('claude-card');

    const view = render(<ClaudeChatView card={makeCard()} />);

    expect(await screen.findByText('reply-1000')).toBeInTheDocument();
    expect(screen.queryByText('reply-0')).not.toBeInTheDocument();
    expect(view.container.querySelectorAll('[class*="whitespace-pre-wrap"]').length).toBeLessThanOrEqual(160);

    fireEvent.click(screen.getByTestId('conversation-window-older'));

    expect(await screen.findByText('reply-840')).toBeInTheDocument();
    expect(screen.queryByText('reply-1000')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-window-newer')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-window-latest')).toBeInTheDocument();
  });

  it('binds the ready session and resolves queued tool approval', async () => {
    render(<ClaudeChatView card={makeCard()} />);
    await waitFor(() => expect(claudeMock.start).toHaveBeenCalled());

    act(() => {
      claudeMock.eventListener?.({
        ev: 'session.status',
        cardId: 'claude-card',
        phase: 'ready',
        sessionId: 'session-ready',
      });
      claudeMock.requestListener?.({
        ev: 'session.request',
        cardId: 'claude-card',
        requestId: 'request-1',
        kind: 'can_use_tool',
        toolName: 'Bash',
        input: { command: 'npm test' },
      });
    });

    expect(terminalStoreMock.markProviderSessionBound).toHaveBeenCalledWith(
      'claude-card',
      'session-ready',
    );
    expect(screen.getByText('Claude needs permission')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() =>
      expect(claudeMock.decide).toHaveBeenCalledWith({
        cardId: 'claude-card',
        requestId: 'request-1',
        behavior: 'allow',
        updatedInput: { command: 'npm test' },
        message: undefined,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText('Claude needs permission'),
      ).not.toBeInTheDocument(),
    );
  });
});
