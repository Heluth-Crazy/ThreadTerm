import type { GitChange, GitStatus } from "@threadterm/protocol";
import { changeGroups, decorationFor, isConflict, type Decoration } from "./workbench/gitDecorations";

/** How the branch home's Git card describes the checked-out branch against its upstream. */
export type BranchSync =
  | { kind: "detached" }
  | { kind: "unpublished" }
  | { kind: "synced"; upstream: string }
  | { kind: "diverged"; upstream: string; ahead: number; behind: number };

export function branchSync(status: Pick<GitStatus, "branch" | "upstream" | "ahead" | "behind">): BranchSync {
  if (!status.branch) return { kind: "detached" };
  if (!status.upstream) return { kind: "unpublished" };
  if (!status.ahead && !status.behind) return { kind: "synced", upstream: status.upstream };
  return { kind: "diverged", upstream: status.upstream, ahead: status.ahead, behind: status.behind };
}

export type ChangeSummary = { total: number; staged: number; untracked: number; conflicts: number };

/** Each file counts once in `total`; `staged` counts files with anything in the index (they may also have edits). */
export function summarizeChanges(changes: readonly GitChange[]): ChangeSummary {
  const summary: ChangeSummary = { total: changes.length, staged: 0, untracked: 0, conflicts: 0 };
  for (const change of changes) {
    const groups = changeGroups(change);
    if (groups.includes("conflicts")) summary.conflicts++;
    else if (groups.includes("untracked")) summary.untracked++;
    if (groups.includes("staged")) summary.staged++;
  }
  return summary;
}

/** "1 staged · 2 untracked" beside the count; empty when every change is a plain edit. */
export function changeNote(summary: ChangeSummary, zh: boolean): string {
  const parts: string[] = [];
  if (summary.conflicts) parts.push(zh ? `${summary.conflicts} 个冲突` : `${summary.conflicts} ${summary.conflicts === 1 ? "conflict" : "conflicts"}`);
  if (summary.staged) parts.push(zh ? `${summary.staged} 个已暂存` : `${summary.staged} staged`);
  if (summary.untracked) parts.push(zh ? `${summary.untracked} 个未跟踪` : `${summary.untracked} untracked`);
  return parts.join(" · ");
}

export type ListedChange = { change: GitChange; decoration: Decoration; stagedOnly: boolean; partlyStaged: boolean };

/** The first `limit` files the card lists: conflicts, then tracked changes, then untracked; Git's path order within
 * each. `stagedOnly` files open their staged (HEAD → index) diff, since the working tree shows no difference;
 * `partlyStaged` files have staged content plus further edits. */
export function listedChanges(changes: readonly GitChange[], limit: number): ListedChange[] {
  const rank = (change: GitChange) => (isConflict(change) ? 0 : change.untracked ? 2 : 1);
  return changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => rank(a.change) - rank(b.change) || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ change }) => {
      const groups = changeGroups(change);
      const staged = groups.includes("staged");
      return { change, decoration: decorationFor(change), stagedOnly: staged && groups.length === 1, partlyStaged: staged && groups.length > 1 };
    });
}
