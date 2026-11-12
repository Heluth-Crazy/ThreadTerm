import type { Session, SessionDelegation } from '@threadterm/protocol';
import { nestedDelegateIds, withDelegates } from './delegation';
import { sessionActivity } from './sessionActivity';

export const EXPANDED_DELEGATES_KEY = 'threadterm.expandedFinishedDelegates';
const MAX_EXPANDED_PARENTS = 200;
const finishedStates = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export type DelegateCatalogSession = Pick<Session, 'id' | 'createdAt' | 'readOnly' | 'status' | 'activity' | 'mode'> & {
  delegation?: Pick<SessionDelegation, 'parentSessionId' | 'state'>;
};

export type DelegateCatalogRow<T extends DelegateCatalogSession = Session> =
  | { kind: 'session'; session: T; nested: boolean }
  /** `sessionIds`: the finished delegates the fold holds, so the group can be archived or deleted at once. */
  | { kind: 'fold'; parentId: string; count: number; expanded: boolean; sessionIds: string[] };

/** Fold only children actually rendered under a parent in this list. */
export function foldedDelegateRows<T extends DelegateCatalogSession>(
  list: readonly T[], all: readonly T[], selectedId: string | undefined, expandedParents: readonly string[],
  needsAttention?: (session: T) => boolean,
): DelegateCatalogRow<T>[] {
  const ordered = withDelegates(list, all), expanded = new Set(expandedParents), nested = nestedDelegateIds(all);
  const rows: DelegateCatalogRow<T>[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const parent = ordered[index];
    rows.push({ kind: 'session', session: parent, nested: nested.has(parent.id) });
    const finished: T[] = [];
    while (index + 1 < ordered.length && ordered[index + 1].delegation?.parentSessionId === parent.id) {
      const child = ordered[++index], activity = sessionActivity(child);
      if (child.id !== selectedId && !needsAttention?.(child) && activity !== 'awaiting_approval' && activity !== 'awaiting_input'
        && finishedStates.has(child.delegation!.state)) finished.push(child);
      else rows.push({ kind: 'session', session: child, nested: true });
    }
    if (finished.length) {
      const open = expanded.has(parent.id);
      rows.push({ kind: 'fold', parentId: parent.id, count: finished.length, expanded: open, sessionIds: finished.map(session => session.id) });
      if (open) rows.push(...finished.map(session => ({ kind: 'session' as const, session, nested: true })));
    }
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
