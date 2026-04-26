import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalEventBridge } from './TerminalEventBridge';

const bridgeMocks = vi.hoisted(() => {
  const listeners = {
    output: undefined as undefined | ((payload: { id: string; data: string }) => void),
    state: undefined as undefined | ((payload: { ptyId: string; state: string }) => void),
    exit: undefined as undefined | ((payload: { id: string; code?: number }) => void),
    attention: undefined as undefined | ((payload: unknown) => void),
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
    bridgeMocks.pty.getSessionState.mockResolvedValue('Idle');
  });

  afterEach(() => {
    cleanup();
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
});
