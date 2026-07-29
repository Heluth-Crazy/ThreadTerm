import {
  effectiveWorktreePath,
  normalizeComparablePath,
} from '../worktreePaths';
import type {
  AttentionItem,
  WorkbenchScopeAttentionCounts,
} from './types';

export function deriveWorkbenchScopeAttentionCounts(
  attentionItems: readonly AttentionItem[],
): WorkbenchScopeAttentionCounts {
  const byProjectPath: Record<string, number> = {};
  const byWorktreeKey: Record<string, number> = {};

  for (const item of attentionItems) {
    const projectKey = workbenchProjectScopeKey(item.projectPath);
    const worktreeKey = workbenchWorktreeScopeKey(
      item.projectPath,
      effectiveWorktreePath(item),
    );
    byProjectPath[projectKey] = (byProjectPath[projectKey] ?? 0) + 1;
    byWorktreeKey[worktreeKey] = (byWorktreeKey[worktreeKey] ?? 0) + 1;
  }

  return { byProjectPath, byWorktreeKey };
}

export function getWorkbenchProjectAttentionCount(
  counts: WorkbenchScopeAttentionCounts,
  projectPath: string,
): number {
  return counts.byProjectPath[workbenchProjectScopeKey(projectPath)] ?? 0;
}

export function getWorkbenchWorktreeAttentionCount(
  counts: WorkbenchScopeAttentionCounts,
  projectPath: string,
  worktreePath: string,
): number {
  return (
    counts.byWorktreeKey[
      workbenchWorktreeScopeKey(projectPath, worktreePath)
    ] ?? 0
  );
}

export function workbenchProjectScopeKey(projectPath: string): string {
  return normalizeComparablePath(projectPath);
}

export function workbenchWorktreeScopeKey(
  projectPath: string,
  worktreePath: string,
): string {
  return `${normalizeComparablePath(projectPath)}\u001f${normalizeComparablePath(worktreePath)}`;
}
