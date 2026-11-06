import type { GroupSummary, Method, ProjectCatalogItem, RequestParams, RequestResult, Worktree } from '@threadterm/protocol';

type CatalogRequest = <M extends Method>(method: M, params: RequestParams<M>) => Promise<RequestResult<M>>;
export type CatalogSnapshot = {
  items: ProjectCatalogItem[];
  trees: Record<string, Worktree[]>;
  groups: Record<string, GroupSummary[]>;
  loaded: boolean;
  loading: boolean;
  issue?: string;
};
type RetryClock = { schedule: (run: () => void, delay: number) => unknown; cancel: (timer: unknown) => void };
const clock: RetryClock = { schedule: (run, delay) => setTimeout(run, delay), cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

/** A renderer keeps its last catalog through sidebar remounts. Optional details never gate project rows. */
export function createProjectCatalogStore(request: CatalogRequest, retryClock: RetryClock = clock) {
  let snapshot: CatalogSnapshot = { items: [], trees: {}, groups: {}, loaded: false, loading: true };
  let generation = 0, groupGeneration = 0, users = 0;
  const listeners = new Set<() => void>(), timers = new Map<string, unknown>(), attempts = new Map<string, number>(), issues = new Map<string, string>();
  const publish = (patch: Partial<CatalogSnapshot>) => {
    snapshot = { ...snapshot, ...patch, issue: issues.values().next().value };
    listeners.forEach(listener => listener());
  };
  const clearTimer = (key: string) => {
    if (timers.has(key)) retryClock.cancel(timers.get(key));
    timers.delete(key);
  };
  const cancelPending = () => {
    generation++; groupGeneration++;
    timers.forEach(timer => retryClock.cancel(timer)); timers.clear();
  };
  const retry = (key: string, run: () => void) => {
    if (!users || timers.has(key)) return;
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    timers.set(key, retryClock.schedule(() => { timers.delete(key); run(); }, Math.min(1000 * 2 ** Math.min(attempt, 4), 10000)));
  };
  const detail = async (kind: 'trees' | 'groups', id: string, current: number, currentGroup: number) => {
    const key = `${kind}:${id}`;
    clearTimer(key);
    const valid = () => users > 0 && generation === current && (kind !== 'groups' || groupGeneration === currentGroup);
    try {
      const rows = kind === 'trees' ? await request('worktree.list', { projectId: id }) : await request('group.list', { projectId: id });
      if (!valid()) return;
      issues.delete(key); attempts.delete(key);
      if (kind === 'trees') publish({ trees: { ...snapshot.trees, [id]: rows as Worktree[] } });
      else publish({ groups: { ...snapshot.groups, [id]: rows as GroupSummary[] } });
    } catch (error) {
      if (!valid()) return;
      issues.set(key, error instanceof Error ? error.message : String(error)); publish({});
      retry(key, () => { void detail(kind, id, current, currentGroup); });
    }
  };
  const reload = async () => {
    if (!users) return;
    cancelPending();
    const current = generation;
    publish({ loading: true });
    try {
      const items = await request('project.catalog.list', {});
      if (!users || current !== generation) return;
      const currentGroup = groupGeneration;
      issues.clear(); attempts.delete('catalog');
      const ids = new Set(items.map(item => item.id));
      publish({ items: [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder), loaded: true, loading: false,
        trees: Object.fromEntries(Object.entries(snapshot.trees).filter(([id]) => ids.has(id))),
        groups: Object.fromEntries(Object.entries(snapshot.groups).filter(([id]) => ids.has(id))) });
      for (const item of items) {
        void detail('trees', item.id, current, currentGroup);
        void detail('groups', item.id, current, currentGroup);
      }
    } catch (error) {
      if (!users || current !== generation) return;
      issues.set('catalog', error instanceof Error ? error.message : String(error)); publish({ loading: false });
      retry('catalog', () => { void reload(); });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate: () => {
      if (++users === 1) void reload();
      return () => { if (--users === 0) cancelPending(); };
    },
    reload,
    reloadGroups: () => {
      const currentGroup = ++groupGeneration;
      for (const item of snapshot.items) void detail('groups', item.id, generation, currentGroup);
    },
    transport: (state: unknown) => {
      if (state === 'reconnected') void reload();
      else if (state === 'disconnected' || state === 'incompatible') {
        cancelPending();
        publish({ loading: true });
        retry('catalog', () => { void reload(); });
      }
    },
  };
}

// Each Electron machine view has its own JS realm. The key also keeps tests/embedded views isolated.
const stores = new Map<string, ReturnType<typeof createProjectCatalogStore>>();
export function projectCatalogStore(machineId: string, request: CatalogRequest) {
  let store = stores.get(machineId);
  if (!store) { store = createProjectCatalogStore(request); stores.set(machineId, store); }
  return store;
}
