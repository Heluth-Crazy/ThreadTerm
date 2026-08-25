import { ChevronDown, ChevronUp, TimerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AttentionItem } from '../../lib/workbench/types';
import { AttentionItemCard } from './AttentionItemCard';

interface WorkbenchStalledSectionProps {
  items: readonly AttentionItem[];
  expanded: boolean;
  followedCardIds: ReadonlySet<string>;
  now: number;
  onToggleExpanded: () => void;
  onOpenTerminal: (cardId: string) => void;
  onOpenAttention: (item: AttentionItem) => void;
  onIgnoreAttention: (item: AttentionItem) => void;
  onSetCardFollowed: (cardId: string, followed: boolean) => void;
}

export function WorkbenchStalledSection({
  items,
  expanded,
  followedCardIds,
  now,
  onToggleExpanded,
  onOpenTerminal,
  onOpenAttention,
  onIgnoreAttention,
  onSetCardFollowed,
}: WorkbenchStalledSectionProps) {
  const { t } = useTranslation('terminal');

  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="workbench-stalled-heading"
      className="mt-3 rounded-lg border border-border/70 bg-card/40"
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <TimerOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          id="workbench-stalled-heading"
          className="text-[13px] font-semibold text-muted-foreground"
        >
          {t('workbench.stalled.title', { defaultValue: 'No-progress watch' })}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('workbench.stalled.count', {
            count: items.length,
            defaultValue: '{{count}} terminals',
          })}
        </span>
        <span className="ml-auto truncate text-[11px] text-muted-foreground/80">
          {t('workbench.stalled.hint', {
            defaultValue: 'Running, but quiet beyond the rule threshold',
          })}
        </span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="space-y-2 px-3 pb-3">
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
      )}
    </section>
  );
}
