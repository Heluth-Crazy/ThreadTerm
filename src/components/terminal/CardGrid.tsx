/**
 * CardGrid — responsive grid of TerminalCards.
 *
 * Behaviour:
 *   • single-click focuses a card (lightweight preview in panels)
 *   • double-click opens the card in the full-screen view (TerminalView)
 *   • empty state invites the user to create the first terminal
 *   • always includes a "+ new terminal" tile at the end
 */
import { useCallback, useMemo } from 'react';
import { FolderOpen, Plus, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauriEnv } from '../../lib/tauri-bridge';
import { openLocalDirectory } from '../../lib/localDirectory';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalCardComponent } from './TerminalCard';

interface CardGridProps {
  onCreateTerminal?: () => void;
  onOpenTerminal?: (cardId: string) => void;
}

export function CardGrid({ onCreateTerminal, onOpenTerminal }: CardGridProps) {
  const { t } = useTranslation('terminal');
  const cards = useTerminalStore((s) => s.cards);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const removeCard = useTerminalStore((s) => s.removeCard);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);
  const selectProject = useTerminalStore((s) => s.selectProject);

  const visibleCards = useMemo(
    () =>
      selectedProjectPath
        ? cards.filter((c) => c.projectPath === selectedProjectPath)
        : cards,
    [cards, selectedProjectPath],
  );

  const selectedProjectLabel = useMemo(() => {
    if (!selectedProjectPath) return null;
    const c = cards.find((x) => x.projectPath === selectedProjectPath);
    return c?.projectName ?? selectedProjectPath;
  }, [cards, selectedProjectPath]);

  const handleCopyCwd = useCallback((path: string) => {
    void navigator.clipboard?.writeText(path).catch(() => {
      /* ignore */
    });
  }, []);

  const handleOpenDir = useCallback((path: string) => {
    if (!isTauriEnv()) return;
    openLocalDirectory(path).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[CardGrid] Failed to open directory:', err);
    });
  }, []);

  // No cards at all → onboarding empty state.
  if (cards.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-6 p-8">
        <div className="flex h-20 w-20 items-center justify-center rounded-[var(--radius)] bg-muted">
          <TerminalSquare className="h-10 w-10 text-muted-foreground" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold">{t('grid.emptyTitle')}</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {t('grid.emptyDescription')}
          </p>
        </div>
        <button
          type="button"
          onClick={onCreateTerminal}
          className="inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> {t('grid.createFirst')}
        </button>
        <p className="text-[11px] text-muted-foreground/70">
          {t('grid.tipPrefix')} <kbd className="rounded border border-white/10 px-1">⌘/Ctrl</kbd>
          {' '}
          +
          {' '}
          <kbd className="rounded border border-white/10 px-1">N</kbd>
          {' '}{t('grid.tipSuffix')}
        </p>
      </div>
    );
  }

  // A project is selected but has no matching cards (shouldn't normally
  // happen because removeCard clears the filter, but render a clean state
  // anyway if the user filtered and then somehow all disappear).
  if (visibleCards.length === 0 && selectedProjectPath) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-[var(--radius)] bg-muted">
          <FolderOpen className="h-7 w-7 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">
            {t('grid.noProjectTitle', { project: selectedProjectLabel })}
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('grid.noProjectDescription')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCreateTerminal}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> {t('grid.newHere')}
          </button>
          <button
            type="button"
            onClick={() => selectProject(null)}
            className="rounded-[var(--radius-md)] border border-white/10 px-3 py-1.5 text-xs hover:bg-accent"
          >
            {t('grid.showAll')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full auto-rows-[260px] grid-cols-1 items-start gap-3 overflow-auto p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {visibleCards.map((card) => (
        <div key={card.id} className="h-full self-start">
          <TerminalCardComponent
            card={card}
            isFocused={card.id === focusedCardId}
            onClick={() => focusCard(card.id)}
            onDoubleClick={() => onOpenTerminal?.(card.id)}
            onClose={() => removeCard(card.id)}
            onCopyCwd={() => handleCopyCwd(card.projectPath)}
            onOpenDir={() => handleOpenDir(card.projectPath)}
          />
        </div>
      ))}

      {/* Add new tile */}
      <button
        type="button"
        onClick={onCreateTerminal}
        className="flex h-full flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-dashed border-white/10 text-muted-foreground hover:border-primary/60 hover:bg-accent/30 hover:text-primary"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Plus className="h-6 w-6" />
        </div>
        <span className="text-sm font-medium">{t('app.newTerminal')}</span>
        <span className="text-[10px] text-muted-foreground/70">⌘/Ctrl + N</span>
      </button>
    </div>
  );
}
