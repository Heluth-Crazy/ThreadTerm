import type { Session } from '@threadterm/protocol';
import { withDelegates } from './delegation';
import { sessionActivity } from './sessionActivity';

export const EXPANDED_DELEGATES_KEY = 'threadterm.expandedFinishedDelegates';
const MAX_EXPANDED_PARENTS = 200;
const finishedStates = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export type DelegateCatalogRow<T extends Session = Session> =
  | { kind: 'session'; session: T }
  | { kind: 'fold'; parentId: string; count: number; expanded: boolean };

/** Fold only children actually rendered under a parent in this list. */
export function foldedDelegateRows<T extends Session>(
  list: readonly T[], all: readonly T[], selectedId: string | undefined, expandedParents: readonly string[],
): DelegateCatalogRow<T>[] {
  const ordered = withDelegates(list, all), expanded = new Set(expandedParents);
  const rows: DelegateCatalogRow<T>[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const parent = ordered[index];
    rows.push({ kind: 'session', session: parent });
    const finished: T[] = [];
    while (index + 1 < ordered.length && ordered[index + 1].delegation?.parentSessionId === parent.id) {
      const child = ordered[++index], activity = sessionActivity(child);
      if (child.id !== selectedId && activity !== 'awaiting_approval' && activity !== 'awaiting_input'
        && finishedStates.has(child.delegation!.state)) finished.push(child);
      else rows.push({ kind: 'session', session: child });
    }
    if (finished.length) {
      const open = expanded.has(parent.id);
      rows.push({ kind: 'fold', parentId: parent.id, count: finished.length, expanded: open });
      if (open) rows.push(...finished.map(session => ({ kind: 'session' as const, session })));
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
