import type { NativeSubagentSummaries, Session, SessionDelegation } from '@threadterm/protocol';
import type { Worktree } from '@threadterm/protocol';
import { delegationActive } from './delegation';
import { canonicalScopePath } from './projectScope';
import { sessionActivity } from './sessionActivity';

/**
 * Pure rules for the tidy sidebar: branch order, the "other branches" split, the
 * session order and older fold, the folded summary, the Recent list and the
 * remembered fold state. Kept free of React and of the DOM so the rules can be
 * tested on their own.
 */

export type TidySession = Pick<Session, 'id' | 'createdAt' | 'updatedAt' | 'readOnly' | 'status' | 'mode' | 'activity'> & {
  delegation?: Pick<SessionDelegation, 'parentSessionId' | 'state'>;
  archived?: boolean;
  followed?: boolean;
};

const runningStates = new Set(['running', 'awaiting_parent']);

/**
 * A session that asks the user to decide something: an approval. Only this moves a row to the top of its branch and
 * counts on a folded row. `awaiting_input` is also the state of a Chat turn that finished with an unread reply, which
 * the Inbox does not count either (owner report 2026-11-16 on the task island); it stays shown (`isTidyLive`) with
 * its amber dot and "Mark handled", but keeps its place.
 */
export function needsYou(session: Pick<TidySession, 'readOnly' | 'status' | 'activity' | 'mode'>): boolean {
  return sessionActivity(session) === 'awaiting_approval';
}

/** A finished turn whose reply is unread, or a question to answer: shown, not moved. */
export function awaitsReply(session: Pick<TidySession, 'readOnly' | 'status' | 'activity' | 'mode'>): boolean {
  return sessionActivity(session) === 'awaiting_input';
}

/** A session that is doing work: running, or waiting for the agent that delegated it. */
export function isRunningNow(session: Pick<TidySession, 'readOnly' | 'status' | 'activity' | 'mode'>): boolean {
  return runningStates.has(sessionActivity(session));
}

/** Running, asking for approval, or holding an unread reply: the states a branch or older fold may never hide. */
export function isTidyLive(session: Pick<TidySession, 'readOnly' | 'status' | 'activity' | 'mode'>): boolean {
  return needsYou(session) || awaitsReply(session) || isRunningNow(session);
}

const time = (value: string | undefined): number => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
};

function pathParts(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

/** R4: a worktree without a branch is named by its folder, or by its parent when the folder repeats the project. */
export function worktreeLabel(
  tree: Pick<Worktree, 'branch' | 'path' | 'isMain'>,
  projectPath: string,
  localDirectory: string,
): string {
  if (tree.branch) return tree.branch;
  if (tree.isMain) return localDirectory;
  const parts = pathParts(tree.path);
  const leaf = parts.at(-1) ?? '';
  const projectLeaf = pathParts(projectPath).at(-1) ?? '';
  if (leaf && projectLeaf && leaf.toLowerCase() === projectLeaf.toLowerCase() && parts.length > 1) return parts.at(-2) ?? leaf;
  return leaf;
}

/**
 * One row per worktree folder. The runtime can hold the same folder twice: a worktree whose folder is gone while Git
 * still lists it is recorded under Git's own spelling of the path (forward slashes, no `\\?\` prefix) next to the
 * row it already had. Keep the row whose folder exists, else the first.
 */
export function uniqueWorktrees<T extends Pick<Worktree, 'path' | 'missing'>>(trees: readonly T[]): T[] {
  const kept = new Map<string, T>();
  for (const tree of trees) {
    const key = canonicalScopePath(tree.path) ?? tree.path;
    const seen = kept.get(key);
    if (!seen || (seen.missing && !tree.missing)) kept.set(key, tree);
  }
  return [...kept.values()];
}

/** R4: main first, then the newest session's createdAt, then the name. */
export function orderBranches<T extends { createdAt: string }>(
  trees: readonly Worktree[],
  sessionsOf: (tree: Worktree) => readonly T[],
  nameOf: (tree: Worktree) => string = tree => tree.branch ?? tree.path,
): Worktree[] {
  return [...trees].sort((left, right) => {
    if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
    const leftNewest = sessionsOf(left).reduce((newest, session) => Math.max(newest, time(session.createdAt)), 0);
    const rightNewest = sessionsOf(right).reduce((newest, session) => Math.max(newest, time(session.createdAt)), 0);
    return rightNewest - leftNewest || nameOf(left).localeCompare(nameOf(right)) || left.path.localeCompare(right.path);
  });
}

/**
 * R3: worktrees with no listed session, plus unused deleted ones, fold into
 * "other branches"; the current branch and any branch with a running or waiting
 * session stay listed.
 */
export function foldableBranches<T extends TidySession>(
  trees: readonly Worktree[],
  sessionsOf: (tree: Worktree) => readonly T[],
  options: { isCurrent?: (tree: Worktree) => boolean } = {},
): { listed: Worktree[]; other: Worktree[] } {
  const listed: Worktree[] = [], other: Worktree[] = [];
  for (const tree of trees) {
    const sessions = sessionsOf(tree);
    const live = sessions.some(isTidyLive);
    const current = options.isCurrent?.(tree) ?? false;
    const unused = sessions.length === 0;
    const deletedAndUnused = Boolean(tree.missing) && !live;
    if (!current && !live && (unused || deletedAndUnused)) other.push(tree);
    else listed.push(tree);
  }
  return { listed, other };
}

/** R6: waiting first, then createdAt descending; a turn starting or ending never moves a row. */
export function orderBranchSessions<T extends TidySession>(
  sessions: readonly T[],
  frozenOrder?: ReadonlyMap<string, number>,
): T[] {
  return [...sessions].sort((left, right) => {
    if (frozenOrder) {
      const leftOrder = frozenOrder.get(left.id), rightOrder = frozenOrder.get(right.id);
      if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    }
    return Number(needsYou(right)) - Number(needsYou(left))
      || time(right.createdAt) - time(left.createdAt)
      || left.id.localeCompare(right.id);
  });
}

/** Parents whose delegate or native subagent is still active. */
export function activeDelegateParents(
  sessions: readonly TidySession[],
  nativeSubagents?: NativeSubagentSummaries,
): Set<string> {
  const parents = new Set<string>();
  for (const session of sessions) {
    if (session.delegation && delegationActive(session.delegation.state)) parents.add(session.delegation.parentSessionId);
  }
  for (const [parentId, agents] of Object.entries(nativeSubagents ?? {})) {
    if (agents.some(agent => agent.status === 'running')) parents.add(parentId);
  }
  return parents;
}

/** The displayed ancestors of a selected session, so selecting a delegate cannot hide its parent. */
export function selectedAncestors(sessions: readonly TidySession[], selectedId: string | undefined): Set<string> {
  const ancestors = new Set<string>();
  if (!selectedId) return ancestors;
  const parentOf = new Map<string, string>();
  for (const session of sessions) if (session.delegation) parentOf.set(session.id, session.delegation.parentSessionId);
  let current = parentOf.get(selectedId);
  while (current && !ancestors.has(current) && ancestors.size < 32) {
    ancestors.add(current);
    current = parentOf.get(current);
  }
  return ancestors;
}

/** R5: waiting, running, selected, followed and active parents are always shown. */
export function isPinnedSession(
  session: TidySession,
  options: { selectedId?: string; activeDelegateParents?: ReadonlySet<string> } = {},
): boolean {
  return isTidyLive(session) || session.id === options.selectedId || Boolean(session.followed)
    || Boolean(options.activeDelegateParents?.has(session.id));
}

/** R5: the pinned rows plus the 3 newest other top-level sessions; the rest fold. */
export function splitBranchSessions<T extends TidySession>(
  ordered: readonly T[],
  options: { selectedId?: string; activeDelegateParents?: ReadonlySet<string>; keep?: number } = {},
): { shown: T[]; older: T[] } {
  const keep = options.keep ?? 3;
  const shown: T[] = [], older: T[] = [];
  let others = 0;
  for (const session of ordered) {
    const pinned = isPinnedSession(session, options);
    if (pinned || others < keep) {
      shown.push(session);
      if (!pinned) others += 1;
    } else older.push(session);
  }
  return { shown, older };
}

export type FoldSummary = { kind: 'needs'; count: number } | { kind: 'running' } | { kind: 'count'; count: number };

/** R1: needs count, else running, else the plain count. */
export function foldSummary(sessions: readonly TidySession[]): FoldSummary | undefined {
  const needs = sessions.filter(needsYou).length;
  if (needs) return { kind: 'needs', count: needs };
  if (sessions.some(isRunningNow)) return { kind: 'running' };
  return sessions.length ? { kind: 'count', count: sessions.length } : undefined;
}

/** The summary's accessible wording (the visual is an amber count, a spinner or a muted number). */
export function foldedSummaryLabel(summary: FoldSummary | undefined, zh: boolean): string | undefined {
  if (!summary) return undefined;
  if (summary.kind === 'needs') return zh ? `${summary.count} 项需要你` : `${summary.count} needs you`;
  if (summary.kind === 'running') return zh ? '有会话进行中' : 'Sessions running';
  return zh ? `${summary.count} 个会话` : `${summary.count} sessions`;
}

export type RecentDay = 'today' | 'yesterday' | 'earlier';
export type RecentCandidate<T extends TidySession> = { session: T; where: string };
export type RecentRow<T extends TidySession> =
  | { kind: 'day'; day: RecentDay; label: string }
  | { kind: 'session'; session: T; where: string; when: string };

const dayLabels: Record<RecentDay, { en: string; zh: string }> = {
  today: { en: 'Today', zh: '今天' },
  yesterday: { en: 'Yesterday', zh: '昨天' },
  earlier: { en: 'Earlier', zh: '更早' },
};

export function recentDay(updatedAt: string, now: number): RecentDay {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 'earlier';
  const date = new Date(at), base = new Date(now);
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(base) - start(date)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : 'earlier';
}

/** R7: 刚刚 / 5 分钟 / 3 小时 / 2 天, or now / 5 min / 3 h / 2 d. */
export function relativeTime(updatedAt: string, now: number, zh: boolean): string {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return zh ? '更早' : 'Earlier';
  const minutes = Math.max(0, now - at) / 60_000;
  if (minutes < 1) return zh ? '刚刚' : 'now';
  if (minutes < 60) return zh ? `${Math.round(minutes)} 分钟` : `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return zh ? `${Math.round(hours)} 小时` : `${Math.round(hours)} h`;
  return zh ? `${Math.round(hours / 24)} 天` : `${Math.round(hours / 24)} d`;
}

/** R7: newest first, with stable ties; unarchived only, and a delegate only while it waits. */
export function orderRecentCandidates<T extends TidySession>(candidates: readonly RecentCandidate<T>[]): RecentCandidate<T>[] {
  return candidates
    .filter(candidate => !candidate.session.archived && (!candidate.session.delegation || needsYou(candidate.session)))
    .sort((left, right) => time(right.session.updatedAt) - time(left.session.updatedAt)
      || time(right.session.createdAt) - time(left.session.createdAt)
      || left.session.id.localeCompare(right.session.id));
}

/** R7: at most 40 rows, under Today / Yesterday / Earlier headers, with the relative time. */
export function recentRows<T extends TidySession>(
  candidates: readonly RecentCandidate<T>[],
  options: { now: number; zh: boolean; limit?: number },
): RecentRow<T>[] {
  const limit = options.limit ?? 40;
  const rows: RecentRow<T>[] = [];
  let day: RecentDay | undefined;
  for (const candidate of orderRecentCandidates(candidates).slice(0, limit)) {
    const next = recentDay(candidate.session.updatedAt, options.now);
    if (next !== day) {
      rows.push({ kind: 'day', day: next, label: options.zh ? dayLabels[next].zh : dayLabels[next].en });
      day = next;
    }
    rows.push({ kind: 'session', session: candidate.session, where: candidate.where,
      when: relativeTime(candidate.session.updatedAt, options.now, options.zh) });
  }
  return rows;
}

/* ── Remembered folds (R1) ──────────────────────────────────────────────── */

export type CatalogFoldKind = 'project' | 'branch' | 'parent' | 'older' | 'other';
export const CATALOG_FOLD_KEY = 'threadterm.catalogFolds';
const MAX_FOLD_ENTRIES = 300;
const foldDefaults: Record<CatalogFoldKind, boolean> = { project: true, branch: true, parent: true, older: false, other: false };

export function foldKey(kind: CatalogFoldKind, id: string): string {
  return `${kind}:${id}`;
}

export function foldKind(key: string): CatalogFoldKind | undefined {
  const colon = key.indexOf(':');
  if (colon <= 0) return undefined;
  const kind = key.slice(0, colon);
  return kind in foldDefaults ? kind as CatalogFoldKind : undefined;
}

export function boundedCatalogFolds(folds: Record<string, boolean>, limit = MAX_FOLD_ENTRIES): Record<string, boolean> {
  return Object.fromEntries(Object.entries(folds).slice(-limit));
}

/** One bounded key; bad JSON, arrays and unknown keys fall back to the defaults. */
export function readCatalogFolds(raw: string | null): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return boundedCatalogFolds(Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => foldKind(key) !== undefined && typeof value === 'boolean')) as Record<string, boolean>);
  } catch {
    return {};
  }
}

export function writeCatalogFolds(folds: Record<string, boolean>): string {
  return JSON.stringify(boundedCatalogFolds(folds));
}

export function foldExpanded(folds: Record<string, boolean>, kind: CatalogFoldKind, id: string): boolean {
  const value = folds[foldKey(kind, id)];
  return typeof value === 'boolean' ? value : foldDefaults[kind];
}

/** Sets one fold; an explicit default is dropped so a capped key only keeps real deviations. */
export function setCatalogFold(
  folds: Record<string, boolean>,
  kind: CatalogFoldKind,
  id: string,
  expanded: boolean,
): Record<string, boolean> {
  const key = foldKey(kind, id);
  const rest = { ...folds };
  delete rest[key];
  if (expanded !== foldDefaults[kind]) rest[key] = expanded;
  return boundedCatalogFolds(rest);
}

export const CATALOG_VIEW_KEY = 'threadterm.catalogView';
export type CatalogView = 'tree' | 'recent';

export function readCatalogView(raw: string | null): CatalogView {
  return raw === 'recent' ? 'recent' : 'tree';
}

export function writeCatalogView(view: CatalogView): string {
  return view;
}
