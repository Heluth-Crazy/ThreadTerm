import { useCallback, useEffect, useState } from 'react';
import { git, isTauriEnv, type BranchRow } from '../../lib/tauri-bridge';

interface CachedBranches {
  branches: BranchRow[];
}

interface ProjectBranchesState {
  branches: BranchRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const branchCache = new Map<string, CachedBranches>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clearProjectBranchCache(): void {
  branchCache.clear();
}

export function useProjectBranches(projectPath: string | null | undefined): ProjectBranchesState {
  const cacheKey = projectPath ?? '';
  const cached = cacheKey ? branchCache.get(cacheKey) : undefined;
  const [branches, setBranches] = useState<BranchRow[]>(cached?.branches ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (!projectPath || !isTauriEnv()) {
        setBranches([]);
        setLoading(false);
        setError(null);
        return;
      }

      if (!force) {
        const nextCached = branchCache.get(projectPath);
        if (nextCached) {
          setBranches(nextCached.branches);
          setLoading(false);
          setError(null);
          return;
        }
      }

      setLoading(true);
      setError(null);
      try {
        const next = await git.branches.overview(projectPath);
        branchCache.set(projectPath, { branches: next });
        setBranches(next);
      } catch (err) {
        setError(errorMessage(err));
        setBranches([]);
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
    branches,
    loading,
    error,
    refresh: () => load(true),
  };
}
