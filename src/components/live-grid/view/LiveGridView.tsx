import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import LiveGridToolbar from './LiveGridToolbar';
import CardGrid from './CardGrid';
import LiveGridFocusedLayout from './LiveGridFocusedLayout';
import { useLiveGridStore } from '../../../stores/liveGridStore';
import { useSessionStatusStore } from '../../../stores/sessionStatusStore';
import { useMultiSessionDispatcher } from '../../../hooks/useMultiSessionDispatcher';
import type { Project } from '../../../types/app';

type LiveGridViewProps = {
  projects: Project[];
  onNewSession: () => void;
};

export default function LiveGridView({ projects, onNewSession }: LiveGridViewProps) {
  const { t } = useTranslation('common');
  const layout = useLiveGridStore((s) => s.layout);
  const setLayout = useLiveGridStore((s) => s.setLayout);
  const focusedCardId = useLiveGridStore((s) => s.focusedCardId);
  const cards = useLiveGridStore((s) => s.cards);

  const [filter, setFilter] = useState('all');

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

  // Count statuses for footer
  const statuses = useSessionStatusStore((s) => s.statuses);
  const cardSessionIds = new Set(cards.map((c) => c.sessionId));
  let processingCount = 0;
  let attentionCount = 0;
  let completedCount = 0;
  let idleCount = 0;
  for (const sid of cardSessionIds) {
    const entry = statuses[sid];
    if (!entry || entry.status === 'idle') idleCount++;
    else if (entry.status === 'processing') processingCount++;
    else if (entry.status === 'needs_attention') attentionCount++;
    else if (entry.status === 'completed') completedCount++;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
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

          <CardGrid projects={projects} filter={filter} onSend={handleSend} />

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
            {cardSessionIds.size === 0 && (
              <span>{t('liveGrid.emptySlot')}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
