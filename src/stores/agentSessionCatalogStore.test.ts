import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentSessionCatalogStore } from './agentSessionCatalogStore';

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
});
