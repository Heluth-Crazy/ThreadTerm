import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TerminalCardComponent } from './TerminalCard';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';

const saveAiSessionMarkdownFileMock = vi.fn();
vi.mock('../../lib/ai/tauriAiSessionExport', () => ({
  saveAiSessionMarkdownFile: (...args: unknown[]) => saveAiSessionMarkdownFileMock(...args),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
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
        if (key === 'card.worktree' && opts && typeof opts === 'object' && 'path' in opts) {
          return `worktree: ${(opts as { path: string }).path}`;
        }
        if (typeof opts === 'string') return opts;
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  return {
    id: 'card-claude',
    ptyId: 'card-claude',
    projectPath: '/repo/threadterm',
    projectName: 'ThreadTerm',
    terminalType: 'claude',
    providerSessionId: '11111111-1111-4111-8111-111111111111',
    providerSessionState: 'bound',
    aiIntent: 'review',
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
  saveAiSessionMarkdownFileMock.mockReset();
  saveAiSessionMarkdownFileMock.mockResolvedValue({ kind: 'saved', path: '/tmp/threadterm-ai.md' });
  useTerminalStore.setState({
    pinnedCardIds: [],
    pendingTerminalConfigurations: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('TerminalCardComponent AI session export', () => {
  it('shows the branch label as the card ownership strip', () => {
    render(
      <TerminalCardComponent
        card={makeCard({
          worktreePath: '/repo/threadterm-feature',
          branchLabel: 'feature/worktree-ui',
        })}
        isFocused={false}
      />,
    );

    expect(screen.getByText('worktree: feature/worktree-ui')).toBeInTheDocument();
  });

  it('shows the card status badge in the ownership strip', () => {
    render(<TerminalCardComponent card={makeCard({ status: 'waiting' })} isFocused={false} />);

    expect(screen.getByText('Waiting')).toBeInTheDocument();
  });

  it('exports provider card session metadata from the card action strip', async () => {
    render(<TerminalCardComponent card={makeCard()} isFocused={false} />);

    fireEvent.click(screen.getByLabelText('Export AI Markdown'));

    await waitFor(() => expect(saveAiSessionMarkdownFileMock).toHaveBeenCalledTimes(1));
    const markdown = saveAiSessionMarkdownFileMock.mock.calls[0][0] as string;
    expect(markdown).toContain('- User intent: review');
    expect(markdown).toContain('- Provider: claude');
    expect(markdown).toContain('- Session id: 11111111-1111-4111-8111-111111111111');
    expect(markdown).toContain('launch resume');
    expect(markdown).toContain('_No prompt or reply content is available for this session._');
  });

  it('does not show AI session export for a custom AI command card', () => {
    render(
      <TerminalCardComponent
        card={makeCard({ command: 'claude --help', providerSessionId: undefined })}
        isFocused={false}
      />,
    );

    expect(screen.queryByLabelText('Export AI Markdown')).toBeNull();
  });

  it('shows a pending indicator without changing the displayed terminal type', () => {
    const card = makeCard({ terminalType: 'shell' });
    useTerminalStore.setState({
      pendingTerminalConfigurations: {
        [card.id]: {
          terminalType: 'codex',
          launchMode: 'default',
        },
      },
    });

    render(<TerminalCardComponent card={card} isFocused={false} />);

    expect(screen.getByText('edit.pending')).toBeInTheDocument();
    expect(screen.getByText(/Shell/)).toBeInTheDocument();
  });
});
