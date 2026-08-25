/**
 * 卡片 slice —— 卡片 CRUD、归档生命周期，以及 PTY 输出热路径
 * （`updateCardOutput` / `updateCardReplyPreview`，写入在存储层节流，
 * 见 ../throttledStorage）。
 *
 * 删除/归档卡片时会经共享 `set` 一并清理它在 navigation 与 notifications
 * slice 中的痕迹（焦点、置顶、最近浏览、通知）。
 */
import type {
  TerminalCard,
  CodexAppThreadBinding,
  ProviderSessionImportInfo,
  ProviderSessionImportResult,
} from '../../types/terminal';
import { MAX_ARCHIVED_CARDS, MAX_LAST_OUTPUT_LENGTH } from '../../types/terminal';
import i18n from '../../i18n/config';
import {
  effectiveWorktreePath,
  isPendingWorktreePath,
  pathBasename,
  projectDisplayName,
  samePath,
} from '../../lib/worktreePaths';
import {
  appendEvent,
  archiveCardSnapshot,
  archivedCardsForProject,
  cardsForProjectView,
  compactProjectCardOrder,
  isCatalogProviderSessionType,
  isProviderSessionType,
  normalizeImportedProviderSession,
  prependProjectCardOrder,
  providerSessionKey,
  restoreArchivedCardSnapshot,
  tailJoin,
  uid,
  uuid,
} from './helpers';
import { createAnsiTailSanitizer } from '../../lib/ansiText';
import {
  isAgentTerminalType,
  type TerminalLaunchConfiguration,
} from '../../lib/terminalConfiguration';
import {
  cancelPendingAutoRestart,
  normalizeAutoRestartConfig,
} from '../../lib/autoRestart';
import type { CardsSlice, TerminalSliceCreator } from './types';
import { MAX_CARD_NAME_LENGTH } from './types';
import { releaseClaudeChatCard } from '../../lib/claudeChat/lifecycle';

function compactPendingTerminalConfigurations(
  pending: Record<string, TerminalLaunchConfiguration>,
  cards: readonly TerminalCard[],
  archivedCards: readonly TerminalCard[],
): Record<string, TerminalLaunchConfiguration> {
  const knownIds = new Set([
    ...cards.map((card) => card.id),
    ...archivedCards.map((card) => card.id),
  ]);
  return Object.fromEntries(
    Object.entries(pending).filter(([cardId]) => knownIds.has(cardId)),
  );
}

function nextStartupProjectionEpoch(currentEpoch: string): string {
  const first = uuid().replace(/-/g, '');
  if (first !== currentEpoch) return first;

  const retry = uuid().replace(/-/g, '');
  if (retry !== currentEpoch) return retry;

  // Keep the final fallback opaque and lowercase-hex even when a test/runtime
  // UUID source is unexpectedly deterministic.
  const finalNibble = first.endsWith('0') ? '1' : '0';
  return `${first.slice(0, -1)}${finalNibble}`;
}

export const createCardsSlice: TerminalSliceCreator<CardsSlice> = (set, get) => {
  const outputSanitizers = new Map<
    string,
    ReturnType<typeof createAnsiTailSanitizer>
  >();
  const sanitizeOutput = (id: string, chunk: string) => {
    let sanitizer = outputSanitizers.get(id);
    if (!sanitizer) {
      sanitizer = createAnsiTailSanitizer();
      outputSanitizers.set(id, sanitizer);
    }
    return sanitizer.push(chunk, MAX_LAST_OUTPUT_LENGTH);
  };

  return {
  cards: [],
  archivedCards: [],
  pendingTerminalConfigurations: {},
  projectCardOrder: {},

  createCard: (options) => {
    const id = uid();
    const now = Date.now();
    // A one-shot process must have a concrete command at creation time. Keep
    // malformed/legacy callers interactive rather than creating a generation
    // that Rust cannot execute.
    const executionMode =
      options.executionMode === 'oneShot' && options.command?.trim()
        ? 'oneShot'
        : 'interactive';
    const card: TerminalCard = {
      id,
      ptyId: id, // 1:1 by default; Rust side uses the same id
      projectPath: options.projectPath,
      projectName: options.projectName,
      worktreePath: options.worktreePath,
      branchLabel: options.branchLabel,
      terminalType: options.terminalType,
      command: options.command,
      executionMode,
      oneShotRun:
        executionMode === 'oneShot'
          ? { generation: 1, state: 'queued', requestedAt: now }
          : undefined,
      providerSessionId:
        options.terminalType === 'claude' || options.terminalType === 'grok'
          ? uuid()
          : undefined,
      providerSessionState: isProviderSessionType(options.terminalType) ? 'unbound' : undefined,
      status: 'idle',
      createdAt: now,
      lastActivity: now,
      lastOutput: '',
      lastReplyPreview: '',
      messageCount: 0,
      events: [
        {
          at: now,
          kind: 'created',
          summary: i18n.t('terminal:events.created', {
            type: i18n.t(`terminal:types.${options.terminalType}`, options.terminalType),
            project: options.projectName,
          }),
        },
      ],
      unread: false,
    };
    set((state) => ({
      cards: [...state.cards, card],
      projectCardOrder: prependProjectCardOrder(
        state.projectCardOrder,
        options.projectPath,
        id,
      ),
    }));
    return id;
  },

  renameCard: (id, name) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const existing = state.cards[idx];
      const trimmed = name.trim().slice(0, MAX_CARD_NAME_LENGTH);
      const nextName = trimmed || pathBasename(existing.projectPath);
      if (nextName === existing.projectName) return state;
      const cards = [...state.cards];
      cards[idx] = { ...existing, projectName: nextName };
      return { cards };
    }),

  importProviderSessionCards: (sessions) => {
    if (sessions.length === 0) return [];

    const results: ProviderSessionImportResult[] = [];
    set((state) => {
      const knownCards = [...state.cards, ...(state.archivedCards ?? [])];
      const activeKeys = new Set(
        state.cards
          .filter(
            (card) =>
              isCatalogProviderSessionType(card.terminalType) && Boolean(card.providerSessionId),
          )
          .map((card) =>
            providerSessionKey(
              card.terminalType as ProviderSessionImportInfo['provider'],
              card.providerSessionId ?? '',
            ),
          ),
      );
      const archivedKeys = new Set(
        (state.archivedCards ?? [])
          .filter(
            (card) =>
              isCatalogProviderSessionType(card.terminalType) && Boolean(card.providerSessionId),
          )
          .map((card) =>
            providerSessionKey(
              card.terminalType as ProviderSessionImportInfo['provider'],
              card.providerSessionId ?? '',
            ),
          ),
      );
      const projectLabels = new Map(
        knownCards.map((card) => [card.projectPath, projectDisplayName(card)]),
      );
      const cards = [...state.cards];
      let projectCardOrder = state.projectCardOrder ?? {};
      let imported = 0;

      for (const rawSession of sessions) {
        const session = normalizeImportedProviderSession(rawSession);
        if (!session) {
          results.push({
            id: rawSession.id,
            provider: rawSession.provider,
            outcome: isCatalogProviderSessionType(rawSession.provider)
              ? 'invalid'
              : 'unsupported',
          });
          continue;
        }

        const key = providerSessionKey(session.provider, session.id);
        if (activeKeys.has(key)) {
          results.push({
            id: session.id,
            provider: session.provider,
            outcome: 'alreadyActive',
          });
          continue;
        }
        if (archivedKeys.has(key)) {
          results.push({
            id: session.id,
            provider: session.provider,
            outcome: 'archived',
          });
          continue;
        }

        const now = Date.now();
        const hint = session.projectNameHint?.trim();
        const projectLabel =
          projectLabels.get(session.projectPath) ?? pathBasename(session.projectPath);
        const projectName =
          (hint && hint.length > 0 && hint.length <= 80 ? hint : null) ?? projectLabel;
        const id = uid();
        cards.push({
          id,
          ptyId: session.id,
          projectPath: session.projectPath,
          projectName,
          projectLabel,
          terminalType: session.provider,
          providerSessionId: session.id,
          providerSessionState: 'bound',
          providerSessionBoundAt: now,
          status: 'idle',
          createdAt: now,
          lastActivity: session.updatedAt ?? now,
          lastOutput: '',
          lastReplyPreview: '',
          messageCount: 0,
          events: [
            {
              at: now,
              kind: 'created',
              summary: i18n.t('terminal:events.created', {
                type: i18n.t(`terminal:types.${session.provider}`, session.provider),
                project: projectName,
              }),
            },
          ],
          unread: false,
        });
        projectCardOrder = prependProjectCardOrder(projectCardOrder, session.projectPath, id);
        activeKeys.add(key);
        projectLabels.set(session.projectPath, projectLabel);
        imported += 1;
        results.push({
          id: session.id,
          provider: session.provider,
          outcome: 'imported',
        });
      }

      return imported > 0 ? { cards, projectCardOrder } : state;
    });

    return results;
  },

  removeCard: (id) => {
    outputSanitizers.delete(id);
    const target = get().cards.find((c) => c.id === id);

    set((state) => {
      const cards = state.cards.filter((c) => c.id !== id);
      const focusedCardId = state.focusedCardId === id ? null : state.focusedCardId;
      const lastActiveCardId =
        state.lastActiveCardId === id ? null : state.lastActiveCardId;
      // if the removed card was the last one for its project and the project
      // was selected, fall back to "All"
      let selectedProjectPath = state.selectedProjectPath;
      let selectedWorktreePath = state.selectedWorktreePath;
      let selectedWorktreeLabel = state.selectedWorktreeLabel;
      if (
        target &&
        selectedProjectPath === target.projectPath &&
        !cards.some((c) => c.projectPath === target.projectPath)
      ) {
        selectedProjectPath = null;
        selectedWorktreePath = null;
        selectedWorktreeLabel = null;
      } else if (
        target &&
        selectedWorktreePath &&
        !isPendingWorktreePath(selectedWorktreePath) &&
        samePath(effectiveWorktreePath(target), selectedWorktreePath) &&
        !cards.some(
          (c) =>
            c.projectPath === target.projectPath &&
            samePath(effectiveWorktreePath(c), selectedWorktreePath),
        )
      ) {
        selectedWorktreePath = null;
        selectedWorktreeLabel = null;
      }
      // Also drop from the pinned list so it doesn't linger as a dead entry.
      const pinnedCardIds = state.pinnedCardIds.filter((p) => p !== id);
      const recentlyViewedCardIds = state.recentlyViewedCardIds.filter(
        (recentId) => recentId !== id,
      );
      const projectCardOrder = compactProjectCardOrder(state.projectCardOrder, cards);
      return {
        cards,
        focusedCardId,
        lastActiveCardId,
        selectedProjectPath,
        selectedWorktreePath,
        selectedWorktreeLabel,
        projectCardOrder,
        pinnedCardIds,
        recentlyViewedCardIds,
        pendingTerminalConfigurations: compactPendingTerminalConfigurations(
          state.pendingTerminalConfigurations,
          cards,
          state.archivedCards,
        ),
      };
    });
  },

  archiveCard: (id) => {
    outputSanitizers.delete(id);

    set((state) => {
      const targetIndex = state.cards.findIndex((c) => c.id === id);
      if (targetIndex === -1) return state;

      const now = Date.now();
      const targetCard = state.cards[targetIndex];
      const cards = state.cards.filter((c) => c.id !== id);
      // Newest-first; FIFO cap drops the oldest snapshots past the limit.
      const archivedCards = [
        archiveCardSnapshot(targetCard, now),
        ...(state.archivedCards ?? []).filter((card) => card.id !== id),
      ].slice(0, MAX_ARCHIVED_CARDS);
      const focusedCardId = state.focusedCardId === id ? null : state.focusedCardId;
      const lastActiveCardId =
        state.lastActiveCardId === id ? null : state.lastActiveCardId;
      const pendingFocusCardId =
        state.pendingFocusCardId === id ? null : state.pendingFocusCardId;
      const pendingLocateCardId =
        state.pendingLocateCardId === id ? null : state.pendingLocateCardId;
      const pinnedCardIds = state.pinnedCardIds.filter((pinnedId) => pinnedId !== id);
      const recentlyViewedCardIds = state.recentlyViewedCardIds.filter(
        (recentId) => recentId !== id,
      );
      const projectCardOrder = compactProjectCardOrder(state.projectCardOrder, cards);
      const pendingTerminalConfigurations = compactPendingTerminalConfigurations(
        state.pendingTerminalConfigurations,
        cards,
        archivedCards,
      );

      return {
        cards,
        archivedCards,
        focusedCardId,
        lastActiveCardId,
        pendingFocusCardId,
        pendingLocateCardId,
        pinnedCardIds,
        recentlyViewedCardIds,
        projectCardOrder,
        pendingTerminalConfigurations,
      };
    });
  },

  restoreArchivedCard: (id) =>
    set((state) => {
      const archivedIndex = (state.archivedCards ?? []).findIndex((card) => card.id === id);
      if (archivedIndex === -1) return state;

      const now = Date.now();
      const archivedCard = state.archivedCards[archivedIndex];
      const restoredCard = restoreArchivedCardSnapshot(archivedCard, now);
      const archivedCards = state.archivedCards.filter((card) => card.id !== id);
      const cards = [...state.cards, restoredCard];

      return {
        cards,
        archivedCards,
        selectedProjectPath: restoredCard.projectPath,
        selectedWorktreePath: state.selectedWorktreePath
          ? effectiveWorktreePath(restoredCard)
          : null,
        selectedWorktreeLabel: state.selectedWorktreePath
          ? (restoredCard.branchLabel ?? state.selectedWorktreeLabel)
          : null,
        projectCardOrder: prependProjectCardOrder(
          state.projectCardOrder,
          restoredCard.projectPath,
          restoredCard.id,
        ),
      };
    }),

  savePendingTerminalConfiguration: (id, configuration) => {
    const exists = get().cards.some((card) => card.id === id);
    if (!exists) return false;
    set((state) => ({
      pendingTerminalConfigurations: {
        ...state.pendingTerminalConfigurations,
        [id]: configuration,
      },
    }));
    return true;
  },

  discardPendingTerminalConfiguration: (id) =>
    set((state) => {
      if (!(id in state.pendingTerminalConfigurations)) return state;
      const pendingTerminalConfigurations = {
        ...state.pendingTerminalConfigurations,
      };
      delete pendingTerminalConfigurations[id];
      return { pendingTerminalConfigurations };
    }),

  commitTerminalConfiguration: (id, input) => {
    const now = input.now ?? Date.now();
    const nextPtyId = input.nextPtyId ?? `${id}-configured-${now.toString(36)}-${uid()}`;
    let committedPtyId: string | null = null;
    let releasePreviousClaudeSession = false;

    set((state) => {
      const idx = state.cards.findIndex((card) => card.id === id);
      if (idx === -1) return state;
      const existing = state.cards[idx];
      if ((existing.ptyId || existing.id) !== input.expectedPtyId) return state;
      releasePreviousClaudeSession = existing.terminalType === 'claude';

      const configuration = input.configuration;
      let projectPath = existing.projectPath;
      let projectName = existing.projectName;
      let worktreePath = existing.worktreePath;
      let branchLabel = existing.branchLabel;

      if (
        configuration.launchMode === 'resume'
        && configuration.workspaceMode === 'session'
        && configuration.sessionProjectPath
      ) {
        const sessionProjectPath = configuration.sessionProjectPath;
        const knownWorkspaceCard = [
          ...state.cards,
          ...(state.archivedCards ?? []),
        ].find((card) =>
          samePath(effectiveWorktreePath(card), sessionProjectPath),
        );
        if (knownWorkspaceCard) {
          projectPath = knownWorkspaceCard.projectPath;
          projectName = knownWorkspaceCard.projectName;
          worktreePath = knownWorkspaceCard.worktreePath;
          branchLabel = knownWorkspaceCard.branchLabel;
        } else {
          projectPath = sessionProjectPath;
          projectName = pathBasename(sessionProjectPath);
          worktreePath = undefined;
          branchLabel = undefined;
        }
      }

      const workspaceChanged =
        !samePath(existing.projectPath, projectPath)
        || !samePath(effectiveWorktreePath(existing), worktreePath ?? projectPath);
      const isAgent = isAgentTerminalType(configuration.terminalType);
      const isBoundResume = configuration.launchMode === 'resume';
      const providerSessionId = isBoundResume
        ? configuration.providerSessionId
        : configuration.launchMode === 'default'
          && (configuration.terminalType === 'claude' || configuration.terminalType === 'grok')
          ? uuid()
          : undefined;
      const providerSessionState = isAgent
        ? isBoundResume
          ? 'bound' as const
          : 'unbound' as const
        : undefined;
      const preserveCodexAppBinding =
        existing.terminalType === 'codex'
        && configuration.terminalType === 'codex';
      const autoRestart = existing.autoRestart
        ? {
            ...cancelPendingAutoRestart(
              normalizeAutoRestartConfig(existing.autoRestart),
              now,
            ),
            retryCount: 0,
            limitReachedAt: undefined,
            lastExitCode: undefined,
          }
        : undefined;

      const startupSideEffects = existing.startupSideEffects;
      const reconfiguredStartupSideEffects = startupSideEffects
        ? {
            schema: 1 as const,
            projectionEpoch: nextStartupProjectionEpoch(
              startupSideEffects.projectionEpoch,
            ),
            parentProjectionEpoch: startupSideEffects.projectionEpoch,
            applied: startupSideEffects.applied.map((record) =>
              record.kind === 'recordUserSubmit'
                ? { ...record, timeline: 'retired' as const }
                : { ...record, binding: 'retired' as const },
            ),
          }
        : undefined;
      const retiredStartupTokens = startupSideEffects
        ? new Set(startupSideEffects.applied.map((record) => record.token))
        : undefined;

      const configuredCard = appendEvent(
        {
          ...existing,
          ptyId: nextPtyId,
          projectPath,
          projectName,
          worktreePath,
          branchLabel,
          terminalType: configuration.terminalType,
          command:
            configuration.launchMode === 'custom'
              ? configuration.command
              : undefined,
          providerSessionId,
          providerSessionState,
          providerSessionBoundAt: isBoundResume ? now : undefined,
          providerSessionLastResumeAt: undefined,
          codexAppThreadId: preserveCodexAppBinding
            ? existing.codexAppThreadId
            : undefined,
          codexAppSessionId: preserveCodexAppBinding
            ? existing.codexAppSessionId
            : undefined,
          codexAppThreadPath: preserveCodexAppBinding
            ? existing.codexAppThreadPath
            : undefined,
          codexAppBoundAt: preserveCodexAppBinding
            ? existing.codexAppBoundAt
            : undefined,
          status: 'idle',
          lastOutput: '',
          lastReplyPreview: '',
          unread: false,
          autoRestart,
          ...(reconfiguredStartupSideEffects
            ? {
                startupSideEffects: reconfiguredStartupSideEffects,
                events: existing.events.filter(
                  (event) =>
                    !event.startupEffectToken
                    || !retiredStartupTokens?.has(event.startupEffectToken),
                ),
              }
            : {}),
        },
        {
          at: now,
          kind: 'status',
          summary: i18n.t('terminal:events.configurationApplied', {
            type: i18n.t(
              `terminal:types.${configuration.terminalType}`,
              configuration.terminalType,
            ),
          }),
        },
      );
      const cards = [...state.cards];
      cards[idx] = configuredCard;
      let projectCardOrder = compactProjectCardOrder(
        state.projectCardOrder,
        cards,
      );
      if (workspaceChanged) {
        projectCardOrder = prependProjectCardOrder(
          projectCardOrder,
          projectPath,
          id,
        );
      }

      const pendingTerminalConfigurations = {
        ...state.pendingTerminalConfigurations,
      };
      delete pendingTerminalConfigurations[id];
      committedPtyId = nextPtyId;

      return {
        cards,
        projectCardOrder,
        pendingTerminalConfigurations,
        ...(workspaceChanged
          ? {
              selectedProjectPath: projectPath,
              selectedWorktreePath: worktreePath
                ? effectiveWorktreePath(configuredCard)
                : null,
              selectedWorktreeLabel: worktreePath ? (branchLabel ?? null) : null,
            }
          : {}),
      };
    });
    if (committedPtyId) {
      outputSanitizers.delete(id);
      if (releasePreviousClaudeSession) {
        void releaseClaudeChatCard(id, 'type-change');
      }
    }
    return committedPtyId;
  },

  updateCardOutput: (id, chunk) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const cleaned = sanitizeOutput(id, chunk);
      const cards = [...state.cards];
      const existing = cards[idx];
      cards[idx] = {
        ...existing,
        lastOutput: tailJoin(existing.lastOutput, cleaned, MAX_LAST_OUTPUT_LENGTH),
        lastActivity: Date.now(),
      };
      return { cards };
    }),

  updateCardOutputAndPreview: (id, chunk, preview) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;

      const existing = state.cards[idx];
      let updated = existing;
      if (chunk !== null) {
        const cleaned = sanitizeOutput(id, chunk);
        updated = {
          ...updated,
          lastOutput: tailJoin(existing.lastOutput, cleaned, MAX_LAST_OUTPUT_LENGTH),
          lastActivity: Date.now(),
        };
      }
      if (preview !== null && updated.lastReplyPreview !== preview) {
        updated = { ...updated, lastReplyPreview: preview };
      }
      if (updated === existing) return state;

      const cards = [...state.cards];
      cards[idx] = updated;
      return { cards };
    }),

  updateCardStatus: (id, status) => {
    if (status === 'idle' || status === 'completed' || status === 'failed') {
      outputSanitizers.get(id)?.reset();
    }
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      const existing = cards[idx];
      if (existing.status === status) return state;
      const now = Date.now();
      cards[idx] = appendEvent(
        { ...existing, status, lastActivity: now },
        {
          at: now,
          kind: 'status',
          summary: i18n.t('terminal:events.status', {
            status: i18n.t(`terminal:status.${status}`, status),
          }),
        },
      );
      return { cards };
    });
  },

  markOneShotRunRunning: (id, generation) => {
    let changed = false;
    set((state) => {
      const idx = state.cards.findIndex((card) => card.id === id);
      const card = idx >= 0 ? state.cards[idx] : undefined;
      if (
        !card ||
        card.executionMode !== 'oneShot' ||
        card.oneShotRun?.generation !== generation ||
        card.oneShotRun.state !== 'queued'
      ) {
        return state;
      }
      changed = true;
      const cards = [...state.cards];
      cards[idx] = {
        ...card,
        status: 'running',
        lastActivity: Date.now(),
        oneShotRun: { ...card.oneShotRun, state: 'running' },
      };
      return { cards };
    });
    return changed;
  },

  finishOneShotRun: (id, input) => {
    let changed = false;
    set((state) => {
      const idx = state.cards.findIndex((card) => card.id === id);
      const card = idx >= 0 ? state.cards[idx] : undefined;
      if (
        !card ||
        card.executionMode !== 'oneShot' ||
        card.oneShotRun?.generation !== input.generation ||
        (card.oneShotRun.state !== 'queued' && card.oneShotRun.state !== 'running')
      ) {
        return state;
      }
      changed = true;
      const cards = [...state.cards];
      const finishedAt = input.finishedAt ?? Date.now();
      cards[idx] = {
        ...card,
        status:
          input.state === 'completed'
            ? 'completed'
            : input.state === 'failed'
              ? 'failed'
              : 'idle',
        oneShotRun: {
          ...card.oneShotRun,
          state: input.state,
          finishedAt,
          ...(input.exitCode === undefined ? { exitCode: undefined } : { exitCode: input.exitCode }),
        },
        lastActivity: finishedAt,
      };
      return { cards };
    });
    return changed;
  },

  runOneShotAgain: (id, now = Date.now()) => {
    let nextGeneration: number | null = null;
    set((state) => {
      const idx = state.cards.findIndex((card) => card.id === id);
      const card = idx >= 0 ? state.cards[idx] : undefined;
      const run = card?.oneShotRun;
      if (
        !card ||
        card.executionMode !== 'oneShot' ||
        !card.command?.trim() ||
        !run ||
        (run.state !== 'completed' && run.state !== 'failed' && run.state !== 'interrupted')
      ) {
        return state;
      }
      nextGeneration = run.generation + 1;
      const cards = [...state.cards];
      cards[idx] = {
        ...card,
        // Rotating the PTY id makes late events from the previous generation
        // unresolvable, so a completed run can never overwrite a newer run.
        ptyId: `${id}-oneshot-${nextGeneration}-${uid()}`,
        status: 'idle',
        lastActivity: now,
        lastOutput: '',
        lastReplyPreview: '',
        unread: false,
        oneShotRun: {
          generation: nextGeneration,
          state: 'queued',
          requestedAt: now,
        },
      };
      return { cards };
    });
    return nextGeneration;
  },

  updateCardReplyPreview: (id, preview) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      if (state.cards[idx].lastReplyPreview === preview) return state;
      const cards = [...state.cards];
      cards[idx] = { ...cards[idx], lastReplyPreview: preview };
      return { cards };
    }),

  appendEvent: (id, event) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      cards[idx] = appendEvent(cards[idx], {
        at: event.at ?? Date.now(),
        kind: event.kind,
        summary: event.summary,
        ...(event.summaryKey === undefined ? {} : { summaryKey: event.summaryKey }),
        ...(event.startupEffectToken === undefined
          ? {}
          : { startupEffectToken: event.startupEffectToken }),
      });
      return { cards };
    }),

  incrementMessageCount: (id) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      cards[idx] = { ...cards[idx], messageCount: cards[idx].messageCount + 1 };
      return { cards };
    }),

  recordUserSubmit: (id, summary) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const now = Date.now();
      const cards = [...state.cards];
      const existing = cards[idx];
      cards[idx] = appendEvent(
        {
          ...existing,
          messageCount: existing.messageCount + 1,
          lastActivity: now,
        },
        {
          at: now,
          kind: 'user-input',
          summary,
        },
      );
      return { cards };
    }),

  markUnread: (id, unread) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1 || state.cards[idx].unread === unread) return state;
      const cards = [...state.cards];
      cards[idx] = { ...cards[idx], unread };
      return { cards };
    }),

  markCardRead: (id) =>
    set((state) => {
      let changed = false;
      const cards = state.cards.map((card) => {
        if (card.id !== id || !card.unread) return card;
        changed = true;
        return { ...card, unread: false };
      });
      return changed ? { cards } : state;
    }),

  markProviderSessionBound: (id, providerSessionId) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const now = Date.now();
      const cards = [...state.cards];
      const existing = cards[idx];
      cards[idx] = {
        ...existing,
        providerSessionId,
        providerSessionState: 'bound',
        providerSessionBoundAt: existing.providerSessionBoundAt ?? now,
        providerSessionLastResumeAt: now,
      };
      return { cards };
    }),

  bindCodexAppThread: (id, binding: CodexAppThreadBinding) =>
    set((state) => {
      const threadId = binding.threadId.trim();
      if (!threadId) return state;
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      const existing = cards[idx];
      cards[idx] = {
        ...existing,
        codexAppThreadId: threadId,
        codexAppSessionId: binding.sessionId?.trim() || undefined,
        codexAppThreadPath: binding.threadPath?.trim() || undefined,
        codexAppBoundAt: binding.boundAt ?? Date.now(),
      };
      return { cards };
    }),

  updateCardAiIntent: (id, intent) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const nextIntent = intent ?? undefined;
      if (state.cards[idx].aiIntent === nextIntent) return state;
      const cards = [...state.cards];
      cards[idx] = { ...cards[idx], aiIntent: nextIntent };
      return { cards };
    }),

  moveProjectCard: (projectPath, id, toIndex) =>
    set((state) => {
      const projectCards = cardsForProjectView(
        state.cards,
        state.projectCardOrder,
        projectPath,
      );
      const from = projectCards.findIndex((card) => card.id === id);
      if (from === -1) return state;

      const nextCards = projectCards.slice();
      const [moved] = nextCards.splice(from, 1);
      if (!moved) return state;
      const target = Math.max(0, Math.min(nextCards.length, toIndex));
      nextCards.splice(target, 0, moved);

      const nextIds = nextCards.map((card) => card.id);
      const previousIds = state.projectCardOrder[projectPath] ?? [];
      if (
        previousIds.length === nextIds.length &&
        previousIds.every((candidate, index) => candidate === nextIds[index])
      ) {
        return state;
      }

      return {
        projectCardOrder: {
          ...state.projectCardOrder,
          [projectPath]: nextIds,
        },
      };
    }),

  getCardsForProjectView: (path, worktreePath) => {
    const state = get();
    return cardsForProjectView(state.cards, state.projectCardOrder, path, worktreePath);
  },

  getArchivedCardsForProject: (path, worktreePath) =>
    archivedCardsForProject(get().archivedCards, path, worktreePath),

  getCardById: (id) => get().cards.find((c) => c.id === id),
  };
};
