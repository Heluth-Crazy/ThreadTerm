import type { GitBranch, GitStatus } from '@threadterm/protocol';

export type BranchRowState = 'current'|'checkout'|'open-worktree'|'worktree-unavailable'|'worktree-missing';

/** Presents the current local branch first, then recent local history, followed by remotes. */
export function sortBranches(branches:readonly GitBranch[]):GitBranch[] {
 return [...branches].sort((left,right) => {
  if(left.remote !== right.remote) return left.remote ? 1 : -1;
  if(!left.remote && left.current !== right.current) return left.current ? -1 : 1;
  const timestamp=(branch:GitBranch) => { const value=Date.parse(branch.lastCommit?.committedAt ?? ''); return Number.isFinite(value) ? value : 0; };
  const leftAt=timestamp(left), rightAt=timestamp(right);
  if(leftAt !== rightAt) return rightAt-leftAt;
  return left.name.localeCompare(right.name);
 });
}

export function branchRowState(branch:GitBranch, canOpenWorktree:boolean):BranchRowState {
 if(branch.current) return 'current';
 if(branch.worktreeMissing) return 'worktree-missing';
 if(branch.worktreePath) return canOpenWorktree ? 'open-worktree' : 'worktree-unavailable';
 return 'checkout';
}

/** Keeps checkout warnings readable when Git reports a path in more than one status group. */
export function checkoutLocalPaths(status:Pick<GitStatus,'changes'>|undefined):string[]|undefined {
 if(!status) return undefined;
 return Array.from(new Set(status.changes.map(change=>change.path)));
}

export const worktreeName = (path:string) => path.split(/[\\/]+/).filter(Boolean).at(-1) || path;
