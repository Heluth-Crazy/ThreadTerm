import {
  ChevronRight,
  Clock3,
  FolderHeart,
  FolderKanban,
  FolderPlus,
  PlayCircle,
  Plus,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { formatTimeAgo } from '../../../utils/dateUtils';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import { cn } from '../../../lib/utils';
import { loadStarredProjects } from '../../sidebar/utils/utils';
import { Badge } from '../../ui/badge';
import { SessionStatusBadge } from '../../shared/SessionStatusBadge';

type SessionRecord = {
  session: ProjectSession;
  project: Project;
  provider: SessionProvider;
  timestamp: string;
  timestampMs: number;
  label: string;
};

type QuickAction = {
  id: string;
  label: string;
  description: string;
  icon: typeof Plus;
  onClick: () => void;
  disabled?: boolean;
};

type ProjectsOverviewPageProps = {
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onSelectSession: (session: ProjectSession) => void;
  onNewSession: (project: Project, provider?: string) => void;
  onCreateProject: () => void;
  onShowSettings: () => void;
};

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getProjectLabel(project: Project): string {
  return project.displayName || project.name;
}

function getProjectPath(project: Project): string {
  return project.fullPath || project.path || project.name;
}

function getSessionTimestamp(session: ProjectSession, provider: SessionProvider): string {
  if (provider === 'codex') {
    return String(session.createdAt || session.lastActivity || session.updated_at || '');
  }

  return String(session.lastActivity || session.updated_at || session.createdAt || '');
}

function getSessionLabel(
  session: ProjectSession,
  provider: SessionProvider,
  t: (key: string) => string,
): string {
  if (provider === 'codex') {
    return String(session.summary || session.name || session.title || t('projects.codexSession'));
  }

  return String(session.summary || session.title || session.name || t('projects.newSession'));
}

function getProjectLastActivity(project: Project): number {
  return Math.max(
    0,
    ...[...(project.sessions || []), ...(project.codexSessions || [])].map((session) =>
      parseTimestamp(String(session.lastActivity || session.updated_at || session.createdAt || '')),
    ),
  );
}

function buildSessionRecords(
  projects: Project[],
  t: (key: string) => string,
): SessionRecord[] {
  return projects.flatMap((project) => {
    const claudeSessions = (project.sessions || []).map((session) => {
      const timestamp = getSessionTimestamp(session, 'claude');
      return {
        session,
        project,
        provider: 'claude' as const,
        timestamp,
        timestampMs: parseTimestamp(timestamp),
        label: getSessionLabel(session, 'claude', t),
      };
    });

    const codexSessions = (project.codexSessions || []).map((session) => {
      const timestamp = getSessionTimestamp(session, 'codex');
      return {
        session,
        project,
        provider: 'codex' as const,
        timestamp,
        timestampMs: parseTimestamp(timestamp),
        label: getSessionLabel(session, 'codex', t),
      };
    });

    return [...claudeSessions, ...codexSessions];
  });
}

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: typeof FolderKanban;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-[22px] border border-border/60 bg-card/72 p-3.5 shadow-sm', className)}>
      <div className="mb-2.5 flex items-start gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted text-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function ProviderBadge({ provider }: { provider: SessionProvider }) {
  const badgeClassName =
    provider === 'claude'
      ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-[0.06em] uppercase',
        badgeClassName,
      )}
    >
      {provider === 'claude' ? 'Claude' : 'Codex'}
    </span>
  );
}

function RecentSessionRow({
  item,
  currentTime,
  onSelectSession,
  t,
}: {
  item: SessionRecord;
  currentTime: Date;
  onSelectSession: (session: ProjectSession) => void;
  t: TFunction;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        onSelectSession({
          ...item.session,
          __projectName: item.project.name,
          __provider: item.provider,
        })
      }
      className="group relative flex w-full items-start gap-2.5 overflow-hidden rounded-xl border border-border/60 bg-background px-3 py-2.5 text-left transition-colors hover:bg-muted/45"
    >
      <div className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-border transition-colors group-hover:bg-foreground/30" />
      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-5 text-foreground">{item.label}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <span className="truncate">{getProjectLabel(item.project)}</span>
              <span className="text-muted-foreground/50">/</span>
              <ProviderBadge provider={item.provider} />
              <SessionStatusBadge sessionId={item.session.id} />
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1 pl-2 text-[11px] text-muted-foreground">
            <span>{formatTimeAgo(item.timestamp, currentTime, t)}</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>
    </button>
  );
}

function QuickActionTile({ action }: { action: QuickAction }) {
  const Icon = action.icon;

  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={action.disabled}
      className="rounded-xl border border-border/60 bg-background px-3 py-2.5 text-left transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-55"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-5 text-foreground">{action.label}</div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{action.description}</p>
        </div>
      </div>
    </button>
  );
}

function ProjectEntry({
  project,
  currentTime,
  onSelectProject,
  t,
}: {
  project: Project;
  currentTime: Date;
  onSelectProject: (project: Project) => void;
  t: TFunction;
}) {
  const lastActivity = getProjectLastActivity(project);

  return (
    <button
      type="button"
      onClick={() => onSelectProject(project)}
      className="flex w-full items-center justify-between gap-2.5 rounded-xl border border-border/60 bg-background px-3 py-2.5 text-left transition-colors hover:bg-muted/45"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium leading-5 text-foreground">{getProjectLabel(project)}</div>
        <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{getProjectPath(project)}</div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <span>
          {lastActivity > 0
            ? formatTimeAgo(new Date(lastActivity).toISOString(), currentTime, t)
            : t('workbench.overview.noRecentActivity')}
        </span>
        <ChevronRight className="h-3.5 w-3.5" />
      </div>
    </button>
  );
}

export default function ProjectsOverviewPage({
  projects,
  onSelectProject,
  onSelectSession,
  onNewSession,
  onCreateProject,
  onShowSettings,
}: ProjectsOverviewPageProps) {
  const { t } = useTranslation('sidebar');
  const currentTime = new Date();

  const allSessions = useMemo(() => buildSessionRecords(projects, t), [projects, t]);

  const recentSessions = useMemo(
    () => [...allSessions].filter((item) => item.timestampMs > 0).sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 8),
    [allSessions],
  );

  const starredProjects = useMemo(() => {
    const starred = loadStarredProjects();
    return projects.filter((project) => starred.has(project.name)).slice(0, 4);
  }, [projects]);

  const recentProjects = useMemo(
    () => [...projects].sort((a, b) => getProjectLastActivity(b) - getProjectLastActivity(a)).slice(0, 6),
    [projects],
  );

  const primaryProject = recentSessions[0]?.project || starredProjects[0] || recentProjects[0] || projects[0] || null;
  const featuredProjects = starredProjects.length > 0 ? starredProjects : recentProjects.slice(0, 4);

  const quickActions: QuickAction[] = [
    {
      id: 'claude',
      label: t('workbench.overview.actions.claude'),
      description: primaryProject
        ? t('workbench.overview.actions.claudeHint', { project: getProjectLabel(primaryProject) })
        : t('workbench.overview.actions.noProjectHint'),
      icon: Plus,
      onClick: () => {
        if (primaryProject) {
          onNewSession(primaryProject, 'claude');
        }
      },
      disabled: !primaryProject,
    },
    {
      id: 'codex',
      label: t('workbench.overview.actions.codex'),
      description: primaryProject
        ? t('workbench.overview.actions.codexHint', { project: getProjectLabel(primaryProject) })
        : t('workbench.overview.actions.noProjectHint'),
      icon: PlayCircle,
      onClick: () => {
        if (primaryProject) {
          onNewSession(primaryProject, 'codex');
        }
      },
      disabled: !primaryProject,
    },
    {
      id: 'open',
      label: t('workbench.overview.actions.openProject'),
      description: primaryProject
        ? t('workbench.overview.actions.openProjectHint', { project: getProjectLabel(primaryProject) })
        : t('workbench.overview.actions.noProjectHint'),
      icon: FolderKanban,
      onClick: () => {
        if (primaryProject) {
          onSelectProject(primaryProject);
        }
      },
      disabled: !primaryProject,
    },
    {
      id: 'settings',
      label: t('workbench.overview.actions.createProject'),
      description: t('workbench.overview.actions.createProjectHint'),
      icon: FolderPlus,
      onClick: onCreateProject,
    },
  ];

  const showProjectsEmptyState = projects.length === 0;
  const showSessionsEmptyState = projects.length > 0 && recentSessions.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-4 lg:px-6">
        <section className="rounded-[22px] border border-border/60 bg-card/72 px-4 py-3.5 shadow-sm">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.45fr)_296px] xl:items-start">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{t('workbench.overview.title')}</h1>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('workbench.overview.subtitle')}</p>

              <div className="mt-3 rounded-[20px] border border-border/60 bg-background/80 p-3">
                <div className="mb-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">{t('workbench.overview.continue')}</h2>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {t('workbench.overview.continueDescription')}
                    </p>
                  </div>
                  {recentSessions.length > 0 ? (
                    <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                      {t('workbench.overview.sessionCount', { count: recentSessions.length })}
                    </Badge>
                  ) : null}
                </div>

                {showProjectsEmptyState ? (
                  <div className="rounded-lg border border-dashed border-border/70 bg-background/70 px-3.5 py-3">
                    <div className="text-sm font-medium text-foreground">{t('workbench.overview.emptyProjectsTitle')}</div>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">{t('workbench.overview.emptyProjects')}</p>
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={onCreateProject}
                        className="rounded-lg border border-border/60 bg-card px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-muted/45"
                      >
                        {t('workbench.overview.actions.createProject')}
                      </button>
                    </div>
                  </div>
                ) : showSessionsEmptyState ? (
                  <div className="rounded-lg border border-dashed border-border/70 bg-background/70 px-3.5 py-3">
                    <div className="text-sm font-medium text-foreground">{t('workbench.overview.emptySessionsTitle')}</div>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">{t('workbench.overview.emptySessions')}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => primaryProject && onNewSession(primaryProject, 'claude')}
                        disabled={!primaryProject}
                        className="rounded-lg border border-border/60 bg-card px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        {t('workbench.overview.actions.claude')}
                      </button>
                      <button
                        type="button"
                        onClick={() => primaryProject && onNewSession(primaryProject, 'codex')}
                        disabled={!primaryProject}
                        className="rounded-lg border border-border/60 bg-card px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        {t('workbench.overview.actions.codex')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {recentSessions.map((item) => (
                      <RecentSessionRow
                        key={`${item.project.name}:${item.session.id}`}
                        item={item}
                        currentTime={currentTime}
                        onSelectSession={onSelectSession}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <SectionCard
              icon={PlayCircle}
              title={t('workbench.overview.quickStart')}
              description={t('workbench.overview.quickStartDescription')}
              className="xl:sticky xl:top-4"
            >
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {quickActions.map((action) => (
                  <QuickActionTile key={action.id} action={action} />
                ))}
              </div>
              {primaryProject ? (
                <div className="mt-2 rounded-xl border border-border/60 bg-background px-3 py-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {t('workbench.overview.launchTarget')}
                  </div>
                  <div className="mt-1 truncate text-[13px] font-medium leading-5 text-foreground">
                    {getProjectLabel(primaryProject)}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{getProjectPath(primaryProject)}</div>
                </div>
              ) : null}
            </SectionCard>
          </div>
        </section>

        <div className="grid gap-3 xl:grid-cols-2">
          <SectionCard
            icon={FolderHeart}
            title={t('workbench.overview.starred')}
            description={t('workbench.overview.starredDescription')}
          >
            {featuredProjects.length > 0 ? (
              <div className="space-y-1.5">
                {featuredProjects.map((project) => (
                  <ProjectEntry
                    key={project.name}
                    project={project}
                    currentTime={currentTime}
                    onSelectProject={onSelectProject}
                    t={t}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 bg-background px-3.5 py-3 text-sm text-muted-foreground">
                {t('workbench.overview.noStarredProjects')}
              </div>
            )}
          </SectionCard>

          <SectionCard
            icon={FolderKanban}
            title={t('workbench.overview.recentProjects')}
            description={t('workbench.overview.recentProjectsDescription')}
          >
            {recentProjects.length > 0 ? (
              <div className="space-y-1.5">
                {recentProjects.map((project) => (
                  <ProjectEntry
                    key={project.name}
                    project={project}
                    currentTime={currentTime}
                    onSelectProject={onSelectProject}
                    t={t}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 bg-background px-3.5 py-3 text-sm text-muted-foreground">
                {t('workbench.overview.emptyProjects')}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
