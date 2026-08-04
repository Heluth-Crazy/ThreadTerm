import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SESSION_CATALOG_MAX_ROWS_PER_PROVIDER,
  getAgentSessionCatalogDiagnostics,
  useAgentSessionCatalogStore,
} from './agentSessionCatalogStore';

const listAgentSessions = vi.fn();

vi.mock('../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    listAgentSessions: (...args: unknown[]) => listAgentSessions(...args),
  },
}));

describe('useAgentSessionCatalogStore', () => {
  beforeEach(() => {
    listAgentSessions.mockReset();
    useAgentSessionCatalogStore.getState().reset();
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
      expect.objectContaining({ provider: 'claude' }),
    );
    expect(useAgentSessionCatalogStore.getState().providers.codex.loadState).toBe('idle');
    expect(useAgentSessionCatalogStore.getState().providers.opencode.loadState).toBe('idle');
    expect(useAgentSessionCatalogStore.getState().providers.gemini.loadState).toBe('idle');
    expect(useAgentSessionCatalogStore.getState().providers.claude.items).toHaveLength(1);
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
