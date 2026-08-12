import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER,
  AGENT_SESSION_CATALOG_STALL_TIMEOUT_MS,
  AGENT_SESSION_CATALOG_STALLED_ERROR,
  getAgentSessionCatalogDiagnostics,
  useAgentSessionCatalogStore,
} from './agentSessionCatalogStore';

const listAgentSessions = vi.fn();
const cancelAgentSessionScan = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    listAgentSessions: (...args: unknown[]) => listAgentSessions(...args),
    cancelAgentSessionScan: (...args: unknown[]) => cancelAgentSessionScan(...args),
    onCatalogProgress: vi.fn().mockResolvedValue(() => {}),
  },
}));

describe('useAgentSessionCatalogStore', () => {
  beforeEach(() => {
    listAgentSessions.mockReset();
    cancelAgentSessionScan.mockClear();
    useAgentSessionCatalogStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads only the active provider and leaves other tabs idle', async () => {
    listAgentSessions.mockResolvedValue({
      provider: 'claude',
      availability: 'available',
      items: [
        {
          provider: 'claude',
          id: 'c1',
          projectPath: '/repo',
          titleKind: 'firstPrompt',
          firstUserMessagePreview: 'hello',
          resumable: true,
        },
      ],
      nextCursor: null,
      scannedAt: 1,
    });

    await useAgentSessionCatalogStore.getState().ensureLoaded('claude');

    expect(listAgentSessions).toHaveBeenCalledTimes(1);
    expect(listAgentSessions).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude', requestId: expect.any(Number) }),
    );
    expect(useAgentSessionCatalogStore.getState().providers.codex.loadState).toBe('idle');
    expect(useAgentSessionCatalogStore.getState().providers.opencode.loadState).toBe('idle');
    expect(useAgentSessionCatalogStore.getState().providers.gemini.loadState).toBe('idle');
    expect(useAgentSessionCatalogStore.getState().providers.claude.items).toHaveLength(1);
  });

  it('loads a switched provider independently while the previous scan continues', async () => {
    let resolveClaude: ((value: unknown) => void) | undefined;
    listAgentSessions
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveClaude = resolve; }),
      )
      .mockResolvedValueOnce({
        provider: 'codex',
        availability: 'available',
        items: [],
        nextCursor: null,
        scannedAt: 2,
      });

    const claude = useAgentSessionCatalogStore.getState().ensureLoaded('claude');
    useAgentSessionCatalogStore.getState().setActiveProvider('codex');
    await vi.waitFor(() => {
      expect(useAgentSessionCatalogStore.getState().providers.codex.loadState).toBe('ready');
    });

    expect(listAgentSessions).toHaveBeenCalledTimes(2);
    expect(useAgentSessionCatalogStore.getState().providers.claude.loadState).toBe('loading');
    resolveClaude?.({
      provider: 'claude',
      availability: 'available',
      items: [],
      nextCursor: null,
      scannedAt: 1,
    });
    await claude;
  });

  it('ignores stale responses after a query reset', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    listAgentSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const first = useAgentSessionCatalogStore.getState().ensureLoaded('claude');
    useAgentSessionCatalogStore.getState().setQuery('login');
    await Promise.resolve();

    const firstRequestId = listAgentSessions.mock.calls[0]?.[0]?.requestId;
    expect(cancelAgentSessionScan).toHaveBeenCalledWith(firstRequestId);

    resolveFirst?.({
      provider: 'claude',
      availability: 'available',
      items: [
        {
          provider: 'claude',
          id: 'stale',
          projectPath: '/repo',
          titleKind: 'unknown',
          resumable: true,
        },
      ],
      nextCursor: null,
      scannedAt: 1,
    });
    await first;

    expect(
      useAgentSessionCatalogStore
        .getState()
        .providers.claude.items.some((item) => item.id === 'stale'),
    ).toBe(false);
  });

  it('accepts only request-correlated monotonic progress', async () => {
    let resolvePage: ((value: unknown) => void) | undefined;
    listAgentSessions.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );
    const pending = useAgentSessionCatalogStore.getState().ensureLoaded('claude');
    const requestId = listAgentSessions.mock.calls[0]?.[0]?.requestId as number;

    useAgentSessionCatalogStore.getState().handleProgress({
      requestId: requestId + 1,
      provider: 'claude',
      phase: 'scanning',
      completed: 9,
      total: 10,
      elapsedMs: 100,
    });
    expect(useAgentSessionCatalogStore.getState().providers.claude.progress).toBeNull();

    useAgentSessionCatalogStore.getState().handleProgress({
      requestId,
      provider: 'claude',
      phase: 'scanning',
      completed: 5,
      total: 10,
      elapsedMs: 200,
    });
    useAgentSessionCatalogStore.getState().handleProgress({
      requestId,
      provider: 'claude',
      phase: 'scanning',
      completed: 3,
      total: 10,
      elapsedMs: 150,
    });
    expect(useAgentSessionCatalogStore.getState().providers.claude.progress).toMatchObject({
      requestId,
      completed: 5,
      total: 10,
      elapsedMs: 200,
    });

    resolvePage?.({
      provider: 'claude',
      availability: 'available',
      items: [],
      nextCursor: null,
      scannedAt: 1,
    });
    await pending;
    expect(useAgentSessionCatalogStore.getState().providers.claude.progress).toBeNull();
  });

  it('turns a silent scan into an explicit retryable error', async () => {
    vi.useFakeTimers();
    listAgentSessions.mockImplementationOnce(() => new Promise(() => {}));
    void useAgentSessionCatalogStore.getState().ensureLoaded('codex');
    const requestId = listAgentSessions.mock.calls[0]?.[0]?.requestId as number;

    await vi.advanceTimersByTimeAsync(AGENT_SESSION_CATALOG_STALL_TIMEOUT_MS);

    expect(cancelAgentSessionScan).toHaveBeenCalledWith(requestId);
    expect(useAgentSessionCatalogStore.getState().providers.codex).toMatchObject({
      loadState: 'error',
      availability: 'error',
      errorMessage: AGENT_SESSION_CATALOG_STALLED_ERROR,
      activeRequestId: null,
      progress: null,
    });
  });

  it('keeps a long scan alive while correlated heartbeats continue', async () => {
    vi.useFakeTimers();
    listAgentSessions.mockImplementationOnce(() => new Promise(() => {}));
    void useAgentSessionCatalogStore.getState().ensureLoaded('codex');
    const requestId = listAgentSessions.mock.calls[0]?.[0]?.requestId as number;

    for (let heartbeat = 1; heartbeat <= 11; heartbeat += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      useAgentSessionCatalogStore.getState().handleProgress({
        requestId,
        provider: 'codex',
        phase: 'scanning',
        completed: 0,
        total: null,
        elapsedMs: heartbeat * 2_000,
      });
    }

    expect(useAgentSessionCatalogStore.getState().providers.codex.loadState).toBe(
      'loading',
    );
    expect(cancelAgentSessionScan).not.toHaveBeenCalledWith(requestId);

    await vi.advanceTimersByTimeAsync(
      AGENT_SESSION_CATALOG_STALL_TIMEOUT_MS,
    );
    expect(cancelAgentSessionScan).toHaveBeenCalledWith(requestId);
    expect(useAgentSessionCatalogStore.getState().providers.codex.errorMessage).toBe(
      AGENT_SESSION_CATALOG_STALLED_ERROR,
    );
  });

  it('preserves selected summaries when a query replaces provider rows', async () => {
    listAgentSessions
      .mockResolvedValueOnce({
        provider: 'claude',
        availability: 'available',
        items: [
          {
            provider: 'claude',
            id: 'selected-session',
            projectPath: '/repo',
            titleKind: 'firstPrompt',
            firstUserMessagePreview: 'keep me selected',
            resumable: true,
          },
        ],
        nextCursor: null,
        scannedAt: 1,
      })
      .mockResolvedValueOnce({
        provider: 'claude',
        availability: 'available',
        items: [],
        nextCursor: null,
        scannedAt: 2,
      });

    await useAgentSessionCatalogStore.getState().ensureLoaded('claude');
    useAgentSessionCatalogStore.getState().toggleSelected('claude', 'selected-session');
    useAgentSessionCatalogStore.getState().setQuery('different result');

    await vi.waitFor(() => {
      expect(useAgentSessionCatalogStore.getState().providers.claude.loadState).toBe('ready');
    });
    expect(useAgentSessionCatalogStore.getState().providers.claude.items).toEqual([]);
    expect(useAgentSessionCatalogStore.getState().selectedKeys.size).toBe(1);
    expect(useAgentSessionCatalogStore.getState().getSelectedSummaries()).toEqual([
      expect.objectContaining({ id: 'selected-session' }),
    ]);
  });

  it('keeps provider rows bounded and exposes catalog diagnostics', async () => {
    listAgentSessions.mockResolvedValue({
      provider: 'claude',
      availability: 'available',
      items: Array.from({ length: AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER + 25 }, (_, index) => ({
        provider: 'claude',
        id: `session-${index}`,
        projectPath: `/repo/${index}`,
        titleKind: 'firstPrompt',
        firstUserMessagePreview: `preview-${index}`,
        resumable: true,
      })),
      nextCursor: 'next',
      scannedAt: 1,
    });

    await useAgentSessionCatalogStore.getState().ensureLoaded('claude');

    expect(useAgentSessionCatalogStore.getState().providers.claude.items).toHaveLength(
      AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER,
    );
    expect(getAgentSessionCatalogDiagnostics()).toMatchObject({
      rowCount: AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER,
      maxRowCount: AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER * 6,
      selectedSummaryCount: 0,
    });
    expect(getAgentSessionCatalogDiagnostics().estimatedBytes).toBeGreaterThan(0);
  });
});
