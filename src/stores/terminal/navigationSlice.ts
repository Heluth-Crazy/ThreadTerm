/**
 * 导航 slice —— 聚焦模式、卡片切换、session dock 最近浏览，以及全局悬浮
 * selector 的置顶列表。
 *
 * 聚焦卡片时只清除普通 activity 的 `cards.unread` 标记；通知条目必须由
 * 用户明确点击/确认后才能标记已读。
 */
import type { TerminalCard } from '../../types/terminal';
import { cardsForProjectView, recentCardIdsAfterFocus } from './helpers';
import type { NavigationSlice, TerminalSliceCreator } from './types';
import { MAX_PINNED_CARDS } from './types';

export const createNavigationSlice: TerminalSliceCreator<NavigationSlice> = (set, get) => ({
  focusedCardId: null,
  lastActiveCardId: null,
  recentlyViewedCardIds: [],
  dockPinned: false,
  pinnedCardIds: [],

  focusCard: (id) =>
    set((state) => {
      if (state.focusedCardId === id) {
        if (!id) return state;
        const recentlyViewedCardIds = recentCardIdsAfterFocus(
          state.recentlyViewedCardIds,
          id,
          state.cards,
        );
        const recentChanged = recentlyViewedCardIds !== state.recentlyViewedCardIds;
        let changed = false;
        const cards = state.cards.map((card) => {
          if (card.id !== id || !card.unread) return card;
          changed = true;
          return { ...card, unread: false };
        });
        return changed || recentChanged
          ? { cards, recentlyViewedCardIds }
          : state;
      }
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
      return {
        focusedCardId: id,
        lastActiveCardId,
        cards,
        recentlyViewedCardIds: recentCardIdsAfterFocus(
          state.recentlyViewedCardIds,
          id,
          state.cards,
        ),
      };
    }),

  toggleDockPin: () => set((state) => ({ dockPinned: !state.dockPinned })),

  switchToLast: () => {
    const { lastActiveCardId, focusedCardId, cards } = get();
    if (!lastActiveCardId || lastActiveCardId === focusedCardId) return;
    if (!cards.some((c) => c.id === lastActiveCardId)) return;
    get().focusCard(lastActiveCardId);
  },

  nextCard: () => {
    const state = get();
    const { focusedCardId } = state;
    const cards = cardsForProjectView(
      state.cards,
      state.projectCardOrder,
      state.selectedProjectPath,
      state.selectedWorktreePath,
    );
    if (cards.length === 0) return;
    const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : -1;
    const next = cards[(i + 1 + cards.length) % cards.length];
    get().focusCard(next.id);
  },

  prevCard: () => {
    const state = get();
    const { focusedCardId } = state;
    const cards = cardsForProjectView(
      state.cards,
      state.projectCardOrder,
      state.selectedProjectPath,
      state.selectedWorktreePath,
    );
    if (cards.length === 0) return;
    const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : 0;
    const prev = cards[(i - 1 + cards.length) % cards.length];
    get().focusCard(prev.id);
  },

  jumpToIndex: (i) => {
    const state = get();
    const cards = cardsForProjectView(
      state.cards,
      state.projectCardOrder,
      state.selectedProjectPath,
      state.selectedWorktreePath,
    );
    if (i < 0 || i >= cards.length) return;
    get().focusCard(cards[i].id);
  },

  pinCard: (id) => {
    const state = get();
    if (state.pinnedCardIds.includes(id)) return true;
    if (state.pinnedCardIds.length >= MAX_PINNED_CARDS) return false;
    set({ pinnedCardIds: [...state.pinnedCardIds, id] });
    return true;
  },

  unpinCard: (id) =>
    set((state) => ({
      pinnedCardIds: state.pinnedCardIds.filter((p) => p !== id),
    })),

  movePinned: (id, toIndex) =>
    set((state) => {
      const from = state.pinnedCardIds.indexOf(id);
      if (from === -1) return state;
      const next = state.pinnedCardIds.slice();
      next.splice(from, 1);
      const target = Math.max(0, Math.min(next.length, toIndex));
      next.splice(target, 0, id);
      return { pinnedCardIds: next };
    }),

  isPinned: (id) => get().pinnedCardIds.includes(id),

  getPinnedCards: () => {
    const { cards, pinnedCardIds } = get();
    return pinnedCardIds
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is TerminalCard => !!c);
  },
});
