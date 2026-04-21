import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import LiveGridToolbar from './LiveGridToolbar';
import CardGrid from './CardGrid';
import LiveGridFocusedLayout from './LiveGridFocusedLayout';
import { useLiveGridStore } from '../../../stores/liveGridStore';
import { useSessionStatusStore } from '../../../stores/sessionStatusStore';
import { useMultiSessionDispatcher } from '../../../hooks/useMultiSessionDispatcher';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget } from '../../../lib/mission-control';
import type { Project } from '../../../types/app';
import type { GridLayout } from '../../../stores/liveGridStore';

function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function getColCount(layout: GridLayout): number {
  switch (layout) {
    case '1x2': return 2;
    case '2x2': return 2;
    case '2x3': return 3;
    case '3x3': return 3;
  }
}

type LiveGridViewProps = {
  projects: Project[];
  onNewSession: () => void;
  onOpenTaskQueue?: (projectPath?: string) => void;
  onOpenSessionById?: (sessionId: string) => void;
  onOpenMissionControlSurface?: (target: MissionControlSurfaceTarget, locator?: MissionControlSurfaceLocator) => void;
};

export default function LiveGridView({
  projects,
  onNewSession,
  onOpenTaskQueue,
  onOpenSessionById,
  onOpenMissionControlSurface,
}: LiveGridViewProps) {
  const { t } = useTranslation('common');
  const layout = useLiveGridStore((s) => s.layout);
  const setLayout = useLiveGridStore((s) => s.setLayout);
  const focusedCardId = useLiveGridStore((s) => s.focusedCardId);
  const setFocusedCard = useLiveGridStore((s) => s.setFocusedCard);
  const cards = useLiveGridStore((s) => s.cards);

  const [filter, setFilter] = useState('all');
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  // Initialize the multi-session dispatcher at the top level
  const { sendToSession } = useMultiSessionDispatcher();

  const handleSend = useCallback(
    (sessionId: string, text: string, projectPath: string, provider: string) => {
      sendToSession(sessionId, text, {
        projectPath,
        provider,
      });
    },
    [sendToSession],
  );

  // Filtered cards sorted by slot index for keyboard navigation
  const filledCards = useMemo(() => {
    const filtered = filter === 'all' ? cards : cards.filter((c) => c.provider === filter);
    return [...filtered].sort((a, b) => a.slotIndex - b.slotIndex);
  }, [cards, filter]);

  const colCount = getColCount(layout);

  // Reset focus index when cards change and current index is out of bounds
  useEffect(() => {
    if (focusedIndex >= filledCards.length) {
      setFocusedIndex(filledCards.length > 0 ? filledCards.length - 1 : -1);
    }
  }, [filledCards.length, focusedIndex]);

  // Keyboard navigation for grid cards
  useEffect(() => {
    if (focusedCardId) return; // Don't navigate when in focused mode

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;

      const count = filledCards.length;
      if (count === 0) return;

      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault();
          setFocusedIndex((i) => (i < 0 ? 0 : Math.min(i + 1, count - 1)));
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          setFocusedIndex((i) => (i < 0 ? 0 : Math.max(i - 1, 0)));
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          setFocusedIndex((i) => {
            if (i < 0) return 0;
            const currentSlot = filledCards[i].slotIndex;
            const targetSlot = currentSlot + colCount;
            let closest = i;
            let minDist = Infinity;
            for (let j = i + 1; j < count; j++) {
              const dist = Math.abs(filledCards[j].slotIndex - targetSlot);
              if (dist < minDist) {
                minDist = dist;
                closest = j;
              }
            }
            return closest;
          });
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setFocusedIndex((i) => {
            if (i < 0) return 0;
            const currentSlot = filledCards[i].slotIndex;
            const targetSlot = currentSlot - colCount;
            if (targetSlot < 0) return i;
            let closest = i;
            let minDist = Infinity;
            for (let j = i - 1; j >= 0; j--) {
              const dist = Math.abs(filledCards[j].slotIndex - targetSlot);
              if (dist < minDist) {
                minDist = dist;
                closest = j;
              }
            }
            return closest;
          });
          break;
        }
        case 'Enter':
        case ' ': {
          if (focusedIndex >= 0 && focusedIndex < count) {
            e.preventDefault();
            setFocusedCard(filledCards[focusedIndex].sessionId);
          }
          break;
        }
        case 'Escape': {
          if (focusedIndex >= 0) {
            e.preventDefault();
            setFocusedIndex(-1);
          }
          break;
        }
        case 'Tab': {
          e.preventDefault();
          if (e.shiftKey) {
            setFocusedIndex((i) => (i <= 0 ? count - 1 : i - 1));
          } else {
            setFocusedIndex((i) => (i < 0 || i >= count - 1 ? 0 : i + 1));
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusedCardId, filledCards, colCount, focusedIndex, setFocusedCard]);

  // Determine the focused session ID from the index
  const focusedSessionId = focusedIndex >= 0 && focusedIndex < filledCards.length
    ? filledCards[focusedIndex].sessionId
    : null;

  // Count statuses for footer — avoid subscribing to entire statuses object
  const processingCount = useSessionStatusStore((s) =>
    cards.filter((c) => s.statuses[c.sessionId]?.status === 'processing').length,
  );
  const attentionCount = useSessionStatusStore((s) =>
    cards.filter((c) => s.statuses[c.sessionId]?.status === 'needs_attention').length,
  );
  const completedCount = useSessionStatusStore((s) =>
    cards.filter((c) => s.statuses[c.sessionId]?.status === 'completed').length,
  );
  const idleCount = cards.length - processingCount - attentionCount - completedCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {focusedCardId ? (
        <LiveGridFocusedLayout projects={projects} />
      ) : (
        <>
          <LiveGridToolbar
            layout={layout}
            onLayoutChange={setLayout}
            filter={filter}
            onFilterChange={setFilter}
            onNewSession={onNewSession}
          />

          <CardGrid
            projects={projects}
            filter={filter}
            onSend={handleSend}
            focusedSessionId={focusedSessionId}
            onOpenTaskQueue={onOpenTaskQueue}
            onOpenSessionById={onOpenSessionById}
            onOpenMissionControlSurface={onOpenMissionControlSurface}
          />

          {/* Status footer */}
          <div className="flex items-center gap-4 border-t border-border/60 bg-card/70 px-4 py-1.5 text-[11px] text-muted-foreground">
            {processingCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full border border-blue-500 border-t-transparent" style={{ animation: 'spin 0.8s linear infinite' }} />
                {processingCount} {t('liveGrid.status.processing')}
              </span>
            )}
            {attentionCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                {attentionCount} {t('liveGrid.status.needsAttention')}
              </span>
            )}
            {completedCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {completedCount} {t('liveGrid.status.completed')}
              </span>
            )}
            {idleCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                {idleCount} {t('liveGrid.status.idle')}
              </span>
            )}
            {cards.length === 0 && (
              <span>{t('liveGrid.emptySlot')}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
