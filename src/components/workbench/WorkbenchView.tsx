import { Plus, Search, SlidersHorizontal, TerminalSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  attentionFilterMatches,
} from '../../lib/workbench/deriveAttentionItems';
import type {
  AttentionItem,
  ExecutionContextGroup,
  WorkbenchAttentionFilter,
  WorkbenchSummary as WorkbenchSummaryData,
  WorkbenchViewFilter,
} from '../../lib/workbench/types';
import type { TerminalCard } from '../../types/terminal';
import { AttentionItemCard } from './AttentionItemCard';
import { ExecutionGroupCard } from './ExecutionGroupCard';
import { WorkbenchSummary } from './WorkbenchSummary';

interface WorkbenchViewProps {
  cards: readonly TerminalCard[];
  attentionItems: readonly AttentionItem[];
  groups: readonly ExecutionContextGroup[];
  summary: WorkbenchSummaryData;
  now: number;
  scopeLabel: string | null;
  onOpenTerminal: (cardId: string) => void;
  onOpenAttention: (item: AttentionItem) => void;
  onOpenGroup: (group: ExecutionContextGroup) => void;
  onOpenRules: () => void;
  onNavigateTerminals: () => void;
  onCreateTerminal: () => void;
}

const FILTERS: WorkbenchAttentionFilter[] = [
  'all',
  'approval',
  'waiting',
  'failed',
  'review',
  'stalled',
];

export function WorkbenchView({
  cards,
  attentionItems,
  groups,
  summary,
  now,
  scopeLabel,
  onOpenTerminal,
  onOpenAttention,
  onOpenGroup,
  onOpenRules,
  onNavigateTerminals,
  onCreateTerminal,
}: WorkbenchViewProps) {
  const { t } = useTranslation('terminal');
  const [filter, setFilter] = useState<WorkbenchViewFilter>('all');
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const normalRunningCardIds = useMemo(() => {
    const cardsWithAttention = new Set(attentionItems.map((item) => item.cardId));
    return new Set(
      cards
        .filter(
          (card) => card.status === 'running' && !cardsWithAttention.has(card.id),
        )
        .map((card) => card.id),
    );
  }, [attentionItems, cards]);

  const visibleItems = useMemo(
    () =>
      attentionItems.filter(
        (item) =>
          filter !== 'running' &&
          attentionFilterMatches(item, filter) &&
          (!normalizedQuery || attentionSearchText(item).includes(normalizedQuery)),
      ),
    [attentionItems, filter, normalizedQuery],
  );
  const visibleGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          (filter !== 'running' ||
            group.cardIds.some((cardId) => normalRunningCardIds.has(cardId))) &&
          (!normalizedQuery || executionGroupSearchText(group).includes(normalizedQuery)),
      ),
    [filter, groups, normalRunningCardIds, normalizedQuery],
  );

  return (
    <div
      data-testid="workbench-view"
      className="h-full w-full overflow-y-auto bg-background/20"
    >
      <div className="mx-auto w-full max-w-[1180px] px-4 pb-8 pt-4 md:px-6 md:pt-5">
        <header className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="text-[15px] font-semibold">
                {t('workbench.title', { defaultValue: 'Workbench' })}
              </h1>
              {scopeLabel && (
                <span
                  title={scopeLabel}
                  className="max-w-48 truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                >
                  {scopeLabel}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t('workbench.subtitle', {
                defaultValue: 'Deterministic signals from your active terminals',
              })}
            </p>
          </div>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:flex-initial">
            <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card/70 px-3 focus-within:border-primary/50 sm:w-64">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="sr-only">
                {t('workbench.searchLabel', { defaultValue: 'Search workbench' })}
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.searchPlaceholder', {
                  defaultValue: 'Search project, branch, or output',
                })}
                className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <button
              type="button"
              onClick={onOpenRules}
              title={t('workbench.rules.title', { defaultValue: 'Attention rules' })}
              aria-label={t('workbench.rules.title', { defaultValue: 'Attention rules' })}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-card/70 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <WorkbenchSummary
          summary={summary}
          activeFilter={filter}
          onSelectFilter={setFilter}
        />

        {cards.length === 0 ? (
          <div className="mt-5 flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/35 px-6 text-center">
            <TerminalSquare className="h-7 w-7 text-muted-foreground/60" />
            <div className="mt-3 text-sm font-medium">
              {scopeLabel
                ? t('workbench.empty.noScopeTerminalsTitle', {
                    defaultValue: 'No terminals in this scope',
                  })
                : t('workbench.empty.noTerminalsTitle', {
                    defaultValue: 'No terminals yet',
                  })}
            </div>
            <div className="mt-1 max-w-sm text-[11px] text-muted-foreground">
              {scopeLabel
                ? t('workbench.empty.noScopeTerminalsBody', {
                    defaultValue:
                      'Choose another project or worktree, or create a terminal in this scope.',
                  })
                : t('workbench.empty.noTerminalsBody', {
                    defaultValue:
                      'Create a terminal to start collecting local status signals.',
                  })}
            </div>
            <button
              type="button"
              onClick={onCreateTerminal}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[11px] font-semibold text-primary-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('app.newTerminal', { defaultValue: 'New terminal' })}
            </button>
          </div>
        ) : (
          <>
            <section aria-labelledby="workbench-attention-heading">
              <div className="mb-2 mt-5 flex min-w-0 flex-wrap items-center gap-2">
                <h2 id="workbench-attention-heading" className="text-[13px] font-semibold">
                  {t('workbench.attention.title', { defaultValue: 'Needs attention' })}
                </h2>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {t('workbench.attention.count', {
                    count: visibleItems.length,
                    defaultValue: '{{count}} items',
                  })}
                </span>
                <div
                  role="group"
                  aria-label={t('workbench.filters.label', {
                    defaultValue: 'Filter attention items',
                  })}
                  className="flex max-w-full items-center gap-1 overflow-x-auto sm:ml-auto"
                >
                  {FILTERS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                      className={[
                        'h-6 shrink-0 rounded-md border px-2 text-[11px] transition-colors',
                        filter === value
                          ? 'border-border bg-foreground/[0.08] text-foreground'
                          : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
                      ].join(' ')}
                    >
                      {t(`workbench.filters.${value}`, {
                        defaultValue: filterLabel(value),
                      })}
                    </button>
                  ))}
                </div>
              </div>

              {visibleItems.length > 0 ? (
                <div className="space-y-2 lg:max-h-[238px] lg:overflow-y-auto lg:pr-1">
                  {visibleItems.map((item) => (
                    <AttentionItemCard
                      key={item.id}
                      item={item}
                      now={now}
                      onOpenItem={() => onOpenTerminal(item.cardId)}
                      onOpenDetail={onOpenAttention}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-card/30 px-4 py-5 text-center text-[11px] text-muted-foreground">
                  {normalizedQuery
                    ? t('workbench.empty.noSearchResults', {
                        defaultValue: 'No attention items match this search.',
                      })
                    : t('workbench.empty.noAttention', {
                        defaultValue: 'Nothing needs your attention in this scope.',
                      })}
                </div>
              )}
            </section>

            <section aria-labelledby="workbench-groups-heading">
              <div className="mb-2 mt-5 flex items-center gap-2">
                <div className="min-w-0">
                  <h2 id="workbench-groups-heading" className="text-[13px] font-semibold">
                    {t('workbench.groups.title', { defaultValue: 'Execution contexts' })}
                  </h2>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t('workbench.groups.subtitle', {
                      defaultValue: 'Grouped by project and worktree, not inferred tasks',
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onNavigateTerminals}
                  className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground hover:text-primary"
                >
                  {t('workbench.action.viewAllTerminals', {
                    defaultValue: 'View all terminals',
                  })}
                  {' →'}
                </button>
              </div>
              {visibleGroups.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {visibleGroups.map((group) => (
                    <ExecutionGroupCard
                      key={group.id}
                      group={group}
                      now={now}
                      onOpenDetail={onOpenGroup}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-card/30 px-4 py-5 text-center text-[11px] text-muted-foreground">
                  {t('workbench.empty.noActiveContexts', {
                    defaultValue: 'No active execution contexts in this scope.',
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function attentionSearchText(item: AttentionItem): string {
  return [
    item.title,
    item.detail,
    item.projectName,
    item.projectPath,
    item.branchLabel,
    item.worktreePath,
    item.terminalType,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function executionGroupSearchText(group: ExecutionContextGroup): string {
  return [
    group.projectName,
    group.projectPath,
    group.branchLabel,
    group.worktreePath,
    group.preview,
    ...group.terminalTypes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function filterLabel(filter: WorkbenchAttentionFilter): string {
  switch (filter) {
    case 'all':
      return 'All';
    case 'approval':
      return 'Approval';
    case 'waiting':
      return 'Waiting';
    case 'failed':
      return 'Failed';
    case 'review':
      return 'Review';
    case 'stalled':
      return 'No progress';
  }
}
