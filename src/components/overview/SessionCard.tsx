import { useMemo } from 'react';
import HandoffTaskMenu from '../shared/HandoffTaskMenu';
import { useAttentionStore } from '../../stores/attentionStore';
import { useSessionStatusStore, type SessionRuntimeStatus } from '../../stores/sessionStatusStore';
import type { Task } from '../../lib/tauri-bridge';
import { getTaskControlPlaneSurface, getTaskControlPlaneSurfaceLabel } from '../../lib/control-plane';
import { formatTaskMainPathBadgeLabel, type TaskMainPathBadge } from '../../lib/task-main-path';
import {
  buildTaskDispatchPresentation,
  formatTaskExecutionStrategyLabel,
  formatTaskRoleLabel,
  formatTaskStatusLabel,
  getTaskSessionBindingLabel,
  type TaskDispatchContextTask,
  type TaskSessionBinding,
  type TaskSessionSummaryInput,
} from '../../lib/task-dispatch';
import type { Project, ProjectSession } from '../../types/app';

export interface SessionCardProps {
  session: ProjectSession;
  project: Project;
  linkedTask?: Task;
  taskSessionBinding?: TaskSessionBinding;
  mainPathAction?: {
    label: string;
    onClick: () => void;
  };
  mainPathBadge?: TaskMainPathBadge | null;
  sourceSessionLabel?: TaskSessionSummaryInput;
  runtimeSessionLabel?: TaskSessionSummaryInput;
  availableProjects?: Project[];
  onClick: () => void;
  showHandoffAction?: boolean;
  onQueueHandoffTask?: (projectPath: string) => void;
}

function formatRelativeTime(dateStr?: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function StatusDot({ status }: { status: SessionRuntimeStatus }) {
  switch (status) {
    case 'needs_attention':
      return <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />;
    case 'processing':
      return (
        <span className="inline-block h-2 w-2 rounded-full border-[1.5px] border-blue-500 border-t-transparent" style={{ animation: 'spin 0.8s linear infinite' }} />
      );
    case 'completed':
      return <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />;
    default:
      return <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />;
  }
}

export default function SessionCard({
  session,
  project,
  linkedTask,
  taskSessionBinding,
  mainPathAction,
  mainPathBadge,
  sourceSessionLabel,
  runtimeSessionLabel,
  availableProjects = [],
  onClick,
  showHandoffAction = false,
  onQueueHandoffTask,
}: SessionCardProps) {
  const getStatus = useSessionStatusStore((s) => s.getStatus);
  const pendingApproval = useAttentionStore((s) => s.approvalRequests[session.id]);
  const activeAttentionItem = useAttentionStore((s) =>
    Object.values(s.attentionItems).find((item) => item.sessionId === session.id && item.status === 'active'),
  );
  const statusEntry = getStatus(session.id);
  const provider = session.__provider ?? 'claude';

  const borderClass = useMemo(() => {
    if (statusEntry.status === 'needs_attention') return 'ring-2 ring-red-500/50 animate-pulse';
    if (statusEntry.status === 'processing') return 'ring-1 ring-blue-500/30';
    return '';
  }, [statusEntry.status]);

  const timeLabel = formatRelativeTime(session.lastActivity || session.updated_at || session.created_at || session.createdAt);
  const resolvedTaskTitle = statusEntry.taskTitle || linkedTask?.title;
  const resolvedTaskStatus = formatTaskStatusLabel(statusEntry.taskStatus || linkedTask?.status);
  const resolvedTaskRole = formatTaskRoleLabel(statusEntry.taskRole || linkedTask?.role);
  const resolvedTaskExecutionStrategy = formatTaskExecutionStrategyLabel(statusEntry.taskExecutionStrategy || linkedTask?.execution_strategy);
  const handoffBindingLabel = linkedTask?.execution_strategy === 'handoff'
    ? getTaskSessionBindingLabel(taskSessionBinding)
    : null;
  const controlPlaneSurface = pendingApproval
    ? 'approval-inbox'
    : getTaskControlPlaneSurface(
      linkedTask
        ?? (statusEntry.taskStatus ? { status: statusEntry.taskStatus as Task['status'] } : null),
    );
  const controlPlaneSurfaceLabel = getTaskControlPlaneSurfaceLabel(controlPlaneSurface);
  const fallbackMainPathBadge = !mainPathBadge && controlPlaneSurfaceLabel
    ? {
      kind: 'surface',
      label: controlPlaneSurfaceLabel,
      surfaceTarget: controlPlaneSurface ?? undefined,
    } satisfies TaskMainPathBadge
    : !mainPathBadge && linkedTask?.execution_strategy === 'handoff'
      ? {
        kind: 'path',
        label: 'Handoff',
      } satisfies TaskMainPathBadge
      : null;
  const effectiveMainPathBadge = mainPathBadge ?? fallbackMainPathBadge;
  const mainPathBadgeLabel = formatTaskMainPathBadgeLabel(effectiveMainPathBadge);
  const projectWorktreePath = project.worktreePath || (project.isGitWorktree ? (project.fullPath || project.path) : undefined);
  const effectiveTaskForContext: TaskDispatchContextTask | null = linkedTask
    ? {
      ...linkedTask,
      worktree_path: linkedTask.worktree_path || statusEntry.worktreePath || projectWorktreePath,
    }
      : statusEntry.taskExecutionStrategy
      ? {
        execution_strategy: statusEntry.taskExecutionStrategy as Task['execution_strategy'],
        worktree_path: statusEntry.worktreePath || projectWorktreePath,
        status: (statusEntry.taskStatus as Task['status']) ?? 'queued',
        session_id: session.id,
        source_session_id: undefined,
        result_summary: '',
      }
      : null;
  const dispatchPresentation = effectiveTaskForContext
    ? buildTaskDispatchPresentation(effectiveTaskForContext, {
      sourceSessionLabel,
      runtimeSessionLabel,
      taskSessionBinding,
      fallbackWorktreePath: projectWorktreePath,
    })
    : null;
  const dispatchContextLines = dispatchPresentation?.dispatchDetailLines ?? [];
  const dispatchTargetSummary = dispatchPresentation?.dispatchTargetLabel;
  const sessionTitle = String(session.title || session.name || session.summary || `Session ${session.id.slice(0, 8)}`);
  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    onClick();
  };

  return (
    <div className="relative">
      {showHandoffAction ? (
        <div className="absolute right-3 top-3 z-10">
          <HandoffTaskMenu
            currentProvider={provider}
            sessionId={session.id}
            sessionTitle={String(session.title || session.name || session.summary || `Session ${session.id.slice(0, 8)}`)}
            projectPath={project.path || project.fullPath}
            worktreePath={statusEntry.worktreePath || linkedTask?.worktree_path || projectWorktreePath || undefined}
            selectedProject={project}
            availableProjects={availableProjects}
            onQueuedTask={onQueueHandoffTask}
          />
        </div>
      ) : null}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${sessionTitle}`}
        onClick={onClick}
        onKeyDown={handleCardKeyDown}
        className={`group relative flex w-full flex-col gap-2.5 rounded-2xl border border-border/60 bg-card/80 p-4 text-left shadow-sm transition-all hover:border-border hover:bg-card hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${showHandoffAction ? 'pr-11' : ''} ${borderClass}`}
      >
        <div className="flex items-center gap-2">
          <StatusDot status={statusEntry.status} />
          <span
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white ${
              provider === 'codex' ? 'bg-blue-600' : 'bg-violet-600'
            }`}
          >
            {provider}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {project.displayName || project.name}
          </span>
          {project.branch ? (
            <span className="ml-auto truncate text-[10px] text-muted-foreground/60">
              {project.branch}
            </span>
          ) : null}
        </div>

        <div className="min-h-[2.5rem]">
          <p className="line-clamp-1 text-sm font-medium text-foreground">
            {sessionTitle}
          </p>
          {session.summary ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{session.summary}</p>
          ) : null}
        </div>

        {resolvedTaskTitle || resolvedTaskRole || resolvedTaskExecutionStrategy || dispatchTargetSummary ? (
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            {resolvedTaskTitle ? (
              <span className="max-w-full rounded-full bg-primary/8 px-2 py-0.5 font-medium text-primary">
                <span className="text-primary/70">Task</span> · {resolvedTaskTitle}
              </span>
            ) : null}
            {resolvedTaskRole ? (
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-600">
                Role · {resolvedTaskRole}
              </span>
            ) : null}
            {resolvedTaskExecutionStrategy ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600">
                Exec · {resolvedTaskExecutionStrategy}
              </span>
            ) : null}
            {handoffBindingLabel ? (
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 font-medium text-sky-700">
                {handoffBindingLabel}
              </span>
            ) : null}
            {mainPathBadgeLabel ? (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700">
                {mainPathBadgeLabel}
              </span>
            ) : null}
            {resolvedTaskStatus ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                {resolvedTaskStatus}
              </span>
            ) : null}
            {dispatchTargetSummary ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                {dispatchTargetSummary}
              </span>
            ) : null}
          </div>
        ) : null}

        {dispatchContextLines.length > 1 ? (
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            {dispatchPresentation?.contextDetailLines.map((line) => (
              <p key={line} className="truncate">{line}</p>
            ))}
          </div>
        ) : null}

        {mainPathAction ? (
          <div className="flex items-center">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                mainPathAction.onClick();
              }}
              className="inline-flex h-7 items-center rounded-lg border border-border/60 bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              {mainPathAction.label}
            </button>
          </div>
        ) : null}

        <div className="flex items-center gap-2 text-muted-foreground">
          {pendingApproval ? (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600">
              Approval pending
            </span>
          ) : activeAttentionItem ? (
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500">
              {activeAttentionItem.reason}
            </span>
          ) : (
            <>
              <span className="text-[10px]">💬 Chat</span>
              <span className="text-[10px]">🖥 Terminal</span>
            </>
          )}
          <span className="ml-auto text-[10px]">{timeLabel}</span>
        </div>
      </div>
    </div>
  );
}
