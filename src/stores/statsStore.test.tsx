import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STATS_AUTO_REFRESH_HIDDEN_PANEL_INTERVAL_MS,
  STATS_AUTO_REFRESH_INTERVAL_MS,
  useStatsAutoRefresh,
  useStatsStore,
} from './statsStore';
import { useTerminalStore } from './terminalStore';
import type { AgentStats } from '../types/stats';
import type { StatsDashboard } from '../types/stats';
import type { TerminalCard } from '../types/terminal';

const bridgeMocks = vi.hoisted(() => ({
  compute: vi.fn(),
  dashboard: vi.fn(),
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
    dashboard: bridgeMocks.dashboard,
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
    inputOutputTokens: 150,
    cacheTokens: 0,
    costUsd: 0.001,
    calls: 1,
  };
  return {
    totalTokens: 150,
    inputOutputTokens: 150,
    cacheTokens: 0,
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

function makeDashboard(requestCount: number, requestId = `request-${requestCount}`): StatsDashboard {
  return {
    overview: {
      requestCount,
      successCount: requestCount,
      failureCount: 0,
      totalTokens: requestCount * 100,
      realTotalTokens: requestCount * 100,
      inputTokens: requestCount * 75,
      outputTokens: requestCount * 25,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      successRate: 1,
      totalCostUsd: requestCount / 100,
      unpricedRequestCount: 0,
      sessionCount: requestCount,
      proxyRequestCount: 0,
      sessionLogRequestCount: requestCount,
    },
    trends: [],
    byProvider: [],
    byModel: [],
    requestLogs: [
      {
        requestId,
        provider: 'codex',
        appType: 'codex',
        model: 'gpt-5-codex',
        requestModel: 'gpt-5-codex',
        pricingModel: 'gpt-5-codex',
        usage: { input: 75, output: 25, cacheCreation: 0, cacheRead: 0 },
        totalTokens: 100,
        realTotalTokens: 100,
        costUsd: 0.01,
        pricingStatus: 'builtin',
        success: true,
        streaming: false,
        dataSource: 'session_log',
        createdAt: 1,
      },
    ],
    nextCursor: null,
    pricingVersion: 'test',
  };
}

function resetStores() {
  useStatsStore.setState({
    snapshot: null,
    dashboard: null,
    dashboardLoading: false,
    dashboardError: null,
    bySession: {},
    loading: false,
    error: null,
    scope: 'all',
    range: '30d',
    dashboardFilters: { status: 'all', source: 'all' },
    scanned: 0,
    total: 0,
    activeRequestId: 0,
    activeSilent: false,
    lastComputedAt: null,
    panelOpen: false,
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
  bridgeMocks.dashboard.mockReset();
  bridgeMocks.dashboard.mockResolvedValue(makeDashboard(1));
  bridgeMocks.kill.mockReset();
  resetStores();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('statsStore silent compute', () => {
  it('starts the initial sync once', () => {
    act(() => {
      useStatsStore.getState().ensureInitialSync({ silent: true });
      useStatsStore.getState().ensureInitialSync({ silent: true });
    });

    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);
    expect(useStatsStore.getState().activeSilent).toBe(true);
  });

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

describe('statsStore dashboard query identity', () => {
  it('queries SQLite without scanning or discarding badge data for a new range', () => {
    useStatsStore.setState({
      snapshot: makeStats(),
      dashboard: makeDashboard(30, 'previous-30d'),
    });

    act(() => useStatsStore.getState().setRange('all'));

    expect(useStatsStore.getState()).toMatchObject({
      range: 'all',
      snapshot: makeStats(),
      dashboard: null,
      dashboardLoading: true,
      loading: false,
    });
    expect(bridgeMocks.compute).not.toHaveBeenCalled();
    expect(bridgeMocks.dashboard).toHaveBeenCalledWith(
      'all',
      'all',
      100,
      undefined,
      { status: 'all', source: 'all' },
    );
  });

  it('keeps 30d and all results stable across repeated range switches', async () => {
    bridgeMocks.dashboard.mockImplementation((_scope: string, range: string) =>
      Promise.resolve(range === '30d' ? makeDashboard(30, '30d') : makeDashboard(90, 'all')),
    );

    await act(async () => {
      await useStatsStore.getState().loadDashboard();
    });
    expect(useStatsStore.getState().dashboard?.overview.requestCount).toBe(30);

    for (const [range, expected] of [
      ['all', 90],
      ['30d', 30],
      ['all', 90],
      ['30d', 30],
    ] as const) {
      act(() => {
        useStatsStore.getState().setRange(range);
      });
      await vi.waitFor(() => {
        expect(useStatsStore.getState().dashboard?.overview.requestCount).toBe(expected);
      });
    }
    expect(bridgeMocks.compute).not.toHaveBeenCalled();
  });

  it('rejects an old same-key dashboard response after a range round trip', async () => {
    let resolveFirst30d: ((dashboard: StatsDashboard) => void) | undefined;
    let calls = 0;
    bridgeMocks.dashboard.mockImplementation((_scope: string, range: string) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<StatsDashboard>((resolve) => {
          resolveFirst30d = resolve;
        });
      }
      return Promise.resolve(
        range === 'all' ? makeDashboard(90, 'all') : makeDashboard(31, 'latest-30d'),
      );
    });

    act(() => {
      void useStatsStore.getState().loadDashboard();
    });
    act(() => {
      useStatsStore.getState().setRange('all');
    });
    await vi.waitFor(() => {
      expect(useStatsStore.getState().dashboard?.overview.requestCount).toBe(90);
    });
    act(() => {
      useStatsStore.getState().setRange('30d');
    });
    await vi.waitFor(() => {
      expect(useStatsStore.getState().dashboard?.overview.requestCount).toBe(31);
    });

    await act(async () => {
      resolveFirst30d?.(makeDashboard(29, 'stale-30d'));
      await Promise.resolve();
    });

    expect(useStatsStore.getState().dashboard?.overview.requestCount).toBe(31);
    expect(useStatsStore.getState().dashboard?.requestLogs[0]?.requestId).toBe('latest-30d');
  });

  it('uses DB-only queries for scope and dashboard filters', async () => {
    act(() => useStatsStore.getState().setScope('codex'));
    await vi.waitFor(() => expect(bridgeMocks.dashboard).toHaveBeenCalledTimes(1));

    act(() => {
      useStatsStore.getState().setDashboardFilters({
        status: 'success',
        source: 'proxy',
        projectPath: 'D:/repo/app',
      });
    });
    await vi.waitFor(() => expect(bridgeMocks.dashboard).toHaveBeenCalledTimes(2));

    expect(bridgeMocks.compute).not.toHaveBeenCalled();
    expect(bridgeMocks.dashboard).toHaveBeenLastCalledWith(
      'codex',
      '30d',
      100,
      undefined,
      {
        status: 'success',
        source: 'proxy',
        projectPath: 'D:/repo/app',
      },
    );
  });

  it('coalesces identical in-flight dashboard queries', async () => {
    let resolveDashboard: ((dashboard: StatsDashboard) => void) | undefined;
    bridgeMocks.dashboard.mockImplementation(
      () =>
        new Promise<StatsDashboard>((resolve) => {
          resolveDashboard = resolve;
        }),
    );

    const first = useStatsStore.getState().loadDashboard();
    const second = useStatsStore.getState().loadDashboard();

    expect(second).toBe(first);
    expect(bridgeMocks.dashboard).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveDashboard?.(makeDashboard(30));
      await first;
    });
  });
});

describe('useStatsAutoRefresh', () => {
  it('runs immediately and then on the relaxed interval while the panel is closed', () => {
    mockVisibility('visible');
    act(() => {
      useTerminalStore.setState({
        cards: [makeCard({ terminalType: 'codex', providerSessionId: 'codex-session-1' })],
      });
    });

    const { unmount } = renderHook(() => useStatsAutoRefresh());

    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(
        STATS_AUTO_REFRESH_HIDDEN_PANEL_INTERVAL_MS - STATS_AUTO_REFRESH_INTERVAL_MS,
      );
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(2);

    unmount();
    act(() => {
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_HIDDEN_PANEL_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(2);
  });

  it('polls at the faster interval while the stats panel is open', () => {
    mockVisibility('visible');
    useTerminalStore.setState({
      cards: [makeCard({ terminalType: 'codex', providerSessionId: 'codex-session-1' })],
    });
    act(() => {
      useStatsStore.getState().setPanelOpen(true);
    });

    renderHook(() => useStatsAutoRefresh());
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

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
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_HIDDEN_PANEL_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(2);
  });

  it('changes the polling interval without rescanning when the panel opens', () => {
    mockVisibility('visible');
    useTerminalStore.setState({
      cards: [makeCard({ terminalType: 'codex', providerSessionId: 'codex-session-1' })],
    });

    renderHook(() => useStatsAutoRefresh());
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    act(() => {
      useStatsStore.getState().setPanelOpen(true);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).toHaveBeenCalledTimes(2);
  });

  it.each(['opencode', 'gemini', 'grok'] as const)(
    'polls for a bound %s card',
    (terminalType) => {
      mockVisibility('visible');
      useTerminalStore.setState({
        cards: [makeCard({ terminalType, providerSessionId: `${terminalType}-session-1` })],
      });

      renderHook(() => useStatsAutoRefresh());

      expect(bridgeMocks.compute).toHaveBeenCalledTimes(1);
    },
  );

  it('does not poll without a bound stats-backed card', () => {
    mockVisibility('visible');
    useTerminalStore.setState({
      cards: [
        makeCard({ terminalType: 'claude', providerSessionId: undefined }),
        makeCard({ id: 'kimi', terminalType: 'kimi', providerSessionId: 'kimi-1' }),
      ],
    });

    renderHook(() => useStatsAutoRefresh());

    act(() => {
      vi.advanceTimersByTime(STATS_AUTO_REFRESH_HIDDEN_PANEL_INTERVAL_MS);
    });
    expect(bridgeMocks.compute).not.toHaveBeenCalled();
  });
});
