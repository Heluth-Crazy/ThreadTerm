import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TerminalView } from './TerminalView';
import type { TerminalCard } from '../../types/terminal';

const shellMock = vi.hoisted(() => ({
  events: [] as string[],
  props: [] as Array<{ paneId?: string; initialCommand?: string }>,
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
});

afterEach(() => {
  cleanup();
});

describe('TerminalView Shell lifecycle', () => {
  it('passes updated pane and command without remounting Shell', () => {
    const first = makeCard();
    const second = makeCard({
      id: 'claude-b',
      ptyId: 'claude-b',
      providerSessionId: '22222222-2222-4222-8222-222222222222',
    });

    const { rerender } = render(<TerminalView card={first} onBack={vi.fn()} />);

    expect(screen.getByTestId('mock-shell')).toHaveAttribute('data-pane-id', 'claude-a');
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      'claude --session-id 11111111-1111-4111-8111-111111111111',
    );

    rerender(<TerminalView card={second} onBack={vi.fn()} />);

    expect(screen.getByTestId('mock-shell')).toHaveAttribute('data-pane-id', 'claude-b');
    expect(screen.getByTestId('mock-shell')).toHaveAttribute(
      'data-initial-command',
      'claude --session-id 22222222-2222-4222-8222-222222222222',
    );
    expect(shellMock.events).toEqual(['mount:claude-a']);
  });
});
