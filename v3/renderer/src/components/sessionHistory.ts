import type { Project, Session, SessionStatus } from '@threadterm/protocol';

export type HistoryScope = 'all' | 'bookmarked' | 'archived';

export function filterSessionHistory(
  sessions: readonly Session[],
  query: string,
  scope: HistoryScope,
  projectId: string,
  worktreePath: string,
  status: SessionStatus | '',
): Session[] {
  const terms = query.trim().toLocaleLowerCase();
  return sessions.filter(session => {
    if (scope === 'bookmarked' && !session.bookmarked) return false;
    if (scope === 'archived' ? !session.archived : scope === 'all' && session.archived) return false;
    if (projectId && session.projectId !== projectId) return false;
    if (worktreePath && session.worktreePath !== worktreePath) return false;
    if (status && session.status !== status) return false;
    return !terms || `${session.title} ${session.provider} ${session.worktreePath ?? ''}`.toLocaleLowerCase().includes(terms);
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function projectLabel(projects: readonly Project[], projectId: string | undefined, unknown: string) {
  return projects.find(project => project.id === projectId)?.name ?? unknown;
}

export function nextSelection(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
