import type { TerminalCard } from '../types/terminal';

export const PENDING_WORKTREE_PREFIX = 'pending-worktree:';

export interface PendingWorktreeSelection {
  projectPath: string;
  branch: string;
}

export interface WorktreePathCard {
  projectPath: string;
  projectName?: string;
  worktreePath?: string | null;
  branchLabel?: string | null;
}

export function normalizeComparablePath(path: string): string {
  const raw = path.trim();
  let normalized = raw
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\/unc\//i, '//')
    .replace(/^\/\/\?\//i, '');

  const windowsPath = (
    /^[A-Za-z]:(?:\/|$)/.test(normalized)
    || normalized.startsWith('//')
    || raw.includes('\\')
  );
  if (windowsPath) {
    const unc = normalized.startsWith('//');
    normalized = normalized.replace(/\/{2,}/g, '/');
    if (unc) normalized = `/${normalized}`;
  }

  const driveRootLength = /^[A-Za-z]:\/$/.test(normalized) ? 3 : 1;
  while (normalized.endsWith('/') && normalized.length > driveRootLength) {
    normalized = normalized.slice(0, -1);
  }

  return windowsPath ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeComparablePath(a) === normalizeComparablePath(b);
}

export function effectiveWorktreePath(card: WorktreePathCard): string {
  return card.worktreePath || card.projectPath;
}

export function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed || path;
}

export function worktreeDisplayLabel(card: WorktreePathCard): string {
  return (
    card.branchLabel?.trim() ||
    (card.worktreePath ? pathBasename(card.worktreePath) : card.projectName?.trim()) ||
    pathBasename(card.projectPath)
  );
}

export function pendingWorktreePath(projectPath: string, branch: string): string {
  return `${PENDING_WORKTREE_PREFIX}${encodeURIComponent(projectPath)}|${encodeURIComponent(branch)}`;
}

export function parsePendingWorktreePath(
  value: string | null | undefined,
): PendingWorktreeSelection | null {
  if (!value?.startsWith(PENDING_WORKTREE_PREFIX)) return null;
  const encoded = value.slice(PENDING_WORKTREE_PREFIX.length);
  const separator = encoded.indexOf('|');
  if (separator === -1) return null;
  try {
    return {
      projectPath: decodeURIComponent(encoded.slice(0, separator)),
      branch: decodeURIComponent(encoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export function isPendingWorktreePath(value: string | null | undefined): boolean {
  return parsePendingWorktreePath(value) !== null;
}

export function cardMatchesWorktree(
  card: Pick<TerminalCard, 'projectPath' | 'worktreePath'>,
  worktreePath: string | null | undefined,
): boolean {
  if (!worktreePath) return true;
  if (isPendingWorktreePath(worktreePath)) return false;
  return samePath(effectiveWorktreePath(card), worktreePath);
}
