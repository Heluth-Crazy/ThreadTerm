import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStatusStore, type SessionRuntimeStatus } from '../../stores/sessionStatusStore';
import type { Project, ProjectSession } from '../../types/app';
import SessionCard from './SessionCard';

export interface MissionControlViewProps {
  projects: Project[];
  isLoading: boolean;
  onSelectSession: (project: Project, session: ProjectSession) => void;
  onNewSession: () => void;
  onCreateProject: () => void;
}

const STATUS_PRIORITY: Record<SessionRuntimeStatus, number> = {
  needs_attention: 0,
  processing: 1,
  completed: 2,
  idle: 3,
};

export default function MissionControlView({
  projects,
  isLoading,
  onSelectSession,
  onNewSession,
  onCreateProject,
}: MissionControlViewProps) {
  const { t } = useTranslation('common');
  const statuses = useSessionStatusStore((s) => s.statuses);

  // Flatten all sessions across all projects
  const sortedSessions = useMemo(() => {
    const entries: { project: Project; session: ProjectSession }[] = [];

    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        entries.push({ project, session: { ...session, __provider: session.__provider ?? 'claude' } });
      }
      for (const session of project.codexSessions ?? []) {
        entries.push({ project, session: { ...session, __provider: session.__provider ?? 'codex' } });
      }
    }

    // Sort: needs_attention first → processing → completed → idle
    entries.sort((a, b) => {
      const sa = statuses[a.session.id]?.status ?? 'idle';
      const sb = statuses[b.session.id]?.status ?? 'idle';
      const pa = STATUS_PRIORITY[sa] ?? 3;
      const pb = STATUS_PRIORITY[sb] ?? 3;
      if (pa !== pb) return pa - pb;
      // Within same status, newer first
      const ta = new Date(a.session.lastActivity || a.session.updated_at || a.session.createdAt || 0).getTime();
      const tb = new Date(b.session.lastActivity || b.session.updated_at || b.session.createdAt || 0).getTime();
      return tb - ta;
    });

    return entries;
  }, [projects, statuses]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent" style={{ animation: 'spin 0.8s linear infinite' }} />
          <span className="text-sm text-muted-foreground">{t('status.loading', 'Loading...')}</span>
        </div>
      </div>
    );
  }

  if (sortedSessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/60">
            <svg className="h-8 w-8 text-muted-foreground/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            {t('overview.noSessions', 'No active sessions')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('overview.noSessionsHint', 'Create a project and start your first AI agent session')}
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={onCreateProject}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              Add Project
            </button>
            <button
              type="button"
              onClick={onNewSession}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t('overview.newSession', 'New Session')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              {t('overview.title', 'Mission Control')}
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('overview.sessionCount', '{{count}} sessions', { count: sortedSessions.length })}
            </p>
          </div>
          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <span className="text-sm leading-none">+</span>
            {t('overview.newSession', 'New Session')}
          </button>
        </div>

        {/* Card grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sortedSessions.map(({ project, session }) => (
            <SessionCard
              key={session.id}
              session={session}
              project={project}
              onClick={() => onSelectSession(project, session)}
            />
          ))}

          {/* New session placeholder card */}
          <button
            type="button"
            onClick={onNewSession}
            className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/60 bg-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted/30 hover:text-foreground"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted/60 text-lg">+</span>
            <span className="text-sm font-medium">{t('overview.newSession', 'New Session')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
