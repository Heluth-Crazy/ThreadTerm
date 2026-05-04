/**
 * TerminalView — Stage 6 provider selection + Run-as-command wiring.
 *
 * We render the real BlockInspector through the TerminalView so we can
 * assert: (a) that the Explain button invokes ai_explain with the correct
 * provider based on the focused card's terminalType, and (b) that the
 * Run-as-command two-step confirm calls pty_input against the focused
 * card's PTY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAiThreadStore } from '../../stores/aiThreadStore';
import { TerminalView } from './TerminalView';
import type { TerminalCard } from '../../types/terminal';

// Silence real i18n lookups.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: unknown) => {
        if (typeof opts === 'string') return opts;
        if (
          opts &&
          typeof opts === 'object' &&
          'defaultValue' in (opts as Record<string, unknown>)
        ) {
          return (opts as { defaultValue: string }).defaultValue;
        }
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

// Keep Shell inert so we don't try to mount xterm in happy-dom.
vi.mock('../Shell', () => ({ default: () => <div data-testid="mock-shell" /> }));
vi.mock('./BlockOverlay', () => ({
  BlockOverlay: () => <div data-testid="mock-block-overlay" />,
}));
vi.mock('./useProviderSessionLifecycle', () => ({
  useProviderSessionLifecycle: () => () => {},
}));

// Capture every invoke() call so we can assert provider + pty_input payloads.
const invokeMock = vi.fn<(cmd: string, payload: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, payload: unknown) => invokeMock(cmd, payload),
}));

function resetStores() {
  useTerminalStore.setState({
    cards: [],
    blocks: {},
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    pinnedCardIds: [],
    notifications: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
    selectedBlockId: {},
    collapsedBlockIds: [],
    bookmarks: [],
    aiExplainDefaultProvider: 'claude',
    bottomBarHidden: false,
  });
  useAiThreadStore.setState({ threads: {} });
}

function makeCard(overrides: Partial<TerminalCard> = {}): TerminalCard {
  const now = Date.now();
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/tmp/repo',
    projectName: 'repo',
    terminalType: 'shell',
    status: 'idle',
    createdAt: now,
    lastActivity: now,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

function seedBlock(cardId: string, blockId = 'blk-1') {
  useTerminalStore.setState((state) => ({
    blocks: {
      ...state.blocks,
      [cardId]: [
        {
          id: blockId,
          cardId,
          cwd: '/tmp/repo',
          command: 'ls',
          startedAt: Date.now(),
          finishedAt: Date.now() + 1000,
          exitCode: 0,
          durationMs: 1000,
          bufferStart: 0,
          bufferEnd: 10,
          state: 'success',
        },
      ],
    },
    selectedBlockId: { ...state.selectedBlockId, [cardId]: blockId },
  }));
}

beforeEach(() => {
  resetStores();
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('TerminalView — Stage 6 AI wiring', () => {
  it('passes the focused card terminalType as provider when AI', async () => {
    const card = makeCard({ terminalType: 'codex' });
    useTerminalStore.setState((s) => ({ cards: [...s.cards, card] }));
    seedBlock(card.id);

    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'ai_explain') {
        return { stdout: 'ok', stderr: '', exit_code: 0, timed_out: false };
      }
      return undefined;
    });

    render(<TerminalView card={card} active onBack={() => {}} />);
    // Open the inspector first via the Layers toggle.
    fireEvent.click(screen.getByTitle('Block Inspector'));
    fireEvent.click(await screen.findByTestId('block-inspector-explain'));
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'ai_explain');
      expect(call).toBeDefined();
      expect((call?.[1] as { provider: string }).provider).toBe('codex');
    });
  });

  it('falls back to aiExplainDefaultProvider codex when card is shell and surfaces empty output as error', async () => {
    const card = makeCard({ terminalType: 'shell' });
    useTerminalStore.setState((s) => ({
      cards: [...s.cards, card],
      aiExplainDefaultProvider: 'codex',
    }));
    seedBlock(card.id);

    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'ai_explain') {
        return {
          stdout: '   ',
          stderr: 'codex returned no final answer',
          exit_code: 0,
          timed_out: false,
        };
      }
      return undefined;
    });

    render(<TerminalView card={card} active onBack={() => {}} />);
    fireEvent.click(screen.getByTitle('Block Inspector'));
    fireEvent.click(await screen.findByTestId('block-inspector-explain'));
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'ai_explain');
      expect(call).toBeDefined();
      expect((call?.[1] as { provider: string }).provider).toBe('codex');
    });
    await waitFor(() => {
      expect(screen.getByText(/AI provider returned no answer/)).toBeInTheDocument();
      expect(screen.getByText(/codex returned no final answer/)).toBeInTheDocument();
    });
  });

  it('Run-as-command pumps text to pty_input for the focused card', async () => {
    const card = makeCard({ terminalType: 'shell', ptyId: 'pty-xyz', id: 'card-xyz' });
    useTerminalStore.setState((s) => ({ cards: [...s.cards, card] }));
    seedBlock(card.id, 'blk-xyz');

    // Seed a synthetic AI answer so Run-as-command appears immediately.
    useAiThreadStore.setState({
      threads: {
        'blk-xyz': {
          blockId: 'blk-xyz',
          entries: [
            {
              id: 'a1',
              role: 'ai',
              text: '`echo hi`',
              provider: 'claude',
              createdAt: Date.now(),
              state: 'ok',
            },
          ],
        },
      },
    });

    invokeMock.mockResolvedValue(undefined);

    render(<TerminalView card={card} active onBack={() => {}} />);
    fireEvent.click(screen.getByTitle('Block Inspector'));

    const btn = await screen.findByTestId('ai-run-as-command-a1');
    // First click → pending state, no invoke yet.
    fireEvent.click(btn);
    expect(invokeMock.mock.calls.find(([cmd]) => cmd === 'pty_input')).toBeUndefined();
    // Second click within 1.5s confirms.
    fireEvent.click(btn);

    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'pty_input');
      expect(call).toBeDefined();
      expect(call?.[1]).toEqual({ id: 'pty-xyz', data: 'echo hi\n' });
    });

    // Silence any pending timers so afterEach cleanup is tidy.
    act(() => {});
  });
});
