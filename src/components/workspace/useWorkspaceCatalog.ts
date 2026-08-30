import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { normalizeComparablePath, samePath } from '../../lib/worktreePaths';
import { workspaceClient } from '../../lib/workspace/client';
import type {
  WorkspaceEvent,
  WorkspaceRecord,
  WorkspaceSnapshot,
  WorkspaceTab,
} from '../../lib/workspace/types';

const MAX_INACTIVE_ENTRIES = 16;
const MAX_SNAPSHOT_CONCURRENCY = 4;

export interface WorkspaceCatalogTabRef {
  workspaceId: string;
  rootPath: string;
  tabId: string;
  kind: 'terminal' | 'file' | 'diff';
  cardId: string | null;
  relativePath: string | null;
}

export interface WorkspaceCatalogEntry {
  requestedRoot: string;
  rootKey: string;
  workspaceId: string | null;
  canonicalRoot: string | null;
  tabs: WorkspaceTab[];
  dirtyByTabId: Record<string, boolean>;
  conflictByTabId: Record<string, boolean>;
  activeTabId: string | null;
  loading: boolean;
  error: string | null;
}

export interface WorkspaceCatalogSelectedOverlay {
  workspaceId: string | null;
  rootPath: string | null;
  tabs: WorkspaceTab[];
  dirtyByTabId: Record<string, boolean>;
  conflictByTabId: Record<string, boolean>;
  activeTabId: string;
  workspaceVisible: boolean;
}

interface RefreshState {
  generation: number;
  inFlight: Promise<void> | null;
  needsRefresh: boolean;
}

interface QueuedTask {
  start(): void;
  cancel(): void;
}

export interface WorkspaceCatalogController {
  mount(): void;
  unmount(): void;
  registerRoot(rootPath: string): void;
  unregisterRoot(rootPath: string): void;
  getEntry(rootPath: string): WorkspaceCatalogEntry;
  getEntries(): WorkspaceCatalogEntry[];
  getRegisteredRootKeys(): string[];
  getRevision(): number;
  subscribe(listener: () => void): () => void;
  invalidateWorkspace(workspaceId: string): void;
  retryRoot(rootPath: string): void;
  setSelectedOverlay(overlay: WorkspaceCatalogSelectedOverlay): void;
}

function emptyEntry(rootPath: string): WorkspaceCatalogEntry {
  return {
    requestedRoot: rootPath,
    rootKey: normalizeComparablePath(rootPath),
    workspaceId: null,
    canonicalRoot: null,
    tabs: [],
    dirtyByTabId: {},
    conflictByTabId: {},
    activeTabId: null,
    loading: true,
    error: null,
  };
}

function metadataFromSnapshot(snapshot: WorkspaceSnapshot) {
  const dirtyByTabId: Record<string, boolean> = {};
  const conflictByTabId: Record<string, boolean> = {};
  for (const metadata of snapshot.draftMetas) {
    if (metadata.dirty) dirtyByTabId[metadata.tabId] = true;
    if (metadata.conflict !== 'none') conflictByTabId[metadata.tabId] = true;
  }
  return { dirtyByTabId, conflictByTabId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkspaceCatalogController(): WorkspaceCatalogController {
  const entries = new Map<string, WorkspaceCatalogEntry>();
  const entryVersions = new Map<string, number>();
  const registrations = new Map<string, number>();
  const workspaceToRoot = new Map<string, string>();
  const refreshStates = new Map<string, RefreshState>();
  const discoveryRequests = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const taskQueue: QueuedTask[] = [];
  let activeTasks = 0;
  let active = false;
  let lifecycleGeneration = 0;
  let revision = 0;
  let bootstrapScheduled = false;
  let bootstrapGeneration = 0;
  let listenerPromise: Promise<void> | null = null;
  let unlisten: (() => void) | null = null;
  let overlay: WorkspaceCatalogSelectedOverlay = {
    workspaceId: null,
    rootPath: null,
    tabs: [],
    dirtyByTabId: {},
    conflictByTabId: {},
    activeTabId: 'home',
    workspaceVisible: false,
  };

  const emit = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const registered = (rootKey: string) => (registrations.get(rootKey) ?? 0) > 0;

  const runTask = <T,>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    let started = false;
    const queued: QueuedTask = {
      start() {
        if (started) return;
        started = true;
        activeTasks += 1;
        void task()
          .then(resolve, reject)
          .finally(() => {
            activeTasks -= 1;
            taskQueue.shift()?.start();
          });
      },
      cancel() {
        if (started) return;
        started = true;
        reject(new Error('Workspace catalog task cancelled during unmount'));
      },
    };
    if (activeTasks < MAX_SNAPSHOT_CONCURRENCY) queued.start();
    else taskQueue.push(queued);
  });

  const touchEntry = (rootKey: string, next: WorkspaceCatalogEntry) => {
    entries.delete(rootKey);
    entries.set(rootKey, next);
    entryVersions.set(rootKey, (entryVersions.get(rootKey) ?? 0) + 1);
  };

  const pruneInactive = () => {
    const inactiveKeys = [...entries.keys()].filter((key) => !registered(key));
    while (inactiveKeys.length > MAX_INACTIVE_ENTRIES) {
      const rootKey = inactiveKeys.shift();
      if (!rootKey) break;
      const removed = entries.get(rootKey);
      entries.delete(rootKey);
      entryVersions.delete(rootKey);
      if (removed?.workspaceId) {
        workspaceToRoot.delete(removed.workspaceId);
        refreshStates.delete(removed.workspaceId);
      }
    }
  };

  const commitSnapshot = (rootKey: string, snapshot: WorkspaceSnapshot) => {
    const current = entries.get(rootKey);
    if (!current) return;
    const metadata = metadataFromSnapshot(snapshot);
    workspaceToRoot.set(snapshot.workspace.id, rootKey);
    touchEntry(rootKey, {
      ...current,
      workspaceId: snapshot.workspace.id,
      canonicalRoot: snapshot.workspace.canonicalRoot,
      tabs: [...snapshot.tabs].sort((left, right) => left.sharedOrder - right.sharedOrder),
      ...metadata,
      loading: false,
      error: null,
    });
    pruneInactive();
    emit();
  };

  const refreshWorkspace = (workspaceId: string): Promise<void> => {
    const rootKey = workspaceToRoot.get(workspaceId);
    if (!rootKey || !registered(rootKey) || !active) return Promise.resolve();
    const state = refreshStates.get(workspaceId) ?? {
      generation: 0,
      inFlight: null,
      needsRefresh: false,
    };
    refreshStates.set(workspaceId, state);
    if (state.inFlight) {
      state.generation += 1;
      state.needsRefresh = true;
      return state.inFlight;
    }

    const generation = state.generation + 1;
    const lifecycle = lifecycleGeneration;
    state.generation = generation;
    state.needsRefresh = false;
    const current = entries.get(rootKey);
    if (current) {
      touchEntry(rootKey, { ...current, loading: current.tabs.length === 0, error: null });
      emit();
    }

    const request = runTask(() => workspaceClient.getSnapshot(workspaceId))
      .then((snapshot) => {
        if (
          active
          && lifecycleGeneration === lifecycle
          && state.generation === generation
          && registered(rootKey)
          && normalizeComparablePath(snapshot.workspace.canonicalRoot) === rootKey
        ) {
          commitSnapshot(rootKey, snapshot);
        }
      })
      .catch((error) => {
        if (
          !active
          || lifecycleGeneration !== lifecycle
          || state.generation !== generation
          || !registered(rootKey)
        ) return;
        const entry = entries.get(rootKey);
        if (!entry) return;
        touchEntry(rootKey, { ...entry, loading: false, error: errorMessage(error) });
        emit();
      })
      .finally(() => {
        if (refreshStates.get(workspaceId) !== state) return;
        if (state.inFlight === request) state.inFlight = null;
        if (
          state.needsRefresh
          && active
          && lifecycleGeneration === lifecycle
          && registered(rootKey)
        ) {
          state.needsRefresh = false;
          void refreshWorkspace(workspaceId);
        }
      });
    state.inFlight = request;
    return request;
  };

  const discoverWorkspace = (workspaceId: string): Promise<void> => {
    const existing = discoveryRequests.get(workspaceId);
    if (existing) return existing;
    const lifecycle = lifecycleGeneration;
    const request = workspaceClient.get(workspaceId)
      .then((record) => {
        if (!active || lifecycleGeneration !== lifecycle) return;
        const rootKey = normalizeComparablePath(record.canonicalRoot);
        if (!registered(rootKey)) return;
        const current = entries.get(rootKey) ?? emptyEntry(record.canonicalRoot);
        workspaceToRoot.set(record.id, rootKey);
        touchEntry(rootKey, {
          ...current,
          workspaceId: record.id,
          canonicalRoot: record.canonicalRoot,
          loading: true,
          error: null,
        });
        emit();
        void refreshWorkspace(record.id);
      })
      .catch(() => undefined)
      .finally(() => {
        if (discoveryRequests.get(workspaceId) === request) {
          discoveryRequests.delete(workspaceId);
        }
      });
    discoveryRequests.set(workspaceId, request);
    return request;
  };

  const patchEvent = (event: WorkspaceEvent) => {
    if (event.type === 'leaseChanged') return;
    const rootKey = workspaceToRoot.get(event.workspaceId);
    if (rootKey && !registered(rootKey)) return;
    if (!rootKey) {
      void discoverWorkspace(event.workspaceId);
      return;
    }
    if (event.type === 'draftRevision' || event.type === 'conflict') {
      const current = entries.get(rootKey);
      if (current) {
        const dirtyByTabId = { ...current.dirtyByTabId };
        const conflictByTabId = { ...current.conflictByTabId };
        if (event.type === 'draftRevision') {
          if (event.dirty) dirtyByTabId[event.tabId] = true;
          else delete dirtyByTabId[event.tabId];
        }
        if (event.conflict !== 'none') conflictByTabId[event.tabId] = true;
        else delete conflictByTabId[event.tabId];
        touchEntry(rootKey, { ...current, dirtyByTabId, conflictByTabId });
        emit();
      }
    }
    void refreshWorkspace(event.workspaceId);
  };

  const ensureListener = (): Promise<void> => {
    if (listenerPromise) return listenerPromise;
    const lifecycle = lifecycleGeneration;
    listenerPromise = workspaceClient.onEvent((event) => {
      if (active && lifecycleGeneration === lifecycle) patchEvent(event);
    }).then((cleanup) => {
      if (!active || lifecycleGeneration !== lifecycle) cleanup();
      else unlisten = cleanup;
    });
    return listenerPromise;
  };

  const bootstrap = async () => {
    bootstrapScheduled = false;
    if (!active) return;
    const generation = ++bootstrapGeneration;
    const lifecycle = lifecycleGeneration;
    await ensureListener();
    if (!active || lifecycleGeneration !== lifecycle) return;
    const versionsAtListStart = new Map<string, number>();
    for (const [rootKey, count] of registrations) {
      if (count > 0) versionsAtListStart.set(rootKey, entryVersions.get(rootKey) ?? 0);
    }
    let records: WorkspaceRecord[];
    try {
      records = await workspaceClient.list();
    } catch (error) {
      if (!active || generation !== bootstrapGeneration) return;
      for (const [rootKey, count] of registrations) {
        if (count < 1) continue;
        if ((entryVersions.get(rootKey) ?? 0) !== versionsAtListStart.get(rootKey)) {
          continue;
        }
        const current = entries.get(rootKey);
        if (current) touchEntry(rootKey, { ...current, loading: false, error: errorMessage(error) });
      }
      emit();
      return;
    }
    if (
      !active
      || lifecycleGeneration !== lifecycle
      || generation !== bootstrapGeneration
    ) return;

    const recordByRoot = new Map<string, WorkspaceRecord>();
    for (const record of records) {
      const rootKey = normalizeComparablePath(record.canonicalRoot);
      if (!registered(rootKey)) continue;
      const previous = recordByRoot.get(rootKey);
      if (!previous || previous.updatedAtUnixMs < record.updatedAtUnixMs) {
        recordByRoot.set(rootKey, record);
      }
    }

    for (const [rootKey, count] of registrations) {
      if (count < 1) continue;
      const current = entries.get(rootKey);
      if (!current) continue;
      // An authority event or a newer registration may have updated this
      // scope while list() was in flight. Its targeted refresh is newer than
      // this bootstrap result, including when the stale list omits the scope.
      if ((entryVersions.get(rootKey) ?? 0) !== versionsAtListStart.get(rootKey)) {
        continue;
      }
      const record = recordByRoot.get(rootKey);
      if (!record) {
        touchEntry(rootKey, {
          ...current,
          workspaceId: null,
          canonicalRoot: null,
          tabs: [],
          dirtyByTabId: {},
          conflictByTabId: {},
          activeTabId: null,
          loading: false,
          error: null,
        });
        continue;
      }
      workspaceToRoot.set(record.id, rootKey);
      touchEntry(rootKey, {
        ...current,
        workspaceId: record.id,
        canonicalRoot: record.canonicalRoot,
        loading: true,
        error: null,
      });
      void refreshWorkspace(record.id);
    }
    emit();
  };

  const scheduleBootstrap = () => {
    if (bootstrapScheduled) return;
    bootstrapScheduled = true;
    queueMicrotask(() => void bootstrap());
  };

  const projectEntry = (entry: WorkspaceCatalogEntry): WorkspaceCatalogEntry => {
    const overlayMatches = Boolean(
      overlay.workspaceId
      && entry.workspaceId === overlay.workspaceId
      && overlay.rootPath
      && samePath(entry.requestedRoot, overlay.rootPath),
    );
    if (!overlayMatches) return entry;
    return {
      ...entry,
      tabs: [...overlay.tabs].sort((left, right) => left.sharedOrder - right.sharedOrder),
      dirtyByTabId: overlay.dirtyByTabId,
      conflictByTabId: overlay.conflictByTabId,
      activeTabId: overlay.workspaceVisible && overlay.activeTabId !== 'home'
        ? overlay.activeTabId
        : null,
      loading: false,
      error: null,
    };
  };

  return {
    mount() {
      active = true;
      lifecycleGeneration += 1;
      listenerPromise = null;
      void ensureListener();
      if (registrations.size > 0) scheduleBootstrap();
    },
    unmount() {
      active = false;
      lifecycleGeneration += 1;
      bootstrapGeneration += 1;
      bootstrapScheduled = false;
      listenerPromise = null;
      unlisten?.();
      unlisten = null;
      for (const task of taskQueue.splice(0)) task.cancel();
      // These promises belong to the prior mounted lifetime. Keeping either
      // map would make a StrictMode remount join an old request that can no
      // longer publish, leaving the new entry loading indefinitely.
      refreshStates.clear();
      discoveryRequests.clear();
    },
    registerRoot(rootPath) {
      const requestedRoot = rootPath.trim();
      const rootKey = normalizeComparablePath(requestedRoot);
      if (!rootKey) return;
      registrations.set(rootKey, (registrations.get(rootKey) ?? 0) + 1);
      const current = entries.get(rootKey);
      touchEntry(rootKey, current
        ? { ...current, requestedRoot, loading: current.workspaceId ? current.loading : true }
        : emptyEntry(requestedRoot));
      emit();
      scheduleBootstrap();
    },
    unregisterRoot(rootPath) {
      const rootKey = normalizeComparablePath(rootPath);
      const count = registrations.get(rootKey) ?? 0;
      if (count <= 1) registrations.delete(rootKey);
      else registrations.set(rootKey, count - 1);
      pruneInactive();
      emit();
    },
    getEntry(rootPath) {
      const rootKey = normalizeComparablePath(rootPath);
      return projectEntry(entries.get(rootKey) ?? emptyEntry(rootPath));
    },
    getEntries() {
      return [...entries.values()].map(projectEntry);
    },
    getRegisteredRootKeys() {
      return [...registrations.entries()]
        .filter(([, count]) => count > 0)
        .map(([rootKey]) => rootKey);
    },
    getRevision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidateWorkspace(workspaceId) {
      void refreshWorkspace(workspaceId);
    },
    retryRoot(rootPath) {
      const rootKey = normalizeComparablePath(rootPath);
      const entry = entries.get(rootKey);
      if (entry?.workspaceId) void refreshWorkspace(entry.workspaceId);
      else scheduleBootstrap();
    },
    setSelectedOverlay(nextOverlay) {
      overlay = nextOverlay;
      emit();
    },
  };
}

export function useWorkspaceCatalog(
  overlay: WorkspaceCatalogSelectedOverlay,
): WorkspaceCatalogController {
  const [controller] = useState(createWorkspaceCatalogController);
  useEffect(() => {
    controller.mount();
    return () => controller.unmount();
  }, [controller]);
  useEffect(() => controller.setSelectedOverlay(overlay), [controller, overlay]);
  return controller;
}

export function useWorkspaceCatalogEntry(
  controller: WorkspaceCatalogController,
  rootPath: string,
): WorkspaceCatalogEntry {
  useSyncExternalStore(
    controller.subscribe,
    controller.getRevision,
    controller.getRevision,
  );
  return controller.getEntry(rootPath);
}

export function useWorkspaceCatalogEntries(
  controller: WorkspaceCatalogController,
): WorkspaceCatalogEntry[] {
  useSyncExternalStore(
    controller.subscribe,
    controller.getRevision,
    controller.getRevision,
  );
  return controller.getEntries();
}

const WorkspaceCatalogContext = createContext<WorkspaceCatalogController | null>(null);

export function WorkspaceCatalogProvider({
  controller,
  children,
}: {
  controller: WorkspaceCatalogController;
  children: ReactNode;
}) {
  return createElement(WorkspaceCatalogContext.Provider, { value: controller }, children);
}

export function useWorkspaceCatalogController(): WorkspaceCatalogController | null {
  return useContext(WorkspaceCatalogContext);
}
