import { ChevronRight, Clock3, FolderKanban, MessageSquarePlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project, ProjectSession, SessionProvider } from '../../types/app';
import { formatTimeAgo } from '../../utils/dateUtils';
import { cn } from '../../lib/utils';
import { SessionStatusBadge } from '../shared/SessionStatusBadge';

type SessionFilter = 'all' | 'claude' | 'codex';

type SessionRecord = {
  id: string;
  provider: SessionProvider;
  session: ProjectSession;
  label: string;
  timestamp: string;
  timestampMs: number;
};

type MobileSessionsViewProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  onSelectProjectTab: () => void;
  onSelectSession: (session: ProjectSession) => void;
  onNewSession: (project: Project, provider?: string) => void;
};

const parseTimestamp = (value: string | undefined): number => {
  if (!value) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const getSessionTimestamp = (session: ProjectSession, provider: SessionProvider): string => {
  if (provider === 'codex') {
    return String(session.createdAt || session.lastActivity || session.updated_at || '');
  }

  return String(session.lastActivity || session.updated_at || session.createdAt || '');
};

const getSessionLabel = (
  session: ProjectSession,
  provider: SessionProvider,
  fallbackClaude: string,
  fallbackCodex: string,
): string => {
  if (provider === 'codex') {
    return String(session.summary || session.name || session.title || fallbackCodex);
  }
  return String(session.summary || session.title || session.name || fallbackClaude);
};

export default function MobileSessionsView({
  selectedProject,
  selectedSession,
  onSelectProjectTab,
  onSelectSession,
  onNewSession,
}: MobileSessionsViewProps) {
  const { t } = useTranslation('sidebar');
  const [activeFilter, setActiveFilter] = useState<SessionFilter>('all');
  const currentTime = new Date();
  const fallbackClaude = t('projects.newSession', { defaultValue: 'New Session' });
  const fallbackCodex = t('projects.codexSession', { defaultValue: 'Codex Session' });

  const sessions = useMemo<SessionRecord[]>(() => {
    if (!selectedProject) {
      return [];
    }

    const claudeSessions = (selectedProject.sessions || []).map((session) => {
      const timestamp = getSessionTimestamp(session, 'claude');
      return {
        id: session.id,
        provider: 'claude' as const,
        session,
        label: getSessionLabel(session, 'claude', fallbackClaude, fallbackCodex),
        timestamp,
        timestampMs: parseTimestamp(timestamp),
      };
    });

    const codexSessions = (selectedProject.codexSessions || []).map((session) => {
      const timestamp = getSessionTimestamp(session, 'codex');
      return {
        id: session.id,
        provider: 'codex' as const,
        session,
        label: getSessionLabel(session, 'codex', fallbackClaude, fallbackCodex),
        timestamp,
        timestampMs: parseTimestamp(timestamp),
      };
    });

    return [...claudeSessions, ...codexSessions].sort((left, right) => right.timestampMs - left.timestampMs);
  }, [fallbackClaude, fallbackCodex, selectedProject]);

  const filteredSessions = useMemo(
    () => (activeFilter === 'all' ? sessions : sessions.filter((s) => s.provider === activeFilter)),
    [activeFilter, sessions],
  );

  if (!selectedProject) {
    return (
      <section className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card/80 p-5 text-center">
          <h1 className="text-sm font-semibold text-foreground">
            {t('sessions.title', { defaultValue: 'Sessions' })}
          </h1>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('projectOverview.emptyDescription', { defaultValue: 'Select a project first.' })}
          </p>
          <button
            type="button"
            onClick={onSelectProjectTab}
            className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
          >
            <FolderKanban className="h-3.5 w-3.5" />
            <span>{t('workbench.projects', { defaultValue: 'Projects' })}</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col px-3 pb-4 pt-3">
      <header className="mb-3 rounded-xl border border-border/60 bg-card/70 px-3 py-2.5">
        <div className="text-xs text-muted-foreground">{t('workbench.projects', { defaultValue: 'Projects' })}</div>
        <div className="truncate text-sm font-semibold text-foreground">
          {selectedProject.displayName || selectedProject.name}
        </div>
      </header>

      {/* Session type filter tabs */}
      <div className="mb-3 flex gap-1 rounded-lg border border-border/60 bg-card/70 p-1">
        {(['all', 'claude', 'codex'] as const).map((filter) => (
          <button
            key={filter}
            type="button"
            onClick={() => setActiveFilter(filter)}
            className={cn(
              'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
              activeFilter === filter
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {filter === 'all' ? 'All' : filter === 'claude' ? 'Claude' : 'Codex'}
          </button>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onNewSession(selectedProject, 'claude')}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          <span>New Claude</span>
        </button>
        <button
          type="button"
          onClick={() => onNewSession(selectedProject, 'codex')}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          <span>New Codex</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto space-y-2">
        {filteredSessions.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card/70 p-4 text-sm text-muted-foreground">
            {t('sessions.noSessions', { defaultValue: 'No sessions yet' })}
          </div>
        ) : null}

        {filteredSessions.map((item) => {
          const isActive = selectedSession?.id === item.id;
          const providerLabel = item.provider === 'codex' ? 'Codex' : 'Claude';

          return (
            <button
              key={`${item.provider}-${item.id}`}
              type="button"
              onClick={() =>
                onSelectSession({
                  ...item.session,
                  __provider: item.provider,
                  __projectName: selectedProject.name,
                })
              }
              className={cn(
                'flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                isActive
                  ? 'border-foreground/15 bg-muted text-foreground'
                  : 'border-border/60 bg-card/70 text-foreground hover:bg-muted/45',
              )}
            >
              <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-background/90 text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.label}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{providerLabel}</span>
                  <SessionStatusBadge sessionId={item.session.id} />
                  <span className="text-muted-foreground/50">/</span>
                  <span>
                    {item.timestampMs
                      ? formatTimeAgo(item.timestamp, currentTime, t)
                      : t('status.unknown', { defaultValue: 'Unknown' })}
                  </span>
                </div>
              </div>
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center text-muted-foreground">
                <ChevronRight className="h-4 w-4" />
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

