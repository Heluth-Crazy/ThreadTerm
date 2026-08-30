import type { TerminalCard } from '../../types/terminal';
import type { WorkspaceTab } from '../../lib/workspace/types';

export type WorkspaceCatalogCategoryId = 'sessions' | 'files' | 'changes';

export interface WorkspaceCatalogRow {
  tab: WorkspaceTab;
  kind: 'terminal' | 'file' | 'diff';
  card: TerminalCard | null;
  label: string;
  fullPath: string | null;
  parentSuffix: string | null;
  dirty: boolean;
  conflict: boolean;
}
export interface WorkspaceCatalogCategory {
  id: WorkspaceCatalogCategoryId;
  rows: WorkspaceCatalogRow[];
}

interface BuildWorkspaceCatalogOptions {
  tabs: readonly WorkspaceTab[];
  cards: readonly TerminalCard[];
  dirtyByTabId?: Readonly<Record<string, boolean>>;
  conflictByTabId?: Readonly<Record<string, boolean>>;
}

const CATEGORY_ORDER: readonly WorkspaceCatalogCategoryId[] = [
  'sessions',
  'files',
  'changes',
];

function normalizedRelativePath(tab: WorkspaceTab): string {
  return (tab.relativePath?.trim() || tab.title).replace(/\\/g, '/');
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed || path;
}

function parentSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  return segments.slice(0, -1);
}

function addUniqueParentSuffixes(rows: WorkspaceCatalogRow[]): WorkspaceCatalogRow[] {
  const byLabel = new Map<string, WorkspaceCatalogRow[]>();
  for (const row of rows) {
    const group = byLabel.get(row.label) ?? [];
    group.push(row);
    byLabel.set(row.label, group);
  }

  return rows.map((row) => {
    const duplicates = byLabel.get(row.label) ?? [];
    if (duplicates.length < 2 || !row.fullPath) return row;
    const ownParent = parentSegments(row.fullPath);
    if (ownParent.length === 0) return row;

    for (let length = 1; length <= ownParent.length; length += 1) {
      const suffix = ownParent.slice(-length).join('/');
      const unique = duplicates.every((candidate) => {
        if (candidate.tab.id === row.tab.id || !candidate.fullPath) return true;
        return parentSegments(candidate.fullPath).slice(-length).join('/') !== suffix;
      });
      if (unique) return { ...row, parentSuffix: suffix };
    }

    return { ...row, parentSuffix: ownParent.join('/') };
  });
}

/** Read-only projection of authoritative workspace tabs into fixed catalog groups. */
export function buildWorkspaceCatalog({
  tabs,
  cards,
  dirtyByTabId = {},
  conflictByTabId = {},
}: BuildWorkspaceCatalogOptions): WorkspaceCatalogCategory[] {
  const cardsById = new Map(cards.map((card) => [card.id, card] as const));
  const rowsByCategory: Record<WorkspaceCatalogCategoryId, WorkspaceCatalogRow[]> = {
    sessions: [],
    files: [],
    changes: [],
  };

  const concreteTabs = tabs
    .filter((tab): tab is WorkspaceTab & { kind: 'terminal' | 'file' | 'diff' } => (
      tab.kind === 'terminal' || tab.kind === 'file' || tab.kind === 'diff'
    ))
    .map((tab, index) => ({ tab, index }))
    .sort((left, right) => (
      left.tab.sharedOrder - right.tab.sharedOrder || left.index - right.index
    ));

  for (const { tab } of concreteTabs) {
    const path = tab.kind === 'terminal' ? null : normalizedRelativePath(tab);
    const row: WorkspaceCatalogRow = {
      tab,
      kind: tab.kind,
      card: tab.kind === 'terminal' && tab.cardId
        ? cardsById.get(tab.cardId) ?? null
        : null,
      label: path ? pathBasename(path) : tab.title,
      fullPath: path,
      parentSuffix: null,
      dirty: Boolean(dirtyByTabId[tab.id]),
      conflict: Boolean(conflictByTabId[tab.id]),
    };
    if (tab.kind === 'terminal') rowsByCategory.sessions.push(row);
    else if (tab.kind === 'file') rowsByCategory.files.push(row);
    else rowsByCategory.changes.push(row);
  }

  rowsByCategory.files = addUniqueParentSuffixes(rowsByCategory.files);
  rowsByCategory.changes = addUniqueParentSuffixes(rowsByCategory.changes);

  return CATEGORY_ORDER.map((id) => ({ id, rows: rowsByCategory[id] }));
}
