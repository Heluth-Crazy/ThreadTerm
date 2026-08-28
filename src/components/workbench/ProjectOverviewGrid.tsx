import { useMemo, useState, type CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Bookmark,
  ChevronRight,
  CircleAlert,
  Eye,
  FolderKanban,
  GripVertical,
  LayoutGrid,
  Pin,
  Play,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectWorkbenchOverview } from '../../lib/workbench/types';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import { ProjectPinDialog } from './ProjectPinDialog';

interface ProjectOverviewGridProps {
  projects: readonly ProjectWorkbenchOverview[];
  className?: string;
  onSelectProject: (projectPath: string) => void;
}

export function ProjectOverviewGrid({
  projects,
  className = '',
  onSelectProject,
}: ProjectOverviewGridProps) {
  const { t } = useTranslation('terminal');
  const pinnedProjects = useWorkbenchStore((state) => state.pinnedProjects);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const pinnedOverviews = useMemo(() => {
    const byPath = new Map(
      projects.map((project) => [project.projectPath, project]),
    );
    return pinnedProjects
      .map((projectPath) => byPath.get(projectPath))
      .filter((project): project is ProjectWorkbenchOverview =>
        Boolean(project),
      );
  }, [pinnedProjects, projects]);

  if (projects.length === 0) return null;

  return (
    <section
      aria-labelledby="workbench-project-overview-heading"
      className={[
        'flex min-h-0 flex-col rounded-xl border border-border/70 bg-card/50',
        className,
      ].join(' ')}
    >
      <div className="flex h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-3.5">
        <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-primary" />
        <h2
          id="workbench-project-overview-heading"
          className="shrink-0 text-[13px] font-semibold"
        >
          {t('workbench.projects.title', { defaultValue: 'Project overview' })}
        </h2>
        <p className="hidden min-w-0 truncate text-[11px] text-muted-foreground lg:block">
          {t('workbench.projects.subtitle', {
            defaultValue: 'A stable overview across all active projects',
          })}
        </p>
        <button
          type="button"
          onClick={() => setPinDialogOpen(true)}
          className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('workbench.projects.viewAll', { defaultValue: 'View all' })}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {pinnedOverviews.length > 0 ? (
        <div className="grid flex-1 grid-cols-2 content-start gap-2.5 p-3 xl:grid-cols-3">
          {pinnedOverviews.map((project) => (
            <PinnedProjectCard
              key={project.projectPath}
              project={project}
              onSelect={() => onSelectProject(project.projectPath)}
            />
          ))}
        </div>
      ) : (
        <div
          data-testid="workbench-pinned-empty"
          className="grid flex-1 place-items-center px-4 py-8"
        >
          <div className="text-center">
            <span className="mx-auto grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Pin className="h-4 w-4" />
            </span>
            <p className="mt-2 text-xs font-medium">
              {t('workbench.projects.emptyPinnedTitle', {
                defaultValue: 'No pinned projects yet',
              })}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t('workbench.projects.emptyPinnedHint', {
                defaultValue:
                  'Drag frequently used projects into the pin zone from "View all".',
              })}
            </p>
            <button
              type="button"
              onClick={() => setPinDialogOpen(true)}
              className="mt-3 h-7 rounded-md bg-primary px-3 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {t('workbench.projects.emptyPinnedAction', {
                defaultValue: 'Pin a project',
              })}
            </button>
          </div>
        </div>
      )}
      <ProjectPinDialog
        open={pinDialogOpen}
        projects={projects}
        onClose={() => setPinDialogOpen(false)}
      />
    </section>
  );
}

function PinnedProjectCard({
  project,
  onSelect,
}: {
  project: ProjectWorkbenchOverview;
  onSelect: () => void;
}) {
  const { t } = useTranslation('terminal');

  return (
    <button
      type="button"
      data-testid="workbench-pinned-project-card"
      data-project-path={project.projectPath}
      onClick={onSelect}
      title={project.projectPath}
      className="group flex min-w-0 flex-col rounded-lg border border-border/60 bg-background/60 p-3 text-left transition-colors hover:border-primary/30 hover:bg-accent/60"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <FolderKanban className="h-3.5 w-3.5" />
        </span>
        <strong className="truncate text-xs font-medium">
          {project.projectName}
        </strong>
      </span>
      <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
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
    </button>
  );
}

export function SortableProjectOverviewRow({
  project,
  dragLabel,
  pinned = false,
  disableNavigate = false,
  onSelect,
}: {
  project: ProjectWorkbenchOverview;
  dragLabel: string;
  pinned?: boolean;
  disableNavigate?: boolean;
  onSelect?: () => void;
}) {
  const { t } = useTranslation('terminal');
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: project.projectPath });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.86 : undefined,
  };
  // In the pin dialog (disableNavigate) the whole row is the drag handle,
  // matching the drag-a-card interaction; on the home grid only the grip drags.
  const rowDragProps = disableNavigate ? { ...attributes, ...listeners } : {};
  const gripDragProps = disableNavigate ? {} : { ...attributes, ...listeners };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="workbench-project-row"
      data-project-path={project.projectPath}
      className={[
        'group relative flex border-b border-border/60 bg-card/70 last:border-b-0 hover:bg-accent/60',
        disableNavigate ? 'touch-none cursor-grab active:cursor-grabbing' : '',
      ].join(' ')}
      {...rowDragProps}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        data-testid="workbench-project-drag-handle"
        aria-label={dragLabel}
        title={dragLabel}
        tabIndex={disableNavigate ? -1 : undefined}
        onClick={(event) => event.stopPropagation()}
        className="ml-1.5 inline-flex w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing active:bg-accent"
        {...gripDragProps}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={disableNavigate ? undefined : onSelect}
        disabled={disableNavigate}
        title={project.projectPath}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left transition-colors disabled:cursor-default"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <FolderKanban className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <strong className="truncate text-xs">{project.projectName}</strong>
            {pinned && (
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t('workbench.projects.pinnedBadge', {
                  defaultValue: 'Pinned',
                })}
              </span>
            )}
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
        {!disableNavigate && (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        )}
      </button>
    </div>
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
