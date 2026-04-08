import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type GridLayout = '1x2' | '2x2' | '2x3' | '3x3';

export interface CardSlot {
  slotIndex: number;
  sessionId: string;
  projectId: string;
  provider: string;
  title?: string;
}

export interface MessageSnapshot {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'system';
  text: string;
  streaming?: boolean;
  timestamp: number;
  fromHistory?: boolean;
}

const MAX_SNAPSHOTS_PER_SESSION = 100;

function getMaxSlots(layout: GridLayout): number {
  switch (layout) {
    case '1x2': return 2;
    case '2x2': return 4;
    case '2x3': return 6;
    case '3x3': return 9;
  }
}

interface LiveGridState {
  layout: GridLayout;
  cards: CardSlot[];
  focusedCardId: string | null;
  messageSnapshots: Record<string, MessageSnapshot[]>;

  setLayout: (l: GridLayout) => void;
  addCard: (slot: Omit<CardSlot, 'slotIndex'>) => void;
  removeCard: (sessionId: string) => void;
  swapCards: (a: number, b: number) => void;
  setFocusedCard: (id: string | null) => void;
  setSessionSnapshots: (sessionId: string, snaps: MessageSnapshot[]) => void;
  upsertSnapshot: (sessionId: string, snap: MessageSnapshot) => void;
  completeLastStreamingSnapshot: (sessionId: string) => void;
  updateCardTitle: (sessionId: string, newTitle: string) => void;
  updateCardSessionId: (oldSessionId: string, newSessionId: string) => void;
}

export const useLiveGridStore = create<LiveGridState>()(
  persist(
    (set) => ({
      layout: '2x2',
      cards: [],
      focusedCardId: null,
      messageSnapshots: {},

      setLayout: (l) =>
        set((state) => {
          const maxSlots = getMaxSlots(l);
          const trimmedCards = state.cards.slice(0, maxSlots);
          return { layout: l, cards: trimmedCards };
        }),

      addCard: (slot) =>
        set((state) => {
          if (state.cards.some((c) => c.sessionId === slot.sessionId)) return state;
          const maxSlots = getMaxSlots(state.layout);
          if (state.cards.length >= maxSlots) return state;
          const usedIndices = new Set(state.cards.map((c) => c.slotIndex));
          let nextIndex = 0;
          while (usedIndices.has(nextIndex)) nextIndex++;
          return {
            cards: [...state.cards, { ...slot, slotIndex: nextIndex }],
          };
        }),

      removeCard: (sessionId) =>
        set((state) => ({
          cards: state.cards.filter((c) => c.sessionId !== sessionId),
          focusedCardId: state.focusedCardId === sessionId ? null : state.focusedCardId,
        })),

      swapCards: (a, b) =>
        set((state) => {
          const cards = [...state.cards];
          const cardA = cards.find((c) => c.slotIndex === a);
          const cardB = cards.find((c) => c.slotIndex === b);
          if (cardA) cardA.slotIndex = b;
          if (cardB) cardB.slotIndex = a;
          return { cards };
        }),

      setFocusedCard: (id) => set({ focusedCardId: id }),

      setSessionSnapshots: (sessionId, snaps) =>
        set((state) => ({
          messageSnapshots: {
            ...state.messageSnapshots,
            [sessionId]: snaps,
          },
        })),

      upsertSnapshot: (sessionId, snap) =>
        set((state) => {
          const existing = state.messageSnapshots[sessionId] || [];
          // If the incoming snapshot is streaming AND the last existing snapshot
          // shares the same ID (same logical message), update it in-place.
          if (
            snap.streaming &&
            existing.length > 0 &&
            existing[existing.length - 1].id === snap.id &&
            existing[existing.length - 1].streaming
          ) {
            const updated = [...existing];
            updated[updated.length - 1] = snap;
            return {
              messageSnapshots: {
                ...state.messageSnapshots,
                [sessionId]: updated,
              },
            };
          }
          // Otherwise append as a new message
          const updated = [...existing, snap];
          if (updated.length > MAX_SNAPSHOTS_PER_SESSION) {
            updated.splice(0, updated.length - MAX_SNAPSHOTS_PER_SESSION);
          }
          return {
            messageSnapshots: {
              ...state.messageSnapshots,
              [sessionId]: updated,
            },
          };
        }),

      completeLastStreamingSnapshot: (sessionId) =>
        set((state) => {
          const existing = state.messageSnapshots[sessionId];
          if (!existing || existing.length === 0) return state;
          const lastIdx = existing.length - 1;
          if (!existing[lastIdx].streaming) return state;
          const updated = [...existing];
          updated[lastIdx] = { ...updated[lastIdx], streaming: false };
          return {
            messageSnapshots: {
              ...state.messageSnapshots,
              [sessionId]: updated,
            },
          };
        }),

      updateCardTitle: (sessionId, newTitle) =>
        set((state) => {
          const cardIdx = state.cards.findIndex((c) => c.sessionId === sessionId);
          if (cardIdx === -1) return state;
          const updatedCards = [...state.cards];
          updatedCards[cardIdx] = { ...updatedCards[cardIdx], title: newTitle };
          return { cards: updatedCards };
        }),

      updateCardSessionId: (oldSessionId, newSessionId) =>
        set((state) => {
          const cardIdx = state.cards.findIndex((c) => c.sessionId === oldSessionId);
          if (cardIdx === -1) return state;
          const updatedCards = [...state.cards];
          updatedCards[cardIdx] = { ...updatedCards[cardIdx], sessionId: newSessionId };

          // Migrate existing snapshots from old ID to new ID
          const { [oldSessionId]: oldSnaps, ...restSnaps } = state.messageSnapshots;
          const newSnaps = { ...restSnaps };
          if (oldSnaps && oldSnaps.length > 0) {
            newSnaps[newSessionId] = [
              ...(newSnaps[newSessionId] || []),
              ...oldSnaps,
            ];
          }

          return {
            cards: updatedCards,
            focusedCardId:
              state.focusedCardId === oldSessionId ? newSessionId : state.focusedCardId,
            messageSnapshots: newSnaps,
          };
        }),
    }),
    {
      name: 'openwork-live-grid',
      partialize: (state) => ({
        layout: state.layout,
        cards: state.cards,
      }),
    },
  ),
);
