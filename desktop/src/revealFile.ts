import { isAbsolute, relative, resolve } from 'node:path';

export interface ResolvedFileScope {
  worktreePath: string;
  path: string;
}

type SessionSnapshot = { id?: unknown; projectId?: unknown; worktreePath?: unknown };
type ProjectSnapshot = { id?: unknown; path?: unknown };

export function revealTarget(value: unknown, canonicalScope: string): { scope: string; path: string } {
  if (!isResolvedFileScope(value) || !canonicalScope) throw new Error('File is unavailable');
  const scope = resolve(canonicalScope);
  const path = resolve(scope, value.path);
  if (!isWithinScope(scope, path)) throw new Error('File is outside its project scope');
  return { scope, path };
}

export function isWithinScope(scope: string, candidate: string): boolean {
  const segment = relative(scope, candidate);
  return segment === '' || (!isAbsolute(segment) && segment !== '..' && !segment.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export function deletedRevealScope(snapshot: unknown, sessionId: string): string {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('File project scope is unavailable');
  const sessions = (snapshot as { sessions?: unknown }).sessions;
  const projects = (snapshot as { projects?: unknown }).projects;
  if (!Array.isArray(sessions) || !Array.isArray(projects)) throw new Error('File project scope is unavailable');
  const session = sessions.find((value): value is SessionSnapshot => !!value && typeof value === 'object' && (value as SessionSnapshot).id === sessionId);
  if (!session || typeof session.projectId !== 'string') throw new Error('File project scope is unavailable');
  const project = projects.find((value): value is ProjectSnapshot => !!value && typeof value === 'object' && (value as ProjectSnapshot).id === session.projectId);
  const scope = typeof session.worktreePath === 'string' ? session.worktreePath : project?.path;
  if (typeof scope !== 'string' || !scope) throw new Error('File project scope is unavailable');
  return scope;
}

function isResolvedFileScope(value: unknown): value is ResolvedFileScope {
  return !!value
    && typeof value === 'object'
    && typeof (value as ResolvedFileScope).worktreePath === 'string'
    && typeof (value as ResolvedFileScope).path === 'string'
    && (value as ResolvedFileScope).path.length > 0
    && !(value as ResolvedFileScope).path.includes('\0')
    && !isAbsolute((value as ResolvedFileScope).path);
}
