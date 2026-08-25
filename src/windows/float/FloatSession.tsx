/**
 * FloatSession — hosts the xterm Shell for a single card inside the float
 * window.
 *
 * Session-sharing policy:
 *   • The float reuses the card's original pty id (same as the main
 *     window's TerminalView). The Rust backend's `pty_create` is
 *     idempotent for already-bound ids: if the main window already
 *     spawned a PTY for this card, Rust kills the redundant new child
 *     and returns the existing session id. Both webviews then listen to
 *     the same `pty-output` broadcast, so the CLI state is preserved.
 *   • When the user swaps cards inside the float (A → B), React unmounts
 *     the previous Shell via the `key` prop; the main window keeps the
 *     PTY alive (mountedIdsRef), so nothing is lost.
 *   • `initialCommand` is suppressed on remount — the PTY is already
 *     running the user's CLI; re-typing the command would start a second
 *     instance inside the shell.
 *
 * Empty state: when no card id has been assigned yet we render a friendly
 * placeholder so the window isn't a blank rectangle.
 */
import { useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import Shell from '../../components/terminal/Shell';
import type { TerminalCard } from '../../types/terminal';
import { getTerminalTypeMeta } from '../../components/terminal/terminalTypeMeta';
import { useValidatedProviderSessionLaunch } from '../../components/terminal/useValidatedProviderSessionLaunch';
import { ProviderSessionLaunchPlaceholder } from '../../components/terminal/ProviderSessionLaunchPlaceholder';
import { useTerminalStore } from '../../stores/terminalStore';
import { buildProviderStartupIntent } from '../../components/terminal/providerStartup';

export interface FloatSessionProps {
  card: TerminalCard | null;
  active?: boolean;
}

export function FloatSession({ card, active = true }: FloatSessionProps) {
  const { t } = useTranslation('overlay');
  const selectedProject = useMemo(
    () =>
      card
        ? {
            name: card.projectName,
            path: card.projectPath,
            fullPath: card.worktreePath || card.projectPath,
          }
        : null,
    [card?.projectName, card?.projectPath, card?.worktreePath],
  );
  const typeMeta = card ? getTerminalTypeMeta(card.terminalType) : null;
  const {
    launch,
    status: providerSessionLaunchStatus,
    retry: retryProviderSessionLaunch,
  } = useValidatedProviderSessionLaunch(
    card,
    typeMeta?.defaultCommand,
  );
  const markCardRead = useTerminalStore((s) => s.markCardRead);
  const recordUserSubmit = useTerminalStore((s) => s.recordUserSubmit);

  useEffect(() => {
    if (card?.unread) {
      markCardRead(card.id);
    }
  }, [card?.id, card?.unread, markCardRead]);

  if (!card || !selectedProject) {
    return (
      <div
        className="flex flex-1 items-center justify-center bg-[var(--terminal-background)] p-8 text-center text-[var(--terminal-foreground)]"
      >
        <div className="max-w-sm space-y-2">
          <div className="text-sm font-semibold">
            {t('float.emptyTitle')}
          </div>
          <div className="text-xs opacity-70">
            <Trans
              i18nKey="float.emptyDescription"
              ns="overlay"
              values={{ shortcut: '⌘/Ctrl + Shift + Space' }}
              components={{
                kbd: <kbd className="rounded border border-border bg-muted/50 px-1" />,
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Share the PTY with the main window by using the card's own id. The
  // Rust side's `pty_create` is idempotent for this case (returns the
  // existing session), so we never double-spawn.
  const paneId = card.ptyId || card.id;
  const initialCommand = launch?.command;
  const providerStartup = launch
    ? buildProviderStartupIntent(card.id, launch) ?? undefined
    : undefined;

  return (
    <div id={`float-shell-${card.id}`} className="flex-1 min-h-0 bg-[var(--terminal-background)]">
      {launch ? (
        <Shell
          key={paneId}
          selectedProject={selectedProject}
          // If the PTY already exists, Shell suppresses this command and only
          // attaches. If it does not, the float starts the same command that
          // the main TerminalView would have started for this card.
          initialCommand={initialCommand}
          providerStartup={providerStartup}
          minimal={true}
          autoConnect={true}
          paneId={paneId}
          active={active}
          rendererScope="float"
          preservePtyOnUnmount={true}
          suppressInitialCommandWhenPtyExists={true}
          resumeLoading={launch.action === 'resume'}
          onUserSubmit={() => {
            recordUserSubmit(card.id, t('terminal:view.sentInput', { defaultValue: 'Sent input' }));
          }}
          onDisconnect={undefined}
        />
      ) : (
        <ProviderSessionLaunchPlaceholder
          status={providerSessionLaunchStatus}
          onRetry={retryProviderSessionLaunch}
        />
      )}
    </div>
  );
}
