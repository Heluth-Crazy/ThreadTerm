import { useEffect, useMemo } from 'react';
import { getStandaloneAttentionItems } from '../../lib/attention-actions';
import { getTaskTimelineStage, isAcceptedResultTask } from '../../lib/control-plane';
import type { MissionControlSurfaceTarget } from '../../lib/mission-control';
import { useAttentionStore } from '../../stores/attentionStore';
import { useSessionStatusStore } from '../../stores/sessionStatusStore';
import { countQueuedDurableTasks, countRunningDurableTasks, useTaskStore } from '../../stores/taskStore';
import { getProviderDotClass } from '../../utils/providerColors';
import type { Project, ProjectSession } from '../../types/app';

export interface BottomStatusStripProps {
  projects: Project[];
  selectedSession: ProjectSession | null;
  onSelectSession: (project: Project, session: ProjectSession) => void;
  onOpenMissionControlSurface?: (target: MissionControlSurfaceTarget) => void;
}

export default function BottomStatusStrip({
  projects,
  selectedSession,
  onSelectSession,
  onOpenMissionControlSurface,
}: BottomStatusStripProps) {
  const statuses = useSessionStatusStore((s) => s.statuses);
  const attentionItems = useAttentionStore((s) => s.attentionItems);
  const approvalRequests = useAttentionStore((s) => s.approvalRequests);
  const refreshTasks = useTaskStore((s) => s.refresh);
  const loadedTasksByProject = useTaskStore((s) => s.tasksByProject);
  const projectPaths = useMemo(
    () => [...new Set(projects.map((project) => project.path || project.fullPath).filter((projectPath): projectPath is string => Boolean(projectPath)))],
    [projects],
  );
  const visibleTasks = useMemo(
    () => projectPaths.flatMap((projectPath) => loadedTasksByProject[projectPath] ?? []),
    [loadedTasksByProject, projectPaths],
  );
  const activeAttentionItems = useMemo(
    () =>
      Object.values(attentionItems)
        .filter((item) => item.status === 'active')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [attentionItems],
  );
  const pendingApprovals = useMemo(
    () =>
      Object.values(approvalRequests)
        .filter((request) => request.status === 'pending')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [approvalRequests],
  );
  const standaloneAttentionCount = useMemo(
    () => getStandaloneAttentionItems(activeAttentionItems, pendingApprovals).length,
    [activeAttentionItems, pendingApprovals],
  );
  const taskRunning = useMemo(() => countRunningDurableTasks(visibleTasks), [visibleTasks]);
  const taskBacklog = useMemo(() => countQueuedDurableTasks(visibleTasks), [visibleTasks]);
  const reviewCount = useMemo(
    () => visibleTasks.filter((task) => getTaskTimelineStage(task) === 'review').length,
    [visibleTasks],
  );
  const resultCount = useMemo(
    () => visibleTasks.filter((task) => isAcceptedResultTask(task)).length,
    [visibleTasks],
  );

  useEffect(() => {
    if (projectPaths.length === 0) return;
    void Promise.allSettled(projectPaths.map((projectPath) => refreshTasks(projectPath)));
  }, [projectPaths, refreshTasks]);

  // Flatten all sessions
  const allSessions: { project: Project; session: ProjectSession }[] = [];
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      allSessions.push({ project, session: { ...session, __provider: session.__provider ?? 'claude' } });
    }
    for (const session of project.codexSessions ?? []) {
      allSessions.push({ project, session: { ...session, __provider: session.__provider ?? 'codex' } });
    }
  }

  const controlPlaneTargets = [
    { label: 'Approval', count: pendingApprovals.length, target: 'approval-inbox' },
    { label: 'Attention', count: standaloneAttentionCount, target: 'attention-inbox' },
    { label: 'Running', count: taskRunning, target: 'task-running' },
    { label: 'Backlog', count: taskBacklog, target: 'task-backlog' },
    { label: 'Review', count: reviewCount, target: 'review-queue' },
    { label: 'Results', count: resultCount, target: 'result-inbox' },
  ] satisfies Array<{ label: string; count: number; target: MissionControlSurfaceTarget }>;
  const hasControlPlaneCounts = controlPlaneTargets.some((item) => item.count > 0);

  if (allSessions.length === 0 && !hasControlPlaneCounts) return null;

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-t border-border/60 bg-card/80 px-3">
      {hasControlPlaneCounts && (
        <div className="mr-1 flex shrink-0 items-center gap-1.5 rounded-lg bg-muted/50 px-2 py-1">
          {controlPlaneTargets
            .filter((item) => item.count > 0)
            .map((item) => (
              <button
                key={item.target}
                type="button"
                onClick={() => onOpenMissionControlSurface?.(item.target)}
                disabled={!onOpenMissionControlSurface}
                aria-label={`Open ${item.label}`}
                className="inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:cursor-default"
                title={`Open ${item.label}`}
              >
                <span>{item.count}</span>
                <span>{item.label}</span>
              </button>
            ))}
        </div>
      )}
      {allSessions.map(({ project, session }) => {
        const isSelected = selectedSession?.id === session.id;
        const provider = session.__provider ?? 'claude';
        const status = statuses[session.id]?.status ?? 'idle';
        const title = session.title || session.name || session.id.slice(0, 8);

        return (
          <button
            key={`${project.name}__${session.id}`}
            type="button"
            onClick={() => onSelectSession(project, session)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
              isSelected
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
          >
            {/* Provider indicator dot */}
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${getProviderDotClass(provider)}`} />
            {/* Status dot */}
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                status === 'needs_attention'
                  ? 'bg-red-500 animate-pulse'
                  : status === 'processing'
                    ? 'bg-blue-500'
                    : status === 'completed'
                      ? 'bg-emerald-500'
                      : 'bg-muted-foreground/40'
              }`}
            />
            <span className="font-medium text-muted-foreground">
              {provider === 'codex' ? 'CX' : 'CL'}
            </span>
            <span className="max-w-[120px] truncate">{title}</span>
          </button>
        );
      })}
    </div>
  );
}
