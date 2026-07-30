/**
 * Terminal Manager Lite —— 单一 Zustand store，由各域 slice 组合而成。
 *
 * slice 布局（见 ./terminal/）：
 *   • cardsSlice          → 卡片 CRUD + PTY 输出热路径（updateCardOutput）
 *   • autoRestartSlice    → 每卡自动重启状态机
 *   • notificationsSlice  → 通知中心 + OS/supervisor 偏好
 *   • navigationSlice     → 聚焦 / 置顶 / session dock 最近浏览
 *   • projectSlice        → 项目 / worktree 侧栏选择
 *
 * 所有 slice 共享同一组覆盖组合后 store 的 `set`/`get`，跨域更新（如删卡时
 * 一并清理置顶与通知）保持单事务。本文件只负责组合与 persist 配置；persist
 * key、partialize 形状与版本号在拆分前后不变（由"持久化形状契约"测试锁定）。
 *
 * Output buffers (`lastOutput`, `lastReplyPreview`) are persisted as-is because
 * they're tiny (≤2KB per card) and give the user a useful restart preview
 * until the PTY reconnects and overwrites them. Their high-frequency writes
 * are debounced at the storage layer — see `./throttledStorage` (FIX-3) — so
 * per-chunk store mutations don't each trigger a synchronous full
 * `JSON.stringify(cards)` + `localStorage` write.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createThrottledPersistStorage } from './throttledStorage';
import { readOsNotificationsEnabled } from '../lib/notificationPrefs';
import { createCardsSlice } from './terminal/cardsSlice';
import { createAutoRestartSlice } from './terminal/autoRestartSlice';
import { createNotificationsSlice } from './terminal/notificationsSlice';
import { createNavigationSlice } from './terminal/navigationSlice';
import { createProjectSlice } from './terminal/projectSlice';
import {
  compactProjectCardOrder,
  compactRecentCardIds,
  isProviderSessionType,
  isTransientStatus,
  prepareAutoRestartForPersistence,
} from './terminal/helpers';
import type { TerminalStore } from './terminal/types';
import {
  parsePersistedTerminalLaunchConfiguration,
  type TerminalLaunchConfiguration,
} from '../lib/terminalConfiguration';

type PersistedTerminalState = Partial<
  Pick<
    TerminalStore,
    | 'cards'
    | 'archivedCards'
    | 'pendingTerminalConfigurations'
    | 'focusedCardId'
    | 'lastActiveCardId'
    | 'recentlyViewedCardIds'
    | 'dockPinned'
    | 'selectedProjectPath'
    | 'selectedWorktreePath'
    | 'selectedWorktreeLabel'
    | 'projectCardOrder'
    | 'pinnedCardIds'
    | 'notifications'
    | 'notificationCentreOpen'
    | 'osNotificationsEnabled'
    | 'supervisorEnabled'
  >
>;

function compactPendingTerminalConfigurations(
  value: unknown,
  validCardIds: ReadonlySet<string>,
): Record<string, TerminalLaunchConfiguration> {
  if (!value || typeof value !== 'object') return {};
  const pending: Record<string, TerminalLaunchConfiguration> = {};
  for (const [cardId, rawConfiguration] of Object.entries(value)) {
    if (!validCardIds.has(cardId)) continue;
    const configuration = parsePersistedTerminalLaunchConfiguration(
      rawConfiguration,
    );
    if (configuration) pending[cardId] = configuration;
  }
  return pending;
}

export {
  MAX_PINNED_CARDS,
  MAX_RECENTLY_VIEWED_CARDS,
  MAX_CARD_NAME_LENGTH,
} from './terminal/types';
export type { ArchivedTerminalCard } from './terminal/types';

const terminalPersistStorage =
  createThrottledPersistStorage<PersistedTerminalState>(500, 2000);

export function flushTerminalStorePersistence(): void {
  terminalPersistStorage.flush();
}

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (...slice) => ({
      ...createCardsSlice(...slice),
      ...createAutoRestartSlice(...slice),
      ...createNotificationsSlice(...slice),
      ...createNavigationSlice(...slice),
      ...createProjectSlice(...slice),
    }),
    {
      name: 'threadterm-terminal-store',
      // Delay stringify and localStorage I/O together. maxWait keeps other
      // WebViews and restart previews bounded during continuous output.
      storage: terminalPersistStorage,
      partialize: (state) => ({
        cards: state.cards.map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          autoRestart: prepareAutoRestartForPersistence(card),
        })),
        archivedCards: state.archivedCards.map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          unread: false,
          autoRestart: prepareAutoRestartForPersistence(card),
        })),
        pendingTerminalConfigurations: compactPendingTerminalConfigurations(
          state.pendingTerminalConfigurations,
          new Set([
            ...state.cards.map((card) => card.id),
            ...state.archivedCards.map((card) => card.id),
          ]),
        ),
        focusedCardId: null,
        lastActiveCardId: state.lastActiveCardId,
        recentlyViewedCardIds: compactRecentCardIds(state.recentlyViewedCardIds, state.cards),
        dockPinned: state.dockPinned,
        selectedProjectPath: state.selectedProjectPath,
        selectedWorktreePath: state.selectedWorktreePath,
        selectedWorktreeLabel: state.selectedWorktreeLabel,
        projectCardOrder: compactProjectCardOrder(state.projectCardOrder, state.cards),
        pinnedCardIds: state.pinnedCardIds,
        notifications: state.notifications,
        notificationCentreOpen: state.notificationCentreOpen,
        osNotificationsEnabled: state.osNotificationsEnabled,
        // AI Supervisor v0.1 (PRD D3) — master switch persisted; default OFF.
        supervisorEnabled: state.supervisorEnabled,
      }),
      version: 19,
      migrate: (persisted) => {
        const state = persisted as Partial<TerminalStore>;
        const nextState = { ...state } as Partial<TerminalStore> & Record<string, unknown>;
        delete nextState.blocks;
        delete nextState.bookmarks;
        delete nextState.collapsedBlockIds;
        delete nextState.selectedBlockId;
        delete nextState.aiExplainDefaultProvider;
        delete nextState.bottomBarHidden;
        const cards = state.cards?.map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          providerSessionState:
            card.providerSessionState ??
            (isProviderSessionType(card.terminalType) ? 'unbound' : undefined),
          autoRestart: prepareAutoRestartForPersistence(card),
        }));
        const archivedCards = (state.archivedCards ?? []).map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          unread: false,
          providerSessionState:
            card.providerSessionState ??
            (isProviderSessionType(card.terminalType) ? 'unbound' : undefined),
          autoRestart: prepareAutoRestartForPersistence(card),
        }));
        const validCardIds = new Set([
          ...(cards ?? []).map((card) => card.id),
          ...archivedCards.map((card) => card.id),
        ]);
        return {
          ...nextState,
          focusedCardId: null,
          // v9 — AI Supervisor master switch defaults to OFF on upgrade.
          supervisorEnabled: state.supervisorEnabled ?? false,
          // v16 — focus-mode session dock metadata.
          recentlyViewedCardIds: compactRecentCardIds(
            state.recentlyViewedCardIds,
            cards ?? [],
          ),
          dockPinned: state.dockPinned ?? false,
          // v12 — project-scoped manual card order. Empty means existing
          // cards are projected in their current store order until the user
          // creates or drags a card in a project view.
          projectCardOrder: compactProjectCardOrder(state.projectCardOrder, cards ?? []),
          // v15 — branch/worktree card filtering state.
          selectedWorktreePath: state.selectedWorktreePath ?? null,
          selectedWorktreeLabel: state.selectedWorktreeLabel ?? null,
          // v13 — archived cards live outside the active card list so existing
          // views and bridge snapshots keep showing only active cards.
          archivedCards,
          // v17 — desktop pet removed; only the OS-notification preference
          //       survives, as a boolean. Read the new field when present,
          //       else fall back to the legacy petConfig (notificationMode
          //       'system'/'both' → on).
          osNotificationsEnabled: readOsNotificationsEnabled(state),
          // v19 — pending terminal edits are persisted separately from cards
          // so save-only never changes active or mobile-visible configuration.
          pendingTerminalConfigurations: compactPendingTerminalConfigurations(
            state.pendingTerminalConfigurations,
            validCardIds,
          ),
          cards,
        };
      },
    },
  ),
);
