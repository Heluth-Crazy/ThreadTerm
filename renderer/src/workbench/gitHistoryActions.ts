import type { GitHistoryPlan, GitHistoryMutationResult } from '@threadterm/protocol';

/** Bounded, presentation-ready data for the reset confirmation dialog. */
export function resetDialogPreview(reset:GitHistoryPlan['reset']) {
 const commits=reset.commits.slice(0,20);
 return {commits,remaining:Math.max(0,reset.count-commits.length),pushed:reset.pushed};
}

/** Only the direct clean result of this view's request may move its selection. */
export function historyActionSelection(result:Pick<GitHistoryMutationResult,'conflicted'|'head'>, explicitTarget?:string):string|undefined {
 return !result.conflicted&&!explicitTarget?result.head:undefined;
}

export function resetUndoMatchesBranch(symbolicHead:string, branch:string|null|undefined):boolean {
 return branch!==undefined&&symbolicHead===(branch===null?'detached':`refs/heads/${branch}`);
}
