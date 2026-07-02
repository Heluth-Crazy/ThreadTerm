/**
 * TerminalView — Block Inspector visibility wiring.
 *
 * The BlockInspector component still has focused unit coverage, but the
 * terminal view currently hides the inspector entry and side panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

// Capture invoke() calls so hidden inspector tests can assert no AI request fires.
const invokeMock = vi.fn<(cmd: string, payload: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
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

describe('TerminalView — Block Inspector visibility', () => {
  it('hides the Block Inspector entry and panel when block data exists', () => {
    const card = makeCard({ terminalType: 'codex' });
    useTerminalStore.setState((s) => ({ cards: [...s.cards, card] }));
    seedBlock(card.id);

    render(<TerminalView card={card} active onBack={() => {}} />);

    expect(screen.getByTestId('mock-shell')).toBeInTheDocument();
    expect(screen.queryByTitle('Block Inspector')).toBeNull();
    expect(screen.queryByTestId('block-inspector-explain')).toBeNull();
    expect(screen.queryByText('Select a block to inspect')).toBeNull();
  });

  it('does not invoke AI explain from the terminal view while the inspector is hidden', () => {
    const card = makeCard({ terminalType: 'shell' });
    useTerminalStore.setState((s) => ({ cards: [...s.cards, card] }));
    seedBlock(card.id);

    render(<TerminalView card={card} active onBack={() => {}} />);

    expect(screen.queryByTestId('block-inspector-explain')).toBeNull();
    expect(invokeMock.mock.calls.find(([cmd]) => cmd === 'ai_explain')).toBeUndefined();
  });
});
