import { useCallback, useSyncExternalStore } from 'react';
import {
  getPreloadedManagedStateItem,
  MANAGED_STATE_KEYS,
  writeManagedPreference,
} from '../../lib/managedState';
import { normalizeComparablePath } from '../../lib/worktreePaths';
import type { WorkspaceCatalogCategoryId } from './workspaceCatalogModel';

export interface WorkspaceSidebarDisclosureState {
  sessions: boolean;
  files: boolean;
  changes: boolean;
}
interface PersistedWorkspaceSidebarDisclosureState
  extends WorkspaceSidebarDisclosureState {
  updatedAt: number;
}

interface WorkspaceSidebarDisclosureDocumentV1 {
  version: 1;
  scopes: Record<string, PersistedWorkspaceSidebarDisclosureState>;
}

const MAX_PERSISTED_SCOPES = 256;
const DEFAULT_DISCLOSURE: WorkspaceSidebarDisclosureState = Object.freeze({
  sessions: true,
  files: false,
  changes: false,
});

let loaded = false;
let scopes = new Map<string, PersistedWorkspaceSidebarDisclosureState>();
const listeners = new Set<() => void>();

function validScope(value: unknown): value is PersistedWorkspaceSidebarDisclosureState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedWorkspaceSidebarDisclosureState>;
  return (
    typeof candidate.sessions === 'boolean'
    && typeof candidate.files === 'boolean'
    && typeof candidate.changes === 'boolean'
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt)
  );
}

export function parseWorkspaceSidebarDisclosure(
  raw: string | null,
): Map<string, PersistedWorkspaceSidebarDisclosureState> {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceSidebarDisclosureDocumentV1>;
    if (parsed.version !== 1 || !parsed.scopes || typeof parsed.scopes !== 'object') {
      return new Map();
    }
    const entries = Object.entries(parsed.scopes)
      .filter((entry): entry is [string, PersistedWorkspaceSidebarDisclosureState] => (
        Boolean(entry[0]) && validScope(entry[1])
      ))
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_PERSISTED_SCOPES);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  scopes = parseWorkspaceSidebarDisclosure(
    getPreloadedManagedStateItem(MANAGED_STATE_KEYS.workspaceSidebarDisclosure),
  );
}

function persist(): void {
  const retained = [...scopes.entries()]
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_PERSISTED_SCOPES);
  scopes = new Map(retained);
  const document: WorkspaceSidebarDisclosureDocumentV1 = {
    version: 1,
    scopes: Object.fromEntries(retained),
  };
  writeManagedPreference(
    MANAGED_STATE_KEYS.workspaceSidebarDisclosure,
    JSON.stringify(document),
  );
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkspaceSidebarDisclosure(
  rootPath: string,
): WorkspaceSidebarDisclosureState {
  ensureLoaded();
  const rootKey = normalizeComparablePath(rootPath);
  return scopes.get(rootKey) ?? DEFAULT_DISCLOSURE;
}

export function setWorkspaceSidebarDisclosure(
  rootPath: string,
  category: WorkspaceCatalogCategoryId,
  expanded: boolean,
): void {
  ensureLoaded();
  const rootKey = normalizeComparablePath(rootPath);
  if (!rootKey) return;
  const current = scopes.get(rootKey) ?? DEFAULT_DISCLOSURE;
  if (current[category] === expanded) return;
  scopes.set(rootKey, {
    sessions: current.sessions,
    files: current.files,
    changes: current.changes,
    [category]: expanded,
    updatedAt: Date.now(),
  });
  persist();
  emit();
}

export function useWorkspaceSidebarDisclosure(rootPath: string) {
  const rootKey = normalizeComparablePath(rootPath);
  const state = useSyncExternalStore(
    subscribe,
    () => getWorkspaceSidebarDisclosure(rootKey),
    () => getWorkspaceSidebarDisclosure(rootKey),
  );
  const setCategory = useCallback((
    category: WorkspaceCatalogCategoryId,
    expanded: boolean,
  ) => {
    setWorkspaceSidebarDisclosure(rootKey, category, expanded);
  }, [rootKey]);
  const toggleCategory = useCallback((category: WorkspaceCatalogCategoryId) => {
    const current = getWorkspaceSidebarDisclosure(rootKey);
    setWorkspaceSidebarDisclosure(rootKey, category, !current[category]);
  }, [rootKey]);
  return { state, setCategory, toggleCategory };
}

export function __resetWorkspaceSidebarDisclosureForTests(): void {
  loaded = false;
  scopes = new Map();
  listeners.clear();
}
