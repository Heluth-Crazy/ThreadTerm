import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatsPanel } from './StatsPanel';
import { useStatsStore } from '../../stores/statsStore';
import type { AgentStats } from '../../types/stats';

const bridgeMocks = vi.hoisted(() => ({
  compute: vi.fn(),
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
    cancel: vi.fn(),
    rebuild: vi.fn(),
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

function resetStatsStore() {
  useStatsStore.setState({
    snapshot: makeStats(),
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
}

beforeEach(() => {
  bridgeMocks.compute.mockReset();
  bridgeMocks.compute.mockResolvedValue(undefined);
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

  it('shows real, input/output, and cache token totals', () => {
    useStatsStore.setState({
      snapshot: {
        ...makeStats(),
        totalTokens: 500,
        inputOutputTokens: 150,
        cacheTokens: 350,
        usage: { input: 100, output: 50, cacheCreation: 25, cacheRead: 325 },
      },
    });

    render(<StatsPanel onClose={vi.fn()} />);

    expect(screen.getByText(/500 real tokens/)).toBeInTheDocument();
    expect(screen.getByText(/input \+ output 150/)).toBeInTheDocument();
    expect(screen.getByText(/cache 350/)).toBeInTheDocument();
  });

  it('lets the user scope usage to OpenCode', () => {
    render(<StatsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));

    expect(useStatsStore.getState().scope).toBe('opencode');
    expect(bridgeMocks.compute).toHaveBeenCalledWith(
      'opencode',
      '30d',
      expect.any(Number),
    );
  });

  it.each([
    ['Gemini', 'gemini'],
    ['Grok Build', 'grok'],
  ] as const)('lets the user scope usage to %s', (label, scope) => {
    render(<StatsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(useStatsStore.getState().scope).toBe(scope);
    expect(bridgeMocks.compute).toHaveBeenCalledWith(scope, '30d', expect.any(Number));
  });
});
