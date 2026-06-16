/**
 * CardGrid — responsive grid of TerminalCards.
 *
 * Behaviour:
 *   • single-click focuses a card (lightweight preview in panels)
 *   • double-click opens the card in the full-screen view (TerminalView)
 *   • empty state invites the user to create the first terminal
 *   • always includes a "+ new terminal" tile at the end
 */
import { useCallback, useMemo, type CSSProperties } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FolderOpen, GripVertical, Plus, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'framer-motion';
import { isTauriEnv } from '../../lib/tauri-bridge';
import { openLocalDirectory } from '../../lib/localDirectory';
import { compareCardsByActivity, orderCardsByIdList } from '../../lib/cardSort';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalCardComponent } from './TerminalCard';
import type { TerminalCard } from '../../types/terminal';

interface CardGridProps {
  onCreateTerminal?: () => void;
  onOpenTerminal?: (cardId: string) => void;
}

export function CardGrid({ onCreateTerminal, onOpenTerminal }: CardGridProps) {
  const { t } = useTranslation('terminal');
  const reduceMotion = useReducedMotion();
  const cards = useTerminalStore((s) => s.cards);
  const projectCardOrder = useTerminalStore((s) => s.projectCardOrder);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const removeCard = useTerminalStore((s) => s.removeCard);
  const archiveCard = useTerminalStore((s) => s.archiveCard);
  const moveProjectCard = useTerminalStore((s) => s.moveProjectCard);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);
  const selectProject = useTerminalStore((s) => s.selectProject);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // All terminals keeps the shared "activity first" order. A selected project
  // switches to persisted manual order so cards do not jump while the user is
  // working inside one directory.
  const visibleCards = useMemo(() => {
    const filtered = selectedProjectPath
      ? cards.filter((c) => c.projectPath === selectedProjectPath)
      : cards;
    if (selectedProjectPath) {
      return orderCardsByIdList(filtered, projectCardOrder[selectedProjectPath]);
    }
    return [...filtered].sort(compareCardsByActivity);
  }, [cards, projectCardOrder, selectedProjectPath]);

  const visibleCardIds = useMemo(() => visibleCards.map((card) => card.id), [visibleCards]);
  const sortingEnabled = Boolean(selectedProjectPath);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!selectedProjectPath) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const toIndex = visibleCards.findIndex((card) => card.id === over.id);
      if (toIndex === -1) return;
      moveProjectCard(selectedProjectPath, String(active.id), toIndex);
    },
    [moveProjectCard, selectedProjectPath, visibleCards],
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
  if (cards.length === 0 && !selectedProjectPath) {
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

  const cardTiles = (
    <>
      {visibleCards.map((card) => (
        <CardTile
          key={card.id}
          card={card}
          sortingEnabled={sortingEnabled}
          dragLabel={t('grid.reorderCard', { defaultValue: 'Drag to reorder card' })}
          isFocused={focusedCardId === card.id}
          onClick={() => onOpenTerminal?.(card.id)}
          onClose={() => removeCard(card.id)}
          onArchive={() => archiveCard(card.id)}
        />
      ))}

      {/* New Terminal Placeholder */}
      <motion.button
        type="button"
        onClick={onCreateTerminal}
        whileHover={reduceMotion ? undefined : { y: -2, scale: 1.003 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: 'easeOut' }}
        className="group relative flex h-[300px] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-[var(--radius)] border border-dashed border-white/10 bg-white/[0.02] text-muted-foreground transition-all duration-300 hover:border-primary/40 hover:bg-white/[0.05] hover:text-primary sm:w-[calc(50%-12px)] lg:w-[calc(33.333%-16px)] xl:w-[calc(25%-18px)] glass-reflection"
      >
        <div className="absolute inset-0 bg-grid opacity-[0.03] pointer-events-none" />
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/5 border border-primary/10 transition-transform duration-500 group-hover:scale-110 group-hover:bg-primary/10">
          <Plus className="h-6 w-6" />
        </div>
        <div className="text-center">
          <div className="text-sm font-semibold tracking-tight">{t('app.newTerminal')}</div>
          <div className="mt-1 text-[10px] opacity-60 font-mono">⌘/Ctrl + N</div>
        </div>
      </motion.button>
    </>
  );

  return (
    <div className="flex h-full w-full flex-wrap content-start items-stretch gap-6 overflow-y-auto p-6 md:p-8">
      {sortingEnabled ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleCardIds} strategy={rectSortingStrategy}>
            {cardTiles}
          </SortableContext>
        </DndContext>
      ) : (
        cardTiles
      )}
    </div>
  );
}

const CARD_TILE_CLASS =
  'relative h-[300px] w-full sm:w-[calc(50%-12px)] lg:w-[calc(33.333%-16px)] xl:w-[calc(25%-18px)]';

function CardTile({
  card,
  dragLabel,
  isFocused,
  onClick,
  onClose,
  onArchive,
  sortingEnabled,
}: {
  card: TerminalCard;
  dragLabel: string;
  isFocused: boolean;
  onClick: () => void;
  onClose: () => void;
  onArchive: () => void;
  sortingEnabled: boolean;
}) {
  if (!sortingEnabled) {
    return (
      <div className={CARD_TILE_CLASS}>
        <TerminalCardComponent
          card={card}
          isFocused={isFocused}
          onClick={onClick}
          onClose={onClose}
          onArchive={onArchive}
        />
      </div>
    );
  }

  return (
    <SortableCardTile
      card={card}
      dragLabel={dragLabel}
      isFocused={isFocused}
      onClick={onClick}
      onClose={onClose}
      onArchive={onArchive}
    />
  );
}

function SortableCardTile({
  card,
  dragLabel,
  isFocused,
  onClick,
  onClose,
  onArchive,
}: {
  card: TerminalCard;
  dragLabel: string;
  isFocused: boolean;
  onClick: () => void;
  onClose: () => void;
  onArchive: () => void;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: card.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.86 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className={CARD_TILE_CLASS}>
      <TerminalCardComponent
        card={card}
        isFocused={isFocused}
        onClick={onClick}
        onClose={onClose}
        onArchive={onArchive}
        dragHandle={
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={`${dragLabel}: ${card.projectName}`}
            title={dragLabel}
            className="inline-flex h-7 w-5 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground active:scale-95 active:bg-accent"
            onClick={(event) => event.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
}
