import { useCallback, useEffect, useState } from 'react';
import { git, isTauriEnv, type BranchRow } from '../../lib/tauri-bridge';

interface CachedBranches {
  branches: BranchRow[];
}

interface ProjectBranchesSnapshot {
  projectPath: string;
  branches: BranchRow[];
  loading: boolean;
  error: string | null;
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
  const [snapshot, setSnapshot] = useState<ProjectBranchesSnapshot>(() => ({
    projectPath: cacheKey,
    branches: cached?.branches ?? [],
    loading: Boolean(projectPath && isTauriEnv() && !cached),
    error: null,
  }));
  const branches =
    snapshot.projectPath === cacheKey
      ? snapshot.branches
      : cached?.branches ?? [];
  const loading =
    snapshot.projectPath === cacheKey
      ? snapshot.loading
      : Boolean(projectPath && isTauriEnv() && !cached);
  const error =
    snapshot.projectPath === cacheKey ? snapshot.error : null;

  const load = useCallback(
    async (force = false) => {
      if (!projectPath || !isTauriEnv()) {
        setSnapshot({
          projectPath: cacheKey,
          branches: [],
          loading: false,
          error: null,
        });
        return;
      }

      if (!force) {
        const nextCached = branchCache.get(projectPath);
        if (nextCached) {
          setSnapshot({
            projectPath,
            branches: nextCached.branches,
            loading: false,
            error: null,
          });
          return;
        }
      }

      setSnapshot((current) => ({
        projectPath,
        branches:
          current.projectPath === projectPath ? current.branches : [],
        loading: true,
        error: null,
      }));
      try {
        const next = await git.branches.overview(projectPath);
        branchCache.set(projectPath, { branches: next });
        setSnapshot({
          projectPath,
          branches: next,
          loading: false,
          error: null,
        });
      } catch (err) {
        setSnapshot({
          projectPath,
          branches: [],
          loading: false,
          error: errorMessage(err),
        });
      }
    },
    [cacheKey, projectPath],
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
