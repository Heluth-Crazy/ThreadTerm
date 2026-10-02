import type { InboxItem, Session } from "@threadterm/protocol";
import { isActionableInboxItem } from "./inboxVisibility";

/**
 * Runtime identity may keep Windows extended-length forms for filesystem
 * operations. User-facing text must use displayPath(); scope comparisons use
 * canonicalScopePath().
 */
export function displayPath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) return "\\\\" + trimmed.slice(8);
  if (lower.startsWith("\\\\?\\")) return trimmed.slice(4);
  if (lower.startsWith("//?/unc/")) return "//" + trimmed.slice(8);
  if (lower.startsWith("//?/")) return trimmed.slice(4);
  return trimmed;
}

export function canonicalScopePath(value: string | undefined): string | undefined {
  const trimmed = displayPath(value);
  if (!trimmed) return undefined;
  let path = trimmed.replace(/\//g, "\\");
  const unc = path.startsWith("\\\\");
  return (unc ? "\\\\" : "") + (unc ? path.slice(2) : path).replace(/\\+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function sameCanonicalScope(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const canonicalLeft = canonicalScopePath(left);
  const canonicalRight = canonicalScopePath(right);
  return Boolean(canonicalLeft && canonicalRight && canonicalLeft === canonicalRight);
}

export function pathIsWithinCanonicalScope(path: string | undefined, root: string | undefined): boolean {
  const scope = canonicalScopePath(path);
  const base = canonicalScopePath(root);
  if (!scope || !base) return false;
  if (scope === base) return true;
  const slash = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  return scope.startsWith(base + slash);
}

export function closestProjectForPath<T extends { id: string; path: string }>(
  projects: readonly T[],
  cwd: string | undefined,
): T | undefined {
  let best: T | undefined;
  let bestLen = -1;
  for (const project of projects) {
    if (!pathIsWithinCanonicalScope(cwd, project.path)) continue;
    const length = canonicalScopePath(project.path)?.length ?? 0;
    if (length > bestLen) {
      best = project;
      bestLen = length;
    }
  }
  return best;
}

export function sessionsInProjectScope(
  sessions: readonly Session[],
  projectId: string,
  projectPath: string | undefined,
  worktreePath: string | undefined,
): Session[] {
  const selectedPath = worktreePath ?? projectPath;
  return sessions.filter(
    (session) =>
      session.projectId === projectId &&
      (worktreePath
        ? sameCanonicalScope(session.worktreePath, selectedPath)
        : !session.worktreePath || sameCanonicalScope(session.worktreePath, selectedPath)),
  );
}

export function unreadInboxInScope(
  inbox: readonly InboxItem[],
  sessions: readonly Session[],
): number {
  const sessionIds = new Set(sessions.map((session) => session.id));
  return inbox.filter((item) => isActionableInboxItem(item) && sessionIds.has(item.sessionId)).length;
}
