/**
 * CardGrid — responsive grid of TerminalCards.
 *
 * Behaviour:
 *   • single-click focuses a card (lightweight preview in panels)
 *   • double-click opens the card in the full-screen view (TerminalView)
 *   • empty state invites the user to create the first terminal
 *   • always includes a "+ new terminal" tile at the end
 */
import { useCallback } from 'react';
import { motion } from 'framer-motion';
import { Plus, TerminalSquare } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { isTauriEnv } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalCardComponent } from './TerminalCard';

interface CardGridProps {
  onCreateTerminal?: () => void;
  onOpenTerminal?: (cardId: string) => void;
}

const container = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
};

const item = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
};

export function CardGrid({ onCreateTerminal, onOpenTerminal }: CardGridProps) {
  const cards = useTerminalStore((s) => s.cards);
  const focusedCardId = useTerminalStore((s) => s.focusedCardId);
  const focusCard = useTerminalStore((s) => s.focusCard);
  const removeCard = useTerminalStore((s) => s.removeCard);

  const handleCopyCwd = useCallback((path: string) => {
    void navigator.clipboard?.writeText(path).catch(() => {
      /* ignore */
    });
  }, []);

  const handleOpenDir = useCallback((path: string) => {
    if (!isTauriEnv()) return;
    shellOpen(path).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[CardGrid] Failed to open directory:', err);
    });
  }, []);

  if (cards.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex h-full w-full flex-col items-center justify-center gap-6 p-8"
      >
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted">
          <TerminalSquare className="h-10 w-10 text-muted-foreground" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold">No terminals yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Create your first terminal. Each one is bound to a project directory and can
            run a shell, Claude, Codex, or any command you like.
          </p>
        </div>
        <button
          type="button"
          onClick={onCreateTerminal}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New terminal
        </button>
        <p className="text-[11px] text-muted-foreground/70">
          Tip — press <kbd className="rounded border border-border px-1">Ctrl</kbd>
          {' '}
          +
          {' '}
          <kbd className="rounded border border-border px-1">N</kbd>
          {' '}to create one.
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="visible"
      className="grid h-full auto-rows-max grid-cols-1 gap-3 overflow-auto p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {cards.map((card) => (
        <motion.div key={card.id} variants={item}>
          <TerminalCardComponent
            card={card}
            isFocused={card.id === focusedCardId}
            onClick={() => focusCard(card.id)}
            onDoubleClick={() => onOpenTerminal?.(card.id)}
            onClose={() => removeCard(card.id)}
            onCopyCwd={() => handleCopyCwd(card.projectPath)}
            onOpenDir={() => handleOpenDir(card.projectPath)}
          />
        </motion.div>
      ))}

      {/* Add new tile */}
      <motion.button
        variants={item}
        type="button"
        onClick={onCreateTerminal}
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.98 }}
        className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary/60 hover:bg-accent/30 hover:text-primary"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Plus className="h-6 w-6" />
        </div>
        <span className="text-sm font-medium">New terminal</span>
        <span className="text-[10px] text-muted-foreground/70">Ctrl + N</span>
      </motion.button>
    </motion.div>
  );
}
