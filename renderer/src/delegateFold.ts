import type { NativeSubagentSummaries, NativeSubagentSummary, Session, SessionDelegation } from '@threadterm/protocol';
import { delegationActive, nestedDelegateIds, withDelegates } from './delegation';
import { sessionActivity } from './sessionActivity';

export const EXPANDED_DELEGATES_KEY = 'threadterm.expandedFinishedDelegates';
const MAX_EXPANDED_PARENTS = 200;
const finishedStates = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export type DelegateCatalogSession = Pick<Session, 'id' | 'createdAt' | 'readOnly' | 'status' | 'activity' | 'mode'> & {
  delegation?: Pick<SessionDelegation, 'parentSessionId' | 'state'>;
};

export type DelegateCatalogRow<T extends DelegateCatalogSession = Session> =
  | { kind: 'session'; session: T; nested: boolean; nativeRunning?: NativeSubagentSummary[]; activeCount?: number }
  /** `sessionIds`: the finished delegates the fold holds, so the group can be archived or deleted at once. */
  | { kind: 'fold'; parentId: string; count: number; expanded: boolean; sessionIds: string[]; nativeFinished?: NativeSubagentSummary[] };

/** Fold only children actually rendered under a parent in this list. */
export function foldedDelegateRows<T extends DelegateCatalogSession>(
  list: readonly T[], all: readonly T[], selectedId: string | undefined, expandedParents: readonly string[],
  needsAttention?: (session: T) => boolean, nativeSubagents?: NativeSubagentSummaries,
): DelegateCatalogRow<T>[] {
  const ordered = withDelegates(list, all), expanded = new Set(expandedParents), nested = nestedDelegateIds(all);
  const rows: DelegateCatalogRow<T>[] = [];
  const appendSession = (session: T, isNested: boolean) => {
    const native = nativeSubagents?.[session.id] ?? [];
    const nativeRunning = native.filter(agent => agent.status === 'running');
    const row: Extract<DelegateCatalogRow<T>, { kind: 'session' }> = { kind: 'session', session, nested: isNested };
    if (nativeRunning.length) {
      row.nativeRunning = nativeRunning;
      row.activeCount = nativeRunning.length;
    }
    rows.push(row);
    return { row, nativeFinished: native.filter(agent => agent.status !== 'running') };
  };
  const appendFold = (parentId: string, finished: T[], nativeFinished: NativeSubagentSummary[]) => {
    if (!finished.length && !nativeFinished.length) return;
    const open = expanded.has(parentId);
    rows.push({ kind: 'fold', parentId, count: finished.length + nativeFinished.length, expanded: open,
      sessionIds: finished.map(session => session.id), ...(nativeFinished.length ? { nativeFinished } : {}) });
    return open;
  };
  const appendNestedSession = (session: T) => {
    const { nativeFinished } = appendSession(session, true);
    appendFold(session.id, [], nativeFinished);
  };
  for (let index = 0; index < ordered.length; index++) {
    const parent = ordered[index];
    const { row, nativeFinished } = appendSession(parent, nested.has(parent.id));
    const finished: T[] = [];
    while (index + 1 < ordered.length && ordered[index + 1].delegation?.parentSessionId === parent.id) {
      const child = ordered[++index], activity = sessionActivity(child);
      if (row.activeCount !== undefined && child.delegation && delegationActive(child.delegation.state)) row.activeCount += 1;
      if (child.id !== selectedId && !needsAttention?.(child) && activity !== 'awaiting_approval' && activity !== 'awaiting_input'
        && finishedStates.has(child.delegation!.state)) finished.push(child);
      else appendNestedSession(child);
    }
    if (appendFold(parent.id, finished, nativeFinished)) finished.forEach(appendNestedSession);
  }
  return rows;
}

/** A single capped preference list; newest choices win, deleted parents drop out. */
export function boundedExpandedParents(ids: readonly string[], existing?: ReadonlySet<string>): string[] {
  return [...new Set(ids)].filter(id => !existing || existing.has(id)).slice(-MAX_EXPANDED_PARENTS);
}

export function readExpandedParents(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? boundedExpandedParents(parsed.filter((id): id is string => typeof id === 'string')) : [];
  } catch { return []; }
}
