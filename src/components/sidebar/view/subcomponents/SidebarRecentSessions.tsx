import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { formatTimeAgo } from '../../../../utils/dateUtils';
import { useSessionStatusStore } from '../../../../stores/sessionStatusStore';
import { SessionStatusBadge } from '../../../shared/SessionStatusBadge';
import SessionProviderLogo from '../../../SessionProviderLogo';
import type { Project } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

interface FlatSession {
  session: SessionWithProvider;
  project: Project;
}

interface SidebarRecentSessionsProps {
  projects: Project[];
  currentSessionId?: string | null;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onProjectSelect: (project: Project) => void;
}

export default function SidebarRecentSessions({
  projects,
  currentSessionId,
  onSessionSelect,
  onProjectSelect,
}: SidebarRecentSessionsProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const statuses = useSessionStatusStore((s) => s.statuses);
  const currentTime = useMemo(() => new Date(), []);

  const groupedSessions = useMemo(() => {
    const all: FlatSession[] = [];

    for (const project of projects) {
      for (const session of project.sessions || []) {
        all.push({
          session: { ...session, __provider: 'claude' as const },
          project,
        });
      }
      for (const session of project.codexSessions || []) {
        all.push({
          session: { ...session, __provider: 'codex' as const },
          project,
        });
      }
    }

    const needsAttention: FlatSession[] = [];
    const processing: FlatSession[] = [];
    const rest: FlatSession[] = [];

    for (const item of all) {
      const entry = statuses[item.session.id];
      if (entry?.status === 'needs_attention') {
        needsAttention.push(item);
      } else if (entry?.status === 'processing') {
        processing.push(item);
      } else {
        rest.push(item);
      }
    }

    const byTime = (a: FlatSession, b: FlatSession) => {
      const aTime = new Date(
        a.session.lastActivity || a.session.updated_at || a.session.createdAt || 0,
      ).getTime();
      const bTime = new Date(
        b.session.lastActivity || b.session.updated_at || b.session.createdAt || 0,
      ).getTime();
      return bTime - aTime;
    };

    needsAttention.sort(byTime);
    processing.sort(byTime);
    rest.sort(byTime);

    return { needsAttention, processing, rest };
  }, [projects, statuses]);

  const hasAnySessions =
    groupedSessions.needsAttention.length +
      groupedSessions.processing.length +
      groupedSessions.rest.length >
    0;

  if (!hasAnySessions) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        {t('sessions.noSessions')}
      </div>
    );
  }

  const renderSession = (item: FlatSession) => {
    const { session, project } = item;
    const isSelected = currentSessionId === session.id;
    const sessionName =
      session.title || session.summary || session.id.slice(0, 8);
    const timeStr =
      session.lastActivity || session.updated_at || session.createdAt || '';

    return (
      <button
        key={session.id}
        className={cn(
          'w-full rounded-lg px-2 py-1.5 text-left transition-all duration-150 hover:bg-muted/55',
          isSelected && 'bg-muted text-accent-foreground',
        )}
        onClick={() => {
          onProjectSelect(project);
          onSessionSelect(session, project.name);
        }}
      >
        <div className="flex min-w-0 w-full items-start gap-1.5">
          <SessionProviderLogo
            provider={session.__provider}
            className="mt-0.5 h-3 w-3 flex-shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="truncate text-[11px] font-medium text-foreground">
                {sessionName}
              </span>
              <SessionStatusBadge sessionId={session.id} compact />
            </div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {project.displayName}
            </div>
            {timeStr && (
              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Clock className="h-2.5 w-2.5" />
                <span>{formatTimeAgo(timeStr, currentTime, t)}</span>
              </div>
            )}
          </div>
        </div>
      </button>
    );
  };

  const renderGroup = (label: string, items: FlatSession[]) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-0.5">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        {items.map(renderSession)}
      </div>
    );
  };

  return (
    <div className="space-y-2 px-1">
      {renderGroup(
        t('common:sessionStatus.needs_attention'),
        groupedSessions.needsAttention,
      )}
      {renderGroup(
        t('common:sessionStatus.processing'),
        groupedSessions.processing,
      )}
      {renderGroup(t('sessions.title'), groupedSessions.rest)}
    </div>
  );
}
