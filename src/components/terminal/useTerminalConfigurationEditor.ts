import { useCallback, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import {
  findTerminalSessionBindingConflict,
  normalizeTerminalLaunchConfiguration,
  terminalLaunchConfigurationFromCard,
  terminalLaunchConfigurationsEqual,
  type TerminalConfigurationValidationError,
  type TerminalLaunchConfiguration,
  type TerminalLaunchConfigurationDraft,
} from '../../lib/terminalConfiguration';
import { confirmDialog } from '../../lib/nativeDialog';
import {
  isTauriEnv,
  providerSessions,
  pty,
} from '../../lib/tauri-bridge';
import {
  effectiveWorktreePath,
  samePath,
} from '../../lib/worktreePaths';
import {
  flushTerminalStorePersistence,
  useTerminalStore,
} from '../../stores/terminalStore';
import { useClaudeChatStore } from '../../stores/claudeChatStore';
import type { TerminalCard } from '../../types/terminal';
import { claudeChat } from '../../lib/claudeChat/api';
import type {
  TerminalConfigurationAction,
  TerminalConfigurationActionResult,
} from './EditTerminalDialog';

interface UseTerminalConfigurationEditorOptions {
  t: TFunction<'terminal'>;
  requestCardWorkspaceReset: (cardId: string) => Promise<boolean>;
  activateTerminalForCard: (cardId: string) => void;
  openTerminal: (cardId: string) => void;
}

type PreparedConfigurationResult =
  | { ok: true; configuration: TerminalLaunchConfiguration }
  | Exclude<TerminalConfigurationActionResult, { ok: true }>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingRuntimeError(error: unknown): boolean {
  return /not found|not running|unknown (?:card|session)/i.test(
    errorText(error),
  );
}

function validationMessage(
  t: TFunction<'terminal'>,
  error: TerminalConfigurationValidationError,
): string {
  return t(`edit.validation.${error}`);
}

async function prepareConfiguration(
  card: TerminalCard,
  draft: TerminalLaunchConfigurationDraft,
  t: TFunction<'terminal'>,
): Promise<PreparedConfigurationResult> {
  const provisional = normalizeTerminalLaunchConfiguration({
    ...draft,
    workspaceMode: 'current',
  });
  if (!provisional.ok) {
    return {
      ok: false,
      kind: 'error',
      message: validationMessage(t, provisional.error),
    };
  }
  if (provisional.value.launchMode !== 'resume') {
    return { ok: true, configuration: provisional.value };
  }

  let providerSessionId = provisional.value.providerSessionId;
  let sessionProjectPath = draft.sessionProjectPath?.trim() || undefined;
  if (
    provisional.value.terminalType === 'claude'
    || provisional.value.terminalType === 'codex'
  ) {
    try {
      const resolved = await providerSessions.resolveResume(
        provisional.value.terminalType,
        providerSessionId,
      );
      if (!resolved) {
        return {
          ok: false,
          kind: 'error',
          message: t('edit.sessionNotFound'),
        };
      }
      providerSessionId = resolved.id;
      sessionProjectPath = resolved.projectPath.trim() || sessionProjectPath;
    } catch (error) {
      return {
        ok: false,
        kind: 'error',
        message: t('edit.sessionResolveFailed', {
          error: errorText(error),
        }),
      };
    }
  }

  const crossProject =
    Boolean(sessionProjectPath)
    && !samePath(sessionProjectPath, card.projectPath)
    && !samePath(sessionProjectPath, effectiveWorktreePath(card));
  if (
    crossProject
    && draft.workspaceMode !== 'current'
    && draft.workspaceMode !== 'session'
  ) {
    return {
      ok: false,
      kind: 'workspace-choice',
      sessionProjectPath: sessionProjectPath ?? '',
      message: t('edit.chooseWorkspace'),
    };
  }

  const normalized = normalizeTerminalLaunchConfiguration({
    terminalType: provisional.value.terminalType,
    launchMode: 'resume',
    providerSessionId,
    workspaceMode:
      crossProject && draft.workspaceMode === 'session'
        ? 'session'
        : 'current',
    sessionProjectPath,
  });
  return normalized.ok
    ? { ok: true, configuration: normalized.value }
    : {
        ok: false,
        kind: 'error',
        message: validationMessage(t, normalized.error),
      };
}

export function useTerminalConfigurationEditor({
  t,
  requestCardWorkspaceReset,
  activateTerminalForCard,
  openTerminal,
}: UseTerminalConfigurationEditorOptions) {
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [terminalRevealTokens, setTerminalRevealTokens] = useState<
    Record<string, number>
  >({});
  const cards = useTerminalStore((state) => state.cards);
  const archivedCards = useTerminalStore((state) => state.archivedCards);
  const pendingTerminalConfigurations = useTerminalStore(
    (state) => state.pendingTerminalConfigurations,
  );

  const editingCard = useMemo(
    () =>
      editingCardId
        ? cards.find((card) => card.id === editingCardId) ?? null
        : null,
    [cards, editingCardId],
  );

  const closeEditor = useCallback(() => setEditingCardId(null), []);
  const openEditor = useCallback((cardId: string) => {
    if (!useTerminalStore.getState().cards.some((card) => card.id === cardId)) {
      return;
    }
    setEditingCardId(cardId);
  }, []);

  const discardPending = useCallback((cardId: string) => {
    useTerminalStore.getState().discardPendingTerminalConfiguration(cardId);
    flushTerminalStorePersistence();
  }, []);

  const locateConflict = useCallback(
    (cardId: string, archived: boolean) => {
      const store = useTerminalStore.getState();
      if (archived) store.restoreArchivedCard(cardId);
      if (!useTerminalStore.getState().cards.some((card) => card.id === cardId)) {
        return;
      }
      setEditingCardId(null);
      activateTerminalForCard(cardId);
      openTerminal(cardId);
    },
    [activateTerminalForCard, openTerminal],
  );

  const submit = useCallback(
    async (
      cardId: string,
      draft: TerminalLaunchConfigurationDraft,
      action: TerminalConfigurationAction,
    ): Promise<TerminalConfigurationActionResult> => {
      const initialState = useTerminalStore.getState();
      const card = initialState.cards.find((candidate) => candidate.id === cardId);
      if (!card) {
        return {
          ok: false,
          kind: 'error',
          message: t('edit.cardMissing'),
        };
      }

      const prepared = await prepareConfiguration(card, draft, t);
      if (!prepared.ok) return prepared;
      const configuration = prepared.configuration;
      const stateAfterResolve = useTerminalStore.getState();
      const resolvedCard = stateAfterResolve.cards.find(
        (candidate) => candidate.id === cardId,
      );
      if (!resolvedCard) {
        return {
          ok: false,
          kind: 'error',
          message: t('edit.cardMissing'),
        };
      }

      if (configuration.launchMode === 'resume') {
        const duplicate = findTerminalSessionBindingConflict(
          stateAfterResolve.cards,
          stateAfterResolve.archivedCards,
          configuration.terminalType,
          configuration.providerSessionId,
          cardId,
        );
        if (duplicate) {
          return {
            ok: false,
            kind: 'duplicate',
            ...duplicate,
            message: t(
              duplicate.archived
                ? 'edit.duplicateArchived'
                : 'edit.duplicateActive',
            ),
          };
        }
      }

      const activeConfiguration =
        terminalLaunchConfigurationFromCard(resolvedCard);
      if (
        terminalLaunchConfigurationsEqual(
          activeConfiguration,
          configuration,
        )
      ) {
        stateAfterResolve.discardPendingTerminalConfiguration(cardId);
        flushTerminalStorePersistence();
        return { ok: true };
      }

      if (action === 'save') {
        const saved = stateAfterResolve.savePendingTerminalConfiguration(
          cardId,
          configuration,
        );
        if (saved) {
          flushTerminalStorePersistence();
          return { ok: true };
        }
        return {
          ok: false,
          kind: 'error',
          message: t('edit.cardMissing'),
        };
      }

      const restartConfirmed = await confirmDialog(
        t('edit.restartConfirm'),
        t('edit.restartConfirmTitle'),
      );
      if (!restartConfirmed) {
        return {
          ok: false,
          kind: 'error',
          message: t('edit.restartCancelled'),
        };
      }

      const workspaceWillChange =
        configuration.launchMode === 'resume'
        && configuration.workspaceMode === 'session'
        && Boolean(configuration.sessionProjectPath)
        && !samePath(
          configuration.sessionProjectPath,
          effectiveWorktreePath(resolvedCard),
        );
      if (
        workspaceWillChange
        && !(await requestCardWorkspaceReset(cardId))
      ) {
        return {
          ok: false,
          kind: 'error',
          message: t('edit.workspaceChangeCancelled'),
        };
      }

      const beforeStopState = useTerminalStore.getState();
      const beforeStopCard = beforeStopState.cards.find(
        (candidate) => candidate.id === cardId,
      );
      if (!beforeStopCard) {
        return {
          ok: false,
          kind: 'error',
          message: t('edit.cardMissing'),
        };
      }
      if (configuration.launchMode === 'resume') {
        const duplicate = findTerminalSessionBindingConflict(
          beforeStopState.cards,
          beforeStopState.archivedCards,
          configuration.terminalType,
          configuration.providerSessionId,
          cardId,
        );
        if (duplicate) {
          return {
            ok: false,
            kind: 'duplicate',
            ...duplicate,
            message: t(
              duplicate.archived
                ? 'edit.duplicateArchived'
                : 'edit.duplicateActive',
            ),
          };
        }
      }

      const expectedPtyId = beforeStopCard.ptyId || beforeStopCard.id;
      let livePty = false;
      if (isTauriEnv()) {
        try {
          await pty.getSessionState(expectedPtyId);
          livePty = true;
        } catch (error) {
          if (!isMissingRuntimeError(error)) {
            return {
              ok: false,
              kind: 'error',
              message: t('edit.runtimeCheckFailed', {
                error: errorText(error),
              }),
            };
          }
        }
      }

      const resetClaudeChat =
        beforeStopCard.terminalType === 'claude'
        || configuration.terminalType === 'claude';
      if (resetClaudeChat && isTauriEnv()) {
        try {
          await claudeChat.stop(cardId);
        } catch (error) {
          if (!isMissingRuntimeError(error)) {
            return {
              ok: false,
              kind: 'error',
              message: t('edit.chatStopFailed', {
                error: errorText(error),
              }),
            };
          }
        }
      }

      if (isTauriEnv() && livePty) {
        try {
          await pty.kill(expectedPtyId);
        } catch (error) {
          if (!isMissingRuntimeError(error)) {
            return {
              ok: false,
              kind: 'error',
              message: t('edit.runtimeStopFailed', {
                error: errorText(error),
              }),
            };
          }
        }
      }

      const nextPtyId = useTerminalStore
        .getState()
        .commitTerminalConfiguration(cardId, {
          expectedPtyId,
          configuration,
        });
      if (!nextPtyId) {
        return {
          ok: false,
          kind: 'error',
          message: t('edit.cardChangedDuringApply'),
        };
      }

      if (resetClaudeChat) {
        useClaudeChatStore.getState().resetCard(cardId);
      }
      flushTerminalStorePersistence();
      setTerminalRevealTokens((current) => ({
        ...current,
        [cardId]: (current[cardId] ?? 0) + 1,
      }));
      activateTerminalForCard(cardId);
      openTerminal(cardId);
      return { ok: true };
    },
    [
      activateTerminalForCard,
      openTerminal,
      requestCardWorkspaceReset,
      t,
    ],
  );

  return {
    editingCard,
    editingCardId,
    pendingConfiguration: editingCardId
      ? pendingTerminalConfigurations[editingCardId]
      : undefined,
    terminalRevealTokens,
    openEditor,
    closeEditor,
    submit,
    discardPending,
    locateConflict,
  };
}
