/**
 * TerminalView — full-screen view for a single terminal card.
 *
 * Uses the existing Shell.tsx component in `isPlainShell` + `autoConnect`
 * mode, passing the card's PTY id so the main window and floating overlay
 * attach to the same Rust PTY session.
 *
 * Animations: shared `layoutId` with the card in the grid produces a
 * smooth expand/collapse transition courtesy of Framer Motion.
 *
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  MessageSquare,
  MoreVertical,
  Settings2,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Shell from './Shell';
import type { TerminalCard } from '../../types/terminal';
import { useTerminalStore } from '../../stores/terminalStore';
import { getStatusMeta } from './statusMeta';
import { getTerminalTypeMeta } from './terminalTypeMeta';
import {
  AI_CLI_SESSION_BADGE_CLASS,
  getAiCliSessionBadge,
} from './providerSession';
import { useProviderSessionLifecycle } from './useProviderSessionLifecycle';
import { useValidatedProviderSessionLaunch } from './useValidatedProviderSessionLaunch';
import { ProviderSessionLaunchPlaceholder } from './ProviderSessionLaunchPlaceholder';
import { AiIntentSelect } from './AiIntentSelect';
import { AutoRestartControls } from './AutoRestartControls';
import { AutoRestartStatus } from './AutoRestartStatus';
import { normalizeAutoRestartConfig } from '../../lib/autoRestart';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import { CodexChatView } from '../codex/CodexChatView';
import { ClaudeChatView } from '../claude/ClaudeChatView';
import { claudeChat } from '../../lib/claudeChat/api';

interface TerminalViewProps {
  card: TerminalCard;
  active?: boolean;
  onBack: () => void;
  onRemoveCard: (cardId: string) => Promise<boolean>;
  onArchiveCard: (cardId: string) => Promise<boolean>;
  onEdit?: (cardId: string) => void;
  revealTerminalToken?: number;
}

type ClaudeChatAvailability =
  | { status: 'checking'; reason: null }
  | { status: 'available'; reason: null }
  | { status: 'unavailable'; reason: string };

function defaultCodexViewMode(
  terminalType: TerminalCard['terminalType'],
  providerSessionState: TerminalCard['providerSessionState'],
  providerSessionId: TerminalCard['providerSessionId'],
): 'chat' | 'terminal' {
  if (terminalType !== 'codex') return 'terminal';
  return providerSessionState === 'bound' && providerSessionId
    ? 'terminal'
    : 'chat';
}

export const TerminalView = memo(function TerminalView({
  card,
  active = true,
  onBack,
  onRemoveCard,
  onArchiveCard,
  onEdit,
  revealTerminalToken = 0,
}: TerminalViewProps) {
  const { t } = useTranslation('terminal');
  const recordUserSubmit = useTerminalStore((s) => s.recordUserSubmit);
  const markCardRead = useTerminalStore((s) => s.markCardRead);
  const setCardAutoRestartEnabled = useTerminalStore((s) => s.setCardAutoRestartEnabled);
  const setCardAutoRestartMaxRetries = useTerminalStore((s) => s.setCardAutoRestartMaxRetries);

  const preferredCodexViewMode = card.command?.trim()
    ? 'terminal'
    : defaultCodexViewMode(
        card.terminalType,
        card.providerSessionState,
        card.providerSessionId,
      );
  const [chatViewMode, setChatViewMode] = useState<'chat' | 'terminal'>(
    revealTerminalToken > 0 ? 'terminal' : preferredCodexViewMode,
  );
  const [claudeChatAvailability, setClaudeChatAvailability] =
    useState<ClaudeChatAvailability>({
      status: 'checking',
      reason: null,
    });
  const hasPendingConfiguration = useTerminalStore(
    (state) => Boolean(state.pendingTerminalConfigurations[card.id]),
  );

  // Note: no PTY guard is needed even when the float window also hosts
  // this card. Both windows share the same pty id and the
  // Rust backend makes pty_create idempotent, so both xterm instances
  // simply mirror the same session's output stream.

  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const statusInfo = getStatusMeta(card.status);
  const StatusIcon = statusInfo.Icon;
  const TypeIcon = typeMeta.Icon;
  const autoRestart = normalizeAutoRestartConfig(card.autoRestart);
  const paneId = card.ptyId || card.id;
  const isCodexCard = card.terminalType === 'codex';
  const isClaudeCard = card.terminalType === 'claude';
  const supportsChat = isCodexCard || isClaudeCard;
  const showChat = supportsChat && chatViewMode === 'chat';
  const claudeChatDisabled =
    isClaudeCard && claudeChatAvailability.status !== 'available';
  const chatButtonTitle = isClaudeCard
    ? claudeChatAvailability.status === 'unavailable'
      ? claudeChatAvailability.reason
      : claudeChatAvailability.status === 'checking'
        ? t('claudeChat.checking', {
            defaultValue: 'Checking Claude Chat availability…',
          })
        : t('claudeChat.chatMode', {
            defaultValue: 'Claude Chat mode',
          })
    : t('codexChat.chatMode', { defaultValue: 'Chat mode' });
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
  const {
    lifecycleCard,
    launch,
    status: providerSessionLaunchStatus,
    retry: retryProviderSessionLaunch,
  } = useValidatedProviderSessionLaunch(
    card,
    typeMeta.defaultCommand,
  );
  const initialCommand = launch?.command;
  const onProviderInitialCommandSent = useProviderSessionLifecycle(
    lifecycleCard,
    launch,
    active,
  );

  useEffect(() => {
    setChatViewMode(preferredCodexViewMode);
  }, [card.id, preferredCodexViewMode]);

  useEffect(() => {
    if (revealTerminalToken > 0) setChatViewMode('terminal');
  }, [revealTerminalToken]);

  useEffect(() => {
    if (!isClaudeCard) return;
    let cancelled = false;
    setClaudeChatAvailability((current) =>
      current.status === 'checking'
        ? current
        : { status: 'checking', reason: null },
    );
    void claudeChat
      .probe()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setClaudeChatAvailability({ status: 'available', reason: null });
          return;
        }
        setClaudeChatAvailability({
          status: 'unavailable',
          reason:
            result.detail ??
            'Claude Chat is unavailable.',
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setClaudeChatAvailability({
          status: 'unavailable',
          reason:
            error instanceof Error
              ? error.message
              : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [card.id, isClaudeCard]);

  const recordSubmit = useCallback(() => {
    recordUserSubmit(card.id, t('view.sentInput'));
    // AI Supervisor v0.1 (PRD D10) — credit the user with an "acted" event if
    // they recently clicked an alert for this card. Cheap getState read avoids
    // any subscription-driven re-render; the store self-no-ops when there's
    // no eligible click.
    useSupervisorStore.getState().recordAction(card.id);
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

  const handleClose = async () => {
    if (await onRemoveCard(card.id)) {
      onBack();
    }
  };
  const handleArchive = async () => {
    if (await onArchiveCard(card.id)) {
      onBack();
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Header */}
      <div className="flex h-15 shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-2 sm:gap-3 sm:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={onBack}
            title={t('view.backToGrid')}
            className="rounded-md p-1.5 hover:bg-accent hover:text-accent-foreground shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className={`flex h-8 w-8 items-center justify-center rounded-md bg-muted shrink-0 ${typeMeta.accent}`}>
            <TypeIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{card.projectName}</span>
              <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground opacity-70">
                · {t(`types.${card.terminalType}`, typeMeta.label)}
              </span>
              {hasPendingConfiguration && (
                <span
                  title={t('edit.pendingHint')}
                  className="shrink-0 rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                >
                  {t('edit.pending')}
                </span>
              )}
            </div>
            <div className="truncate text-[11px] text-muted-foreground opacity-60" title={card.projectPath}>
              {card.worktreePath ? t('view.worktree', { path: card.worktreePath }) : card.projectPath}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-1.5">
          {aiSessionBadge && (
            <div className="hidden xs:block">
              <AiIntentSelect cardId={card.id} value={card.aiIntent} compact />
            </div>
          )}
          {aiSessionBadge && (
            <span
              title={t(aiSessionBadge.descriptionKey, {
                ...aiSessionBadge.values,
                defaultValue: aiSessionBadge.fallbackDescription,
              })}
              className={[
                'hidden max-w-[190px] items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none sm:inline-flex',
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
          <AutoRestartControls
            enabled={autoRestart.enabled}
            maxRetries={autoRestart.maxRetries}
            onToggle={() =>
              setCardAutoRestartEnabled(card.id, !autoRestart.enabled)
            }
            onMaxRetriesChange={(value) =>
              setCardAutoRestartMaxRetries(card.id, value)
            }
          />
          <AutoRestartStatus card={card} compact />
          {supportsChat && (
            <div className="flex shrink-0 rounded-md border border-border bg-muted/30 p-0.5">
              <button
                type="button"
                onClick={() => {
                  if (!claudeChatDisabled) setChatViewMode('chat');
                }}
                disabled={claudeChatDisabled}
                title={chatButtonTitle}
                className={[
                  'inline-flex h-7 items-center gap-1 rounded-sm px-2 text-[11px]',
                  chatViewMode === 'chat'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                ].join(' ')}
              >
                <MessageSquare className="h-3 w-3" />
                <span className="hidden sm:inline">
                  {isClaudeCard
                    ? t('claudeChat.chat', { defaultValue: 'Chat' })
                    : t('codexChat.chat', { defaultValue: 'Chat' })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setChatViewMode('terminal')}
                title={
                  isClaudeCard
                    ? t('claudeChat.terminalMode', {
                        defaultValue: 'Terminal mode',
                      })
                    : t('codexChat.terminalMode', {
                        defaultValue: 'Terminal mode',
                      })
                }
                className={[
                  'inline-flex h-7 items-center gap-1 rounded-sm px-2 text-[11px]',
                  chatViewMode === 'terminal'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                ].join(' ')}
              >
                <TerminalSquare className="h-3 w-3" />
                <span className="hidden sm:inline">
                  {isClaudeCard
                    ? t('claudeChat.terminal', { defaultValue: 'Terminal' })
                    : t('codexChat.terminal', { defaultValue: 'Terminal' })}
                </span>
              </button>
            </div>
          )}
          <span
            className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${statusInfo.chip}`}
          >
            <StatusIcon className={`h-2.5 w-2.5 sm:h-3 sm:w-3 ${statusInfo.animate ? 'animate-spin' : ''}`} />
            <span className="hidden xs:inline">{t(`status.${card.status}`, statusInfo.label)}</span>
          </span>

          <div className="group relative">
            <button
              type="button"
              className="rounded-md p-1.5 hover:bg-accent hover:text-accent-foreground"
              title={t('view.more')}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            <div className="absolute right-0 top-full z-10 mt-1 hidden w-44 rounded-md border border-border bg-popover p-1 text-sm shadow-lg group-hover:block">
              {onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(card.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                >
                  <Settings2 className="h-3.5 w-3.5" /> {t('edit.action')}
                </button>
              )}
              <button
                type="button"
                onClick={handleArchive}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
              >
                <Archive className="h-3.5 w-3.5" /> {t('view.archiveTerminal')}
              </button>
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
            className="rounded-md p-1.5 hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main area: provider Chat or xterm. */}
      <div className="flex min-h-0 flex-1">
        {showChat ? (
          <div className="min-h-0 flex-1">
            {isCodexCard ? (
              <CodexChatView card={card} active={active} />
            ) : (
              <ClaudeChatView card={card} active={active} />
            )}
          </div>
        ) : (
          <div
            id={`terminal-shell-${card.id}`}
            className="relative min-h-0 flex-1 bg-[var(--terminal-background)]"
          >
            {launch ? (
              <Shell
                selectedProject={selectedProject}
                initialCommand={initialCommand}
                minimal={true}
                autoConnect={true}
                paneId={paneId}
                active={active}
                preservePtyOnUnmount={true}
                suppressInitialCommandWhenPtyExists={true}
                resumeLoading={launch.action === 'resume'}
                autoReconnectOnExit={false}
                onInitialCommandSent={handleInitialCommandSent}
                onUserSubmit={recordSubmit}
                onDisconnect={undefined}
              />
            ) : (
              <ProviderSessionLaunchPlaceholder
                status={providerSessionLaunchStatus}
                onRetry={retryProviderSessionLaunch}
              />
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
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
});
