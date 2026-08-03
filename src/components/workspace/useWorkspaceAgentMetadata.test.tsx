import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMetadataCacheForTests,
  useAgentSessionMetadataCache,
} from '../../stores/agentSessionMetadataCache';
import type {
  AgentSessionMetadataKey,
  AgentSessionMetadataResult,
} from '../../types/agentSession';
import type { TerminalCard } from '../../types/terminal';
import { useWorkspaceAgentMetadata } from './useWorkspaceAgentMetadata';

const bridgeMocks = vi.hoisted(() => ({
  resolveMetadata: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  providerSessions: {
    resolveMetadata: (...args: unknown[]) => bridgeMocks.resolveMetadata(...args),
  },
}));

function card(worktreePath: string, sessionId = 'thread-1'): TerminalCard {
  return {
    id: 'card-1',
    ptyId: 'card-1',
    projectPath: '/repo',
    projectName: 'repo',
    worktreePath,
    terminalType: 'codex',
    status: 'running',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
    providerSessionId: sessionId,
    providerSessionState: 'bound',
  };
}

function found(key: AgentSessionMetadataKey, title: string): AgentSessionMetadataResult {
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

describe('useWorkspaceAgentMetadata', () => {
  afterEach(() => {
    __resetMetadataCacheForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('refreshes an expired visible identity when the desktop regains focus', async () => {
    let clock = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const key: AgentSessionMetadataKey = {
      provider: 'codex',
      sessionId: 'thread-1',
      projectPath: '/repo',
    };
    bridgeMocks.resolveMetadata
      .mockResolvedValueOnce([found(key, 'First title')])
      .mockResolvedValueOnce([found(key, 'Refreshed title')]);

    renderHook(() => useWorkspaceAgentMetadata([card('/repo')]));
    await waitFor(() => expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(1);

    clock += 60_001;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(
        useAgentSessionMetadataCache
          .getState()
          .getEntry('codex', 'thread-1', '/repo')
          ?.summary?.nativeTitle,
      ).toBe('Refreshed title');
    });
  });

  it('invalidates an old in-flight identity when the card changes worktree', async () => {
    const oldRequest = deferred<AgentSessionMetadataResult[]>();
    const oldKey: AgentSessionMetadataKey = {
      provider: 'codex',
      sessionId: 'thread-1',
      projectPath: '/repo/old',
    };
    const newKey: AgentSessionMetadataKey = {
      ...oldKey,
      projectPath: '/repo/new',
    };
    bridgeMocks.resolveMetadata
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce([found(newKey, 'New worktree')]);

    const { rerender } = renderHook(
      ({ cards }: { cards: TerminalCard[] }) => useWorkspaceAgentMetadata(cards),
      { initialProps: { cards: [card('/repo/old')] } },
    );
    await waitFor(() => expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(1));

    rerender({ cards: [card('/repo/new')] });
    await waitFor(() => expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(2));
    oldRequest.resolve([found(oldKey, 'Old worktree')]);

    await waitFor(() => {
      expect(
        useAgentSessionMetadataCache
          .getState()
          .getEntry('codex', 'thread-1', '/repo/new')
          ?.summary?.nativeTitle,
      ).toBe('New worktree');
    });
    expect(
      useAgentSessionMetadataCache
        .getState()
        .getEntry('codex', 'thread-1', '/repo/old'),
    ).toBeUndefined();
  });

  it('invalidates an in-flight identity when its workspace owner unmounts', async () => {
    const pending = deferred<AgentSessionMetadataResult[]>();
    const key: AgentSessionMetadataKey = {
      provider: 'codex',
      sessionId: 'thread-1',
      projectPath: '/repo',
    };
    bridgeMocks.resolveMetadata.mockReturnValueOnce(pending.promise);

    const { unmount } = renderHook(() => useWorkspaceAgentMetadata([card('/repo')]));
    await waitFor(() => expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(1));
    unmount();
    pending.resolve([found(key, 'Stale workspace')]);
    await pending.promise;
    await Promise.resolve();

    expect(
      useAgentSessionMetadataCache
        .getState()
        .getEntry('codex', 'thread-1', '/repo'),
    ).toBeUndefined();
  });

  it('invalidates an old in-flight identity when the card is rebound', async () => {
    const oldRequest = deferred<AgentSessionMetadataResult[]>();
    const oldKey: AgentSessionMetadataKey = {
      provider: 'codex',
      sessionId: 'thread-old',
      projectPath: '/repo',
    };
    const newKey: AgentSessionMetadataKey = {
      ...oldKey,
      sessionId: 'thread-new',
    };
    bridgeMocks.resolveMetadata
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce([found(newKey, 'New binding')]);

    const { rerender } = renderHook(
      ({ cards }: { cards: TerminalCard[] }) => useWorkspaceAgentMetadata(cards),
      { initialProps: { cards: [card('/repo', 'thread-old')] } },
    );
    await waitFor(() => expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(1));

    rerender({ cards: [card('/repo', 'thread-new')] });
    await waitFor(() => expect(bridgeMocks.resolveMetadata).toHaveBeenCalledTimes(2));
    oldRequest.resolve([found(oldKey, 'Old binding')]);

    await waitFor(() => {
      expect(
        useAgentSessionMetadataCache
          .getState()
          .getEntry('codex', 'thread-new', '/repo')
          ?.summary?.nativeTitle,
      ).toBe('New binding');
    });
    expect(
      useAgentSessionMetadataCache
        .getState()
        .getEntry('codex', 'thread-old', '/repo'),
    ).toBeUndefined();
  });
});
