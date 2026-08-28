import { Bookmark, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import { FollowedTerminalRow } from './FollowedTerminalSection';

interface FollowedTerminalsDialogProps {
  open: boolean;
  cards: readonly TerminalCard[];
  now: number;
  onClose: () => void;
  onOpenTerminal: (cardId: string) => void;
  onUnfollowCard: (cardId: string) => void;
  onOpenRecall: () => void;
}

export function FollowedTerminalsDialog({
  open,
  cards,
  now,
  onClose,
  onOpenTerminal,
  onUnfollowCard,
  onOpenRecall,
}: FollowedTerminalsDialogProps) {
  const { t } = useTranslation('terminal');
  const priorFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement as HTMLElement | null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      priorFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label={t('workbench.followed.title', {
          defaultValue: 'Followed terminals',
        })}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-background/60 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="followed-terminals-dialog-title"
          className="pointer-events-auto flex h-[min(560px,calc(100vh-32px))] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-background text-card-foreground shadow-2xl"
        >
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-info/10 text-info">
              <Bookmark className="h-4 w-4" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <h2
                id="followed-terminals-dialog-title"
                className="text-sm font-semibold"
              >
                {t('workbench.followed.title', {
                  defaultValue: 'Followed terminals',
                })}
              </h2>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {cards.length}
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

          {cards.length > 0 ? (
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
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
            <div className="grid flex-1 place-items-center px-4 py-10">
              <div className="text-center">
                <span className="mx-auto grid h-8 w-8 place-items-center rounded-md bg-info/10 text-info">
                  <Bookmark className="h-4 w-4" />
                </span>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t('workbench.followed.empty', {
                    defaultValue:
                      'Keep frequently used terminals here, even after you view them.',
                  })}
                </p>
              </div>
            </div>
          )}

          <div className="shrink-0 border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={onOpenRecall}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent/40 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('workbench.followed.recall', { defaultValue: 'Recall terminals' })}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

interface TerminalsListDialogProps {
  open: boolean;
  cards: readonly TerminalCard[];
  now: number;
  onClose: () => void;
  onOpenTerminal: (cardId: string) => void;
}

export function TerminalsListDialog({
  open,
  cards,
  now,
  onClose,
  onOpenTerminal,
}: TerminalsListDialogProps) {
  const { t } = useTranslation('terminal');
  const priorFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement as HTMLElement | null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      priorFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label={t('sidebar.allTerminals', { defaultValue: 'All terminals' })}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-background/60 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="terminals-list-dialog-title"
          className="pointer-events-auto flex h-[min(560px,calc(100vh-32px))] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-background text-card-foreground shadow-2xl"
        >
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <SquareTerminal className="h-4 w-4" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <h2
                id="terminals-list-dialog-title"
                className="text-sm font-semibold"
              >
                {t('sidebar.allTerminals', { defaultValue: 'All terminals' })}
              </h2>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {cards.length}
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

          {cards.length > 0 ? (
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
              {cards.map((card) => (
                <FollowedTerminalRow
                  key={card.id}
                  card={card}
                  now={now}
                  onOpenTerminal={onOpenTerminal}
                />
              ))}
            </div>
          ) : (
            <div className="grid flex-1 place-items-center px-4 py-10">
              <div className="text-center">
                <span className="mx-auto grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                  <SquareTerminal className="h-4 w-4" />
                </span>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t('workbench.stats.noTerminals', {
                    defaultValue: 'No terminals in this scope.',
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
