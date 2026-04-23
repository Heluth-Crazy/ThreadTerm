/**
 * TerminalView — full-screen view for a single terminal card.
 *
 * Uses the existing Shell.jsx component in `isPlainShell` + `autoConnect`
 * mode, passing `paneId={card.id}` so the PTY session id matches the card
 * id and our TerminalEventBridge can route events by the same key.
 *
 * Animations: shared `layoutId` with the card in the grid produces a
 * smooth expand/collapse transition courtesy of Framer Motion.
 */
import { useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, MoreVertical, Trash2, X } from 'lucide-react';
import Shell from '../Shell';
import type { TerminalCard } from '../../types/terminal';
import { useTerminalStore } from '../../stores/terminalStore';
import { getStatusMeta } from './statusMeta';
import { getTerminalTypeMeta } from './terminalTypeMeta';

interface TerminalViewProps {
  card: TerminalCard;
  onBack: () => void;
}

export function TerminalView({ card, onBack }: TerminalViewProps) {
  const removeCard = useTerminalStore((s) => s.removeCard);
  const appendEvent = useTerminalStore((s) => s.appendEvent);
  const incrementMessageCount = useTerminalStore((s) => s.incrementMessageCount);

  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const statusInfo = getStatusMeta(card.status);
  const StatusIcon = statusInfo.Icon;
  const TypeIcon = typeMeta.Icon;

  // Treat the card's optional `command` as an initial command to execute
  // in the PTY right after spawn.
  const initialCommand = useMemo(() => {
    if (card.command && card.command.trim().length > 0) return card.command.trim();
    const def = typeMeta.defaultCommand;
    return def && def.length > 0 ? def : undefined;
  }, [card.command, typeMeta.defaultCommand]);

  // Count keyboard input events as messages (rough heuristic). We hook into
  // the xterm instance via a data-* selector on the container.
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        incrementMessageCount(card.id);
        appendEvent(card.id, { kind: 'user-input', summary: 'sent input' });
      }
    };
    const el = document.getElementById(`terminal-shell-${card.id}`);
    if (!el) return;
    el.addEventListener('keydown', listener);
    return () => el.removeEventListener('keydown', listener);
  }, [card.id, appendEvent, incrementMessageCount]);

  const selectedProject = useMemo(
    () => ({
      name: card.projectName,
      path: card.projectPath,
      fullPath: card.worktreePath || card.projectPath,
    }),
    [card.projectName, card.projectPath, card.worktreePath],
  );

  const handleClose = () => {
    removeCard(card.id);
    onBack();
  };

  return (
    <motion.div
      layoutId={`terminal-card-${card.id}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'spring', damping: 28, stiffness: 320 }}
      className="flex h-full w-full flex-col bg-background"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            title="Back to grid (Esc)"
            className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-muted ${typeMeta.accent}`}>
            <TypeIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{card.projectName}</span>
              <span className="text-[10px] text-muted-foreground">· {typeMeta.label}</span>
            </div>
            <div className="truncate text-[10px] text-muted-foreground" title={card.projectPath}>
              {card.worktreePath ? `worktree: ${card.worktreePath}` : card.projectPath}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusInfo.chip}`}
          >
            <StatusIcon className={`h-3 w-3 ${statusInfo.animate ? 'animate-spin' : ''}`} />
            {statusInfo.label}
          </span>
          <div className="group relative">
            <button
              type="button"
              className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
              title="More"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            <div className="absolute right-0 top-full z-10 mt-1 hidden w-44 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg group-hover:block">
              <button
                type="button"
                onClick={handleClose}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" /> Close terminal
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onBack}
            title="Close (Esc)"
            className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* xterm */}
      <div id={`terminal-shell-${card.id}`} className="flex-1 min-h-0 bg-black">
        <Shell
          selectedProject={selectedProject}
          selectedSession={null}
          initialCommand={initialCommand}
          isPlainShell={true}
          minimal={true}
          autoConnect={true}
          paneId={card.id}
          onProcessComplete={undefined}
          onDisconnect={undefined}
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
        <span>
          id:&nbsp;<span className="font-mono">{card.id.slice(0, 10)}</span>
        </span>
        <span>
          {card.messageCount} msgs · created{' '}
          {new Date(card.createdAt).toLocaleTimeString()}
        </span>
      </div>
    </motion.div>
  );
}
