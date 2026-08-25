import { useTranslation } from 'react-i18next';
import type {
  AttentionItem,
  WorkbenchAttentionFilter,
  WorkbenchViewFilter,
} from '../../lib/workbench/types';
import { AttentionItemCard } from './AttentionItemCard';
import {
  WORKBENCH_ATTENTION_FILTERS,
  workbenchFilterLabel,
} from './workbenchPresentation';

interface WorkbenchAttentionSectionProps {
  items: readonly AttentionItem[];
  filter: WorkbenchViewFilter;
  followedCardIds: ReadonlySet<string>;
  now: number;
  queryActive: boolean;
  onSelectFilter: (filter: WorkbenchAttentionFilter) => void;
  onOpenTerminal: (cardId: string) => void;
  onOpenAttention: (item: AttentionItem) => void;
  onIgnoreAttention: (item: AttentionItem) => void;
  onSetCardFollowed: (cardId: string, followed: boolean) => void;
}

export function WorkbenchAttentionSection({
  items,
  filter,
  followedCardIds,
  now,
  queryActive,
  onSelectFilter,
  onOpenTerminal,
  onOpenAttention,
  onIgnoreAttention,
  onSetCardFollowed,
}: WorkbenchAttentionSectionProps) {
  const { t } = useTranslation('terminal');

  return (
    <section aria-labelledby="workbench-attention-heading">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
        <h2 id="workbench-attention-heading" className="text-[13px] font-semibold">
          {t('workbench.attention.title', { defaultValue: 'Needs attention' })}
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('workbench.attention.count', {
            count: items.length,
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
          {WORKBENCH_ATTENTION_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => onSelectFilter(value)}
              className={[
                'h-6 shrink-0 rounded-md border px-2 text-[11px] transition-colors',
                filter === value
                  ? 'border-border bg-foreground/[0.08] text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
              ].join(' ')}
            >
              {t(`workbench.filters.${value}`, {
                defaultValue: workbenchFilterLabel(value),
              })}
            </button>
          ))}
        </div>
      </div>

      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item) => (
            <AttentionItemCard
              key={item.id}
              item={item}
              now={now}
              followed={followedCardIds.has(item.cardId)}
              onOpenItem={() => onOpenTerminal(item.cardId)}
              onOpenDetail={onOpenAttention}
              onIgnoreItem={onIgnoreAttention}
              onToggleFollow={() =>
                onSetCardFollowed(
                  item.cardId,
                  !followedCardIds.has(item.cardId),
                )
              }
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card/30 px-4 py-5 text-center text-[11px] text-muted-foreground">
          {queryActive
            ? t('workbench.empty.noSearchResults', {
                defaultValue: 'No attention items match this search.',
              })
            : t('workbench.empty.noAttention', {
                defaultValue: 'Nothing needs your attention in this scope.',
              })}
        </div>
      )}
    </section>
  );
}
