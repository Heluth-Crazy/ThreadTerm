import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionMetadataKey,
  AgentSessionMetadataResult,
} from '../types/agentSession';
import {
  METADATA_CACHE_FAILURE_TTL_MS,
  METADATA_CACHE_MAX_ENTRIES,
  METADATA_CACHE_SUCCESS_TTL_MS,
  __resetMetadataCacheForTests,
  __seedMetadataCacheEntryForTests,
  useAgentSessionMetadataCache,
} from './agentSessionMetadataCache';

vi.mock('../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    resolveMetadata: vi.fn(async ({ keys }: { keys: AgentSessionMetadataKey[] }) =>
      keys.map((key) => found(key, `Title ${key.sessionId}`)),
    ),
  },
}));

function found(
  key: AgentSessionMetadataKey,
  title: string,
): AgentSessionMetadataResult {
  return {
    key,
    state: 'found',
    summary: {
      provider: key.provider,
      id: key.sessionId,
      projectPath: key.projectPath ?? '',
      nativeTitle: title,
      titleKind: 'explicit',
      resumable: true,
    },
    warning: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('agentSessionMetadataCache', () => {
  afterEach(() => {
    __resetMetadataCacheForTests();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('deduplicates only the full provider/session/project identity', async () => {
    const { providerSessions } = await import('../lib/tauri-bridge');
    await useAgentSessionMetadataCache.getState().ensureKeys([
      { provider: 'kimi', sessionId: 'a', projectPath: 'D:\\repo\\one' },
      { provider: 'kimi', sessionId: 'a', projectPath: 'd:/REPO/one/' },
      { provider: 'kimi', sessionId: 'a', projectPath: 'D:/repo/two' },
      { provider: 'grok', sessionId: 'a', projectPath: 'D:/repo/one' },
    ]);

    const call = vi.mocked(providerSessions.resolveMetadata).mock.calls[0]?.[0];
    expect(call?.keys).toHaveLength(3);
    expect(
      useAgentSessionMetadataCache
        .getState()
        .getEntry('kimi', 'a', 'D:/repo/one')
        ?.summary?.nativeTitle,
    ).toBe('Title a');
  });

  it('queries every visible identity in bounded batches beyond one hundred', async () => {
    const { providerSessions } = await import('../lib/tauri-bridge');
    const keys = Array.from({ length: 205 }, (_, index) => ({
      provider: 'kimi' as const,
      sessionId: `s${index}`,
      projectPath: `/repo/${index}`,
    }));

    await useAgentSessionMetadataCache.getState().ensureKeys(keys);

    const calls = vi.mocked(providerSessions.resolveMetadata).mock.calls;
    expect(calls.map(([request]) => request.keys.length)).toEqual([100, 100, 5]);
    expect(useAgentSessionMetadataCache.getState().entries.size).toBe(205);
    expect(
      useAgentSessionMetadataCache
        .getState()
        .getEntry('kimi', 's204', '/repo/204')
        ?.status,
    ).toBe('found');
  });

  it('updates LRU order on a cache read hit', () => {
    const now = Date.now();
    for (let index = 0; index < METADATA_CACHE_MAX_ENTRIES; index += 1) {
      __seedMetadataCacheEntryForTests({
        key: { provider: 'kimi', sessionId: `s${index}`, projectPath: '/repo' },
        status: 'found',
        summary: null,
        warning: null,
        updatedAt: now,
        generation: 1,
        expiresAt: now + METADATA_CACHE_SUCCESS_TTL_MS,
      });
    }

    expect(
      useAgentSessionMetadataCache.getState().getEntry('kimi', 's0', '/repo'),
    ).toBeDefined();
    __seedMetadataCacheEntryForTests({
      key: { provider: 'kimi', sessionId: 'new', projectPath: '/repo' },
      status: 'found',
      summary: null,
      warning: null,
      updatedAt: now,
      generation: 1,
      expiresAt: now + METADATA_CACHE_SUCCESS_TTL_MS,
    });

    expect(useAgentSessionMetadataCache.getState().entries.size).toBe(
      METADATA_CACHE_MAX_ENTRIES,
    );
    expect(
      useAgentSessionMetadataCache.getState().getEntry('kimi', 's0', '/repo'),
    ).toBeDefined();
    expect(
      useAgentSessionMetadataCache.getState().getEntry('kimi', 's1', '/repo'),
    ).toBeUndefined();
  });

  it('deduplicates concurrent requests for the same effective identity', async () => {
    const { providerSessions } = await import('../lib/tauri-bridge');
    const pending = deferred<AgentSessionMetadataResult[]>();
    vi.mocked(providerSessions.resolveMetadata).mockReturnValueOnce(pending.promise);
    const key = { provider: 'kimi' as const, sessionId: 'same', projectPath: '/repo' };

    const first = useAgentSessionMetadataCache.getState().ensureKeys([key]);
    const second = useAgentSessionMetadataCache.getState().ensureKeys([key]);
    await Promise.resolve();
    expect(providerSessions.resolveMetadata).toHaveBeenCalledTimes(1);
    pending.resolve([found(key, 'Shared')]);
    await Promise.all([first, second]);
  });

  it('rejects a late response after invalidating and re-requesting the same key', async () => {
    const { providerSessions } = await import('../lib/tauri-bridge');
    const oldRequest = deferred<AgentSessionMetadataResult[]>();
    const key = { provider: 'kimi' as const, sessionId: 'same', projectPath: '/repo' };
    vi.mocked(providerSessions.resolveMetadata)
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce([found(key, 'New title')]);

    const first = useAgentSessionMetadataCache.getState().ensureKeys([key]);
    useAgentSessionMetadataCache.getState().invalidateKey('kimi', 'same', '/repo');
    await useAgentSessionMetadataCache.getState().ensureKeys([key]);
    oldRequest.resolve([found(key, 'Old title')]);
    await first;

    expect(
      useAgentSessionMetadataCache.getState().getEntry('kimi', 'same', '/repo')
        ?.summary?.nativeTitle,
    ).toBe('New title');
  });

  it('does not repopulate the cache after clear while a request is in flight', async () => {
    const { providerSessions } = await import('../lib/tauri-bridge');
    const pending = deferred<AgentSessionMetadataResult[]>();
    const key = { provider: 'grok' as const, sessionId: 'late', projectPath: '/repo' };
    vi.mocked(providerSessions.resolveMetadata).mockReturnValueOnce(pending.promise);

    const request = useAgentSessionMetadataCache.getState().ensureKeys([key]);
    useAgentSessionMetadataCache.getState().clear();
    pending.resolve([found(key, 'Too late')]);
    await request;

    expect(useAgentSessionMetadataCache.getState().entries.size).toBe(0);
  });

  it('rejects the old late response when the visible project changes', async () => {
    const { providerSessions } = await import('../lib/tauri-bridge');
    const oldRequest = deferred<AgentSessionMetadataResult[]>();
    const oldKey = { provider: 'codex' as const, sessionId: 'thread', projectPath: '/repo/old' };
    const newKey = { ...oldKey, projectPath: '/repo/new' };
    vi.mocked(providerSessions.resolveMetadata)
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce([found(newKey, 'New project')]);

    const oldPromise = useAgentSessionMetadataCache.getState().ensureKeys([oldKey]);
    useAgentSessionMetadataCache
      .getState()
      .invalidateKey('codex', 'thread', '/repo/old');
    await useAgentSessionMetadataCache.getState().ensureKeys([newKey]);
    oldRequest.resolve([found(oldKey, 'Old project')]);
    await oldPromise;

    expect(
      useAgentSessionMetadataCache.getState().getEntry('codex', 'thread', '/repo/new')
        ?.summary?.nativeTitle,
    ).toBe('New project');
    expect(
      useAgentSessionMetadataCache.getState().getEntry('codex', 'thread', '/repo/old')
        ?.summary?.nativeTitle,
    ).toBeUndefined();
  });

  it('isolates omitted and unavailable results inside a partial batch', async () => {
    const { providerSessions } = await import('../lib/tauri-bridge');
    const keys: AgentSessionMetadataKey[] = [
      { provider: 'claude', sessionId: 'ok', projectPath: '/repo' },
      { provider: 'codex', sessionId: 'omitted', projectPath: '/repo' },
      { provider: 'opencode', sessionId: 'missing-cli', projectPath: '/repo' },
    ];
    vi.mocked(providerSessions.resolveMetadata).mockResolvedValueOnce([
      found(keys[0], 'Found'),
      {
        key: keys[2],
        state: 'unavailable',
        summary: null,
        warning: 'missingCli',
      },
    ]);

    await useAgentSessionMetadataCache.getState().ensureKeys(keys);

    expect(
      useAgentSessionMetadataCache.getState().getEntry('claude', 'ok', '/repo')?.status,
    ).toBe('found');
    expect(
      useAgentSessionMetadataCache.getState().getEntry('codex', 'omitted', '/repo')?.status,
    ).toBe('error');
    expect(
      useAgentSessionMetadataCache
        .getState()
        .getEntry('opencode', 'missing-cli', '/repo')
        ?.status,
    ).toBe('unavailable');
  });

  it('uses sixty-second success and fifteen-second failure TTLs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));
    const { providerSessions } = await import('../lib/tauri-bridge');
    const foundKey = { provider: 'kimi' as const, sessionId: 'found', projectPath: '/repo' };
    const missingKey = { provider: 'grok' as const, sessionId: 'missing', projectPath: '/repo' };
    vi.mocked(providerSessions.resolveMetadata).mockResolvedValueOnce([
      found(foundKey, 'Found'),
      { key: missingKey, state: 'missing', summary: null, warning: null },
    ]);
    await useAgentSessionMetadataCache.getState().ensureKeys([foundKey, missingKey]);

    vi.advanceTimersByTime(METADATA_CACHE_FAILURE_TTL_MS - 1);
    expect(
      useAgentSessionMetadataCache.getState().getEntry('grok', 'missing', '/repo'),
    ).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(
      useAgentSessionMetadataCache.getState().getEntry('grok', 'missing', '/repo'),
    ).toBeUndefined();
    expect(
      useAgentSessionMetadataCache.getState().getEntry('kimi', 'found', '/repo'),
    ).toBeDefined();
    vi.advanceTimersByTime(
      METADATA_CACHE_SUCCESS_TTL_MS - METADATA_CACHE_FAILURE_TTL_MS,
    );
    expect(
      useAgentSessionMetadataCache.getState().getEntry('kimi', 'found', '/repo'),
    ).toBeUndefined();
  });
});
