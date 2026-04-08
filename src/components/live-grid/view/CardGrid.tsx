import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search, MessageCircle, Code2 } from 'lucide-react';

import LiveCard from './LiveCard';
import { useLiveGridStore } from '../../../stores/liveGridStore';
import { useSessionStatusStore } from '../../../stores/sessionStatusStore';
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
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('__all__');
  const addCard = useLiveGridStore((s) => s.addCard);
  const statuses = useSessionStatusStore((s) => s.statuses);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allSessions = getAllSessions(projects);
  const available = useMemo(() => {
    let list = allSessions.filter((s) => !existingSessionIds.has(s.sessionId));
    if (projectFilter !== '__all__') {
      list = list.filter((s) => s.projectName === projectFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.projectName.toLowerCase().includes(q),
      );
    }
    return list;
  }, [allSessions, existingSessionIds, projectFilter, search]);

  const projectNames = useMemo(
    () => [...new Set(allSessions.map((s) => s.projectName))].sort(),
    [allSessions],
  );

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

  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus();
    }
    if (!open) {
      setSearch('');
      setProjectFilter('__all__');
    }
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

  const statusDot = (sessionId: string) => {
    const entry = statuses[sessionId];
    const st = entry?.status ?? 'idle';
    const color =
      st === 'needs_attention'
        ? 'bg-red-500 animate-pulse'
        : st === 'processing'
          ? 'bg-blue-500'
          : st === 'completed'
            ? 'bg-emerald-500'
            : 'bg-muted-foreground/40';
    return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
  };

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
          className="absolute top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-72 max-h-80 flex flex-col rounded-xl border border-border/60 bg-card shadow-lg"
        >
          {/* Search */}
          <div className="flex items-center gap-1.5 border-b border-border/40 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('liveGrid.searchSessions', 'Search sessions…')}
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none"
            />
          </div>

          {/* Project filter */}
          {projectNames.length > 1 && (
            <div className="border-b border-border/40 px-2.5 py-1.5">
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="w-full rounded-md bg-muted/40 px-2 py-1 text-[10px] text-foreground outline-none"
              >
                <option value="__all__">{t('liveGrid.allProjects', 'All Projects')}</option>
                {projectNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Session list */}
          <div className="flex-1 overflow-y-auto">
            {available.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t('liveGrid.noAvailableSessions', 'No available sessions')}
              </div>
            ) : (
              available.map((opt) => (
                <button
                  key={opt.sessionId}
                  type="button"
                  onClick={() => handleSelect(opt)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50"
                >
                  {opt.provider === 'codex' ? (
                    <Code2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                  ) : (
                    <MessageCircle className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                  )}
                  <span className="truncate font-medium text-foreground">{opt.title}</span>
                  {statusDot(opt.sessionId)}
                  <span
                    className={`ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white ${
                      opt.provider === 'codex' ? 'bg-blue-600' : 'bg-violet-600'
                    }`}
                  >
                    {opt.provider}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {opt.projectName}
                  </span>
                </button>
              ))
            )}
          </div>
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

  // Find session title helper — prefer renamed title from project state, fallback to card title
  const findSessionTitle = (sessionId: string, projectId: string): string => {
    const project = projectMap.get(projectId);
    if (!project) return 'Unknown';
    const allSessions: ProjectSession[] = [
      ...(project.sessions || []),
      ...(project.codexSessions || []),
    ];
    const session = allSessions.find((s) => s.id === sessionId);
    if (session?.title) return session.title;
    // Fallback to card stored title
    const card = cards.find((c) => c.sessionId === sessionId);
    return card?.title || sessionId.slice(0, 8);
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
