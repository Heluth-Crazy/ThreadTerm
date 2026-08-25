/**
 * 通知 slice —— 通知中心、OS 通知 / supervisor 偏好，以及系统通知点击后的
 * pending-focus 交接。
 *
 * 通知 acknowledgement (`read`) 与卡片普通 activity (`unread`) 是两套
 * 独立语义；导航、聚焦和卡片生命周期不会隐式改写通知 ledger。
 */
import type { CompletionSignal, NotificationEntry } from '../../types/terminal';
import { NOTIFICATION_READ_RETENTION_MS } from '../../types/terminal';
import {
  CompletionCoordinator,
  retainNotificationHistory,
  sanitizeNotificationSummary,
  type CompletionIngestResult,
} from '../../lib/notificationLedger';
import { DEFAULT_OS_NOTIFICATIONS_ENABLED } from '../../lib/notificationPrefs';
import {
  notifyTerminalPreferencesChanged,
  terminalPreferenceSnapshotFromState,
  uid,
} from './helpers';
import type { NotificationsSlice, TerminalSliceCreator } from './types';

/** 通知定位脉冲的默认时长 —— 需求为 2~3 秒的短暂高亮。 */
export const HIGHLIGHT_TTL_MS = 2400;

/** Derived selectors keep notification acknowledgement separate from card activity. */
export function selectUnreadNotificationsForCard(
  notifications: readonly NotificationEntry[],
  cardId: string,
): NotificationEntry[] {
  return notifications.filter((notification) =>
    notification.cardId === cardId && !notification.read,
  );
}

export function selectUnreadNotificationCountForCard(
  notifications: readonly NotificationEntry[],
  cardId: string,
): number {
  return selectUnreadNotificationsForCard(notifications, cardId).length;
}

export function selectUnreadNotificationCount(
  notifications: readonly NotificationEntry[],
): number {
  return notifications.reduce((count, notification) => count + (notification.read ? 0 : 1), 0);
}

// 高亮过期定时器放在模块作用域：store 只持有可序列化状态
// （见 state-management.md「Persisting Timer-Dependent State」）。
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const completionCoordinator = new CompletionCoordinator();

export const createNotificationsSlice: TerminalSliceCreator<NotificationsSlice> = (set, get) => ({
  notifications: [],
  notificationCentreOpen: false,
  pendingFocusCardId: null,
  pendingLocateCardId: null,
  pendingArchivedNotificationTarget: null,
  highlightCardId: null,
  osNotificationsEnabled: DEFAULT_OS_NOTIFICATIONS_ENABLED,
  osNotificationPreviewEnabled: true,
  agentCliCompatibilityCompletionEnabled: true,
  supervisorEnabled: false,

  setSupervisorEnabled: (enabled) => {
    const snapshot = terminalPreferenceSnapshotFromState({
      ...get(),
      supervisorEnabled: enabled,
    });
    set({ supervisorEnabled: enabled });
    notifyTerminalPreferencesChanged(snapshot);
  },

  setOsNotificationsEnabled: (enabled) => {
    const snapshot = terminalPreferenceSnapshotFromState({
      ...get(),
      osNotificationsEnabled: enabled,
    });
    set({ osNotificationsEnabled: enabled });
    notifyTerminalPreferencesChanged(snapshot);
  },

  setOsNotificationPreviewEnabled: (enabled) => {
    const snapshot = terminalPreferenceSnapshotFromState({
      ...get(),
      osNotificationPreviewEnabled: enabled,
    });
    set({ osNotificationPreviewEnabled: enabled });
    notifyTerminalPreferencesChanged(snapshot);
  },

  setAgentCliCompatibilityCompletionEnabled: (enabled) => {
    const snapshot = terminalPreferenceSnapshotFromState({
      ...get(),
      agentCliCompatibilityCompletionEnabled: enabled,
    });
    set({ agentCliCompatibilityCompletionEnabled: enabled });
    notifyTerminalPreferencesChanged(snapshot);
  },

  pushNotification: (input) => {
    const entry: NotificationEntry = {
      id: uid(),
      at: input.at ?? Date.now(),
      read: false,
      cardId: input.cardId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      routing: input.routing,
    };
    set((state) => {
      const notifications = retainNotificationHistory([entry, ...state.notifications]);
      // mark originating card as unread
      const idx = state.cards.findIndex((c) => c.id === entry.cardId);
      let cards = state.cards;
      if (idx !== -1 && !state.cards[idx].unread) {
        cards = [...state.cards];
        cards[idx] = { ...cards[idx], unread: true };
      }
      return { notifications, cards };
    });
    return entry;
  },

  ingestCompletionSignal: (signal, content) => {
    let result: CompletionIngestResult = { kind: 'ignored' };
    set((state) => {
      const nextResult = completionCoordinator.ingest(
        signal,
        state.notifications,
        (routing): NotificationEntry => ({
          id: uid(),
          at: signal.at,
          read: false,
          cardId: signal.cardId,
          kind: content.kind,
          title: content.title,
          body: sanitizeNotificationSummary(content.body) || content.body,
          routing,
        }),
      );
      result = nextResult;
      if (nextResult.kind === 'ignored') return state;

      const notifications = retainNotificationHistory(
        nextResult.kind === 'inserted'
          ? [nextResult.entry, ...state.notifications]
          : state.notifications.map((entry) =>
              entry.id === nextResult.entry.id ? nextResult.entry : entry,
            ),
      );
      const idx = state.cards.findIndex((card) => card.id === signal.cardId);
      let cards = state.cards;
      if (idx !== -1 && !state.cards[idx].unread) {
        cards = [...state.cards];
        cards[idx] = { ...cards[idx], unread: true };
      }
      return { notifications, cards };
    });
    return result;
  },

  markNotificationRead: (id) =>
    set((state) => {
      const target = state.notifications.find((n) => n.id === id);
      const notifications = retainNotificationHistory(
        target && !target.read
          ? state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n))
          : state.notifications,
      );
      return notifications === state.notifications ? state : { notifications };
    }),

  markTerminalNotificationsRead: (cardId) =>
    set((state) => {
      const notifications = retainNotificationHistory(
        state.notifications.map((notification) =>
          notification.cardId === cardId && !notification.read
            ? { ...notification, read: true }
            : notification,
        ),
      );
      return notifications === state.notifications ? state : { notifications };
    }),

  markAllNotificationsRead: () =>
    set((state) => {
      const notifications = retainNotificationHistory(
        state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
      );
      return notifications === state.notifications ? state : { notifications };
    }),

  clearNotifications: () =>
    set({ notifications: [] }),

  removeNotification: (id) =>
    set((state) => {
      const notifications = state.notifications.filter((n) => n.id !== id);
      return { notifications };
    }),

  purgeReadNotifications: (olderThanMs = NOTIFICATION_READ_RETENTION_MS) => {
    const now = Date.now();
    let removed = 0;
    set((state) => {
      const notifications = retainNotificationHistory(state.notifications, now, olderThanMs);
      removed = state.notifications.length - notifications.length;
      if (removed === 0) return state;
      return { notifications };
    });
    return removed;
  },

  toggleNotificationCentre: (open) =>
    set((state) => ({
      notificationCentreOpen: open ?? !state.notificationCentreOpen,
    })),

  setPendingFocusCardId: (id) => set({ pendingFocusCardId: id }),

  setPendingLocateCardId: (id) => set({ pendingLocateCardId: id }),

  setPendingArchivedNotificationTarget: (target) =>
    set({ pendingArchivedNotificationTarget: target }),

  highlightCard: (id, ttlMs = HIGHLIGHT_TTL_MS) => {
    if (highlightTimer !== null) clearTimeout(highlightTimer);
    set({ highlightCardId: id });
    highlightTimer = setTimeout(() => {
      highlightTimer = null;
      // 仅当仍是本次高亮时才清除，避免误清后续更新的高亮。
      set((state) => (state.highlightCardId === id ? { highlightCardId: null } : state));
    }, ttlMs);
  },

  getUnreadCount: () => selectUnreadNotificationCount(get().notifications),

  getUnreadNotificationCount: (cardId) =>
    selectUnreadNotificationCountForCard(get().notifications, cardId),
});
