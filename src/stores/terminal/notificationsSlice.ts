/**
 * 通知 slice —— 通知中心、OS 通知 / supervisor 偏好，以及系统通知点击后的
 * pending-focus 交接。
 *
 * 标记通知已读时会经共享 `set` 一并清除来源卡片的 `unread` 标志
 * （该字段归 cards slice 所有）。
 */
import type { NotificationEntry } from '../../types/terminal';
import { MAX_NOTIFICATIONS } from '../../types/terminal';
import { DEFAULT_OS_NOTIFICATIONS_ENABLED } from '../../lib/notificationPrefs';
import {
  notifyTerminalPreferencesChanged,
  terminalPreferenceSnapshotFromState,
  uid,
} from './helpers';
import type { NotificationsSlice, TerminalSliceCreator } from './types';

export const createNotificationsSlice: TerminalSliceCreator<NotificationsSlice> = (set, get) => ({
  notifications: [],
  notificationCentreOpen: false,
  pendingFocusCardId: null,
  osNotificationsEnabled: DEFAULT_OS_NOTIFICATIONS_ENABLED,
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

  pushNotification: (input) => {
    const entry: NotificationEntry = {
      id: uid(),
      at: input.at ?? Date.now(),
      read: false,
      cardId: input.cardId,
      kind: input.kind,
      title: input.title,
      body: input.body,
    };
    set((state) => {
      const notifications = [entry, ...state.notifications];
      if (notifications.length > MAX_NOTIFICATIONS) {
        notifications.length = MAX_NOTIFICATIONS;
      }
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

  markNotificationRead: (id) =>
    set((state) => {
      const target = state.notifications.find((n) => n.id === id);
      if (!target) return state;

      const notifications = state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n,
      );
      const cardStillHasUnread = notifications.some(
        (n) => n.cardId === target.cardId && !n.read,
      );
      if (cardStillHasUnread) return { notifications };

      const cards = state.cards.map((card) =>
        card.id === target.cardId && card.unread ? { ...card, unread: false } : card,
      );
      return { notifications, cards };
    }),

  markAllNotificationsRead: () =>
    set((state) => ({
      notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
      cards: state.cards.map((card) => (card.unread ? { ...card, unread: false } : card)),
    })),

  clearNotifications: () =>
    set((state) => ({
      notifications: [],
      cards: state.cards.map((card) => (card.unread ? { ...card, unread: false } : card)),
    })),

  removeNotification: (id) =>
    set((state) => {
      const target = state.notifications.find((n) => n.id === id);
      const notifications = state.notifications.filter((n) => n.id !== id);
      if (!target) return { notifications };
      const cardStillHasUnread = notifications.some(
        (n) => n.cardId === target.cardId && !n.read,
      );
      if (cardStillHasUnread) return { notifications };
      return {
        notifications,
        cards: state.cards.map((card) =>
          card.id === target.cardId && card.unread ? { ...card, unread: false } : card,
        ),
      };
    }),

  purgeReadNotifications: (olderThanMs = 2 * 60 * 60_000) => {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    set((state) => {
      const notifications = state.notifications.filter((n) => {
        if (n.read && n.at < cutoff) {
          removed += 1;
          return false;
        }
        return true;
      });
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

  getUnreadCount: () => get().notifications.filter((n) => !n.read).length,
});
