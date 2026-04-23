/**
 * Terminal Manager Lite — single Zustand store.
 *
 * State split:
 *   • cards / lastActiveCardId / focusedCardId     → persisted metadata
 *   • notifications / centreOpen                   → persisted
 *   • switcherVisible / switcherSelectedIndex      → volatile (not persisted)
 *
 * Output buffers (`lastOutput`, `lastReplyPreview`) are persisted as-is because
 * they're tiny (≤2KB per card) and give the user a useful restart preview
 * until the PTY reconnects and overwrites them.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  NotificationEntry,
  NotificationKind,
  TerminalCard,
  TerminalCreateOptions,
  TerminalEvent,
  TerminalStatus,
} from '../types/terminal';
import {
  MAX_LAST_OUTPUT_LENGTH,
  MAX_NOTIFICATIONS,
  MAX_TIMELINE_EVENTS,
} from '../types/terminal';

// ── helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  // Not security-sensitive; time + random is plenty.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function appendEvent(card: TerminalCard, event: TerminalEvent): TerminalCard {
  const events = [...card.events, event];
  if (events.length > MAX_TIMELINE_EVENTS) {
    events.splice(0, events.length - MAX_TIMELINE_EVENTS);
  }
  return { ...card, events, lastActivity: event.at };
}

function tailJoin(buffer: string, chunk: string, limit: number): string {
  if (!chunk) return buffer;
  const next = buffer + chunk;
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

// Strip ANSI escape sequences + carriage returns for preview purposes.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g; // eslint-disable-line no-control-regex
function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '').replace(/\r/g, '');
}

// ── store shape ──────────────────────────────────────────────────────────────

interface TerminalStore {
  // Cards
  cards: TerminalCard[];
  focusedCardId: string | null;
  lastActiveCardId: string | null;

  // Switcher (volatile)
  switcherVisible: boolean;
  switcherSelectedIndex: number;

  // Notification centre
  notifications: NotificationEntry[];
  notificationCentreOpen: boolean;
  /** Pending cardId to focus once the app regains focus (system-notification click). */
  pendingFocusCardId: string | null;

  // ─── card actions ────────────────────────────────────────────────────────
  createCard: (options: TerminalCreateOptions) => string;
  removeCard: (id: string) => void;
  updateCardOutput: (id: string, chunk: string) => void;
  updateCardStatus: (id: string, status: TerminalStatus) => void;
  updateCardReplyPreview: (id: string, preview: string) => void;
  appendEvent: (id: string, event: Omit<TerminalEvent, 'at'> & { at?: number }) => void;
  incrementMessageCount: (id: string) => void;
  markUnread: (id: string, unread: boolean) => void;

  // ─── focus / switching ───────────────────────────────────────────────────
  focusCard: (id: string | null) => void;
  switchToLast: () => void;
  nextCard: () => void;
  prevCard: () => void;
  jumpToIndex: (i: number) => void;

  // ─── switcher overlay ────────────────────────────────────────────────────
  openSwitcher: () => void;
  closeSwitcher: () => void;
  confirmSwitcher: () => void;
  setSwitcherSelectedIndex: (i: number) => void;

  // ─── notifications ───────────────────────────────────────────────────────
  pushNotification: (n: Omit<NotificationEntry, 'id' | 'at' | 'read'> & { at?: number }) => NotificationEntry;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  removeNotification: (id: string) => void;
  toggleNotificationCentre: (open?: boolean) => void;
  setPendingFocusCardId: (id: string | null) => void;

  // ─── selectors ───────────────────────────────────────────────────────────
  getCardById: (id: string) => TerminalCard | undefined;
  getUnreadCount: () => number;
}

// ── store impl ───────────────────────────────────────────────────────────────

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (set, get) => ({
      cards: [],
      focusedCardId: null,
      lastActiveCardId: null,

      switcherVisible: false,
      switcherSelectedIndex: 0,

      notifications: [],
      notificationCentreOpen: false,
      pendingFocusCardId: null,

      createCard: (options) => {
        const id = uid();
        const now = Date.now();
        const card: TerminalCard = {
          id,
          ptyId: id, // 1:1 by default; Rust side uses the same id
          projectPath: options.projectPath,
          projectName: options.projectName,
          worktreePath: options.worktreePath,
          terminalType: options.terminalType,
          command: options.command,
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
              summary: `Created ${options.terminalType} in ${options.projectName}`,
            },
          ],
          unread: false,
        };
        set((state) => ({ cards: [...state.cards, card] }));
        return id;
      },

      removeCard: (id) =>
        set((state) => {
          const cards = state.cards.filter((c) => c.id !== id);
          const focusedCardId = state.focusedCardId === id ? null : state.focusedCardId;
          const lastActiveCardId =
            state.lastActiveCardId === id ? null : state.lastActiveCardId;
          // also drop notifications targeting this card
          const notifications = state.notifications.filter((n) => n.cardId !== id);
          return { cards, focusedCardId, lastActiveCardId, notifications };
        }),

      updateCardOutput: (id, chunk) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cleaned = stripAnsi(chunk);
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = {
            ...existing,
            lastOutput: tailJoin(existing.lastOutput, cleaned, MAX_LAST_OUTPUT_LENGTH),
            lastActivity: Date.now(),
          };
          return { cards };
        }),

      updateCardStatus: (id, status) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          const existing = cards[idx];
          if (existing.status === status) return state;
          const now = Date.now();
          cards[idx] = appendEvent(
            { ...existing, status, lastActivity: now },
            { at: now, kind: 'status', summary: `status → ${status}` },
          );
          return { cards };
        }),

      updateCardReplyPreview: (id, preview) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          cards[idx] = { ...cards[idx], lastReplyPreview: preview };
          return { cards };
        }),

      appendEvent: (id, event) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          cards[idx] = appendEvent(cards[idx], { at: event.at ?? Date.now(), kind: event.kind, summary: event.summary });
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

      markUnread: (id, unread) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1 || state.cards[idx].unread === unread) return state;
          const cards = [...state.cards];
          cards[idx] = { ...cards[idx], unread };
          return { cards };
        }),

      // ─── focus / switching ────────────────────────────────────────────────
      focusCard: (id) =>
        set((state) => {
          if (state.focusedCardId === id) return state;
          // when leaving a card, remember it as last-active for double-ctrl switching
          const lastActiveCardId =
            state.focusedCardId && state.focusedCardId !== id
              ? state.focusedCardId
              : state.lastActiveCardId;
          // mark the newly focused card as read
          let cards = state.cards;
          if (id) {
            const idx = state.cards.findIndex((c) => c.id === id);
            if (idx !== -1 && state.cards[idx].unread) {
              cards = [...state.cards];
              cards[idx] = { ...cards[idx], unread: false };
            }
          }
          return { focusedCardId: id, lastActiveCardId, cards };
        }),

      switchToLast: () => {
        const { lastActiveCardId, focusedCardId, cards } = get();
        if (!lastActiveCardId || lastActiveCardId === focusedCardId) return;
        if (!cards.some((c) => c.id === lastActiveCardId)) return;
        get().focusCard(lastActiveCardId);
      },

      nextCard: () => {
        const { cards, focusedCardId } = get();
        if (cards.length === 0) return;
        const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : -1;
        const next = cards[(i + 1 + cards.length) % cards.length];
        get().focusCard(next.id);
      },

      prevCard: () => {
        const { cards, focusedCardId } = get();
        if (cards.length === 0) return;
        const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : 0;
        const prev = cards[(i - 1 + cards.length) % cards.length];
        get().focusCard(prev.id);
      },

      jumpToIndex: (i) => {
        const { cards } = get();
        if (i < 0 || i >= cards.length) return;
        get().focusCard(cards[i].id);
      },

      // ─── switcher overlay ─────────────────────────────────────────────────
      openSwitcher: () =>
        set((state) => {
          if (state.switcherVisible) return state;
          const focusIndex = state.focusedCardId
            ? Math.max(0, state.cards.findIndex((c) => c.id === state.focusedCardId))
            : 0;
          return { switcherVisible: true, switcherSelectedIndex: focusIndex };
        }),

      closeSwitcher: () =>
        set((state) => (state.switcherVisible ? { switcherVisible: false } : state)),

      confirmSwitcher: () => {
        const { switcherVisible, switcherSelectedIndex, cards } = get();
        if (!switcherVisible) return;
        const card = cards[switcherSelectedIndex];
        if (card) get().focusCard(card.id);
        set({ switcherVisible: false });
      },

      setSwitcherSelectedIndex: (i) =>
        set((state) => {
          if (state.cards.length === 0) return state;
          const idx = ((i % state.cards.length) + state.cards.length) % state.cards.length;
          return { switcherSelectedIndex: idx };
        }),

      // ─── notifications ────────────────────────────────────────────────────
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
        set((state) => ({
          notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        })),

      markAllNotificationsRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
        })),

      clearNotifications: () => set({ notifications: [] }),

      removeNotification: (id) =>
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id),
        })),

      toggleNotificationCentre: (open) =>
        set((state) => ({
          notificationCentreOpen: open ?? !state.notificationCentreOpen,
        })),

      setPendingFocusCardId: (id) => set({ pendingFocusCardId: id }),

      // ─── selectors ────────────────────────────────────────────────────────
      getCardById: (id) => get().cards.find((c) => c.id === id),
      getUnreadCount: () => get().notifications.filter((n) => !n.read).length,
    }),
    {
      name: 'terminal-manager-lite',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        cards: state.cards,
        focusedCardId: state.focusedCardId,
        lastActiveCardId: state.lastActiveCardId,
        notifications: state.notifications,
        notificationCentreOpen: state.notificationCentreOpen,
      }),
      version: 1,
    },
  ),
);
