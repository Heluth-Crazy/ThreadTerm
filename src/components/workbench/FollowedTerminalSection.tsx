import {
  Bookmark,
  ChevronDown,
  ChevronUp,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { worktreeDisplayLabel } from '../../lib/worktreePaths';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { EditableCardName } from '../terminal/EditableCardName';
import { relativeTime } from './workbenchFormatting';

interface FollowedTerminalSectionProps {
  cards: readonly TerminalCard[];
  totalCount: number;
  now: number;
  queryActive: boolean;
  className?: string;
  onOpenTerminal: (cardId: string) => void;
  onUnfollowCard: (cardId: string) => void;
  onOpenRecall: () => void;
}

export function FollowedTerminalSection({
  cards,
  totalCount,
  now,
  queryActive,
  className = 'mt-5',
  onOpenTerminal,
  onUnfollowCard,
  onOpenRecall,
}: FollowedTerminalSectionProps) {
  const { t, i18n } = useTranslation('terminal');
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const renameCard = useTerminalStore((s) => s.renameCard);

  return (
    <section aria-labelledby="workbench-followed-heading" className={className}>
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <Bookmark className="h-3.5 w-3.5 shrink-0 text-primary" />
        <h2 id="workbench-followed-heading" className="text-[13px] font-semibold">
          {t('workbench.followed.title', { defaultValue: 'Followed terminals' })}
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {totalCount}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenRecall}
            title={t('workbench.followed.recall', { defaultValue: 'Recall terminals' })}
            aria-label={t('workbench.followed.recall', { defaultValue: 'Recall terminals' })}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card/70 px-2 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            <span className="xl:hidden">
              {t('workbench.followed.recall', { defaultValue: 'Recall terminals' })}
            </span>
          </button>
          {cards.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              title={
                expanded
                  ? t('workbench.followed.collapse', { defaultValue: 'Collapse' })
                  : t('workbench.followed.expand', { defaultValue: 'Show all' })
              }
              className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card/70 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {cards.length > 0 ? (
        <div
          className={
            expanded
              ? 'flex flex-wrap gap-2'
              : 'flex gap-2 overflow-x-auto pb-1'
          }
        >
          {cards.map((card) => {
            const preview = followedPreview(card);
            return (
              <article
                key={card.id}
                className="group flex w-[248px] shrink-0 items-stretch overflow-hidden rounded-lg border border-border bg-card/75 transition-colors hover:border-primary/30 hover:bg-card"
              >
                <button
                  type="button"
                  onClick={() => onOpenTerminal(card.id)}
                  aria-label={t('workbench.followed.openTerminal', {
                    name: card.projectName,
                    defaultValue: 'Open {{name}} terminal',
                  })}
                  className="min-w-0 flex-1 px-3 py-2 text-left"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-primary" />
                    {/* Same interaction as the terminal card header: the name
                        owns its click region — single click is stopped so it
                        doesn't open the terminal, double-click enters rename. */}
                    <span
                      className="flex min-w-0 flex-1 items-center"
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        if (editingId !== card.id) setEditingId(card.id);
                      }}
                      title={
                        editingId === card.id
                          ? undefined
                          : t('card.renameHint', { defaultValue: 'Double-click to rename' })
                      }
                    >
                      <EditableCardName
                        value={card.projectName}
                        editing={editingId === card.id}
                        onCommit={(name) => {
                          renameCard(card.id, name);
                          setEditingId(null);
                        }}
                        onCancel={() => setEditingId(null)}
                        ariaLabel={t('card.rename', { defaultValue: 'Rename card' })}
                        className="min-w-0 flex-1 truncate text-xs font-bold"
                      />
                    </span>
                    <span
                      className={[
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        statusDotClass(card.status),
                      ].join(' ')}
                    />
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="truncate">{worktreeDisplayLabel(card)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0 font-mono">{card.terminalType}</span>
                  </span>
                  <span className="mt-1.5 flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/75">
                      {preview ||
                        t(`status.${card.status}`, {
                          defaultValue: card.status,
                        })}
                    </span>
                    <time className="shrink-0 text-[11px] text-muted-foreground/75">
                      {relativeTime(card.lastActivity, now, i18n.language)}
                    </time>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onUnfollowCard(card.id)}
                  title={t('workbench.followed.remove', {
                    defaultValue: 'Remove from Workbench',
                  })}
                  aria-label={t('workbench.followed.removeNamed', {
                    name: card.projectName,
                    defaultValue: 'Remove {{name}} from Workbench',
                  })}
                  className="grid w-8 shrink-0 place-items-center border-l border-border/70 text-muted-foreground opacity-70 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpenRecall}
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/30 px-4 text-[11px] text-muted-foreground hover:border-primary/30 hover:bg-card/45 hover:text-foreground"
        >
          <Bookmark className="h-4 w-4" />
          {queryActive && totalCount > 0
            ? t('workbench.followed.noSearchResults', {
                defaultValue: 'No followed terminals match this search.',
              })
            : t('workbench.followed.empty', {
                defaultValue:
                  'Keep frequently used terminals here, even after you view them.',
              })}
        </button>
      )}
    </section>
  );
}

function followedPreview(card: TerminalCard): string {
  return (card.lastReplyPreview || card.lastOutput)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function statusDotClass(status: TerminalCard['status']): string {
  switch (status) {
    case 'running':
      return 'bg-success';
    case 'waiting':
      return 'bg-warning';
    case 'completed':
      return 'bg-info';
    case 'failed':
      return 'bg-destructive';
    case 'idle':
      return 'bg-muted-foreground/60';
  }
}
