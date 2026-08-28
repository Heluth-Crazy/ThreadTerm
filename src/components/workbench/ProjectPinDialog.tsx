import { useEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { FolderKanban, Pin, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MAX_PINNED_PROJECTS } from '../../lib/workbench/pinnedProjects';
import { orderProjectItems } from '../../lib/workbench/projectOrder';
import type { ProjectWorkbenchOverview } from '../../lib/workbench/types';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import { SortableProjectOverviewRow } from './ProjectOverviewGrid';

export const PIN_ZONE_ID = 'pin-zone';

// Rows are wide, so their center stays inside the list even when the pointer
// is already over the pin zone — pointerWithin follows the pointer itself.
// Prefer the pin zone when both it and a row contain the pointer. Fall back
// to closestCenter for keyboard drags, which have no pointer.
export const pinDialogCollisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length === 0) return closestCenter(args);
  const pinHit = within.find((hit) => hit.id === PIN_ZONE_ID);
  return pinHit ? [pinHit] : within;
};

export function applyPinDialogDragEnd(
  event: Pick<DragEndEvent, 'active' | 'over'>,
  options: {
    pinnedProjects: readonly string[];
    visibleProjectPaths: readonly string[];
    pinProject: (projectPath: string) => void;
    moveProject: (
      activeProjectPath: string,
      overProjectPath: string,
      visibleProjectPaths: readonly string[],
    ) => void;
    onPinFull: () => void;
  },
): void {
  const { over, active } = event;
  if (!over) return;
  const activePath = String(active.id);
  if (over.id === PIN_ZONE_ID) {
    if (
      options.pinnedProjects.length >= MAX_PINNED_PROJECTS &&
      !options.pinnedProjects.includes(activePath)
    ) {
      options.onPinFull();
      return;
    }
    options.pinProject(activePath);
    return;
  }
  if (active.id === over.id) return;
  options.moveProject(activePath, String(over.id), options.visibleProjectPaths);
}

interface ProjectPinDialogProps {
  open: boolean;
  projects: readonly ProjectWorkbenchOverview[];
  onClose: () => void;
}

export function ProjectPinDialog({
  open,
  projects,
  onClose,
}: ProjectPinDialogProps) {
  const { t } = useTranslation('terminal');
  const pinnedProjects = useWorkbenchStore((state) => state.pinnedProjects);
  const projectOrder = useWorkbenchStore((state) => state.projectOrder);
  const pinProject = useWorkbenchStore((state) => state.pinProject);
  const unpinProject = useWorkbenchStore((state) => state.unpinProject);
  const moveProject = useWorkbenchStore((state) => state.moveProject);
  const [pinFullHint, setPinFullHint] = useState(false);
  const pinFullHintTimerRef = useRef<number | null>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);

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
  const pinnedPathSet = useMemo(
    () => new Set(pinnedProjects),
    [pinnedProjects],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement as HTMLElement | null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      priorFocusRef.current?.focus();
    };
  }, [onClose, open]);

  useEffect(
    () => () => {
      if (pinFullHintTimerRef.current !== null) {
        window.clearTimeout(pinFullHintTimerRef.current);
      }
    },
    [],
  );

  if (!open) return null;

  const showPinFullHint = () => {
    setPinFullHint(true);
    if (pinFullHintTimerRef.current !== null) {
      window.clearTimeout(pinFullHintTimerRef.current);
    }
    pinFullHintTimerRef.current = window.setTimeout(
      () => setPinFullHint(false),
      2_500,
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    applyPinDialogDragEnd(event, {
      pinnedProjects,
      visibleProjectPaths,
      pinProject,
      moveProject,
      onPinFull: showPinFullHint,
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label={t('workbench.projects.pinManage', {
          defaultValue: 'Pin management',
        })}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-background/60 backdrop-blur-sm"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-pin-dialog-title"
          className="pointer-events-auto flex h-[min(640px,calc(100vh-32px))] w-[880px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-background text-card-foreground shadow-2xl"
        >
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <Pin className="h-4 w-4" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <h2 id="project-pin-dialog-title" className="text-sm font-semibold">
                {t('workbench.projects.title', {
                  defaultValue: 'Project overview',
                })}
              </h2>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {t('workbench.projects.pinManage', {
                  defaultValue: 'Pin management',
                })}
              </span>
            </span>
            <button
              type="button"
              onClick={onClose}
              title={t('workbench.recall.close', { defaultValue: 'Close' })}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <DndContext
            sensors={sensors}
            collisionDetection={pinDialogCollisionDetection}
            onDragEnd={handleDragEnd}
          >
            <PinZoneDropTarget
              pinnedOverviews={pinnedOverviews}
              pinFullHint={pinFullHint}
              onUnpin={unpinProject}
            />

            <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
              <h3 className="mb-2 text-[11px] font-semibold text-muted-foreground">
                {t('workbench.projects.allProjects', {
                  defaultValue: 'All projects',
                })}
              </h3>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                <SortableContext
                  items={visibleProjectPaths}
                  strategy={verticalListSortingStrategy}
                >
                  {orderedProjects.map((project) => (
                    <SortableProjectOverviewRow
                      key={project.projectPath}
                      project={project}
                      pinned={pinnedPathSet.has(project.projectPath)}
                      disableNavigate
                      dragLabel={t('workbench.projects.reorder', {
                        project: project.projectName,
                        defaultValue: 'Drag to reorder {{project}}',
                      })}
                    />
                  ))}
                </SortableContext>
              </div>
            </div>
          </DndContext>
        </div>
      </div>
    </>
  );
}

function PinZoneDropTarget({
  pinnedOverviews,
  pinFullHint,
  onUnpin,
}: {
  pinnedOverviews: readonly ProjectWorkbenchOverview[];
  pinFullHint: boolean;
  onUnpin: (projectPath: string) => void;
}) {
  const { t } = useTranslation('terminal');
  const { isOver, setNodeRef } = useDroppable({
    id: PIN_ZONE_ID,
  });

  return (
    <div className="border-b border-border px-5 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold text-muted-foreground">
          {t('workbench.projects.pinZone', {
            defaultValue: 'Pinned on home (max 6)',
          })}
        </h3>
        {pinFullHint && (
          <span
            role="status"
            className="text-[11px] text-amber-600 dark:text-amber-400"
          >
            {t('workbench.projects.pinFullHint', {
              defaultValue:
                'You can pin up to 6 projects. Remove one first.',
            })}
          </span>
        )}
      </div>
      <div
        ref={setNodeRef}
        data-testid="workbench-pin-zone"
        className={[
          'flex min-h-[52px] flex-wrap items-center gap-2 rounded-lg border border-dashed p-2 transition-colors',
          isOver
            ? 'border-primary/60 bg-primary/5'
            : 'border-border bg-card/30',
        ].join(' ')}
      >
        {pinnedOverviews.map((project) => (
          <span
            key={project.projectPath}
            data-testid="workbench-pinned-chip"
            data-project-path={project.projectPath}
            className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1"
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-primary/10 text-primary">
              <FolderKanban className="h-3 w-3" />
            </span>
            <span className="truncate text-[11px] font-medium">
              {project.projectName}
            </span>
            <button
              type="button"
              aria-label={t('workbench.projects.unpin', {
                project: project.projectName,
                defaultValue: 'Unpin {{project}}',
              })}
              onClick={() => onUnpin(project.projectPath)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {Array.from({
          length: MAX_PINNED_PROJECTS - pinnedOverviews.length,
        }).map((_, index) => (
          <span
            key={`empty-slot-${index}`}
            aria-hidden="true"
            className="h-8 w-28 rounded-md border border-dashed border-border/60"
          />
        ))}
      </div>
    </div>
  );
}
