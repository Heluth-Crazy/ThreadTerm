export interface TranscriptTurnGroup<Item> {
  id: string;
  items: readonly Item[];
  cacheable: boolean;
}

interface CachedTurn<Item, Context, Version, Rendered> {
  items: readonly Item[];
  context: Context;
  version: readonly Version[];
  rendered: Rendered;
}

const sameReferences = <Value>(left: readonly Value[], right: readonly Value[]): boolean =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/**
 * Retains the exact React element for an unchanged historical turn. React can
 * then bail out of reconciling that subtree while a live sibling receives
 * chunks. Callers own the context/version values: anything observed by render
 * must be represented there, so locale, permission or handler changes cannot
 * go stale. A live/working turn must always pass `cacheable: false`.
 */
export function createTranscriptTurnCache<Item, Context, Version, Rendered>() {
  const entries = new Map<string, CachedTurn<Item, Context, Version, Rendered>>();

  return {
    render(group: TranscriptTurnGroup<Item>, context: Context, version: readonly Version[], render: () => Rendered): Rendered {
      if (!group.cacheable) return render();
      const cached = entries.get(group.id);
      if (cached
        && Object.is(cached.context, context)
        && sameReferences(cached.items, group.items)
        && sameReferences(cached.version, version)) return cached.rendered;
      const rendered = render();
      entries.set(group.id, { items: [...group.items], context, version: [...version], rendered });
      return rendered;
    },
    prune(liveIds: ReadonlySet<string>): void {
      for (const id of entries.keys()) if (!liveIds.has(id)) entries.delete(id);
    },
  };
}
