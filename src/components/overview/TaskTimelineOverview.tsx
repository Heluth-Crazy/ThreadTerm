import { useTranslation } from 'react-i18next';
import type { Task } from '../../lib/tauri-bridge';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget, TaskTimelineStage } from '../../lib/mission-control';
import {
  buildTaskDispatchPresentation,
  compactPathLabel,
  formatProviderLabel,
  formatTaskExecutionStrategyLabel,
  formatTaskRoleLabel,
  formatTaskStatusLabel,
  type TaskSessionSummaryContext,
} from '../../lib/task-dispatch';
import type { BackgroundRun } from '../../types/background-run';
import { describeTaskMainPath, formatTaskMainPathBadgeLabel, type TaskMainPathBadge } from '../../lib/task-main-path';

export type TaskFlowStage = TaskTimelineStage;
export type TaskTimelineSurfaceTarget = MissionControlSurfaceTarget;
export type TaskTimelineSurfaceFocusLocator = MissionControlSurfaceLocator;

interface TaskTimelineOverviewProps {
  backlogTasks: Task[];
  runningTasks: Task[];
  reviewTasks: Task[];
  completedTasks: Task[];
  backgroundRuns: BackgroundRun[];
  sessionLabels: Record<string, TaskSessionSummaryContext>;
  pendingApprovalSessionIds: Set<string>;
  resultTaskIds: Set<string>;
  onOpenSession: (sessionId: string) => void;
  onOpenTaskQueue: (projectPath: string) => void;
  onFocusSurface: (target: TaskTimelineSurfaceTarget, locator?: TaskTimelineSurfaceFocusLocator) => void;
  focusedStage?: TaskFlowStage | null;
}

interface StageConfig {
  key: TaskFlowStage;
  title: string;
  description: string;
  badgeClassName: string;
  emptyMessage: string;
}

const VISIBLE_TASK_COUNT = 3;

type TFunc = (key: string, fallback: string) => string;

const STAGES_KEYS = [
  {
    key: 'backlog' as const,
    titleKey: 'taskTimeline.backlogTitle',
    titleFallback: 'Backlog',
    descKey: 'taskTimeline.backlogDesc',
    descFallback: 'Open and queued durable tasks waiting to be dispatched.',
    badgeClassName: 'bg-slate-500/10 text-slate-700',
    emptyKey: 'taskTimeline.backlogEmpty',
    emptyFallback: 'No backlog tasks.',
  },
  {
    key: 'running' as const,
    titleKey: 'taskTimeline.runningTitle',
    titleFallback: 'Running',
    descKey: 'taskTimeline.runningDesc',
    descFallback: 'Dispatched work that is actively executing or blocked on approval.',
    badgeClassName: 'bg-sky-500/10 text-sky-700',
    emptyKey: 'taskTimeline.runningEmpty',
    emptyFallback: 'No running tasks.',
  },
  {
    key: 'review' as const,
    titleKey: 'taskTimeline.pendingReviewTitle',
    titleFallback: 'Pending Review',
    descKey: 'taskTimeline.pendingReviewDesc',
    descFallback: 'Completed runs waiting for a human accept or rework decision.',
    badgeClassName: 'bg-violet-500/10 text-violet-700',
    emptyKey: 'taskTimeline.pendingReviewEmpty',
    emptyFallback: 'Nothing is waiting for review.',
  },
  {
    key: 'completed' as const,
    titleKey: 'taskTimeline.completedTitle',
    titleFallback: 'Completed',
    descKey: 'taskTimeline.completedDesc',
    descFallback: 'Recently finished durable tasks, including accepted results and terminal failures or cancellations.',
    badgeClassName: 'bg-emerald-500/10 text-emerald-700',
    emptyKey: 'taskTimeline.completedEmpty',
    emptyFallback: 'No recently completed tasks.',
  },
];

function getStages(t: TFunc): StageConfig[] {
  return STAGES_KEYS.map(({ key, titleKey, titleFallback, descKey, descFallback, badgeClassName, emptyKey, emptyFallback }) => ({
    key,
    title: t(titleKey, titleFallback),
    description: t(descKey, descFallback),
    badgeClassName,
    emptyMessage: t(emptyKey, emptyFallback),
  }));
}

function formatRunStatus(status: BackgroundRun['status']) {
  return status.replace(/_/g, ' ');
}

function formatRelativeTime(dateString?: string) {
  if (!dateString) return 'now';
  const diff = Date.now() - new Date(dateString).getTime();
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compactProjectLabel(projectPath: string) {
  return compactPathLabel(projectPath) ?? projectPath;
}

function findLinkedRun(task: Task, backgroundRuns: BackgroundRun[]) {
  const taskLinkedRun = backgroundRuns.find((run) => run.taskId === task.id);
  if (taskLinkedRun) return taskLinkedRun;
  if (!task.session_id) return undefined;
  return backgroundRuns.find((run) => run.sessionId === task.session_id);
}

function getTaskSummary(stage: TaskFlowStage, task: Task, t: TFunc, linkedRun?: BackgroundRun) {
  if (stage === 'running') {
    if (linkedRun?.summary) return linkedRun.summary;
    if (linkedRun?.lastOutputExcerpt) return linkedRun.lastOutputExcerpt;
    if (task.result_summary) return task.result_summary;
    if (task.status === 'pending_approval') return t('taskTimeline.waitingApproval', 'Waiting for approval before this run can continue.');
    return task.description || t('taskTimeline.executing', 'Task is currently executing.');
  }

  if (stage === 'review') {
    return task.result_summary || t('taskTimeline.awaitingReview', 'Awaiting human review before this result is accepted.');
  }

  if (stage === 'completed') {
    if (task.status === 'failed') {
      return task.result_summary || t('taskTimeline.executionFailed', 'Execution failed before this task reached review or result inbox.');
    }
    if (task.status === 'cancelled') {
      return task.result_summary || t('taskTimeline.cancelled', 'This task was cancelled before it completed.');
    }
    return task.result_summary || t('taskTimeline.completedNoMeta', 'Completed without extra structured result metadata yet.');
  }

  return task.description || t('taskTimeline.queuedBacklog', 'Queued in the durable task backlog.');
}

function getPrimaryAction(
  _stage: TaskFlowStage,
  task: Task,
  linkedRun: BackgroundRun | undefined,
  pendingApprovalSessionIds: Set<string>,
  availableSessionIds: Set<string>,
  resultTaskIds: Set<string>,
){
  return describeTaskMainPath(task, {
    pendingApprovalSessionIds,
    backgroundRunId: linkedRun?.id,
    availableSessionIds,
    resultTaskIds,
  }).action;
}

function getStageTasks(stage: TaskFlowStage, props: TaskTimelineOverviewProps) {
  switch (stage) {
    case 'backlog':
      return props.backlogTasks;
    case 'running':
      return props.runningTasks;
    case 'review':
      return props.reviewTasks;
    case 'completed':
      return props.completedTasks;
  }
}

function getTaskMainPathBadgeClassName(badge: TaskMainPathBadge | null) {
  if (!badge) return null;

  if (badge.kind === 'path') {
    return 'bg-sky-500/10 text-sky-700';
  }

  switch (badge.surfaceTarget) {
    case 'approval-inbox':
      return 'bg-amber-500/10 text-amber-700';
    case 'review-queue':
      return 'bg-violet-500/10 text-violet-700';
    case 'result-inbox':
      return 'bg-emerald-500/10 text-emerald-700';
    case 'background-runs':
      return 'bg-sky-500/10 text-sky-700';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function TaskFlowCard({
  stage,
  task,
  linkedRun,
  sessionLabels,
  pendingApprovalSessionIds,
  resultTaskIds,
  onOpenSession,
  onOpenTaskQueue,
  onFocusSurface,
}: {
  stage: TaskFlowStage;
  task: Task;
  linkedRun?: BackgroundRun;
  sessionLabels: Record<string, TaskSessionSummaryContext>;
  pendingApprovalSessionIds: Set<string>;
  resultTaskIds: Set<string>;
  onOpenSession: (sessionId: string) => void;
  onOpenTaskQueue: (projectPath: string) => void;
  onFocusSurface: (target: TaskTimelineSurfaceTarget, locator?: TaskTimelineSurfaceFocusLocator) => void;
}) {
  const { t } = useTranslation('common');
  const summary = getTaskSummary(stage, task, t, linkedRun);
  const changedFileCount = task.result_changed_files?.length ?? 0;
  const availableSessionIds = new Set(Object.keys(sessionLabels));
  const primaryAction = getPrimaryAction(
    stage,
    task,
    linkedRun,
    pendingApprovalSessionIds,
    availableSessionIds,
    resultTaskIds,
  );
  const mainPathBadge = describeTaskMainPath(task, {
    pendingApprovalSessionIds,
    backgroundRunId: linkedRun?.id,
    availableSessionIds,
    resultTaskIds,
  }).badge;
  const mainPathBadgeLabel = formatTaskMainPathBadgeLabel(mainPathBadge);
  const roleLabel = formatTaskRoleLabel(task.role);
  const executionStrategyLabel = formatTaskExecutionStrategyLabel(task.execution_strategy);
  const mainPathBadgeClassName = getTaskMainPathBadgeClassName(mainPathBadge);
  const dispatchPresentation = buildTaskDispatchPresentation(task, {
    sessionLabelsById: sessionLabels,
  });
  const dispatchTargetLabel = dispatchPresentation.dispatchTargetLabel;
  const contextDetailLines = dispatchPresentation.contextDetailLines;

  const handlePrimaryAction = () => {
    if (primaryAction.kind === 'session' && primaryAction.sessionId) {
      onOpenSession(primaryAction.sessionId);
      return;
    }

    if (primaryAction.kind === 'surface' && primaryAction.surfaceTarget) {
      onFocusSurface(primaryAction.surfaceTarget, primaryAction.focusLocator);
      return;
    }

    onOpenTaskQueue(task.project_path);
  };

  return (
    <article className="rounded-xl border border-border/60 bg-background/70 p-3">
      {mainPathBadgeLabel && mainPathBadgeClassName ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className={`rounded-full px-2 py-0.5 font-medium ${mainPathBadgeClassName}`}>
            {mainPathBadgeLabel}
          </span>
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{task.title}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{summary}</p>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(task.updated_at)}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
          {formatTaskStatusLabel(task.status) ?? task.status}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
          {formatProviderLabel(task.provider)}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
          {compactProjectLabel(task.project_path)}
        </span>
        {roleLabel ? (
          <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-700">
            {roleLabel}
          </span>
        ) : null}
        {executionStrategyLabel ? (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700">
            {executionStrategyLabel}
          </span>
        ) : null}
        {dispatchTargetLabel ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
            {dispatchTargetLabel}
          </span>
        ) : null}
        {linkedRun ? (
          <span className="rounded-full bg-sky-500/10 px-2 py-0.5 font-medium text-sky-700">
            Run · {formatRunStatus(linkedRun.status)}
          </span>
        ) : null}
        {changedFileCount > 0 ? (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700">
            {changedFileCount} file{changedFileCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {contextDetailLines.length > 0 ? (
        <div className="mt-3 space-y-1 text-[11px] text-muted-foreground">
          {contextDetailLines.map((line) => (
            <p key={line} className="truncate">{line}</p>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={handlePrimaryAction}
          className="inline-flex h-7 items-center rounded-lg bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {primaryAction.label}
        </button>
      </div>
    </article>
  );
}

export default function TaskTimelineOverview(props: TaskTimelineOverviewProps) {
  const { t } = useTranslation('common');
  const STAGES = getStages(t);
  const counts = {
    backlog: props.backlogTasks.length,
    running: props.runningTasks.length,
    review: props.reviewTasks.length,
    completed: props.completedTasks.length,
  } as const;

  return (
    <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('taskTimeline.title', 'Task Timeline')}</h2>
          <p className="text-xs text-muted-foreground">{t('taskTimeline.subtitle', 'Durable task flow from backlog through running, review, and completion.')}</p>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {counts.backlog + counts.running + counts.review + counts.completed}
        </span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {STAGES.map((stage) => (
          <div key={stage.key} className="rounded-xl border border-border/60 bg-background/60 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{stage.title}</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{counts[stage.key]}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        {STAGES.map((stage) => {
          const tasks = getStageTasks(stage.key, props);
          const visibleTasks = tasks.slice(0, VISIBLE_TASK_COUNT);

          return (
            <section
              key={stage.key}
              role="region"
              aria-label={`Task flow ${stage.title}`}
              tabIndex={-1}
              data-task-timeline-stage={stage.key}
              data-surface-focused={props.focusedStage === stage.key ? 'true' : 'false'}
              className={`rounded-2xl border border-border/60 bg-muted/20 p-3 ${
                props.focusedStage === stage.key
                  ? 'ring-2 ring-primary/30 ring-offset-2 ring-offset-background'
                  : ''
              }`}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">{stage.title}</div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{stage.description}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${stage.badgeClassName}`}>
                  {counts[stage.key]}
                </span>
              </div>

              {visibleTasks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-3 py-6 text-center text-xs text-muted-foreground">
                  {stage.emptyMessage}
                </div>
              ) : (
                <div className="space-y-3">
                  {visibleTasks.map((task, index) => (
                    <TaskFlowCard
                      key={task.id || `${stage.key}-${index}`}
                      stage={stage.key}
                      task={task}
                      linkedRun={findLinkedRun(task, props.backgroundRuns)}
                      sessionLabels={props.sessionLabels}
                      pendingApprovalSessionIds={props.pendingApprovalSessionIds}
                      resultTaskIds={props.resultTaskIds}
                      onOpenSession={props.onOpenSession}
                      onOpenTaskQueue={props.onOpenTaskQueue}
                      onFocusSurface={props.onFocusSurface}
                    />
                  ))}
                  {tasks.length > visibleTasks.length ? (
                    <div className="rounded-xl border border-dashed border-border/60 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
                      +{tasks.length - visibleTasks.length} more in {stage.title.toLowerCase()}
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
