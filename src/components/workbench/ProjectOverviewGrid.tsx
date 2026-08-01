import { useMemo, type CSSProperties } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Bookmark,
  ChevronRight,
  CircleAlert,
  Eye,
  FolderKanban,
  GripVertical,
  Play,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { orderProjectItems } from '../../lib/workbench/projectOrder';
import type { ProjectWorkbenchOverview } from '../../lib/workbench/types';
import { useWorkbenchStore } from '../../stores/workbenchStore';

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
  const projectOrder = useWorkbenchStore((state) => state.projectOrder);
  const moveProject = useWorkbenchStore((state) => state.moveProject);
  const orderedProjects = useMemo(
    () =>
      orderProjectItems(
        projects,
        projectOrder,
        (project) => project.projectPath,
        (project) => project.projectName,
      ),
    [projectOrder, projects],
  );
  const visibleProjectPaths = useMemo(
    () => orderedProjects.map((project) => project.projectPath),
    [orderedProjects],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    moveProject(String(active.id), String(over.id), visibleProjectPaths);
  };

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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={visibleProjectPaths}
            strategy={verticalListSortingStrategy}
          >
            {orderedProjects.map((project) => (
              <SortableProjectOverviewRow
                key={project.projectPath}
                project={project}
                dragLabel={t('workbench.projects.reorder', {
                  project: project.projectName,
                  defaultValue: 'Drag to reorder {{project}}',
                })}
                onSelect={() => onSelectProject(project.projectPath)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}

function SortableProjectOverviewRow({
  project,
  dragLabel,
  onSelect,
}: {
  project: ProjectWorkbenchOverview;
  dragLabel: string;
  onSelect: () => void;
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="workbench-project-row"
      data-project-path={project.projectPath}
      className="group relative flex border-b border-border/60 bg-card/70 last:border-b-0 hover:bg-accent/60"
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        data-testid="workbench-project-drag-handle"
        aria-label={dragLabel}
        title={dragLabel}
        onClick={(event) => event.stopPropagation()}
        className="ml-1.5 inline-flex w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing active:bg-accent"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onSelect}
        title={project.projectPath}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left transition-colors"
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
