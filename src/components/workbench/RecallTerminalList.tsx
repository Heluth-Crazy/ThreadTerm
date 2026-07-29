import { Check, FolderGit2, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { worktreeDisplayLabel } from '../../lib/worktreePaths';
import type { TerminalCard } from '../../types/terminal';

interface RecallTerminalListProps {
  cards: readonly TerminalCard[];
  followedCardIds: ReadonlySet<string>;
  selectedCardIds: ReadonlySet<string>;
  onToggleCard: (cardId: string) => void;
}

export function RecallTerminalList({
  cards,
  followedCardIds,
  selectedCardIds,
  onToggleCard,
}: RecallTerminalListProps) {
  const { t } = useTranslation('terminal');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {cards.length > 0 ? (
        <div className="space-y-1">
          {cards.map((card) => {
            const alreadyFollowed = followedCardIds.has(card.id);
            const selected = selectedCardIds.has(card.id);
            return (
              <label
                key={card.id}
                className={[
                  'flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5',
                  alreadyFollowed
                    ? 'cursor-not-allowed border-transparent bg-muted/35 opacity-65'
                    : 'cursor-pointer border-border/70 hover:border-primary/25 hover:bg-card',
                  selected ? 'border-primary/40 bg-primary/[0.06]' : '',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={alreadyFollowed || selected}
                  disabled={alreadyFollowed}
                  onChange={() => onToggleCard(card.id)}
                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                />
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-foreground/[0.05] text-muted-foreground">
                  <SquareTerminal className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <strong className="truncate text-xs">
                      {card.projectName}
                    </strong>
                    <span className="shrink-0 rounded bg-foreground/[0.05] px-1 py-px font-mono text-[10px] text-muted-foreground">
                      {card.terminalType}
                    </span>
                  </span>
                  <small className="block truncate text-[11px] text-muted-foreground">
                    {worktreeDisplayLabel(card)} ·{' '}
                    {(card.lastReplyPreview || card.lastOutput)
                      .replace(/\s+/g, ' ')
                      .trim() ||
                      t(`status.${card.status}`, {
                        defaultValue: card.status,
                      })}
                  </small>
                </span>
                {alreadyFollowed && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary">
                    <Check className="h-3 w-3" />
                    {t('workbench.recall.alreadyFollowed', {
                      defaultValue: 'Already followed',
                    })}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center text-center text-muted-foreground">
          <FolderGit2 className="h-6 w-6 opacity-60" />
          <strong className="mt-2 text-xs text-foreground">
            {t('workbench.recall.emptyTitle', {
              defaultValue: 'No matching active terminals',
            })}
          </strong>
          <p className="mt-1 text-[11px]">
            {t('workbench.recall.emptyBody', {
              defaultValue: 'Try another search or scope.',
            })}
          </p>
        </div>
      )}
    </div>
  );
}
