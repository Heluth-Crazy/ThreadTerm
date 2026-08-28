import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { attentionFilterMatches } from '../../lib/workbench/deriveAttentionItems';
import type {
  AttentionItem,
  WorkbenchAttentionFilter,
} from '../../lib/workbench/types';
import { AttentionItemCard } from './AttentionItemCard';
import {
  WORKBENCH_ATTENTION_FILTERS,
  workbenchFilterLabel,
} from './workbenchPresentation';

interface AttentionItemsDialogProps {
  open: boolean;
  items: readonly AttentionItem[];
  followedCardIds: ReadonlySet<string>;
  now: number;
  queryActive: boolean;
  initialFilter: WorkbenchAttentionFilter;
  onClose: () => void;
  onOpenItem: (item: AttentionItem) => void;
  onOpenAttention: (item: AttentionItem) => void;
  onIgnoreAttention: (item: AttentionItem) => void;
  onSetCardFollowed: (cardId: string, followed: boolean) => void;
}

export function AttentionItemsDialog({
  open,
  items,
  followedCardIds,
  now,
  queryActive,
  initialFilter,
  onClose,
  onOpenItem,
  onOpenAttention,
  onIgnoreAttention,
  onSetCardFollowed,
}: AttentionItemsDialogProps) {
  const { t } = useTranslation('terminal');
  const [filter, setFilter] = useState<WorkbenchAttentionFilter>(initialFilter);
  const priorFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setFilter(initialFilter);
    priorFocusRef.current = document.activeElement as HTMLElement | null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      priorFocusRef.current?.focus();
    };
  }, [initialFilter, onClose, open]);

  if (!open) return null;

  const visibleItems = items.filter((item) =>
    attentionFilterMatches(item, filter),
  );

  return (
    <>
      <button
        type="button"
        aria-label={t('workbench.attention.title', {
          defaultValue: 'Needs attention',
        })}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-background/60 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attention-items-dialog-title"
          className="pointer-events-auto flex h-[min(640px,calc(100vh-32px))] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-background text-card-foreground shadow-2xl"
        >
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-warning/10 text-warning">
              <CircleAlert className="h-4 w-4" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <h2
                id="attention-items-dialog-title"
                className="text-sm font-semibold"
              >
                {t('workbench.attention.title', {
                  defaultValue: 'Needs attention',
                })}
              </h2>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {t('workbench.attention.count', {
                  count: items.length,
                  defaultValue: '{{count}} items',
                })}
              </span>
            </span>
            <button
              type="button"
              onClick={onClose}
              title={t('workbench.recall.close', { defaultValue: 'Close' })}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div
            role="group"
            aria-label={t('workbench.filters.label', {
              defaultValue: 'Filter attention items',
            })}
            className="flex items-center gap-1 border-b border-border/60 px-5 py-2.5"
          >
            {WORKBENCH_ATTENTION_FILTERS.map((value) => (
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
                  defaultValue: workbenchFilterLabel(value),
                })}
              </button>
            ))}
          </div>

          {visibleItems.length > 0 ? (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
              {visibleItems.map((item) => (
                <AttentionItemCard
                  key={item.id}
                  item={item}
                  now={now}
                  followed={followedCardIds.has(item.cardId)}
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
            <div className="grid flex-1 place-items-center px-4 py-10">
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
                        defaultValue:
                          'Nothing needs your attention in this scope.',
                      })}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
