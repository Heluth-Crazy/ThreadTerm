import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalEventBridge } from './TerminalEventBridge';

const bridgeMocks = vi.hoisted(() => {
  const listeners = {
    output: undefined as undefined | ((payload: { id: string; data: string; seq: number }) => void),
    state: undefined as undefined | ((payload: { ptyId: string; state: string }) => void),
    exit: undefined as undefined | ((payload: { id: string; code?: number | null }) => void),
    attention: undefined as undefined | ((payload: unknown) => void),
  };

  return {
    listeners,
    headlessPreviewById: new Map<string, string>(),
    pty: {
      getAllSessionStates: vi.fn(() => Promise.resolve({})),
      attachSnapshot: vi.fn(() => Promise.resolve(null)),
      ack: vi.fn(() => Promise.resolve()),
      onOutput: vi.fn((handler) => {
        listeners.output = handler;
        return Promise.resolve(() => {});
      }),
      onStateChanged: vi.fn((handler) => {
        listeners.state = handler;
        return Promise.resolve(() => {});
      }),
      onExit: vi.fn((handler) => {
        listeners.exit = handler;
        return Promise.resolve(() => {});
      }),
      onAttentionRequired: vi.fn((handler) => {
        listeners.attention = handler;
        return Promise.resolve(() => {});
      }),
      kill: vi.fn(() => Promise.resolve()),
    },
  };
});

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  pty: bridgeMocks.pty,
}));

vi.mock('./headlessPreview', () => ({
  feedHeadless: vi.fn((id: string, data: string, onRendered: () => void) => {
    bridgeMocks.headlessPreviewById.set(id, data);
    onRendered();
  }),
  readHeadlessPreview: vi.fn((id: string) => bridgeMocks.headlessPreviewById.get(id) ?? ''),
  disposeHeadless: vi.fn((id: string) => bridgeMocks.headlessPreviewById.delete(id)),
  disposeAllHeadless: vi.fn(() => bridgeMocks.headlessPreviewById.clear()),
  getHeadlessPreviewDiagnostics: vi.fn(() => ({
    activeCount: bridgeMocks.headlessPreviewById.size,
    cardIds: [...bridgeMocks.headlessPreviewById.keys()],
  })),
}));

vi.mock('../../lib/logger', () => ({
  logger: { warn: vi.fn() },
}));

function resetStore() {
  useTerminalStore.setState({
    cards: [],
    archivedCards: [],
    notifications: [],
    focusedCardId: null,
    lastActiveCardId: null,
    selectedProjectPath: null,
    pinnedCardIds: [],
    notificationCentreOpen: false,
    pendingFocusCardId: null,
    agentCliCompatibilityCompletionEnabled: true,
  });
}

function createCodexCard() {
  return useTerminalStore.getState().createCard({
    projectName: 'repo',
    projectPath: '/tmp/repo',
    terminalType: 'codex',
  });
}

async function mountBridge() {
  const view = render(<TerminalEventBridge />);
  await waitFor(() => expect(bridgeMocks.listeners.state).toBeDefined());
  return view;
}

function submitAndStart(cardId: string) {
  act(() => {
    useTerminalStore.getState().recordUserSubmit(cardId, 'run task');
    bridgeMocks.listeners.state?.({ ptyId: cardId, state: 'Running' });
  });
}

function emitOutput(cardId: string, data: string, seq: number) {
  act(() => {
    bridgeMocks.listeners.output?.({ id: cardId, data, seq });
  });
}

function emitState(cardId: string, state: 'Running' | 'Idle' | 'WaitingForInput') {
  act(() => {
    bridgeMocks.listeners.state?.({ ptyId: cardId, state });
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  resetStore();
  bridgeMocks.listeners.output = undefined;
  bridgeMocks.listeners.state = undefined;
  bridgeMocks.listeners.exit = undefined;
  bridgeMocks.listeners.attention = undefined;
  bridgeMocks.headlessPreviewById.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  // The bridge's reconciliation interval is created while mounting with real
  // timers. Restore them before cleanup so its disposer clears that interval.
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe('TerminalEventBridge Agent CLI compatibility completion', () => {
  it('settles a provider prompt for 500 ms and emits one completion', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'answer\ncodex> ', 1);

    advance(499);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
    advance(1);

    expect(useTerminalStore.getState().notifications).toHaveLength(1);
    expect(useTerminalStore.getState().notifications[0]?.routing).toMatchObject({
      signalSource: 'agent_cli_prompt',
      episodeKey: `completion:${id}:1`,
    });
  });

  it('suppresses repeated prompt redraws and duplicate evidence exactly once', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'answer\ncodex> ', 1);
    advance(250);
    emitOutput(id, '\u001b[2K\rcodex> ', 2);
    advance(499);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
    advance(1);
    expect(useTerminalStore.getState().notifications).toHaveLength(1);
    advance(5_000);
    expect(useTerminalStore.getState().notifications).toHaveLength(1);
  });

  it('requires a submission and eight quiet seconds for idle fallback', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    emitState(id, 'Running');
    advance(12_000);
    emitState(id, 'Idle');
    advance(20_000);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);

    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'answer without a recognized prompt', 1);
    emitState(id, 'Idle');
    advance(7_999);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
    advance(1);
    expect(useTerminalStore.getState().notifications).toHaveLength(1);
    expect(useTerminalStore.getState().notifications[0]?.routing?.signalSource).toBe(
      'agent_cli_idle',
    );
  });

  it('does not settle a prompt before the 1.5 second observed-running guard', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    emitOutput(id, 'answer\ncodex> ', 1);

    advance(1_499);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
    advance(1);
    expect(useTerminalStore.getState().notifications).toHaveLength(1);
  });

  it('cancels compatibility when disabled globally', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'answer', 1);
    emitState(id, 'Idle');

    act(() => useTerminalStore.getState().setAgentCliCompatibilityCompletionEnabled(false));
    advance(30_000);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
  });

  it('rearms the idle quiet window from zero after renewed output', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'still working', 1);
    emitState(id, 'Idle');

    advance(4_000);
    emitOutput(id, 'still working, more output', 2);
    advance(7_999);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
    advance(1);
    expect(useTerminalStore.getState().notifications).toHaveLength(1);
  });

  it('cancels a pending compatibility candidate when the PTY waits for approval', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'waiting for approval', 1);
    emitState(id, 'Idle');
    advance(3_000);
    emitState(id, 'WaitingForInput');
    advance(20_000);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
  });

  it('cancels compatibility on an approval attention event while preserving interaction evidence', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'waiting for approval', 1);
    emitState(id, 'Idle');
    advance(3_000);
    act(() => {
      bridgeMocks.listeners.attention?.({
        ptyId: id,
        type: 'waiting',
        message: 'Approve command?',
        fingerprint: 'approve-command',
      });
    });
    advance(20_000);
    const notifications = useTerminalStore.getState().notifications;
    expect(notifications.some((entry) => entry.kind === 'waiting')).toBe(true);
    expect(notifications.some((entry) => entry.kind === 'completed')).toBe(false);
  });

  it('coalesces structured completion over a pending compatibility candidate', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'answer without prompt', 1);
    emitState(id, 'Idle');

    act(() => {
      useTerminalStore.getState().ingestCompletionSignal(
        {
          cardId: id,
          episodeKey: `completion:${id}:1`,
          fingerprint: 'codex:structured:turn-1',
          source: 'codex_chat',
          confidence: 'authoritative',
          outcome: 'completed',
          at: Date.now(),
          summary: 'structured result',
        },
        { kind: 'completed', title: 'Codex complete', body: 'structured result' },
      );
    });

    advance(20_000);
    const notifications = useTerminalStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.routing?.signalSource).toBe('codex_chat');
  });

  it('does not cancel generation two for a structured notification from generation one', async () => {
    const id = createCodexCard();
    await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);

    act(() => {
      useTerminalStore.getState().ingestCompletionSignal(
        {
          cardId: id,
          episodeKey: `completion:${id}:1`,
          fingerprint: 'codex:structured:turn-1',
          source: 'codex_chat',
          confidence: 'authoritative',
          outcome: 'completed',
          at: Date.now(),
          summary: 'generation one result',
        },
        { kind: 'completed', title: 'Generation one', body: 'generation one result' },
      );
      useTerminalStore.getState().recordUserSubmit(id, 'generation two');
    });

    emitOutput(id, 'generation two still working', 1);
    emitState(id, 'Idle');
    act(() => {
      useTerminalStore.getState().pushNotification({
        cardId: 'unrelated-card',
        kind: 'waiting',
        title: 'Unrelated',
        body: 'Unrelated notification-array change',
      });
    });

    advance(7_999);
    expect(
      useTerminalStore
        .getState()
        .notifications.some((entry) => entry.routing?.episodeKey === `completion:${id}:2`),
    ).toBe(false);
    advance(1);

    const notifications = useTerminalStore.getState().notifications;
    expect(notifications).toHaveLength(3);
    expect(notifications.some((entry) => entry.routing?.episodeKey === `completion:${id}:1`)).toBe(
      true,
    );
    expect(notifications.some((entry) => entry.routing?.episodeKey === `completion:${id}:2`)).toBe(
      true,
    );
    expect(notifications.find((entry) => entry.routing?.episodeKey === `completion:${id}:2`)
      ?.routing?.signalSource).toBe('agent_cli_idle');
  });

  it('cancels timers when a card is removed and when the bridge unmounts', async () => {
    const id = createCodexCard();
    const view = await mountBridge();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    submitAndStart(id);
    advance(2_000);
    emitOutput(id, 'answer', 1);
    emitState(id, 'Idle');
    act(() => useTerminalStore.getState().removeCard(id));
    advance(20_000);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);

    const secondId = createCodexCard();
    submitAndStart(secondId);
    advance(2_000);
    emitOutput(secondId, 'answer', 2);
    emitState(secondId, 'Idle');
    vi.useRealTimers();
    view.unmount();
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
  });
});
