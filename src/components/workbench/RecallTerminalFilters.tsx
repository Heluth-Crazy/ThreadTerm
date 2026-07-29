import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ALL_RECALL_CONTEXTS,
  type RecallContextOption,
  type RecallProjectOption,
  type RecallScope,
} from './recallTerminalModel';

interface RecallTerminalFiltersProps {
  query: string;
  scope: RecallScope;
  selectedProjectPath: string | null;
  effectiveProjectPath: string | null;
  effectiveProjectOptionPath: string;
  projectOptions: readonly RecallProjectOption[];
  contextOptions: readonly RecallContextOption[];
  contextOptionId: string;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: RecallScope) => void;
  onProjectPathChange: (projectPath: string) => void;
  onContextIdChange: (contextId: string) => void;
}

export function RecallTerminalFilters({
  query,
  scope,
  selectedProjectPath,
  effectiveProjectPath,
  effectiveProjectOptionPath,
  projectOptions,
  contextOptions,
  contextOptionId,
  onQueryChange,
  onScopeChange,
  onProjectPathChange,
  onContextIdChange,
}: RecallTerminalFiltersProps) {
  const { t } = useTranslation('terminal');

  return (
    <div className="space-y-3 border-b border-border bg-card/25 px-5 py-3">
      <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 focus-within:border-primary/50">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="sr-only">
          {t('workbench.recall.searchLabel', {
            defaultValue: 'Search active terminals',
          })}
        </span>
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('workbench.recall.searchPlaceholder', {
            defaultValue: 'Search project, branch, type, or output',
          })}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
        />
      </label>
      <div
        className={[
          'grid grid-cols-1 gap-2',
          selectedProjectPath ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
        ].join(' ')}
      >
        {selectedProjectPath && (
          <label className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('workbench.recall.scope', { defaultValue: 'Scope' })}
            </span>
            <select
              value={scope}
              onChange={(event) =>
                onScopeChange(event.target.value as RecallScope)
              }
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] outline-none"
            >
              <option value="current">
                {t('workbench.recall.currentScope', {
                  defaultValue: 'Current Workbench scope',
                })}
              </option>
              <option value="all">
                {t('workbench.recall.allScope', {
                  defaultValue: 'All projects',
                })}
              </option>
            </select>
          </label>
        )}
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('workbench.recall.project', { defaultValue: 'Project' })}
          </span>
          <select
            value={effectiveProjectOptionPath}
            disabled={scope === 'current'}
            onChange={(event) => onProjectPathChange(event.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] outline-none disabled:opacity-60"
          >
            <option value="all">
              {t('workbench.recall.allProjects', {
                defaultValue: 'All projects',
              })}
            </option>
            {projectOptions.map((project) => (
              <option key={project.path} value={project.path}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('workbench.recall.worktree', {
              defaultValue: 'Branch / worktree',
            })}
          </span>
          <select
            value={contextOptionId}
            disabled={!effectiveProjectPath}
            onChange={(event) => onContextIdChange(event.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] outline-none disabled:opacity-60"
          >
            <option value={ALL_RECALL_CONTEXTS}>
              {t('workbench.recall.allWorktrees', {
                defaultValue: 'All branches / worktrees',
              })}
            </option>
            {contextOptions.map((context) => (
              <option key={context.id} value={context.id}>
                {context.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
