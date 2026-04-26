/**
 * TerminalView — full-screen view for a single terminal card.
 *
 * Uses the existing Shell.jsx component in `isPlainShell` + `autoConnect`
 * mode, passing the card's PTY id so the main window and floating overlay
 * attach to the same Rust PTY session.
 *
 * Animations: shared `layoutId` with the card in the grid produces a
 * smooth expand/collapse transition courtesy of Framer Motion.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { ArrowLeft, MoreVertical, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Shell from '../Shell';
import type { TerminalCard } from '../../types/terminal';
import { useTerminalStore } from '../../stores/terminalStore';
import { getStatusMeta } from './statusMeta';
import { getTerminalTypeMeta } from './terminalTypeMeta';
import {
  AI_CLI_SESSION_BADGE_CLASS,
  buildTerminalLaunchCommand,
  getAiCliSessionBadge,
} from './providerSession';
import { useProviderSessionLifecycle } from './useProviderSessionLifecycle';

interface TerminalViewProps {
  card: TerminalCard;
  active?: boolean;
  onBack: () => void;
}

export function TerminalView({ card, active = true, onBack }: TerminalViewProps) {
  const { t } = useTranslation('terminal');
  const removeCard = useTerminalStore((s) => s.removeCard);
  const recordUserSubmit = useTerminalStore((s) => s.recordUserSubmit);
  const markCardRead = useTerminalStore((s) => s.markCardRead);

  // Note: no PTY guard is needed even when the float window also hosts
  // this card. Both windows share the same pty id and the
  // Rust backend makes pty_create idempotent, so both xterm instances
  // simply mirror the same session's output stream.

  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const statusInfo = getStatusMeta(card.status);
  const StatusIcon = statusInfo.Icon;
  const TypeIcon = typeMeta.Icon;
  const paneId = card.ptyId || card.id;
  const aiSessionBadge = useMemo(
    () => getAiCliSessionBadge(card),
    [
      card.command,
      card.lastOutput,
      card.providerSessionId,
      card.providerSessionState,
      card.terminalType,
    ],
  );

  // Treat the card's optional `command` as an initial command to execute
  // in the PTY right after spawn.
  const launch = useMemo(
    () => buildTerminalLaunchCommand(card, typeMeta.defaultCommand),
    [card, typeMeta.defaultCommand],
  );
  const initialCommand = launch.command;
  const onProviderInitialCommandSent = useProviderSessionLifecycle(card, launch, active);

  const recordSubmit = useCallback(() => {
    recordUserSubmit(card.id, t('view.sentInput'));
  }, [card.id, recordUserSubmit, t]);

  const handleInitialCommandSent = useCallback(() => {
    recordSubmit();
    onProviderInitialCommandSent();
  }, [onProviderInitialCommandSent, recordSubmit]);

  const selectedProject = useMemo(
    () => ({
      name: card.projectName,
      path: card.projectPath,
      fullPath: card.worktreePath || card.projectPath,
    }),
    [card.projectName, card.projectPath, card.worktreePath],
  );

  useEffect(() => {
    if (active && card.unread) {
      markCardRead(card.id);
    }
  }, [active, card.id, card.unread, markCardRead]);

  const handleClose = () => {
    removeCard(card.id);
    onBack();
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            title={t('view.backToGrid')}
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
              <span className="text-[10px] text-muted-foreground">
                · {t(`types.${card.terminalType}`, typeMeta.label)}
              </span>
            </div>
            <div className="truncate text-[10px] text-muted-foreground" title={card.projectPath}>
              {card.worktreePath ? t('view.worktree', { path: card.worktreePath }) : card.projectPath}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {aiSessionBadge && (
            <span
              title={t(aiSessionBadge.descriptionKey, {
                ...aiSessionBadge.values,
                defaultValue: aiSessionBadge.fallbackDescription,
              })}
              className={[
                'hidden max-w-[190px] items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none sm:inline-flex',
                AI_CLI_SESSION_BADGE_CLASS[aiSessionBadge.tone],
              ].join(' ')}
            >
              <span className="truncate">
                {t(aiSessionBadge.labelKey, {
                  ...aiSessionBadge.values,
                  defaultValue: aiSessionBadge.fallbackLabel,
                })}
              </span>
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusInfo.chip}`}
          >
            <StatusIcon className={`h-3 w-3 ${statusInfo.animate ? 'animate-spin' : ''}`} />
            {t(`status.${card.status}`, statusInfo.label)}
          </span>
          <div className="group relative">
            <button
              type="button"
              className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
              title={t('view.more')}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            <div className="absolute right-0 top-full z-10 mt-1 hidden w-44 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg group-hover:block">
              <button
                type="button"
                onClick={handleClose}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" /> {t('view.closeTerminal')}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onBack}
            title={t('view.close')}
            className="rounded-lg p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* xterm — always mounted; shares the PTY with the float window if present */}
      <div id={`terminal-shell-${card.id}`} className="flex-1 min-h-0 bg-[var(--terminal-background)]">
        <Shell
          selectedProject={selectedProject}
          initialCommand={initialCommand}
          minimal={true}
          autoConnect={true}
          paneId={paneId}
          active={active}
          preservePtyOnUnmount={true}
          replayRecentOutput={true}
          suppressInitialCommandWhenPtyExists={true}
          onInitialCommandSent={handleInitialCommandSent}
          onUserSubmit={recordSubmit}
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
          {t('view.footer', {
            count: card.messageCount,
            time: new Date(card.createdAt).toLocaleTimeString(),
          })}
        </span>
      </div>
    </div>
  );
}
