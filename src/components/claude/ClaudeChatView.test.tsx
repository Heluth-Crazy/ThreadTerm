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
