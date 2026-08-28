import {
  Bookmark,
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
  const { t } = useTranslation('terminal');

  return (
    <section
      aria-labelledby="workbench-followed-heading"
      className={[
        'flex min-h-0 flex-col rounded-xl border border-border/70 bg-card/50',
        className,
      ].join(' ')}
    >
      <div className="flex h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-3.5">
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
        </div>
      </div>

      {cards.length > 0 ? (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5">
          {cards.map((card) => (
            <FollowedTerminalRow
              key={card.id}
              card={card}
              now={now}
              onOpenTerminal={onOpenTerminal}
              onUnfollowCard={onUnfollowCard}
            />
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpenRecall}
          className="group/empty grid flex-1 place-items-center px-4 py-8"
        >
          <span className="text-center">
            <span className="mx-auto grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Bookmark className="h-4 w-4" />
            </span>
            <span className="mt-2 block text-[11px] text-muted-foreground transition-colors group-hover/empty:text-foreground">
              {queryActive && totalCount > 0
                ? t('workbench.followed.noSearchResults', {
                    defaultValue: 'No followed terminals match this search.',
                  })
                : t('workbench.followed.empty', {
                    defaultValue:
                      'Keep frequently used terminals here, even after you view them.',
                  })}
            </span>
          </span>
        </button>
      )}
    </section>
  );
}

interface FollowedTerminalRowProps {
  card: TerminalCard;
  now: number;
  onOpenTerminal: (cardId: string) => void;
  onUnfollowCard?: (cardId: string) => void;
}

export function FollowedTerminalRow({
  card,
  now,
  onOpenTerminal,
  onUnfollowCard,
}: FollowedTerminalRowProps) {
  const { t, i18n } = useTranslation('terminal');
  const [editing, setEditing] = useState(false);
  const renameCard = useTerminalStore((s) => s.renameCard);
  const preview = followedPreview(card);
  const archivedAt = archivedTimestamp(card);
  const archived = archivedAt !== null;

  return (
    <article
      className="group flex items-stretch rounded-lg border border-border/60 bg-background/60 transition-colors hover:border-primary/30 hover:bg-accent/50"
    >
      <button
        type="button"
        onClick={() => onOpenTerminal(card.id)}
        aria-label={t('workbench.followed.openTerminal', {
          name: card.projectName,
          defaultValue: 'Open {{name}} terminal',
        })}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* Same interaction as the terminal card header: the name
                owns its click region — single click is stopped so it
                doesn't open the terminal, double-click enters rename. */}
            <span
              className="flex min-w-0 flex-1 items-center"
              onClick={archived ? undefined : (event) => event.stopPropagation()}
              onDoubleClick={
                archived
                  ? undefined
                  : (event) => {
                      event.stopPropagation();
                      if (!editing) setEditing(true);
                    }
              }
              title={
                editing || archived
                  ? undefined
                  : t('card.renameHint', { defaultValue: 'Double-click to rename' })
              }
            >
              <EditableCardName
                value={card.projectName}
                editing={editing}
                onCommit={(name) => {
                  renameCard(card.id, name);
                  setEditing(false);
                }}
                onCancel={() => setEditing(false)}
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
            <span className="shrink-0">{worktreeDisplayLabel(card)}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 font-mono">{card.terminalType}</span>
            {archived && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">
                  {t('workbench.followed.closed', { defaultValue: 'Closed' })}
                </span>
              </>
            )}
            {preview && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 flex-1 truncate text-foreground/60">
                  {preview}
                </span>
              </>
            )}
          </span>
        </span>
        <time className="shrink-0 self-start pt-0.5 text-[11px] text-muted-foreground/75">
          {relativeTime(archivedAt ?? card.lastActivity, now, i18n.language)}
        </time>
      </button>
      {onUnfollowCard && (
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
          className="grid w-8 shrink-0 place-items-center border-l border-border/60 text-muted-foreground opacity-70 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </article>
  );
}

function archivedTimestamp(card: TerminalCard): number | null {
  if (!('archivedAt' in card)) return null;
  const value = card.archivedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
