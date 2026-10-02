import type { CatalogVisibility, Snapshot } from '@threadterm/protocol';
import { sameCanonicalScope } from './projectScope';

/** A catalogue action changes local presentation; the complete runtime snapshot
 * remains available to restoration menus and never loses provider identities. */
export function visibleCatalogSnapshot(data: Snapshot, entries: CatalogVisibility[]): Snapshot {
  const hidden = entries.filter(entry => entry.visibility === 'removed');
  const projects = new Set(hidden.filter(entry => entry.kind === 'project').map(entry => entry.id));
  const sessions = new Set(hidden.filter(entry => entry.kind === 'session').map(entry => entry.id));
  const trees = hidden.filter(entry => entry.kind === 'worktree');
  const archived = entries.filter(entry => entry.visibility === 'archived');
  const inScope = (entry: CatalogVisibility, session: Snapshot['sessions'][number]) => entry.kind === 'session' ? entry.id === session.id : entry.kind === 'project' ? entry.id === session.projectId : entry.projectId === session.projectId && Boolean(entry.worktreePath) && sameCanonicalScope(entry.worktreePath, session.worktreePath ?? data.projects.find(project => project.id === session.projectId)?.path);
  const visibleSessions = data.sessions.filter(session => !sessions.has(session.id)
    && !projects.has(session.projectId ?? '')
    && !trees.some(tree => tree.projectId === session.projectId
      && Boolean(tree.worktreePath)
      && sameCanonicalScope(tree.worktreePath, session.worktreePath ?? data.projects.find(project => project.id === session.projectId)?.path)))
    .map(session => archived.some(entry => inScope(entry, session)) ? {...session, archived: true} : session);
  const ids = new Set(visibleSessions.map(session => session.id));
  return { ...data, projects: data.projects.filter(project => !projects.has(project.id)), sessions: visibleSessions, inbox: data.inbox.filter(item => ids.has(item.sessionId)) };
}
