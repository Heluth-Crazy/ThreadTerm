import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { pathBasename, worktreeDisplayLabel } from '../../lib/worktreePaths';
import type { TerminalCard } from '../../types/terminal';
import { CardStatusBadge } from './CardStatusBadge';
import { getTerminalTypeMeta } from './terminalTypeMeta';

export interface SessionDockProps {
  visible: boolean;
  pinned: boolean;
  variant?: 'overlay' | 'panel';
  onClose: () => void;
  onHoverChange: (hovered: boolean) => void;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

function formatRelative(
  at: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const d = Date.now() - at;
  if (d < 60_000) return t('card.justNow');
  return t('card.ago', { time: formatDuration(d) });
}

function orderedRecentCards(cards: TerminalCard[], recentIds: string[]): TerminalCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return recentIds.map((id) => byId.get(id)).filter((card): card is TerminalCard => Boolean(card));
}

/**
 * Short branch/worktree chip that disambiguates same-project cards in the list.
 * Null when it would only repeat the project name (i.e. the main worktree).
 */
function worktreeChip(card: TerminalCard): string | null {
  const label = worktreeDisplayLabel(card);
  return label && label !== card.projectName ? label : null;
}

export function SessionDock({
  visible,
  pinned,
  variant = 'overlay',
  onClose,
  onHoverChange,
}: SessionDockProps) {
  const { t } = useTranslation('terminal');
  const cards = useTerminalStore((s) => s.cards);
  const recentIds = useTerminalStore((s) => s.recentlyViewedCardIds);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);

  const recentCards = useMemo(() => orderedRecentCards(cards, recentIds), [cards, recentIds]);

  // Relative timestamps ("3m ago") are computed at render; without this tick the
  // pinned dock would freeze them. Re-render every 30s while the dock is visible.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [visible]);

  const handleSelect = (cardId: string) => {
    focusCard(cardId);
    if (!pinned) onHoverChange(false);
  };

  return (
    <section
      aria-hidden={!visible}
      data-testid="session-dock"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      className={[
        'flex flex-col bg-background/95 shadow-studio backdrop-blur-2xl transition-all duration-150 ease-out',
        variant === 'panel'
          ? 'relative h-full w-full'
          : 'absolute bottom-0 right-0 top-0 z-[35] w-64 border-l border-white/10',
        visible
          ? 'translate-x-0 opacity-100 pointer-events-auto'
          : 'translate-x-full opacity-0 pointer-events-none',
      ].join(' ')}
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-white/10 px-3 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold text-foreground">{t('dock.title')}</h2>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {t('dock.shortcut')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('dock.close')}
          aria-label={t('dock.close')}
          className="rounded-[var(--radius-sm)] p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {recentCards.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          {t('dock.empty')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div className="space-y-1">
            {recentCards.map((card) => {
              const typeMeta = getTerminalTypeMeta(card.terminalType);
              const TypeIcon = typeMeta.Icon;
              const isCurrent = card.id === focusedCardId;
              const chip = worktreeChip(card);
              return (
                <button
                  key={card.id}
                  type="button"
                  data-testid={`session-dock-row-${card.id}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={() => handleSelect(card.id)}
                  className={[
                    'w-full rounded-[var(--radius-md)] border px-2 py-2 text-left transition-colors',
                    isCurrent
                      ? 'border-primary/35 bg-primary/10'
                      : 'border-transparent hover:border-white/10 hover:bg-accent/70',
                  ].join(' ')}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <TypeIcon className={`h-3.5 w-3.5 shrink-0 ${typeMeta.accent}`} />
                      <span className="min-w-0 truncate text-xs font-medium text-foreground">
                        {card.projectName}
                      </span>
                      {chip && (
                        <span className="max-w-[45%] shrink-0 truncate rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground">
                          {chip}
                        </span>
                      )}
                    </div>
                    {isCurrent && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                        {t('dock.current')}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-muted-foreground">
                      {t(`types.${card.terminalType}`, typeMeta.label)}
                    </span>
                    <CardStatusBadge status={card.status} />
                  </div>

                  <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span className="truncate">{pathBasename(card.projectPath)}</span>
                    <span className="shrink-0">{formatRelative(card.lastActivity, t)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
