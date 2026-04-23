/**
 * TerminalManager — top-level container for the terminal surface.
 *
 * Responsibilities:
 *   • render either the card grid or the focused terminal (full-screen)
 *   • host the create dialog
 *   • expose a small imperative API on `window.__terminalManager` for the
 *     KeyboardBridge / headless tests to trigger the create flow
 *
 * The actual keyboard shortcuts and radial switcher live in their own
 * sibling components so this file stays focused on view composition.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, BellDot, Plus } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { CardGrid } from './CardGrid';
import { TerminalView } from './TerminalView';
import { CreateTerminalDialog } from './CreateTerminalDialog';
import type { TerminalCreateOptions } from '../../types/terminal';

type ViewMode = 'grid' | 'focus';

declare global {
  interface Window {
    __terminalManager?: {
      openCreate: () => void;
      closeCreate: () => void;
      focusMode: (mode: ViewMode) => void;
    };
  }
}

export function TerminalManager() {
  const cards = useTerminalStore((s) => s.cards);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const createCard = useTerminalStore((s) => s.createCard);
  const toggleNotificationCentre = useTerminalStore((s) => s.toggleNotificationCentre);
  const unreadCount = useTerminalStore((s) => s.notifications.filter((n) => !n.read).length);

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [createOpen, setCreateOpen] = useState(false);

  const focusedCard = useMemo(
    () => (focusedCardId ? cards.find((c) => c.id === focusedCardId) : undefined),
    [focusedCardId, cards],
  );

  // Automatically enter focus mode when a card is focused, back to grid when cleared.
  useEffect(() => {
    if (focusedCardId && focusedCard) {
      setViewMode('focus');
    } else {
      setViewMode('grid');
    }
  }, [focusedCardId, focusedCard]);

  const handleOpenTerminal = useCallback(
    (cardId: string) => {
      focusCard(cardId);
      setViewMode('focus');
    },
    [focusCard],
  );

  const handleBackToGrid = useCallback(() => {
    focusCard(null);
    setViewMode('grid');
  }, [focusCard]);

  const handleCreate = useCallback(
    (options: TerminalCreateOptions) => {
      const id = createCard(options);
      setCreateOpen(false);
      focusCard(id);
      setViewMode('focus');
    },
    [createCard, focusCard],
  );

  // Expose imperative API.
  useEffect(() => {
    window.__terminalManager = {
      openCreate: () => setCreateOpen(true),
      closeCreate: () => setCreateOpen(false),
      focusMode: (mode) => setViewMode(mode),
    };
    return () => {
      delete window.__terminalManager;
    };
  }, []);

  const recentProjects = useMemo(
    () => cards.map((c) => ({ path: c.projectPath, name: c.projectName })),
    [cards],
  );

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border bg-background/80 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold">Terminal Manager</div>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {cards.length} {cards.length === 1 ? 'terminal' : 'terminals'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            title="New terminal (Ctrl+N)"
            className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
          <button
            type="button"
            onClick={() => toggleNotificationCentre()}
            title="Notifications (Ctrl+B)"
            className="relative rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            {unreadCount > 0 ? (
              <BellDot className="h-4 w-4 text-amber-500" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {unreadCount > 0 && (
              <span className="absolute right-0.5 top-0.5 flex min-h-[14px] min-w-[14px] items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold text-white">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Main body */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {viewMode === 'grid' || !focusedCard ? (
            <motion.div
              key="grid"
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', damping: 26, stiffness: 280 }}
              className="absolute inset-0"
            >
              <CardGrid
                onCreateTerminal={() => setCreateOpen(true)}
                onOpenTerminal={handleOpenTerminal}
              />
            </motion.div>
          ) : (
            <motion.div
              key={`focus-${focusedCard.id}`}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ type: 'spring', damping: 26, stiffness: 280 }}
              className="absolute inset-0"
            >
              <TerminalView card={focusedCard} onBack={handleBackToGrid} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Shortcut hint */}
      {cards.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 select-none rounded-lg border border-border/60 bg-background/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur">
          <span className="font-mono">Ctrl+`</span> switch · <span className="font-mono">Ctrl+Tab</span> next ·{' '}
          <span className="font-mono">Ctrl+1-9</span> jump
        </div>
      )}

      {/* Create dialog */}
      <CreateTerminalDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        recentProjects={recentProjects}
      />
    </div>
  );
}
