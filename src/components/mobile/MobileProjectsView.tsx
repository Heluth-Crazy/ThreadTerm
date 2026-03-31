import { ChevronRight, FolderKanban, FolderPlus } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../types/app';
import { formatTimeAgo } from '../../utils/dateUtils';
import { cn } from '../../lib/utils';

type MobileProjectsViewProps = {
  projects: Project[];
  selectedProject: Project | null;
  isLoading: boolean;
  onSelectProject: (project: Project) => void;
  onCreateProject: () => void;
};

const parseTimestamp = (value: string | undefined): number => {
  if (!value) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const getProjectLastActivityMs = (project: Project): number => {
  return Math.max(
    0,
    ...[...(project.sessions || []), ...(project.codexSessions || [])].map((session) =>
      parseTimestamp(String(session.lastActivity || session.updated_at || session.createdAt || '')),
    ),
  );
};

export default function MobileProjectsView({
  projects,
  selectedProject,
  isLoading,
  onSelectProject,
  onCreateProject,
}: MobileProjectsViewProps) {
  const { t } = useTranslation('sidebar');
  const currentTime = new Date();

  const sortedProjects = useMemo(() => {
    return [...projects].sort((left, right) => getProjectLastActivityMs(right) - getProjectLastActivityMs(left));
  }, [projects]);

  return (
    <section className="flex h-full flex-col px-3 pb-4 pt-3">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">
            {t('workbench.projects', { defaultValue: 'Projects' })}
          </h1>
          <p className="text-xs text-muted-foreground">
            {t('projects.fetchingProjects', { defaultValue: 'Select a project to continue.' })}
          </p>
        </div>
        <button
          type="button"
          onClick={onCreateProject}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/60 bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          <span>{t('projects.newProject', { defaultValue: 'New Project' })}</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto space-y-2">
        {isLoading ? (
          <div className="rounded-xl border border-border/60 bg-card/70 p-4 text-sm text-muted-foreground">
            {t('projects.loadingProjects', { defaultValue: 'Loading projects...' })}
          </div>
        ) : null}

        {!isLoading && sortedProjects.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card/70 p-4 text-sm text-muted-foreground">
            {t('projects.noProjects', { defaultValue: 'No projects found' })}
          </div>
        ) : null}

        {!isLoading &&
          sortedProjects.map((project) => {
            const lastActivity = getProjectLastActivityMs(project);
            const isSelected = selectedProject?.name === project.name;
            const label = project.displayName || project.name;
            const path = project.fullPath || project.path || project.name;

            return (
              <button
                key={project.name}
                type="button"
                onClick={() => onSelectProject(project)}
                className={cn(
                  'flex w-full items-center justify-between gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  isSelected
                    ? 'border-foreground/15 bg-muted text-foreground'
                    : 'border-border/60 bg-card/70 text-foreground hover:bg-muted/45',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{path}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {lastActivity
                      ? formatTimeAgo(new Date(lastActivity).toISOString(), currentTime, t)
                      : t('status.unknown', { defaultValue: 'Unknown' })}
                  </div>
                </div>
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-background/90 text-muted-foreground">
                  <ChevronRight className="h-4 w-4" />
                </div>
              </button>
            );
          })}
      </div>

      {!isLoading && sortedProjects.length > 0 ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-border/60 bg-card/70 px-3 py-2 text-xs text-muted-foreground">
          <FolderKanban className="h-3.5 w-3.5" />
          <span>
            {t('projects.projects', { count: sortedProjects.length, defaultValue: `${sortedProjects.length} projects` })}
          </span>
        </div>
      ) : null}
    </section>
  );
}

