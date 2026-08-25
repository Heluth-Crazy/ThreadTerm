import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveAttentionItems,
  deriveWorkbenchSummary,
} from '../../lib/workbench/deriveAttentionItems';
import { deriveExecutionGroups } from '../../lib/workbench/deriveExecutionGroups';
import { MANAGED_STATE_KEYS } from '../../lib/managedState';
import { useTerminalStore } from '../../stores/terminalStore';
import { DEFAULT_WORKBENCH_RULES } from '../../stores/workbenchStore';
import {
  TerminalEventBridge,
  getTerminalEventBridgeDiagnostics,
} from './TerminalEventBridge';
import { disposeHeadless, feedHeadless } from './headlessPreview';

const bridgeMocks = vi.hoisted(() => {
  const listeners = {
    output: undefined as undefined | ((payload: { id: string; data: string; seq: number }) => void),
    state: undefined as undefined | ((payload: { ptyId: string; state: string }) => void),
    exit: undefined as undefined | ((payload: { id: string; code?: number | null }) => void),
    attention: undefined as undefined | ((payload: unknown) => void),
  };

  return {
    listeners,
    headlessIds: new Set<string>(),
    headlessPreviewById: new Map<string, string>(),
    pty: {
      getAllSessionStates: vi.fn(),
      attachSnapshot: vi.fn((_id: string): Promise<unknown> => Promise.resolve(null)),
      ack: vi.fn(() => Promise.resolve()),
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
      kill: vi.fn(() => Promise.resolve()),
    },
  };
});

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

const managedStateMocks = vi.hoisted(() => {
  const mocks = {
    handler: undefined as undefined | ((key: string) => void),
    listen: vi.fn(),
  };
  mocks.listen.mockImplementation((handler: (key: string) => void) => {
    mocks.handler = handler;
    return Promise.resolve(() => {});
  });
  return mocks;
});

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  pty: bridgeMocks.pty,
}));

vi.mock('./headlessPreview', () => ({
  feedHeadless: vi.fn((_id: string, data: string, onRendered: () => void) => {
    bridgeMocks.headlessIds.add(_id);
    bridgeMocks.headlessPreviewById.set(_id, data);
    onRendered();
  }),
  readHeadlessPreview: vi.fn((id: string) => bridgeMocks.headlessPreviewById.get(id) ?? ''),
  disposeHeadless: vi.fn((id: string) => {
    bridgeMocks.headlessIds.delete(id);
    bridgeMocks.headlessPreviewById.delete(id);
  }),
  disposeAllHeadless: vi.fn(() => {
    bridgeMocks.headlessIds.clear();
    bridgeMocks.headlessPreviewById.clear();
  }),
  getHeadlessPreviewDiagnostics: vi.fn(() => ({
    activeCount: bridgeMocks.headlessIds.size,
    cardIds: Array.from(bridgeMocks.headlessIds),
  })),
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    warn: loggerMocks.warn,
  },
}));

vi.mock('../../lib/managedState', async () => {
  const actual = await vi.importActual<typeof import('../../lib/managedState')>(
    '../../lib/managedState',
  );
  return {
    ...actual,
    listenManagedStateChanges: managedStateMocks.listen,
  };
});

function resetStore() {
  useTerminalStore.setState({
    cards: [],
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('TerminalEventBridge status reconciliation', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    bridgeMocks.listeners.output = undefined;
    bridgeMocks.listeners.state = undefined;
    bridgeMocks.listeners.exit = undefined;
    bridgeMocks.listeners.attention = undefined;
    managedStateMocks.handler = undefined;
  bridgeMocks.headlessIds.clear();
  bridgeMocks.headlessPreviewById.clear();
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({});
    bridgeMocks.pty.attachSnapshot.mockResolvedValue(null);
    loggerMocks.warn.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('syncs a card status from the backend snapshot on mount', async () => {
    const id = createCard();
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({ [id]: 'Running' });

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.status).toBe('running');
    });
    expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalled();
  });

  it('rehydrates terminal state before syncing managed-state changes', async () => {
    createCard();
    const rehydrate = deferred<void>();
    const rehydrateSpy = vi
      .spyOn(useTerminalStore.persist, 'rehydrate')
      .mockReturnValue(rehydrate.promise);
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({});

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(managedStateMocks.handler).toBeDefined();
      expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalledTimes(2);
    });
    const syncCallsBeforeChange = bridgeMocks.pty.getAllSessionStates.mock.calls.length;

    act(() => {
      managedStateMocks.handler?.(MANAGED_STATE_KEYS.workbench);
    });
    expect(rehydrateSpy).not.toHaveBeenCalled();
    expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalledTimes(syncCallsBeforeChange);

    act(() => {
      managedStateMocks.handler?.(MANAGED_STATE_KEYS.terminal);
    });
    expect(rehydrateSpy).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalledTimes(syncCallsBeforeChange);

    await act(async () => {
      rehydrate.resolve();
    });
    await waitFor(() => {
      expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalledTimes(
        syncCallsBeforeChange + 1,
      );
    });
  });

  it('reconciles multiple cards with a single batch IPC call', async () => {
    const idA = createCard();
    const idB = createCard();
    const idC = createCard();
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({
      [idA]: 'Running',
      [idB]: 'WaitingForInput',
      [idC]: 'Completed',
    });

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(idA)?.status).toBe('running');
      expect(useTerminalStore.getState().getCardById(idB)?.status).toBe('waiting');
      expect(useTerminalStore.getState().getCardById(idC)?.status).toBe('completed');
    });
    // Status sync and background snapshot recovery each use one batch; neither
    // scales IPC calls with the number of cards.
    expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalledTimes(2);
  });

  it('uses an atomic attach snapshot to resume background ACK after listener recreation', async () => {
    const id = createCard();
    const snapshot = deferred<{
      ptyId: string;
      data: string;
      seq: number;
      rows: number;
      cols: number;
      cursorRow: number;
      cursorCol: number;
      history?: string;
    } | null>();
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({ [id]: 'Running' });
    bridgeMocks.pty.attachSnapshot
      .mockRejectedValueOnce(new Error('transient attach failure'))
      .mockReturnValue(snapshot.promise);

    render(<TerminalEventBridge />);
    await waitFor(() => expect(bridgeMocks.listeners.output).toBeDefined());

    act(() => {
      bridgeMocks.listeners.output?.({ id, data: 'new-live', seq: 43 });
    });
    expect(feedHeadless).not.toHaveBeenCalled();

    await act(async () => {
      snapshot.resolve({
        ptyId: id,
        data: 'recovered-snapshot',
        seq: 42,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 1,
      });
    });

    await waitFor(() => {
      expect(bridgeMocks.pty.attachSnapshot).toHaveBeenCalledTimes(2);
      expect(feedHeadless).toHaveBeenNthCalledWith(
        1,
        id,
        'recovered-snapshot',
        expect.any(Function),
      );
      expect(feedHeadless).toHaveBeenNthCalledWith(
        2,
        id,
        'new-live',
        expect.any(Function),
      );
      expect(bridgeMocks.pty.ack).toHaveBeenCalledWith(
        id,
        43,
        'background',
        undefined,
      );
    });
  });

  it('falls transient PTYs missing from the batch map back to idle', async () => {
    const id = createCard();
    useTerminalStore.getState().updateCardStatus(id, 'running');
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({});

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.status).toBe('idle');
    });
  });

  it('does not overwrite a failed card when the backend PTY is gone', async () => {
    const id = createCard();
    useTerminalStore.getState().updateCardStatus(id, 'failed');
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({});

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalled();
    });
    expect(useTerminalStore.getState().getCardById(id)?.status).toBe('failed');
  });

  it('skips the round without idling transient cards when the batch call rejects', async () => {
    const id = createCard();
    useTerminalStore.getState().updateCardStatus(id, 'running');
    bridgeMocks.pty.getAllSessionStates.mockRejectedValue(new Error('ipc dropped'));

    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.pty.getAllSessionStates).toHaveBeenCalled();
    });
    // A batch failure means IPC / window-lifecycle trouble, not "every PTY
    // died" — the card must keep its transient status until the next round.
    await act(async () => {});
    expect(useTerminalStore.getState().getCardById(id)?.status).toBe('running');
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
    expect(state.notifications[0]?.routing).toMatchObject({
      origin: 'reply',
      family: 'completion',
      episodeKey: `completion:${id}:1`,
      signalSource: 'agent_cli_idle',
      confidence: 'compatible',
    });
    expect(state.getCardById(id)?.unread).toBe(true);

    const attentionItems = deriveAttentionItems({
      cards: state.cards,
      notifications: state.notifications,
      supervisorAlerts: [],
      codexRequests: [],
      rules: DEFAULT_WORKBENCH_RULES,
      now: now.value,
    });

    expect(attentionItems).toEqual([
      expect.objectContaining({
        cardId: id,
        kind: 'review',
        sourceKind: 'notification',
      }),
    ]);
    expect(deriveWorkbenchSummary(state.cards, attentionItems)).toMatchObject({
      normalRunning: 0,
      review: 1,
    });
    expect(deriveExecutionGroups(state.cards, attentionItems)).toEqual([
      expect.objectContaining({
        cardIds: [id],
        status: 'review',
      }),
    ]);
  });

  it('bounds output queued during snapshot failure and recovers from the authoritative screen', async () => {
    const id = createCard();
    const snapshot = deferred<{
      ptyId: string;
      data: string;
      seq: number;
      rows: number;
      cols: number;
      cursorRow: number;
      cursorCol: number;
    } | null>();
    bridgeMocks.pty.getAllSessionStates.mockResolvedValue({ [id]: 'Running' });
    bridgeMocks.pty.attachSnapshot.mockReturnValue(snapshot.promise);

    render(<TerminalEventBridge />);
    await waitFor(() => expect(bridgeMocks.listeners.output).toBeDefined());

    const oneMiB = 'x'.repeat(1024 * 1024);
    act(() => {
      for (let seq = 1; seq <= 6; seq += 1) {
        bridgeMocks.listeners.output?.({ id, data: oneMiB, seq });
      }
    });

    expect(getTerminalEventBridgeDiagnostics()).toMatchObject({
      pendingBackgroundOutputCount: 4,
      pendingBackgroundOutputBytes: 4 * 1024 * 1024,
      backgroundOutputGapCount: 2,
    });
    expect(loggerMocks.warn).toHaveBeenCalled();

    await act(async () => {
      snapshot.resolve({
        ptyId: id,
        data: 'authoritative screen',
        seq: 6,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 1,
      });
    });

    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.lastReplyPreview)
        .toBe('authoritative screen');
      expect(getTerminalEventBridgeDiagnostics()).toMatchObject({
        pendingBackgroundOutputCount: 0,
        pendingBackgroundOutputBytes: 0,
        backgroundOutputGapCount: 2,
      });
    });
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
    expect(notification?.routing).toMatchObject({
      origin: 'pty',
      family: 'failure',
      signalSource: 'agent_cli_prompt',
      confidence: 'compatible',
    });
    expect(useTerminalStore.getState().getCardById(id)?.unread).toBe(true);
  });

  it('dedupes a PTY prompt by generation and fingerprint, then rearms semantically', async () => {
    const id = createCard();
    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.attention).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.attention?.({
        ptyId: id,
        type: 'waiting',
        message: 'Agent needs your input',
        fingerprint: 'Continue? [y/n]',
      });
      bridgeMocks.listeners.attention?.({
        ptyId: id,
        type: 'waiting',
        message: 'Agent needs your input',
        fingerprint: 'Continue? [y/n]',
      });
    });
    expect(useTerminalStore.getState().notifications).toHaveLength(1);

    act(() => {
      bridgeMocks.listeners.attention?.({
        ptyId: id,
        type: 'waiting',
        message: 'Agent needs your input',
        fingerprint: 'Approve command? [y/n]',
      });
    });
    expect(useTerminalStore.getState().notifications).toHaveLength(2);

    act(() => {
      useTerminalStore.getState().recordUserSubmit(id, 'y');
      bridgeMocks.listeners.attention?.({
        ptyId: id,
        type: 'waiting',
        message: 'Agent needs your input',
        fingerprint: 'Continue? [y/n]',
      });
    });

    const state = useTerminalStore.getState();
    expect(state.notifications).toHaveLength(3);
    expect(state.notifications[0]?.routing).toEqual({
      origin: 'pty',
      family: 'interaction',
      episodeKey: `interaction:${id}:1`,
      fingerprint: 'waiting:continue? [y/n]',
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

  it.each([
    { code: 0, state: 'completed' as const, kind: 'completed' as const },
    { code: 17, state: 'failed' as const, kind: 'failed' as const },
  ])('treats one-shot exit $code as an authoritative $state outcome', async ({ code, state, kind }) => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'one-shot',
      projectPath: '/tmp/one-shot',
      terminalType: 'shell',
      command: 'printf result',
      executionMode: 'oneShot',
    });
    useTerminalStore.getState().updateCardReplyPreview(id, 'final output');

    render(<TerminalEventBridge />);
    await waitFor(() => expect(bridgeMocks.listeners.exit).toBeDefined());

    act(() => {
      bridgeMocks.listeners.exit?.({ id, code });
    });

    const store = useTerminalStore.getState();
    expect(store.getCardById(id)?.oneShotRun).toMatchObject({
      generation: 1,
      state,
      exitCode: code,
    });
    expect(store.getCardById(id)?.autoRestart).toBeUndefined();
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0]).toMatchObject({
      cardId: id,
      kind,
      routing: {
        origin: 'reply',
        family: 'completion',
        episodeKey: 'one-shot:1',
        signalSource: 'one_shot_exit',
        confidence: 'authoritative',
      },
    });
  });

  it('records an intentional/unknown one-shot termination as interrupted without notifying', async () => {
    const id = useTerminalStore.getState().createCard({
      projectName: 'cancelled',
      projectPath: '/tmp/cancelled',
      terminalType: 'shell',
      command: 'sleep 10',
      executionMode: 'oneShot',
    });

    render(<TerminalEventBridge />);
    await waitFor(() => expect(bridgeMocks.listeners.exit).toBeDefined());

    act(() => {
      bridgeMocks.listeners.exit?.({ id, code: null });
    });

    const store = useTerminalStore.getState();
    expect(store.getCardById(id)?.oneShotRun).toMatchObject({
      generation: 1,
      state: 'interrupted',
    });
    expect(store.getCardById(id)?.oneShotRun?.exitCode).toBeUndefined();
    expect(store.notifications).toHaveLength(0);
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
    await waitFor(() => {
      expect(bridgeMocks.pty.ack.mock.calls).toEqual([
        [id, 1, 'background', undefined],
        [id, 2, 'background', undefined],
      ]);
    });
  });

  it('acks output even when no card or Shell consumer exists', async () => {
    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.output).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.output?.({ id: 'unmounted-pty', data: 'background', seq: 42 });
    });

    await waitFor(() => {
      expect(bridgeMocks.pty.ack).toHaveBeenCalledWith(
        'unmounted-pty',
        42,
        'background',
        undefined,
      );
    });
    expect(feedHeadless).not.toHaveBeenCalled();
  });

  it('continues cumulative acking after a transient IPC rejection', async () => {
    const id = createCard();
    bridgeMocks.pty.ack.mockRejectedValueOnce(new Error('ipc dropped'));
    render(<TerminalEventBridge />);

    await waitFor(() => {
      expect(bridgeMocks.listeners.output).toBeDefined();
    });

    act(() => {
      bridgeMocks.listeners.output?.({ id, data: 'one', seq: 10 });
      bridgeMocks.listeners.output?.({ id, data: 'two', seq: 11 });
    });

    await waitFor(() => {
      expect(bridgeMocks.pty.ack).toHaveBeenNthCalledWith(
        1,
        id,
        10,
        'background',
        undefined,
      );
      expect(bridgeMocks.pty.ack).toHaveBeenNthCalledWith(
        2,
        id,
        11,
        'background',
        undefined,
      );
    });
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

  it.each(['remove', 'archive'] as const)(
    'cleans every per-PTY runtime resource when a card is %sd',
    async (operation) => {
      const id = createCard();
      render(<TerminalEventBridge />);
      await waitFor(() => expect(bridgeMocks.listeners.output).toBeDefined());

      act(() => {
        bridgeMocks.listeners.output?.({ id, data: 'pending output', seq: 70 });
      });
      await waitFor(() => {
        expect(getTerminalEventBridgeDiagnostics()).toMatchObject({
          activeRuntimeCount: 1,
          activeHeadlessCount: 1,
        });
      });

      act(() => {
        if (operation === 'remove') useTerminalStore.getState().removeCard(id);
        else useTerminalStore.getState().archiveCard(id);
      });

      await waitFor(() => {
        expect(disposeHeadless).toHaveBeenCalledWith(id);
        expect(getTerminalEventBridgeDiagnostics()).toMatchObject({
          activeRuntimeCount: 0,
          activeHeadlessCount: 0,
          pendingOutputCardCount: 0,
          pendingAckCount: 0,
          lastOutputSeqCount: 0,
          lastProcessedOutputSeqCount: 0,
        });
      });
      if (operation === 'archive') {
        expect(useTerminalStore.getState().archivedCards.some((card) => card.id === id)).toBe(true);
      }
    },
  );

  it('cleans runtime state on exit after flushing the final coalesced output', async () => {
    const id = createCard();
    render(<TerminalEventBridge />);
    await waitFor(() => expect(bridgeMocks.listeners.exit).toBeDefined());

    act(() => {
      bridgeMocks.listeners.output?.({ id, data: 'final output', seq: 80 });
      bridgeMocks.listeners.exit?.({ id, code: 0 });
    });

    await waitFor(() => {
      expect(useTerminalStore.getState().getCardById(id)?.lastOutput).toContain('final output');
      expect(getTerminalEventBridgeDiagnostics()).toMatchObject({
        activeRuntimeCount: 0,
        activeHeadlessCount: 0,
        pendingOutputCardCount: 0,
        lastOutputSeqCount: 0,
        lastProcessedOutputSeqCount: 0,
      });
    });
  });

  it('ignores a delayed headless callback after auto-restart replaces the PTY', async () => {
    const id = createCard();
    let renderOldOutput: (() => void) | undefined;
    vi.mocked(feedHeadless).mockImplementationOnce((cardId, _data, onRendered) => {
      bridgeMocks.headlessIds.add(cardId);
      renderOldOutput = onRendered;
    });
    render(<TerminalEventBridge />);
    await waitFor(() => expect(bridgeMocks.listeners.output).toBeDefined());

    act(() => {
      bridgeMocks.listeners.output?.({ id, data: 'old output', seq: 90 });
    });
    let replacementId: string | null = null;
    act(() => {
      replacementId = useTerminalStore.getState().startCardAutoRestart(id, {
        attempt: 1,
        now: 1000,
      });
    });
    expect(replacementId).not.toBeNull();

    act(() => {
      bridgeMocks.listeners.output?.({ id: replacementId!, data: 'new output', seq: 91 });
      renderOldOutput?.();
    });

    await waitFor(() => {
      const card = useTerminalStore.getState().getCardById(id);
      expect(card?.lastOutput).toContain('new output');
      expect(card?.lastOutput).not.toContain('old output');
      expect(card?.lastReplyPreview).toBe('new output');
      expect(getTerminalEventBridgeDiagnostics().activeRuntimeIds).toEqual([replacementId]);
    });
  });

  it('drops all runtime resources when the bridge unmounts', async () => {
    const id = createCard();
    const view = render(<TerminalEventBridge />);
    await waitFor(() => expect(bridgeMocks.listeners.output).toBeDefined());
    act(() => {
      bridgeMocks.listeners.output?.({ id, data: 'live', seq: 100 });
    });
    await waitFor(() => expect(getTerminalEventBridgeDiagnostics().activeRuntimeCount).toBe(1));

    view.unmount();

    expect(getTerminalEventBridgeDiagnostics()).toEqual({
      activeRuntimeCount: 0,
      activeRuntimeIds: [],
      activeHeadlessCount: 0,
      pendingOutputCardCount: 0,
      pendingAckCount: 0,
      lastOutputSeqCount: 0,
      lastProcessedOutputSeqCount: 0,
      autoRestartTimerCount: 0,
      pendingBackgroundOutputCount: 0,
      pendingBackgroundOutputBytes: 0,
      backgroundOutputGapCount: 0,
    });
  });
});
