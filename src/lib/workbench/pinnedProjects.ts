export const MAX_PINNED_PROJECTS = 6;

export function normalizePinnedProjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== 'string' ||
      candidate.trim().length === 0 ||
      seen.has(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized.slice(0, MAX_PINNED_PROJECTS);
}

export function reconcilePinnedProjectPaths(
  currentPinned: readonly string[],
  validProjectPaths: readonly string[],
): string[] {
  const validSet = new Set(
    validProjectPaths.filter(
      (projectPath) =>
        typeof projectPath === 'string' && projectPath.trim().length > 0,
    ),
  );
  return normalizePinnedProjects(currentPinned).filter((projectPath) =>
    validSet.has(projectPath),
  );
}

export function pinnedProjectsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((projectPath, index) => projectPath === right[index])
  );
}
