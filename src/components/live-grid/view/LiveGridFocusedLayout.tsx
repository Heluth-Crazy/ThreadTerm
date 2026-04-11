import { useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import ChatPanel from '../../chat/ChatPanel';
import SessionProviderLogo from '../../SessionProviderLogo';
import { useLiveGridStore } from '../../../stores/liveGridStore';
import { useSessionStatusStore } from '../../../stores/sessionStatusStore';
import { useWebSocket } from '../../../contexts/TauriEventContext';
import type { Project, ProjectSession } from '../../../types/app';
import type { SessionRuntimeStatus } from '../../../stores/sessionStatusStore';

type LiveGridFocusedLayoutProps = {
  projects: Project[];
};

function ThumbnailCard({
  sessionId,
  provider,
  title,
  isCurrent,
  onClick,
}: {
  sessionId: string;
  provider: string;
  title: string;
  isCurrent: boolean;
  onClick: () => void;
}) {
  const status: SessionRuntimeStatus = useSessionStatusStore(
    (s) => s.statuses[sessionId]?.status ?? 'idle',
  );

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
        isCurrent
          ? 'border-foreground/20 bg-foreground/5'
          : 'border-border/50 bg-card/70 hover:bg-muted/50'
      }`}
    >
      <SessionProviderLogo provider={provider} className="h-3.5 w-3.5" />
      <span className="max-w-[120px] truncate text-foreground">{title}</span>
      {status === 'processing' && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full border border-blue-500 border-t-transparent"
          style={{ animation: 'spin 0.8s linear infinite' }}
        />
      )}
      {status === 'needs_attention' && (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
      )}
    </button>
  );
}

export default function LiveGridFocusedLayout({ projects }: LiveGridFocusedLayoutProps) {
  const { t } = useTranslation('common');
  const { sendMessage, latestMessage, messageSequence, getBufferedMessagesSince } = useWebSocket();

  const focusedCardId = useLiveGridStore((s) => s.focusedCardId);
  const cards = useLiveGridStore((s) => s.cards);
  const setFocusedCard = useLiveGridStore((s) => s.setFocusedCard);

  const focusedCard = cards.find((c) => c.sessionId === focusedCardId);

  // Esc to exit focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocusedCard(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setFocusedCard]);

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.name, p])), [projects]);

  const findProject = useCallback(
    (projectId: string): Project | undefined => projectMap.get(projectId),
    [projectMap],
  );

  const findSession = useCallback(
    (sessionId: string, projectId: string): ProjectSession | null => {
      const project = projectMap.get(projectId);
      if (!project) return null;
      const allSessions: ProjectSession[] = [
        ...(project.sessions || []),
        ...(project.codexSessions || []),
      ];
      return allSessions.find((s) => s.id === sessionId) || null;
    },
    [projectMap],
  );

  const findSessionTitle = (sessionId: string, projectId: string): string => {
    const session = findSession(sessionId, projectId);
    return session?.title || 'Untitled';
  };

  if (!focusedCard) return null;

  const selectedProject = findProject(focusedCard.projectId);
  const selectedSession = findSession(focusedCard.sessionId, focusedCard.projectId);

  if (!selectedProject) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Top: full ChatPanel */}
      <div className="relative flex-[7] min-h-0 overflow-hidden">
        <ChatPanel
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          messageSequence={messageSequence}
          getBufferedMessagesSince={getBufferedMessagesSince}
        />

        {/* Close button */}
        <button
          type="button"
          onClick={() => setFocusedCard(null)}
          className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          title={t('liveGrid.exitFocus')}
        >
          <X className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Esc</span>
        </button>
      </div>

      {/* Bottom: thumbnail strip */}
      <div className="flex flex-[3] min-h-0 items-center gap-2 overflow-x-auto border-t border-border/60 bg-card/50 px-3 py-2">
        {cards.map((card) => (
          <ThumbnailCard
            key={card.sessionId}
            sessionId={card.sessionId}
            provider={card.provider}
            title={findSessionTitle(card.sessionId, card.projectId)}
            isCurrent={card.sessionId === focusedCardId}
            onClick={() => setFocusedCard(card.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}
