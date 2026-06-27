import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STATS_AUTO_REFRESH_INTERVAL_MS,
  useStatsAutoRefresh,
  useStatsStore,
} from './statsStore';
import { useTerminalStore } from './terminalStore';
import type { AgentStats } from '../types/stats';
import type { TerminalCard } from '../types/terminal';

const bridgeMocks = vi.hoisted(() => ({
  compute: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('../lib/tauri-bridge', () => ({
  isTauriEnv: () => false,
  pty: {
    kill: bridgeMocks.kill,
  },
  tokenStats: {
    compute: bridgeMocks.compute,
    cancel: vi.fn(),
    rebuild: vi.fn(),
    onProgress: vi.fn(() => Promise.resolve(() => {})),
    onDone: vi.fn(() => Promise.resolve(() => {})),
    onError: vi.fn(() => Promise.resolve(() => {})),
  },
}));

function makeStats(sessionId = 'session-1'): AgentStats {
  const bucket = {
    key: sessionId,
    label: sessionId,
    usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
    totalTokens: 150,
    costUsd: 0.001,
    calls: 1,
  };
  return {
    totalTokens: 150,
    totalCostUsd: 0.001,
    totalCalls: 1,
    sessionCount: 1,
    usage: bucket.usage,
    byModel: [],
    byProject: [],
    bySession: [bucket],
  };
}

function makeCard(overrides: Partial<TerminalCard>): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo/app',
    projectName: 'app',
    terminalType: 'claude',
    providerSessionId: 'session-1',
    providerSessionState: 'bound',
    status: 'idle',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    ...overrides,
  };
}

function resetStores() {
  useStatsStore.setState({
    snapshot: null,
    bySession: {},
    loading: false,
    error: null,
    scope: 'all',
    range: '30d',
    scanned: 0,
    total: 0,
    activeRequestId: 0,
    activeSilent: false,
    lastComputedAt: null,
  });
  useTerminalStore.setState({ cards: [] });
}

function mockVisibility(state: DocumentVisibilityState) {
  return vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
}

beforeEach(() => {
  vi.useFakeTimers();
  bridgeMocks.compute.mockReset();
  bridgeMocks.compute.mockResolvedValue(undefined);
  bridgeMocks.kill.mockReset();
  resetStores();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('statsStore silent compute', () => {
  it('does not toggle loading or progress, but still updates session buckets on done', () => {
    useStatsStore.setState({ scanned: 3, total: 5 });

    act(() => {
      useStatsStore.getState().compute({ silent: true });
    });

    const requestId = bridgeMocks.compute.mock.calls[0]?.[2] as number;
    expect(useStatsStore.getState()).toMatchObject({
      loading: false,
      scanned: 3,
      total: 5,
      activeSilent: true,
    });

    act(() => {
      useStatsStore.getState().handleProgress({ requestId, scanned: 4, total: 6 });
    });
    expect(useStatsStore.getState()).toMatchObject({ scanned: 3, total: 5 });

    act(() => {
      useStatsStore.getState().handleDone({ requestId, stats: makeStats('session-1') });
    });

    expect(useStatsStore.getState().activeSilent).toBe(false);
    expect(useStatsStore.getState().bySession['session-1']?.totalTokens).toBe(150);
  });

  it('keeps manual compute progress visible', () => {
    act(() => {
      useStatsStore.getState().compute();
    });

    const requestId = bridgeMocks.compute.mock.calls[0]?.[2] as number;
    expect(useStatsStore.getState().loading).toBe(true);

    act(() => {
      useStatsStore.getState().handleProgress({ requestId, scanned: 2, total: 10 });
    });

    expect(useStatsStore.getState()).toMatchObject({
      scanned: 2,
      total: 10,
      activeSilent: false,
    });
  });
});

describe('useStatsAutoRefresh', () => {
  it('runs immediately and then on interval for visible bound Claude/Codex cards', () => {
    mockVisibility('visible');
    useTerminalStore.setState({
      cards: [makeCard({ terminalType: 'codex', providerSessionId: 'codex-session-1' })],
    });

    const { unmount } = renderHook(() => useStatsAutoRefresh());

    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(2);

    unmount();
    act(() => {
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and refreshes immediately when visible again', () => {
    const visibility = mockVisibility('visible');
    useTerminalStore.setState({ cards: [makeCard({})] });

    renderHook(() => useStatsAutoRefresh());
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(2);
  });

  it('does not poll without a bound Claude/Codex card', () => {
    mockVisibility('visible');
    useTerminalStore.setState({
      cards: [
        makeCard({ terminalType: 'claude', providerSessionId: undefined }),
        makeCard({ id: 'opencode', terminalType: 'opencode', providerSessionId: 'open-1' }),
      ],
    });

    renderHook(() => useStatsAutoRefresh());

    act(() => {
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).not.toHaveBeenCalled();
  });
});
