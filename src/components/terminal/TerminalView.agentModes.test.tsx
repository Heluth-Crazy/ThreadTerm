import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getClaudeChatMock,
  makeCard,
  TestTerminalView as TerminalView,
} from './TerminalView.testHarness';

const claudeChatMock = getClaudeChatMock();

describe('TerminalView Agent modes', () => {
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
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-resume-loading',
      'true',
    );
  });

  it.each([
    ['claude', '11111111-1111-4111-8111-111111111111'],
    ['codex', '019f7fa3-f711-7553-83cf-d83df858ffd8'],
    ['opencode', 'oc-session-1'],
    ['gemini', 'gemini-session-1'],
  ] as const)(
    'enables the shared history progress for a bound %s session',
    (terminalType, providerSessionId) => {
      render(
        <TerminalView
          card={makeCard({
            id: `${terminalType}-resume`,
            ptyId: `${terminalType}-resume`,
            terminalType,
            providerSessionId,
            providerSessionState: 'bound',
          })}
          onBack={vi.fn()}
          onRemoveCard={async () => true}
          onArchiveCard={async () => true}
        />,
      );

      expect(screen.getByTestId('mock-shell')).toHaveAttribute(
        'data-resume-loading',
        'true',
      );
    },
  );

  it('does not enable history progress for a new Agent session', () => {
    render(
      <TerminalView
        card={makeCard()}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-resume-loading',
      'false',
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

  it('opens a custom Codex command in terminal mode', () => {
    render(
      <TerminalView
        card={makeCard({
          id: 'custom-codex',
          ptyId: 'custom-codex',
          terminalType: 'codex',
          command: 'codex --no-alt-screen',
          providerSessionId: undefined,
          providerSessionState: 'unbound',
        })}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      'codex --no-alt-screen',
    );
    expect(screen.queryByTestId('mock-codex-chat')).not.toBeInTheDocument();
  });

  it('reveals an unbound Codex terminal immediately after configuration apply', () => {
    render(
      <TerminalView
        card={makeCard({
          id: 'revealed-codex',
          ptyId: 'revealed-codex',
          terminalType: 'codex',
          providerSessionId: undefined,
          providerSessionState: 'unbound',
        })}
        revealTerminalToken={1}
        onBack={vi.fn()}
        onRemoveCard={async () => true}
        onArchiveCard={async () => true}
      />,
    );

    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-codex-chat')).not.toBeInTheDocument();
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

});
