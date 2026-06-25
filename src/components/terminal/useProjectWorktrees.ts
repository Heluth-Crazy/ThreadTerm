import { useCallback, useEffect, useState } from 'react';
import { git, isTauriEnv, type WorktreeInfo } from '../../lib/tauri-bridge';

interface CachedWorktrees {
  worktrees: WorktreeInfo[];
}

interface ProjectWorktreesState {
  worktrees: WorktreeInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const worktreeCache = new Map<string, CachedWorktrees>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clearProjectWorktreeCache(): void {
  worktreeCache.clear();
}

export function useProjectWorktrees(projectPath: string | null | undefined): ProjectWorktreesState {
  const cacheKey = projectPath ?? '';
  const cached = cacheKey ? worktreeCache.get(cacheKey) : undefined;
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>(cached?.worktrees ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (!projectPath || !isTauriEnv()) {
        setWorktrees([]);
        setLoading(false);
        setError(null);
        return;
      }

      if (!force) {
        const nextCached = worktreeCache.get(projectPath);
        if (nextCached) {
          setWorktrees(nextCached.worktrees);
          setLoading(false);
          setError(null);
          return;
        }
      }

      setLoading(true);
      setError(null);
      try {
        const next = await git.worktrees.list(projectPath);
        worktreeCache.set(projectPath, { worktrees: next });
        setWorktrees(next);
      } catch (err) {
        setError(errorMessage(err));
        setWorktrees([]);
      } finally {
        setLoading(false);
      }
    },
    [projectPath],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return {
    worktrees,
    loading,
    error,
    refresh: () => load(true),
  };
}
