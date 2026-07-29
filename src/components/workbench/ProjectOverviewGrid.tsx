import {
  AlertTriangle,
  Bookmark,
  ChevronRight,
  CircleAlert,
  Eye,
  FolderKanban,
  Play,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectWorkbenchOverview } from '../../lib/workbench/types';

interface ProjectOverviewGridProps {
  projects: readonly ProjectWorkbenchOverview[];
  className?: string;
  onSelectProject: (projectPath: string) => void;
}

export function ProjectOverviewGrid({
  projects,
  className = 'mt-5',
  onSelectProject,
}: ProjectOverviewGridProps) {
  const { t } = useTranslation('terminal');
  if (projects.length === 0) return null;

  return (
    <section
      aria-labelledby="workbench-project-overview-heading"
      className={className}
    >
      <div className="mb-2">
        <h2
          id="workbench-project-overview-heading"
          className="text-[13px] font-semibold"
        >
          {t('workbench.projects.title', { defaultValue: 'Project overview' })}
        </h2>
        <p className="text-[11px] text-muted-foreground">
          {t('workbench.projects.subtitle', {
            defaultValue: 'A stable overview across all active projects',
          })}
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card/70">
        {projects.map((project) => (
          <button
            key={project.projectPath}
            type="button"
            onClick={() => onSelectProject(project.projectPath)}
            title={project.projectPath}
            className="group flex w-full items-center gap-2.5 border-b border-border/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/60"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <FolderKanban className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-2">
                <strong className="truncate text-xs">{project.projectName}</strong>
                <small className="hidden truncate text-[11px] text-muted-foreground md:inline xl:hidden">
                  {project.projectPath}
                </small>
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                <ProjectMetric
                  icon={Bookmark}
                  label={t('workbench.projects.followed', { defaultValue: 'Followed' })}
                  value={project.followedCount}
                  emphasized
                />
                <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
                <ProjectMetric
                  icon={Play}
                  label={t('workbench.projects.running', { defaultValue: 'Running' })}
                  value={project.runningCount}
                />
                <ProjectMetric
                  icon={CircleAlert}
                  label={t('workbench.projects.attention', { defaultValue: 'Attention' })}
                  value={project.attentionCount}
                />
                <ProjectMetric
                  icon={Eye}
                  label={t('workbench.projects.review', { defaultValue: 'Review' })}
                  value={project.reviewCount}
                />
                <ProjectMetric
                  icon={AlertTriangle}
                  label={t('workbench.projects.failed', { defaultValue: 'Failed' })}
                  value={project.failedCount}
                />
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </button>
        ))}
      </div>
    </section>
  );
}

function ProjectMetric({
  icon: Icon,
  label,
  value,
  emphasized = false,
}: {
  icon: typeof Bookmark;
  label: string;
  value: number;
  emphasized?: boolean;
}) {
  return (
    <span
      title={`${label}: ${value}`}
      className={[
        'inline-flex items-center gap-1 text-[11px]',
        emphasized ? 'text-primary' : '',
      ].join(' ')}
    >
      <Icon className="h-3 w-3" />
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}
