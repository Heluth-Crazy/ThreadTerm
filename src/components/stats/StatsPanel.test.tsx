import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StatsPanel } from './StatsPanel';
import { useStatsStore } from '../../stores/statsStore';
import type { AgentStats, StatsDashboard } from '../../types/stats';

const bridgeMocks = vi.hoisted(() => ({
  compute: vi.fn(),
  dashboard: vi.fn(),
  proxyStatus: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

vi.mock('../../lib/tauri-bridge', () => ({
  tokenStats: {
    compute: bridgeMocks.compute,
    dashboard: bridgeMocks.dashboard,
    cancel: vi.fn(),
    rebuild: vi.fn(),
    proxyStatus: bridgeMocks.proxyStatus,
    pricingList: vi.fn(() => Promise.resolve([])),
    pricingUpsert: vi.fn(() => Promise.resolve()),
    pricingDelete: vi.fn(() => Promise.resolve()),
    onProgress: vi.fn(() => Promise.resolve(() => {})),
    onDone: vi.fn(() => Promise.resolve(() => {})),
    onError: vi.fn(() => Promise.resolve(() => {})),
  },
}));

function makeStats(): AgentStats {
  return {
    totalTokens: 150,
    inputOutputTokens: 150,
    cacheTokens: 0,
    totalCostUsd: 0.001,
    totalCalls: 1,
    sessionCount: 1,
    usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
    byModel: [],
    byProject: [],
    bySession: [],
  };
}

function makeDashboard(): StatsDashboard {
  return {
    overview: {
      requestCount: 1,
      successCount: 1,
      failureCount: 0,
      totalTokens: 150,
      realTotalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      successRate: 1,
      totalCostUsd: 0.001,
      unpricedRequestCount: 0,
      sessionCount: 1,
      proxyRequestCount: 0,
      sessionLogRequestCount: 1,
    },
    trends: [],
    byProvider: [],
    byModel: [],
    requestLogs: [],
    nextCursor: null,
    pricingVersion: 'test',
  };
}

function resetStatsStore() {
  useStatsStore.setState({
    snapshot: makeStats(),
    dashboard: makeDashboard(),
    dashboardLoading: false,
    dashboardError: null,
    dashboardFilters: { status: 'all', source: 'all' },
    bySession: {},
    loading: false,
    error: null,
    scope: 'all',
    range: '30d',
    scanned: 0,
    total: 0,
    activeRequestId: 0,
    activeSilent: false,
    lastComputedAt: 1,
    panelOpen: false,
  });
}

beforeEach(() => {
  bridgeMocks.compute.mockReset();
  bridgeMocks.compute.mockResolvedValue(undefined);
  bridgeMocks.dashboard.mockReset();
  bridgeMocks.dashboard.mockResolvedValue(makeDashboard());
  bridgeMocks.proxyStatus.mockReset();
  bridgeMocks.proxyStatus.mockResolvedValue({ running: false });
  resetStatsStore();
});

afterEach(() => {
  cleanup();
});

describe('StatsPanel', () => {
  it('keeps the header boundary aligned with the focused terminal header', () => {
    render(<StatsPanel onClose={vi.fn()} />);

    const header = screen.getByRole('heading', { name: 'Token usage' }).parentElement?.parentElement;

    expect(header).toHaveClass('h-15', 'shrink-0');
  });

  it('shows real input, output, and cache token totals from the DB dashboard', () => {
    const dashboard = makeDashboard();
    dashboard.overview.realTotalTokens = 500;
    dashboard.overview.totalTokens = 500;
    dashboard.overview.inputTokens = 100;
    dashboard.overview.outputTokens = 50;
    dashboard.overview.cacheCreationTokens = 25;
    dashboard.overview.cacheReadTokens = 325;
    useStatsStore.setState({
      dashboard,
    });

    render(<StatsPanel onClose={vi.fn()} />);

    expect(screen.getByText(/500 real tokens/)).toBeInTheDocument();
    expect(screen.getByText(/input 100/)).toBeInTheDocument();
    expect(screen.getByText(/output 50/)).toBeInTheDocument();
    expect(screen.getByText(/cache write 25/)).toBeInTheDocument();
    expect(screen.getByText(/cache read 325/)).toBeInTheDocument();
  });

  it('queries persisted usage without scanning when scoped to OpenCode', async () => {
    render(<StatsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));

    expect(useStatsStore.getState().scope).toBe('opencode');
    await waitFor(() => expect(bridgeMocks.dashboard).toHaveBeenCalledWith(
      'opencode',
      '30d',
      100,
      undefined,
      { status: 'all', source: 'all' },
    ));
    expect(bridgeMocks.compute).not.toHaveBeenCalled();
  });

  it('distinguishes a saved-statistics query from a session scan', () => {
    useStatsStore.setState({
      snapshot: makeStats(),
      dashboard: null,
      loading: false,
      dashboardLoading: true,
    });

    render(<StatsPanel onClose={vi.fn()} />);

    expect(screen.getByText('Loading saved statistics…')).toBeVisible();
    expect(screen.queryByText(/150 real tokens/)).not.toBeInTheDocument();
  });

  it('follows the selected project directory for dashboard filtering', () => {
    render(<StatsPanel onClose={vi.fn()} projectPath="D:/repo/app" />);

    expect(screen.getByRole('textbox', { name: 'Project directory' })).toHaveValue('D:/repo/app');
    expect(useStatsStore.getState().dashboardFilters.projectPath).toBe('D:/repo/app');
    expect(bridgeMocks.compute).not.toHaveBeenCalled();
  });

  it('clears a previous project filter when no project is selected', () => {
    useStatsStore.setState({
      dashboardFilters: {
        status: 'all',
        source: 'all',
        projectPath: 'D:/repo/previous',
      },
    });

    render(<StatsPanel onClose={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Project directory' })).toHaveValue('');
    expect(useStatsStore.getState().dashboardFilters.projectPath).toBeUndefined();
  });

  it.each([
    ['Gemini', 'gemini'],
    ['Grok Build', 'grok'],
  ] as const)('queries persisted usage when scoped to %s', async (label, scope) => {
    render(<StatsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(useStatsStore.getState().scope).toBe(scope);
    await waitFor(() => expect(bridgeMocks.dashboard).toHaveBeenCalledWith(
      scope,
      '30d',
      100,
      undefined,
      { status: 'all', source: 'all' },
    ));
    expect(bridgeMocks.compute).not.toHaveBeenCalled();
  });

  it('loads persisted DB data before starting the process initial sync', async () => {
    let resolveDashboard: ((dashboard: StatsDashboard) => void) | undefined;
    bridgeMocks.dashboard.mockImplementation(
      () =>
        new Promise<StatsDashboard>((resolve) => {
          resolveDashboard = resolve;
        }),
    );
    useStatsStore.setState({
      snapshot: null,
      dashboard: null,
      lastComputedAt: null,
      activeRequestId: 0,
    });

    render(<StatsPanel onClose={vi.fn()} />);

    expect(bridgeMocks.dashboard).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.compute).not.toHaveBeenCalled();

    await act(async () => {
      resolveDashboard?.(makeDashboard());
      await Promise.resolve();
    });
    await waitFor(() => expect(bridgeMocks.compute).toHaveBeenCalledTimes(1));
  });
});
