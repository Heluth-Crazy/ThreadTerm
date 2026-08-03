import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { useProviderSessionLifecycle } from './useProviderSessionLifecycle';

const bridgeMocks = vi.hoisted(() => ({
  findRecent: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    findRecent: (...args: unknown[]) => bridgeMocks.findRecent(...args),
  },
}));

function card(): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo',
    projectName: 'repo',
    terminalType: 'opencode',
    status: 'running',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    providerSessionState: 'unbound',
  };
}

describe('useProviderSessionLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridgeMocks.findRecent.mockReset();
    useTerminalStore.setState({ cards: [], archivedCards: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never overlaps slow recent-session polling calls', async () => {
    let resolveFirst!: (value: null) => void;
    bridgeMocks.findRecent.mockImplementationOnce(() => new Promise<null>((resolve) => {
      resolveFirst = resolve;
    }));
    bridgeMocks.findRecent.mockResolvedValue(null);
    const currentCard = card();
    const { result } = renderHook(() => useProviderSessionLifecycle(
      currentCard,
      { command: 'opencode', provider: 'opencode', action: 'start' },
    ));

    act(() => result.current());
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridgeMocks.findRecent).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(bridgeMocks.findRecent).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(null);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(bridgeMocks.findRecent).toHaveBeenCalledTimes(2);
  });
});
