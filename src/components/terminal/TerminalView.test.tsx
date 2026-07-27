import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TerminalView } from './TerminalView';
import type { TerminalCard } from '../../types/terminal';

const shellMock = vi.hoisted(() => ({
  events: [] as string[],
  props: [] as Array<{ paneId?: string; initialCommand?: string }>,
}));

const claudeChatMock = vi.hoisted(() => ({
  probe: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: unknown) => {
        if (opts && typeof opts === 'object' && 'defaultValue' in opts) {
          return (opts as { defaultValue: string }).defaultValue;
        }
        if (key === 'view.footer') return '0 messages';
        if (key === 'view.sentInput') return 'Sent input';
        if (typeof opts === 'string') return opts;
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

vi.mock('./Shell', async () => {
  const React = await import('react');
  function MockShell(props: { paneId?: string; initialCommand?: string }) {
    const initialPaneIdRef = React.useRef(props.paneId);
    React.useEffect(() => {
      const paneId = initialPaneIdRef.current;
      shellMock.events.push(`mount:${paneId ?? ''}`);
      return () => {
        shellMock.events.push(`unmount:${paneId ?? ''}`);
      };
    }, []);
    shellMock.props.push({
      paneId: props.paneId,
      initialCommand: props.initialCommand,
    });
    return React.createElement('div', {
      'data-testid': 'mock-shell',
      'data-pane-id': props.paneId,
      'data-initial-command': props.initialCommand ?? '',
    });
  }

  return {
    default: MockShell,
  };
});

vi.mock('../codex/CodexChatView', () => ({
  CodexChatView: () => <div data-testid="mock-codex-chat" />,
}));

vi.mock('../claude/ClaudeChatView', () => ({
  ClaudeChatView: () => <div data-testid="mock-claude-chat" />,
}));

vi.mock('../../lib/claudeChat/api', () => ({
  claudeChat: {
    probe: claudeChatMock.probe,
  },
}));

vi.mock('./AutoRestartControls', () => ({
  AutoRestartControls: () => <div data-testid="mock-auto-restart-controls" />,
}));

vi.mock('./AutoRestartStatus', () => ({
  AutoRestartStatus: () => <div data-testid="mock-auto-restart-status" />,
}));

vi.mock('./AiIntentSelect', () => ({
  AiIntentSelect: () => <div data-testid="mock-ai-intent-select" />,
}));

function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'claude-a',
    ptyId: 'claude-a',
    projectPath: '/repo/threadterm',
    projectName: 'ThreadTerm',
    terminalType: 'claude',
    providerSessionId: '11111111-1111-4111-8111-111111111111',
    providerSessionState: 'unbound',
    status: 'idle',
    createdAt: 1_700_000_000_000,
    lastActivity: 1_700_000_060_000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

beforeEach(() => {
  shellMock.events.length = 0;
  shellMock.props.length = 0;
  claudeChatMock.probe
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
});

describe('TerminalView Shell lifecycle', () => {
  it('does not rerender the terminal when an unrelated parent update keeps its props unchanged', () => {
    const card = makeCard();
    const onBack = vi.fn();
    const onRemoveCard = vi.fn().mockResolvedValue(true);
    const onArchiveCard = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <TerminalView
        card={card}
        onBack={onBack}
        onRemoveCard={onRemoveCard}
        onArchiveCard={onArchiveCard}
      />,
    );

    expect(shellMock.props).toHaveLength(1);
    rerender(
      <TerminalView
        card={card}
        onBack={onBack}
        onRemoveCard={onRemoveCard}
        onArchiveCard={onArchiveCard}
      />,
    );

    expect(shellMock.props).toHaveLength(1);
    expect(shellMock.events).toEqual(['mount:claude-a']);
  });

  it('passes updated pane and command without remounting Shell', () => {
    const first = makeCard();
    const second = makeCard({
      id: 'claude-b',
      ptyId: 'claude-b',
      providerSessionId: '22222222-2222-4222-8222-222222222222',
    });

    const { rerender } = render(
      <TerminalView
        card={first}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-shell')).toHaveAttribute('data-pane-id', 'claude-a');
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      'claude --session-id 11111111-1111-4111-8111-111111111111',
    );

    rerender(
      <TerminalView
        card={second}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-shell')).toHaveAttribute('data-pane-id', 'claude-b');
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      'claude --session-id 22222222-2222-4222-8222-222222222222',
    );
    expect(shellMock.events).toEqual(['mount:claude-a']);
  });

  it('opens a restored Codex history in terminal mode and resumes its bound id', () => {
    const sessionId = '019f7fa3-f711-7553-83cf-d83df858ffd8';
    render(
      <TerminalView
        card={makeCard({
          id: 'restored-codex',
          ptyId: sessionId,
          terminalType: 'codex',
          providerSessionId: sessionId,
          providerSessionState: 'bound',
        })}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.queryByTestId('mock-codex-chat')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      `codex resume ${sessionId} --no-alt-screen`,
    );
  });

  it('keeps a new unbound Codex card in chat mode', () => {
    render(
      <TerminalView
        card={makeCard({
          id: 'new-codex',
          ptyId: 'new-codex',
          terminalType: 'codex',
          providerSessionId: undefined,
          providerSessionState: 'unbound',
        })}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-codex-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-shell')).not.toBeInTheDocument();
  });

  it('shows the Claude Chat entry and opens it after the environment probe succeeds', async () => {
    claudeChatMock.probe.mockReset().mockResolvedValue({ ok: true });
    render(
      <TerminalView
        card={makeCard()}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    const chatButton = screen.getByTitle('Checking Claude Chat availability…');
    expect(chatButton).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByTitle('Claude Chat mode')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTitle('Claude Chat mode'));

    expect(screen.getByTestId('mock-claude-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-shell')).not.toBeInTheDocument();
  });

  it('navigates back only after the guarded close or archive action succeeds', async () => {
    const onBack = vi.fn();
    const onRemoveCard = vi.fn().mockResolvedValue(false);
    const onArchiveCard = vi.fn().mockResolvedValue(true);
    render(
      <TerminalView
        card={makeCard()}
        onBack={onBack}
        onRemoveCard={onRemoveCard}
        onArchiveCard={onArchiveCard}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'view.closeTerminal' }));
    await waitFor(() => expect(onRemoveCard).toHaveBeenCalledWith('claude-a'));
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'view.archiveTerminal' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(onArchiveCard).toHaveBeenCalledWith('claude-a');
  });
});
