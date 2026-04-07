import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Trash2 } from 'lucide-react';
import { useSessionStatusStore } from '../../stores/sessionStatusStore';
import type { Project, ProjectSession, SessionProvider } from '../../types/app';
import SessionCard from '../overview/SessionCard';

type SortMode = 'time' | 'status';

interface ProjectSessionsPanelProps {
  project: Project;
  selectedSession: ProjectSession | null;
  onSelectSession: (project: Project, session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
  onDeleteSession?: (projectName: string, sessionId: string, provider: SessionProvider) => void;
  onViewProjectDetail?: () => void;
}

const STATUS_ORDER: Record<string, number> = {
  needs_attention: 0,
  processing: 1,
  completed: 2,
  idle: 3,
};

export default function ProjectSessionsPanel({
  project,
  selectedSession,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onViewProjectDetail,
}: ProjectSessionsPanelProps) {
  const { t } = useTranslation('common');
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const statuses = useSessionStatusStore((s) => s.statuses);

  const allSessions = useMemo(() => {
    const claude = (project.sessions ?? []).map((s) => ({
      ...s,
      __provider: s.__provider ?? ('claude' as const),
    }));
    const codex = (project.codexSessions ?? []).map((s) => ({
      ...s,
      __provider: s.__provider ?? ('codex' as const),
    }));
    return [...claude, ...codex];
  }, [project.sessions, project.codexSessions]);

  const sortedSessions = useMemo(() => {
    const list = [...allSessions];

    if (sortMode === 'status') {
      list.sort((a, b) => {
        const sa = statuses[a.id]?.status ?? 'idle';
        const sb = statuses[b.id]?.status ?? 'idle';
        const pa = STATUS_ORDER[sa] ?? 3;
        const pb = STATUS_ORDER[sb] ?? 3;
        if (pa !== pb) return pa - pb;
        const ta = new Date(a.lastActivity || a.updated_at || a.createdAt || 0).getTime();
        const tb = new Date(b.lastActivity || b.updated_at || b.createdAt || 0).getTime();
        return tb - ta;
      });
    } else {
      list.sort((a, b) => {
        const ta = new Date(a.lastActivity || a.updated_at || a.createdAt || 0).getTime();
        const tb = new Date(b.lastActivity || b.updated_at || b.createdAt || 0).getTime();
        return tb - ta;
      });
    }

    return list;
  }, [allSessions, sortMode, statuses]);

  const providerLabel = allSessions.some((s) => s.__provider === 'codex')
    ? allSessions.every((s) => s.__provider === 'codex')
      ? 'codex'
      : 'mixed'
    : 'claude';

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-border/50 bg-background/30">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white ${
              providerLabel === 'codex' ? 'bg-blue-600' : 'bg-violet-600'
            }`}
          >
            {providerLabel === 'mixed' ? '⚡' : providerLabel}
          </span>
          <span className="truncate text-sm font-medium text-foreground">
            {project.displayName || project.name}
          </span>
          <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground ml-auto">
            {allSessions.length}
          </span>
          {onViewProjectDetail && (
            <button
              type="button"
              onClick={onViewProjectDetail}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              title={t('buttons.details', 'Details')}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onNewSession(project)}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            title={t('sessions.startSession', 'Start session')}
          >
            <span className="text-sm leading-none">+</span>
          </button>
        </div>

        {/* Sort toggle */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSortMode('time')}
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              sortMode === 'time'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('sessions.sortByTime', 'Time')}
          </button>
          <button
            type="button"
            onClick={() => setSortMode('status')}
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              sortMode === 'status'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('sessions.sortByStatus', 'Status')}
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {sortedSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {t('sessions.noSessions', 'No sessions yet')}
            </p>
            <button
              type="button"
              onClick={() => onNewSession(project)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t('sessions.startSession', 'Start session')}
            </button>
          </div>
        ) : (
          sortedSessions.map((session) => {
            const isConfirming = pendingDeleteId === session.id;
            const provider: SessionProvider = session.__provider ?? 'claude';

            return (
              <div key={session.id} className="group relative">
                <SessionCard
                  session={session}
                  project={project}
                  onClick={() => onSelectSession(project, session)}
                />
                {/* Delete button (hover) / Confirm (inline) */}
                {onDeleteSession && (
                  isConfirming ? (
                    <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 rounded-xl bg-destructive/90 px-2 py-2 text-xs text-destructive-foreground backdrop-blur-sm">
                      <span className="truncate">{t('buttons.delete', 'Delete')}?</span>
                      <button
                        type="button"
                        onClick={() => {
                          onDeleteSession(project.name, session.id, provider);
                          setPendingDeleteId(null);
                        }}
                        className="rounded-md bg-background/20 px-2 py-0.5 font-medium transition-colors hover:bg-background/40"
                      >
                        {t('buttons.confirm', 'Confirm')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(null)}
                        className="rounded-md bg-background/20 px-2 py-0.5 transition-colors hover:bg-background/40"
                      >
                        {t('buttons.cancel', 'Cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDeleteId(session.id);
                      }}
                      className="absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-md bg-muted/80 text-muted-foreground opacity-0 transition-all hover:bg-destructive/90 hover:text-destructive-foreground group-hover:opacity-100"
                      title={t('buttons.delete', 'Delete')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
