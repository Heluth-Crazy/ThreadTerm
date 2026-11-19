import type { GroupSummary, Method, ProjectCatalogItem, RequestParams, RequestResult, Worktree } from '@threadterm/protocol';

type CatalogRequest = <M extends Method>(method: M, params: RequestParams<M>) => Promise<RequestResult<M>>;
export type CatalogSnapshot = {
  items: ProjectCatalogItem[];
  trees: Record<string, Worktree[]>;
  groups: Record<string, GroupSummary[]>;
  /** `trees:<projectId>` and `groups:<projectId>` reads that have answered at least once, loaded or failed. */
  answered: Record<string, true>;
  loaded: boolean;
  loading: boolean;
  issue?: string;
};
type RetryClock = { schedule: (run: () => void, delay: number) => unknown; cancel: (timer: unknown) => void };
const clock: RetryClock = { schedule: (run, delay) => setTimeout(run, delay), cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

/** A renderer keeps its last catalog through sidebar remounts. Optional details never gate project rows. */
export function createProjectCatalogStore(request: CatalogRequest, retryClock: RetryClock = clock) {
  let snapshot: CatalogSnapshot = { items: [], trees: {}, groups: {}, answered: {}, loaded: false, loading: true };
  // `listGeneration` drops a superseded project list; `generation` drops every read once the sidebar unmounts or the
  // connection is lost.
  let listGeneration = 0, generation = 0, users = 0;
  const listeners = new Set<() => void>(), timers = new Map<string, unknown>(), attempts = new Map<string, number>(), issues = new Map<string, string>();
  // A project's branch list and groups are read one request at a time: asked again while one is in flight, it reads
  // once more after that answer, and every answer is shown. Dropping the answers in flight whenever the list reloaded
  // left projects without branches for as long as slow Git kept them running (11-19).
  const inFlight = new Set<string>(), again = new Set<string>();
  const listed = (id: string) => snapshot.items.some(item => item.id === id);
  const publish = (patch: Partial<CatalogSnapshot>) => {
    snapshot = { ...snapshot, ...patch, issue: issues.values().next().value };
    listeners.forEach(listener => listener());
  };
  const clearTimer = (key: string) => {
    if (timers.has(key)) retryClock.cancel(timers.get(key));
    timers.delete(key);
  };
  const cancelPending = () => {
    listGeneration++; generation++; inFlight.clear(); again.clear();
    timers.forEach(timer => retryClock.cancel(timer)); timers.clear();
  };
  const retry = (key: string, run: () => void) => {
    if (!users || timers.has(key)) return;
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    timers.set(key, retryClock.schedule(() => { timers.delete(key); run(); }, Math.min(1000 * 2 ** Math.min(attempt, 4), 10000)));
  };
  const detail = (kind: 'trees' | 'groups', id: string) => {
    const key = `${kind}:${id}`;
    if (!users) return;
    if (inFlight.has(key)) { again.add(key); return; }
    clearTimer(key); inFlight.add(key);
    const current = generation;
    const settled = () => {
      if (current !== generation) return false;
      inFlight.delete(key);
      // A project that left the list takes its reads, retries and issue with it.
      if (!listed(id)) { again.delete(key); attempts.delete(key); if (issues.delete(key)) publish({}); return false; }
      return true;
    };
    // A bridge that throws instead of rejecting still answers this read (and frees it for the next one).
    let read: Promise<unknown>;
    try { read = kind === 'trees' ? request('worktree.list', { projectId: id }) : request('group.list', { projectId: id }); }
    catch (error) { read = Promise.reject(error); }
    void read.then(rows => {
      if (!settled()) return;
      issues.delete(key); attempts.delete(key);
      const answered = { ...snapshot.answered, [key]: true as const };
      if (kind === 'trees') publish({ trees: { ...snapshot.trees, [id]: rows as Worktree[] }, answered });
      else publish({ groups: { ...snapshot.groups, [id]: rows as GroupSummary[] }, answered });
      if (again.delete(key)) detail(kind, id);
    }, error => {
      if (!settled()) return;
      issues.set(key, error instanceof Error ? error.message : String(error)); publish({ answered: { ...snapshot.answered, [key]: true } });
      if (again.delete(key)) detail(kind, id);
      else retry(key, () => detail(kind, id));
    });
  };
  /** `missing`: read only the details not read yet (the list is asked again because Git was still being read). */
  const reload = async (details: 'all' | 'missing' = 'all') => {
    if (!users) return;
    const current = ++listGeneration;
    clearTimer('catalog'); clearTimer('pending');
    publish({ loading: true });
    try {
      const items = await request('project.catalog.list', {});
      if (!users || current !== listGeneration) return;
      issues.delete('catalog'); attempts.delete('catalog');
      const ids = new Set(items.map(item => item.id));
      for (const key of [...issues.keys(), ...timers.keys()]) {
        const id = /^(?:trees|groups):([^]*)$/.exec(key)?.[1];
        if (id !== undefined && !ids.has(id)) { issues.delete(key); clearTimer(key); attempts.delete(key); again.delete(key); }
      }
      publish({ items: [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder), loaded: true, loading: false,
        trees: Object.fromEntries(Object.entries(snapshot.trees).filter(([id]) => ids.has(id))),
        groups: Object.fromEntries(Object.entries(snapshot.groups).filter(([id]) => ids.has(id))),
        answered: Object.fromEntries(Object.entries(snapshot.answered).filter(([key]) => ids.has(key.slice(key.indexOf(':') + 1)))) });
      for (const item of items) {
        if (details === 'all' || snapshot.trees[item.id] === undefined && !inFlight.has(`trees:${item.id}`)) detail('trees', item.id);
        if (details === 'all' || snapshot.groups[item.id] === undefined && !inFlight.has(`groups:${item.id}`)) detail('groups', item.id);
      }
      // A repository Git was still reading shows its last known facts: list again until every read is in.
      if (items.some(item => item.git?.pending)) retry('pending', () => { void reload('missing'); });
      else attempts.delete('pending');
    } catch (error) {
      if (!users || current !== listGeneration) return;
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
    reload: () => reload(),
    reloadGroups: () => {
      for (const item of snapshot.items) detail('groups', item.id);
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
