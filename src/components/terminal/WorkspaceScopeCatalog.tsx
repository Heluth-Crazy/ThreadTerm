import { useEffect, useId, useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  GitCompare,
  Loader2,
  RefreshCw,
  TerminalSquare,
  TriangleAlert,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAgentSessionMetadataCache } from '../../stores/agentSessionMetadataCache';
import {
  agentSessionMetadataCacheKey,
  isAgentSessionProvider,
} from '../../types/agentSession';
import { effectiveWorktreePath } from '../../lib/worktreePaths';
import { buildWorkspaceTerminalPresentation } from '../../lib/workspaceTerminalPresentation';
import {
  useWorkspaceCatalogController,
  useWorkspaceCatalogEntry,
  type WorkspaceCatalogController,
  type WorkspaceCatalogTabRef,
} from '../workspace/useWorkspaceCatalog';
import {
  buildWorkspaceCatalog,
  type WorkspaceCatalogCategory,
  type WorkspaceCatalogCategoryId,
  type WorkspaceCatalogRow,
} from '../workspace/workspaceCatalogModel';
import { useWorkspaceSidebarDisclosure } from '../workspace/useWorkspaceSidebarDisclosure';

export interface WorkspaceScopeCatalogProps {
  rootPath: string;
  onActivate: (ref: WorkspaceCatalogTabRef) => void;
}

const CATEGORY_ICONS = {
  sessions: TerminalSquare,
  files: FileText,
  changes: GitCompare,
} satisfies Record<WorkspaceCatalogCategoryId, typeof TerminalSquare>;

export function WorkspaceScopeCatalog(props: WorkspaceScopeCatalogProps) {
  const controller = useWorkspaceCatalogController();
  if (!controller) return null;
  return <WorkspaceScopeCatalogInner {...props} controller={controller} />;
}

function WorkspaceScopeCatalogInner({
  rootPath,
  onActivate,
  controller,
}: WorkspaceScopeCatalogProps & { controller: WorkspaceCatalogController }) {
  const { t } = useTranslation('terminal');
  const catalogId = useId().replace(/:/g, '');
  const cards = useTerminalStore((state) => state.cards);
  const metadataEntries = useAgentSessionMetadataCache((state) => state.entries);
  const entry = useWorkspaceCatalogEntry(controller, rootPath);
  const { state: disclosure, toggleCategory } = useWorkspaceSidebarDisclosure(rootPath);
  const categories = useMemo(() => buildWorkspaceCatalog({
    tabs: entry.tabs,
    cards,
    dirtyByTabId: entry.dirtyByTabId,
    conflictByTabId: entry.conflictByTabId,
  }), [cards, entry.conflictByTabId, entry.dirtyByTabId, entry.tabs]);

  useEffect(() => {
    controller.registerRoot(rootPath);
    return () => controller.unregisterRoot(rootPath);
  }, [controller, rootPath]);

  const activate = (row: WorkspaceCatalogRow) => {
    if (!entry.workspaceId) return;
    onActivate({
      workspaceId: entry.workspaceId,
      rootPath: entry.canonicalRoot ?? rootPath,
      tabId: row.tab.id,
      kind: row.kind,
      cardId: row.tab.cardId ?? null,
      relativePath: row.tab.relativePath ?? null,
    });
  };

  return (
    <div
      data-testid="workspace-scope-catalog"
      data-workspace-root={rootPath}
      className="mb-1 ml-4 border-l border-border/60 pl-2"
    >
      {categories.map((category) => (
        <CatalogCategory
          key={category.id}
          catalogId={catalogId}
          category={category}
          expanded={disclosure[category.id]}
          activeTabId={entry.activeTabId}
          metadataEntries={metadataEntries}
          onToggle={() => toggleCategory(category.id)}
          onActivate={activate}
        />
      ))}
      {entry.loading && (
        <div
          role="status"
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground"
        >
          <Loader2
            className="h-3 w-3 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t('workspace.catalog.loading', { defaultValue: 'Loading open content…' })}
        </div>
      )}
      {entry.error && (
        <div className="mx-1 my-1 rounded-md border border-destructive/40 bg-destructive/10 p-1.5 text-[11px] text-destructive">
          <p className="break-words">{entry.error}</p>
          <button
            type="button"
            onClick={() => controller.retryRoot(rootPath)}
            className="mt-1 inline-flex min-h-6 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            {t('workspace.catalog.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      )}
    </div>
  );
}

function CatalogCategory({
  catalogId,
  category,
  expanded,
  activeTabId,
  metadataEntries,
  onToggle,
  onActivate,
}: {
  catalogId: string;
  category: WorkspaceCatalogCategory;
  expanded: boolean;
  activeTabId: string | null;
  metadataEntries: ReturnType<typeof useAgentSessionMetadataCache.getState>['entries'];
  onToggle: () => void;
  onActivate: (row: WorkspaceCatalogRow) => void;
}) {
  const { t } = useTranslation('terminal');
  const Icon = CATEGORY_ICONS[category.id];
  const panelId = `${catalogId}-${category.id}`;
  const containsActive = category.rows.some((row) => row.tab.id === activeTabId);
  const label = t(`workspace.catalog.${category.id}`, {
    defaultValue: category.id === 'sessions'
      ? 'Sessions'
      : category.id === 'files'
        ? 'Files'
        : 'Changes',
  });

  return (
    <div data-testid={`workspace-catalog-category-${category.id}`}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-6 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          className={[
            'min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] font-bold tabular-nums',
            containsActive
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground',
          ].join(' ')}
        >
          {category.rows.length}
        </span>
      </button>
      {expanded && (
        <div id={panelId} className="space-y-0.5 pb-1">
          {category.rows.length === 0 ? (
            <div className="px-7 py-1 text-[11px] text-muted-foreground">
              {t('workspace.catalog.empty', { defaultValue: 'None open' })}
            </div>
          ) : category.rows.map((row) => (
            <CatalogRow
              key={row.tab.id}
              row={row}
              active={row.tab.id === activeTabId}
              metadataEntries={metadataEntries}
              onActivate={() => onActivate(row)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogRow({
  row,
  active,
  metadataEntries,
  onActivate,
}: {
  row: WorkspaceCatalogRow;
  active: boolean;
  metadataEntries: ReturnType<typeof useAgentSessionMetadataCache.getState>['entries'];
  onActivate: () => void;
}) {
  const { t } = useTranslation('terminal');
  let Icon: ComponentType<{ className?: string }> = row.kind === 'terminal'
    ? TerminalSquare
    : row.kind === 'file'
      ? FileText
      : GitCompare;
  let primary = row.label;
  let secondary = row.parentSuffix;
  let tooltip = row.fullPath ?? row.tab.title;

  if (row.kind === 'terminal' && row.card) {
    const metadata = row.card.providerSessionId
      && isAgentSessionProvider(row.card.terminalType)
      ? metadataEntries.get(agentSessionMetadataCacheKey(
          row.card.terminalType,
          row.card.providerSessionId,
          effectiveWorktreePath(row.card),
        ))
      : undefined;
    const presentation = buildWorkspaceTerminalPresentation(row.card, {
      t,
      metadata: metadata?.status === 'found' ? metadata.summary : null,
    });
    Icon = presentation.Icon;
    primary = presentation.primaryTitle;
    secondary = presentation.secondaryTitle ?? presentation.typeLabel;
    tooltip = presentation.tooltip;
  }

  const stateLabels = [
    row.dirty
      ? t('workspace.catalog.unsaved', { defaultValue: 'Unsaved' })
      : null,
    row.conflict
      ? t('workspace.catalog.conflict', { defaultValue: 'Conflict' })
      : null,
  ].filter(Boolean);
  const accessibleLabel = [primary, row.fullPath, ...stateLabels]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={accessibleLabel}
      aria-current={active ? 'page' : undefined}
      onClick={onActivate}
      data-testid={`workspace-catalog-row-${row.tab.id}`}
      className={[
        'group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-foreground hover:bg-accent hover:text-accent-foreground',
      ].join(' ')}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute bottom-1 left-0 top-1 w-0.5 rounded-full bg-primary"
        />
      )}
      <span className="shrink-0" aria-hidden="true">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{primary}</span>
        {secondary && (
          <span className="block truncate text-[10px] text-muted-foreground">
            {secondary}
          </span>
        )}
      </span>
      {row.dirty && (
        <span className="inline-flex shrink-0 items-center gap-1 text-warning">
          <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
          <span className="sr-only">
            {t('workspace.catalog.unsaved', { defaultValue: 'Unsaved' })}
          </span>
        </span>
      )}
      {row.conflict && (
        <span className="shrink-0 text-destructive">
          <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">
            {t('workspace.catalog.conflict', { defaultValue: 'Conflict' })}
          </span>
        </span>
      )}
    </button>
  );
}
