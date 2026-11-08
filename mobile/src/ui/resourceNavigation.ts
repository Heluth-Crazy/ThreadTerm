import type { ResourceRoute } from './ResourceScreen';

/** A Git tab changes the current page; files and commits remain child pages. */
export function isGitTabSwitch(previous: ResourceRoute, next: ResourceRoute): boolean {
  return previous.kind === 'git' && next.kind === 'git'
    && previous.machineId === next.machineId
    && previous.projectId === next.projectId
    && previous.worktreePath === next.worktreePath;
}
