import { useEffect, useRef } from 'react';
import { useAttentionStore } from '../stores/attentionStore';
import { useLiveGridStore } from '../stores/liveGridStore';
import { useToastStore } from '../stores/toastStore';

const WORKBENCH_STORAGE_KEY = 'openwork.workbench';

function getActiveWorkbenchNav(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKBENCH_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { activeNav?: string };
    return typeof parsed.activeNav === 'string' ? parsed.activeNav : null;
  } catch {
    return null;
  }
}

/**
 * Phase 1 batch 1: Mission Control / Attention Inbox is now the primary surface.
 * This hook is intentionally demoted to a narrow Live Grid convenience bridge:
 * it only emits a lightweight toast when a newly-arrived high-risk approval item
 * already has a corresponding Live Grid card and the user is already in Live Grid.
 * It must not hijack navigation or force-focus a card from Mission Control.
 */
export function useAttentionRouter() {
  const previousActiveIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = useAttentionStore.subscribe((state) => {
      const activeItems = Object.values(state.attentionItems)
        .filter((item) => item.status === 'active');
      const currentIds = new Set(activeItems.map((item) => item.id));
      const cards = useLiveGridStore.getState().cards;
      const focusedCardId = useLiveGridStore.getState().focusedCardId;
      const addToast = useToastStore.getState().addToast;
      const activeNav = getActiveWorkbenchNav();

      for (const item of activeItems) {
        const isNew = !previousActiveIds.current.has(item.id);
        const shouldNudgeLiveGrid = isNew && item.kind === 'approval' && item.riskLevel === 'high';
        if (!shouldNudgeLiveGrid || activeNav !== 'livegrid') continue;

        const card = cards.find((candidate) => candidate.sessionId === item.sessionId);
        if (!card || focusedCardId === card.sessionId) {
          continue;
        }

        addToast(`Session ${card.title ?? card.sessionId} requires approval in Live Grid.`, 'warning', 3000);
      }

      previousActiveIds.current = currentIds;
    });

    return unsubscribe;
  }, []);
}
