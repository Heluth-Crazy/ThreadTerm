import { useEffect, useRef } from 'react';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import { useLiveGridStore } from '../stores/liveGridStore';

/**
 * Attention router: watches for sessions that need attention
 * and auto-focuses the corresponding LiveGrid card.
 *
 * Also plays a notification sound when a session transitions
 * to needs_attention state.
 */
export function useAttentionRouter() {
  const previousStatuses = useRef<Record<string, string>>({});

  useEffect(() => {
    const unsubscribe = useSessionStatusStore.subscribe((state) => {
      const currentStatuses = state.statuses;
      const cards = useLiveGridStore.getState().cards;
      const setFocusedCard = useLiveGridStore.getState().setFocusedCard;

      for (const [sessionId, entry] of Object.entries(currentStatuses)) {
        const prevStatus = previousStatuses.current[sessionId];

        // Detect transition INTO needs_attention
        if (
          entry.status === 'needs_attention' &&
          prevStatus !== 'needs_attention'
        ) {
          // Auto-focus the card if it exists in the grid
          const card = cards.find((c) => c.sessionId === sessionId);
          if (card) {
            setFocusedCard(card.sessionId);
          }
        }
      }

      // Snapshot current statuses
      const snapshot: Record<string, string> = {};
      for (const [id, entry] of Object.entries(currentStatuses)) {
        snapshot[id] = entry.status;
      }
      previousStatuses.current = snapshot;
    });

    return unsubscribe;
  }, []);
}
