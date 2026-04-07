import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';

import LiveCard from './LiveCard';
import { useLiveGridStore } from '../../../stores/liveGridStore';
import type { GridLayout } from '../../../stores/liveGridStore';
import type { Project, ProjectSession } from '../../../types/app';

type CardGridProps = {
  projects: Project[];
  filter: string;
  onSend: (sessionId: string, text: string, projectPath: string, provider: string) => void;
};

function getGridCols(layout: GridLayout): string {
  switch (layout) {
    case '1x2': return 'grid-cols-2';
    case '2x2': return 'grid-cols-2';
    case '2x3': return 'grid-cols-3';
    case '3x3': return 'grid-cols-3';
  }
}

function getGridRows(layout: GridLayout): string {
  switch (layout) {
    case '1x2': return 'grid-rows-1';
    case '2x2': return 'grid-rows-2';
    case '2x3': return 'grid-rows-2';
    case '3x3': return 'grid-rows-3';
  }
}

function getMaxSlots(layout: GridLayout): number {
  switch (layout) {
    case '1x2': return 2;
    case '2x2': return 4;
    case '2x3': return 6;
    case '3x3': return 9;
  }
}

type SessionOption = {
  sessionId: string;
  projectId: string;
  provider: string;
  title: string;
  projectName: string;
};

function getAllSessions(projects: Project[]): SessionOption[] {
  const result: SessionOption[] = [];
  for (const project of projects) {
    for (const session of project.sessions || []) {
      result.push({
        sessionId: session.id,
        projectId: project.name,
        provider: session.__provider || 'claude',
        title: session.title || 'Untitled',
        projectName: project.name,
      });
    }
    for (const session of project.codexSessions || []) {
      result.push({
        sessionId: session.id,
        projectId: project.name,
        provider: session.__provider || 'codex',
        title: session.title || 'Untitled',
        projectName: project.name,
      });
    }
  }
  return result;
}

function EmptyCardSlot({
  projects,
  existingSessionIds,
}: {
  projects: Project[];
  existingSessionIds: Set<string>;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const addCard = useLiveGridStore((s) => s.addCard);
  const popoverRef = useRef<HTMLDivElement>(null);

  const allSessions = getAllSessions(projects);
  const available = allSessions.filter((s) => !existingSessionIds.has(s.sessionId));

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleSelect = useCallback(
    (opt: SessionOption) => {
      addCard({
        sessionId: opt.sessionId,
        projectId: opt.projectId,
        provider: opt.provider,
      });
      setOpen(false);
    },
    [addCard],
  );

  return (
    <div className="relative flex items-center justify-center rounded-xl border-2 border-dashed border-border/40 bg-muted/20 transition-colors hover:border-border/60 hover:bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex flex-col items-center gap-1.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        <Plus className="h-5 w-5" />
        <span className="text-xs">{t('liveGrid.emptySlot')}</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-64 max-h-64 overflow-y-auto rounded-xl border border-border/60 bg-card shadow-lg"
        >
          {available.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No available sessions
            </div>
          ) : (
            available.map((opt) => (
              <button
                key={opt.sessionId}
                type="button"
                onClick={() => handleSelect(opt)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50"
              >
                <span className="truncate font-medium text-foreground">{opt.title}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {opt.projectName}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function CardGrid({ projects, filter, onSend }: CardGridProps) {
  const layout = useLiveGridStore((s) => s.layout);
  const cards = useLiveGridStore((s) => s.cards);

  const maxSlots = getMaxSlots(layout);
  const existingSessionIds = new Set(cards.map((c) => c.sessionId));

  // Apply filter
  const filteredCards = filter === 'all'
    ? cards
    : cards.filter((c) => c.provider === filter);

  // Build a map of projectId (name) → project for quick lookup
  const projectMap = new Map(projects.map((p) => [p.name, p]));

  // Find session title helper
  const findSessionTitle = (sessionId: string, projectId: string): string => {
    const project = projectMap.get(projectId);
    if (!project) return 'Unknown';
    const allSessions: ProjectSession[] = [
      ...(project.sessions || []),
      ...(project.codexSessions || []),
    ];
    const session = allSessions.find((s) => s.id === sessionId);
    return session?.title || 'Untitled';
  };

  const findProjectPath = (projectId: string): string => {
    const project = projectMap.get(projectId);
    return project?.path || '';
  };

  // Render slots: fill with cards by slotIndex, rest are empty
  const slots = Array.from({ length: maxSlots }, (_, i) => {
    const card = filteredCards.find((c) => c.slotIndex === i);
    return card || null;
  });

  return (
    <div className={`grid ${getGridCols(layout)} ${getGridRows(layout)} flex-1 gap-2 p-2`}>
      {slots.map((card, i) =>
        card ? (
          <LiveCard
            key={card.sessionId}
            sessionId={card.sessionId}
            projectId={card.projectId}
            provider={card.provider}
            sessionTitle={findSessionTitle(card.sessionId, card.projectId)}
            projectPath={findProjectPath(card.projectId)}
            onSend={onSend}
          />
        ) : (
          <EmptyCardSlot
            key={`empty-${i}`}
            projects={projects}
            existingSessionIds={existingSessionIds}
          />
        ),
      )}
    </div>
  );
}
