import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalEventBridge } from './TerminalEventBridge';
import { feedHeadless } from './headlessPreview';

const bridgeMocks = vi.hoisted(() => {
  const listeners = {
    output: undefined as undefined | ((payload: { id: string; data: string; seq: number }) => void),
    state: undefined as undefined | ((payload: { ptyId: string; state: string }) => void),
    exit: undefined as undefined | ((payload: { id: string; code?: number | null }) => void),
    attention: undefined as undefined | ((payload: unknown) => void),
    blockStarted: undefined as undefined | ((payload: unknown) => void),
    blockFinished: undefined as undefined | ((payload: unknown) => void),
  };

  return {
    listeners,
    pty: {
      getSessionState: vi.fn(),
      onOutput: vi.fn((cb) => {
        listeners.output = cb;
        return Promise.resolve(() => {});
      }),
      onExit: vi.fn((cb) => {
        listeners.exit = cb;
        return Promise.resolve(() => {});
      }),
      onStateChanged: vi.fn((cb) => {
        listeners.state = cb;
        return Promise.resolve(() => {});
      }),
      onAttentionRequired: vi.fn((cb) => {
        listeners.attention = cb;
        return Promise.resolve(() => {});
      }),
      onBlockStarted: vi.fn((cb) => {
        listeners.blockStarted = cb;
        return Promise.resolve(() => {});
      }),
      onBlockFinished: vi.fn((cb) => {
        listeners.blockFinished = cb;
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
  feedHeadless: vi.fn(),
  disposeHeadless: vi.fn(),
  disposeAllHeadless: vi.fn(),
}));

function resetStore() {
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
  });
}

function createCard(terminalType: 'shell' | 'codex' = 'shell') {
  return useTerminalStore.getState().createCard({
    projectName: 'repo',
    projectPath: '/tmp/repo',
    terminalType,
  });
}

describe('TerminalEventBridge status reconciliation', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    bridgeMocks.listeners.output = undefined;
    bridgeMocks.listeners.state = undefined;
    bridgeMocks.listeners.exit = undefined;
    bridgeMocks.listeners.attention = undefined;
    bridgeMocks.listeners.blockStarted = undefined;
    bridgeMocks.listeners.blockFinished = undefined;
    bridgeMocks.pty.getSessionState.mockResolvedValue('Idle');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('syncs a card status from the backend snapshot on mount', async () => {
    const id = createCard();
    bridgeMocks.pty.getSessionState.mockResolvedValue('Running');

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.status).toBe('running');
    });
    expect(bridgeMocks.pty.getSessionState).toHaveBeenCalledWith(id);
  });

  it('falls transient missing PTYs back to idle', async () => {
    const id = createCard();
    useTerminalStore.getState().updateCardStatus(id, 'running');
    bridgeMocks.pty.getSessionState.mockRejectedValue(new Error('missing pty'));

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.status).toBe('idle');
    });
  });

  it('does not overwrite a failed card when the backend PTY is gone', async () => {
    const id = createCard();
    useTerminalStore.getState().updateCardStatus(id, 'failed');
    bridgeMocks.pty.getSessionState.mockRejectedValue(new Error('missing pty'));

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.pty.getSessionState).toHaveBeenCalledWith(id);
    });
    expect(useTerminalStore.getState().getCardById(id)?.status).toBe('failed');
  });

  it('does not notify when a focus or resize redraw briefly flips running to idle', async () => {
    const now = { value: 1_000_000 };
    vi.spyOn(Date, 'now').mockImplementation(() => now.value);
    const id = createCard();

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.state).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.state?.({ ptyId: id, state: 'Running' });
    });
    now.value += 2_000;
    act(() => {
      bridgeMocks.listeners.state?.({ ptyId: id, state: 'Idle' });
    });

    expect(useTerminalStore.getState().getCardById(id)?.status).toBe('idle');
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(false);
  });

  it('notifies when output completes after a new user submit', async () => {
    const now = { value: 1_000_000 };
    vi.spyOn(Date, 'now').mockImplementation(() => now.value);
    const id = createCard();

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.state).toBeDefined();
    });

    act(() => {
      useTerminalStore.getState().recordUserSubmit(id, 'sent input');
      useTerminalStore.getState().updateCardReplyPreview(id, 'done from agent');
      bridgeMocks.listeners.state?.({ ptyId: id, state: 'Running' });
    });
    now.value += 2_000;
    act(() => {
      bridgeMocks.listeners.state?.({ ptyId: id, state: 'Idle' });
    });

    const state = useTerminalStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.kind).toBe('completed');
    expect(state.notifications[0]?.body).toContain('done from agent');
    expect(state.getCardById(id)?.unread).toBe(true);
  });

  it('uses provider-specific copy when an AI CLI is missing', async () => {
    const id = createCard('codex');

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.attention).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.attention?.({
        ptyId: id,
        type: 'error',
        message: 'zsh: command not found: codex',
      });
    });

    const notification = useTerminalStore.getState().notifications[0];
    expect(notification?.title).toContain('Codex');
    expect(notification?.title).toContain('CLI');
    expect(notification?.body).toContain('PATH');
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(true);
  });

  it('records block events against the matching card', async () => {
    const id = createCard();

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.blockStarted).toBeDefined();
      expect(bridgeMocks.listeners.blockFinished).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.blockStarted?.({
        sessionId: id,
        blockId: 'block-1',
        command: 'npm test',
        cwd: '/tmp/repo',
        startedAt: 1_000,
      });
      bridgeMocks.listeners.blockFinished?.({
        sessionId: id,
        blockId: 'block-1',
        exitCode: 0,
        finishedAt: 1_500,
        durationMs: 500,
      });
    });

    expect(useTerminalStore.getState().blocks[id]?.[0]).toMatchObject({
      id: 'block-1',
      command: 'npm test',
      cwd: '/tmp/repo',
      state: 'success',
      exitCode: 0,
      durationMs: 500,
    });
  });

  it('pushes a notification when auto restart reaches its retry limit', async () => {
    const id = createCard();
    useTerminalStore.getState().setCardAutoRestartEnabled(id, true);
    useTerminalStore.getState().setCardAutoRestartMaxRetries(id, 1);

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.exit).toBeDefined();
    });

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    act(() => {
      bridgeMocks.listeners.exit?.({ id, code: 1 });
    });

    expect(useTerminalStore.getState().getCardById(id)?.autoRestart?.history[0])
      .toMatchObject({
        attempt: 1,
        status: 'pending',
      });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const restarted = useTerminalStore.getState().getCardById(id);
    expect(restarted?.ptyId).not.toBe(id);
    expect(restarted?.autoRestart?.history[0]).toMatchObject({
      attempt: 1,
      status: 'started',
    });

    act(() => {
      bridgeMocks.listeners.exit?.({ id: restarted?.ptyId ?? id, code: 1 });
    });

    const state = useTerminalStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.kind).toBe('failed');
    expect(state.notifications[0]?.body).toContain('1');
    expect(state.getCardById(id)?.unread).toBe(true);
  });

  it('does not auto restart cards unless explicitly enabled', async () => {
    const id = createCard();

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.exit).toBeDefined();
    });

    vi.useFakeTimers();
    act(() => {
      bridgeMocks.listeners.exit?.({ id, code: 1 });
      vi.advanceTimersByTime(30_000);
    });

    const card = useTerminalStore.getState().getCardById(id);
    expect(card?.autoRestart).toBeUndefined();
    expect(card?.ptyId).toBe(id);
    expect(useTerminalStore.getState().notifications).toHaveLength(0);
  });

  it('records the exact non-one exit code from the backend', async () => {
    const id = createCard();

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.exit).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.exit?.({ id, code: 127 });
    });

    const card = useTerminalStore.getState().getCardById(id);
    expect(card?.status).toBe('failed');
    expect(card?.events.at(-1)?.kind).toBe('closed');
    expect(card?.events.at(-1)?.summary).toContain('127');
  });

  it('ignores stale exit events from a previous PTY after auto restart swaps ptyId', async () => {
    const id = createCard();
    useTerminalStore.getState().setCardAutoRestartEnabled(id, true);
    useTerminalStore.getState().setCardAutoRestartMaxRetries(id, 3);

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.exit).toBeDefined();
    });

    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);

    act(() => {
      bridgeMocks.listeners.exit?.({ id, code: 1 });
      vi.advanceTimersByTime(1000);
    });

    const restarted = useTerminalStore.getState().getCardById(id);
    expect(restarted?.ptyId).not.toBe(id);

    act(() => {
      bridgeMocks.listeners.exit?.({ id, code: 1 });
    });

    const afterStaleExit = useTerminalStore.getState().getCardById(id);
    expect(afterStaleExit?.autoRestart?.retryCount).toBe(1);
    expect(afterStaleExit?.autoRestart?.history).toHaveLength(1);
    expect(afterStaleExit?.status).not.toBe('failed');
  });

  it('does not start a pending retry after the card is removed', async () => {
    const id = createCard();
    useTerminalStore.getState().setCardAutoRestartEnabled(id, true);
    const startSpy = vi.spyOn(useTerminalStore.getState(), 'startCardAutoRestart');

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.exit).toBeDefined();
    });

    vi.useFakeTimers();
    act(() => {
      bridgeMocks.listeners.exit?.({ id, code: 1 });
    });
    expect(useTerminalStore.getState().getCardById(id)?.autoRestart?.history[0])
      .toMatchObject({ status: 'pending' });

    act(() => {
      useTerminalStore.getState().removeCard(id);
      vi.advanceTimersByTime(1000);
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().getCardById(id)).toBeUndefined();
  });

  it('ignores duplicate or stale pty output seq values', async () => {
    const id = createCard();

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.output).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.output?.({ id, data: 'one', seq: 1 });
      bridgeMocks.listeners.output?.({ id, data: 'duplicate one', seq: 1 });
      bridgeMocks.listeners.output?.({ id, data: 'stale zero', seq: 0 });
      bridgeMocks.listeners.output?.({ id, data: 'two', seq: 2 });
    });

    // The headless emulator sees accepted chunks immediately; the store
    // write is coalesced (audit P0-2) and lands after the flush window.
    expect(feedHeadless).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.lastOutput).toContain('two');
    });
    expect(useTerminalStore.getState().getCardById(id)?.lastOutput).toContain('one');
    expect(useTerminalStore.getState().getCardById(id)?.lastOutput).not.toContain('duplicate one');
    expect(useTerminalStore.getState().getCardById(id)?.lastOutput).not.toContain('stale zero');
  });

  it('coalesces an output burst into a single store write', async () => {
    const id = createCard();

    render(<TerminalEventBridge />);
    await waitFor(() => {
      expect(bridgeMocks.listeners.output).toBeDefined();
    });

    const before = useTerminalStore.getState().getCardById(id);

    act(() => {
      for (let seq = 1; seq <= 50; seq++) {
        bridgeMocks.listeners.output?.({ id, data: `chunk-${seq};`, seq });
      }
    });

    // Nothing hits the store synchronously…
    expect(useTerminalStore.getState().getCardById(id)?.lastOutput).toBe(before?.lastOutput);

    // …then the whole burst lands as one joined write.
    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.lastOutput).toContain('chunk-50;');
    });
    expect(useTerminalStore.getState().getCardById(id)?.lastOutput).toContain('chunk-1;');
  });
});
