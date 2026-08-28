import { ChevronRight, CircleAlert, CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AttentionItem } from '../../lib/workbench/types';
import {
  AttentionItemCard,
  type AttentionItemCardLayout,
} from './AttentionItemCard';

interface WorkbenchAttentionSectionProps {
  items: readonly AttentionItem[];
  followedCardIds: ReadonlySet<string>;
  now: number;
  queryActive: boolean;
  cardLayout?: AttentionItemCardLayout;
  className?: string;
  onOpenAll: () => void;
  onOpenItem: (item: AttentionItem) => void;
  onOpenAttention: (item: AttentionItem) => void;
  onIgnoreAttention: (item: AttentionItem) => void;
  onSetCardFollowed: (cardId: string, followed: boolean) => void;
}

export function WorkbenchAttentionSection({
  items,
  followedCardIds,
  now,
  queryActive,
  cardLayout = 'wide',
  className = '',
  onOpenAll,
  onOpenItem,
  onOpenAttention,
  onIgnoreAttention,
  onSetCardFollowed,
}: WorkbenchAttentionSectionProps) {
  const { t } = useTranslation('terminal');

  return (
    <section
      aria-labelledby="workbench-attention-heading"
      className={[
        'flex min-h-0 flex-col rounded-xl border border-border/70 bg-card/50',
        className,
      ].join(' ')}
    >
      <div className="flex h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-3.5">
        <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
        <h2 id="workbench-attention-heading" className="shrink-0 text-[13px] font-semibold">
          {t('workbench.attention.title', { defaultValue: 'Needs attention' })}
        </h2>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {t('workbench.attention.count', {
            count: items.length,
            defaultValue: '{{count}} items',
          })}
        </span>
        <button
          type="button"
          onClick={onOpenAll}
          className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('workbench.attention.viewAll', { defaultValue: 'View all' })}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {items.length > 0 ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {items.map((item) => (
            <AttentionItemCard
              key={item.id}
              item={item}
              now={now}
              followed={followedCardIds.has(item.cardId)}
              layout={cardLayout}
              onOpenItem={onOpenItem}
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
        <div className="grid flex-1 place-items-center px-4 py-8">
          <div className="text-center">
            <span className="mx-auto grid h-8 w-8 place-items-center rounded-md bg-success/10 text-success">
              <CircleCheck className="h-4 w-4" />
            </span>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {queryActive
                ? t('workbench.empty.noSearchResults', {
                    defaultValue: 'No attention items match this search.',
                  })
                : t('workbench.empty.noAttention', {
                    defaultValue: 'Nothing needs your attention in this scope.',
                  })}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
