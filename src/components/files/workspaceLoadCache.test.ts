import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_CHANGES_CACHE_MAX_ENTRIES,
  WORKSPACE_DIRECTORY_CACHE_MAX_ENTRIES,
  WORKSPACE_DIRECTORY_CACHE_MAX_ESTIMATED_BYTES,
  clearWorkspaceLoadCaches,
  getCachedWorkspaceChanges,
  getCachedWorkspaceDirectory,
  getWorkspaceLoadCacheDiagnostics,
  loadWorkspaceChanges,
  loadWorkspaceDirectory,
} from './workspaceLoadCache';

const bridgeMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  invoke: bridgeMocks.invoke,
  git: {
    changes: {
      status: bridgeMocks.status,
    },
  },
}));

describe('workspaceLoadCache', () => {
  beforeEach(() => {
    clearWorkspaceLoadCaches();
    bridgeMocks.invoke.mockReset().mockImplementation((_command: string, { path }: { path: string }) =>
      Promise.resolve([
        {
          name: path,
          path,
          isDir: false,
          isHidden: false,
        },
      ]),
    );
    bridgeMocks.status.mockReset().mockImplementation((path: string) =>
      Promise.resolve([
        {
          path: 'changed.ts',
          absolutePath: `${path}/changed.ts`,
          repositoryRoot: path,
          isUntracked: false,
        },
      ]),
    );
  });

  it('evicts the least recently used directory and reloads it from the source', async () => {
    for (let index = 0; index < WORKSPACE_DIRECTORY_CACHE_MAX_ENTRIES; index += 1) {
      await loadWorkspaceDirectory(`/repo/${index}`);
    }
    expect(getCachedWorkspaceDirectory('/repo/0')).not.toBeNull();

    await loadWorkspaceDirectory('/repo/overflow');

    expect(getCachedWorkspaceDirectory('/repo/0')).not.toBeNull();
    expect(getCachedWorkspaceDirectory('/repo/1')).toBeNull();
    await loadWorkspaceDirectory('/repo/1');
    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(WORKSPACE_DIRECTORY_CACHE_MAX_ENTRIES + 2);
  });

  it('does not retain a directory result larger than the byte budget', async () => {
    const oversizedPath = 'x'.repeat(Math.floor(WORKSPACE_DIRECTORY_CACHE_MAX_ESTIMATED_BYTES / 2) + 1);
    bridgeMocks.invoke.mockResolvedValue([
      {
        name: 'large',
        path: oversizedPath,
        isDir: false,
        isHidden: false,
      },
    ]);

    await loadWorkspaceDirectory('/oversized');
    expect(getCachedWorkspaceDirectory('/oversized')).toBeNull();
    await loadWorkspaceDirectory('/oversized');
    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('bounds git status entries independently and exposes read-only diagnostics', async () => {
    for (let index = 0; index <= WORKSPACE_CHANGES_CACHE_MAX_ENTRIES; index += 1) {
      await loadWorkspaceChanges(`/repo/${index}`);
    }

    expect(getCachedWorkspaceChanges('/repo/0')).toBeNull();
    expect(getCachedWorkspaceChanges(`/repo/${WORKSPACE_CHANGES_CACHE_MAX_ENTRIES}`)).not.toBeNull();
    expect(getWorkspaceLoadCacheDiagnostics()).toMatchObject({
      directory: {
        entryCount: 0,
        maxEntries: WORKSPACE_DIRECTORY_CACHE_MAX_ENTRIES,
      },
      changes: {
        entryCount: WORKSPACE_CHANGES_CACHE_MAX_ENTRIES,
        maxEntries: WORKSPACE_CHANGES_CACHE_MAX_ENTRIES,
        evictionCount: 1,
      },
    });
  });
});
