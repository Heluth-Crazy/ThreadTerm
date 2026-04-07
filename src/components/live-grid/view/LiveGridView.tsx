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
            {cards.length === 0 && (
              <span>{t('liveGrid.emptySlot')}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
