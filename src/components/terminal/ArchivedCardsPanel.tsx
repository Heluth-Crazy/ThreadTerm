import { Archive, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ArchivedTerminalCard } from '../../stores/terminalStore';
import { getTerminalTypeMeta } from './terminalTypeMeta';

export interface ArchivedCardsPanelProps {
  projectName: string;
  cards: ArchivedTerminalCard[];
  onRestore: (cardId: string) => void;
  onClose: () => void;
}

function formatArchivedAt(value: number): string {
  return new Date(value).toLocaleString();
}

export function ArchivedCardsPanel({
  projectName,
  cards,
  onRestore,
  onClose,
}: ArchivedCardsPanelProps) {
  const { t } = useTranslation('terminal');
  const closeLabel = t('common.close', { defaultValue: 'Close' });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-15 shrink-0 items-center gap-1.5 border-b border-border px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Archive className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate">
          {t('archive.title', { project: projectName, count: cards.length })}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {cards.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
          {t('archive.empty')}
        </div>
      ) : (
        <ul className="flex-1 space-y-1 overflow-y-auto p-1.5">
          {cards.map((card) => {
            const typeMeta = getTerminalTypeMeta(card.terminalType);
            const TypeIcon = typeMeta.Icon;
            return (
              <li
                key={card.id}
                className="rounded-md border border-border bg-muted/50 px-2 py-2"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <div
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted ${typeMeta.accent}`}
                  >
                    <TypeIcon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{card.projectName}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {t(`types.${card.terminalType}`, typeMeta.label)}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground" title={card.worktreePath ?? card.projectPath}>
                      {card.worktreePath ?? card.projectPath}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                      {t('archive.archivedAt', { time: formatArchivedAt(card.archivedAt) })}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRestore(card.id)}
                  className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent hover:text-accent-foreground"
                >
                  <RotateCcw className="h-3 w-3" />
                  {t('archive.restore')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
