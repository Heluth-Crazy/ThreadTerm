import type { Session } from '@threadterm/protocol';
import { isOpenableDiffPath } from './toolCards';

type DiffTarget = { projectId: string; worktreePath?: string; path: string; kind: 'diff'; ownerSessionId: string };

/** Build both diff permissions and navigation from the session belonging to this tab. */
export function sessionDiffActions(session: Pick<Session, 'id' | 'projectId' | 'worktreePath'> | undefined, projectPath: string | undefined, openPath: ((target: DiffTarget) => void) | undefined) {
  if (!session?.projectId || !openPath) return {};
  const projectId = session.projectId;
  const canOpenDiff = (path: string) => isOpenableDiffPath(path, session.worktreePath ?? projectPath);
  return {
    canOpenDiff,
    openDiff: (path: string) => {
      if (canOpenDiff(path)) openPath({ projectId, worktreePath: session.worktreePath, path, kind: 'diff', ownerSessionId: session.id });
    },
  };
}
