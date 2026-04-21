import type { Task } from './tauri-bridge';

type DispatchTaskLike = Pick<
  Task,
  | 'execution_strategy'
  | 'created_at'
  | 'id'
  | 'project_path'
  | 'result_summary'
  | 'session_id'
  | 'source_session_id'
  | 'status'
  | 'updated_at'
  | 'worktree_path'
>;

type DispatchTaskSessionLike = {
  execution_strategy?: Task['execution_strategy'] | null;
  result_summary?: string | null;
  session_id?: string | null;
  source_session_id?: string | null;
  status: Task['status'];
  worktree_path?: string | null;
};

export type TaskDispatchContextTask = DispatchTaskSessionLike;

export interface TaskSessionSummaryContext {
  sessionId?: string | null;
  title?: string | null;
  subtitle?: string | null;
  label?: string | null;
}

export type TaskSessionSummaryInput = string | TaskSessionSummaryContext | null | undefined;

export type TaskSessionBinding = 'source' | 'runtime' | 'shared';

export interface LinkedTaskSession<T extends DispatchTaskLike = DispatchTaskLike> {
  task: T;
  binding: TaskSessionBinding;
}

export interface TaskDispatchContextOptions {
  sourceSessionLabel?: TaskSessionSummaryInput;
  runtimeSessionLabel?: TaskSessionSummaryInput;
  taskSessionBinding?: TaskSessionBinding | null;
}

export interface TaskOpenSessionAction {
  kind: 'source' | 'runtime';
  label: string;
  sessionId: string;
}

export interface TaskDispatchPresentationOptions extends TaskDispatchContextOptions {
  sessionLabelsById?: Record<string, TaskSessionSummaryInput | undefined>;
  fallbackWorktreePath?: string | null;
}

export interface TaskDispatchPresentation {
  sourceSessionId?: string;
  runtimeSessionId?: string;
  dispatchDetailLines: string[];
  dispatchTargetLabel?: string;
  contextDetailLines: string[];
  openSessionAction: TaskOpenSessionAction | null;
}

export function normalizePath(value?: string | null) {
  return value?.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '';
}

export function compactPathLabel(value?: string | null) {
  const normalized = normalizePath(value);
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function formatPathTail(value?: string | null, segmentCount = 2) {
  const normalized = normalizePath(value);
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(-segmentCount).join('/');
}

export function formatTaskSessionSummary(value?: TaskSessionSummaryInput) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }

  if (!value) {
    return null;
  }

  const label = value.label?.trim();
  if (label) {
    return label;
  }

  const subtitle = value.subtitle?.trim();
  const title = value.title?.trim();
  if (subtitle && title) {
    return `${subtitle} · ${title}`;
  }
  if (title) {
    return title;
  }
  if (subtitle) {
    return subtitle;
  }

  const sessionId = value.sessionId?.trim();
  return sessionId || null;
}

export function resolveTaskSourceSessionId(task: DispatchTaskSessionLike) {
  if (task.execution_strategy !== 'handoff') return undefined;

  const sourceSessionId = task.source_session_id?.trim();
  if (sourceSessionId) return sourceSessionId;

  const legacySourceEligibleStatus =
    task.status === 'open'
    || task.status === 'queued'
    || task.status === 'failed'
    || task.status === 'dispatched'
    || (task.status === 'cancelled' && task.result_summary === 'Cancelled before handoff started');

  return legacySourceEligibleStatus ? task.session_id?.trim() || undefined : undefined;
}

export function resolveTaskRuntimeSessionId(task: DispatchTaskSessionLike) {
  const runtimeSessionId = task.session_id?.trim();
  const sourceSessionId = resolveTaskSourceSessionId(task);
  if (!runtimeSessionId || runtimeSessionId === sourceSessionId) return undefined;
  return runtimeSessionId;
}

export function formatProviderLabel(provider?: string | null) {
  const normalizedProvider = provider?.trim();
  if (!normalizedProvider) return 'Unknown';
  return normalizedProvider.charAt(0).toUpperCase() + normalizedProvider.slice(1);
}

export function formatTaskStatusLabel(status?: Task['status'] | string | null) {
  switch (status) {
    case 'pending_approval':
      return 'Approval';
    case 'pending_review':
      return 'Review';
    case 'in_progress':
      return 'Running';
    case 'dispatched':
      return 'Dispatched';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'queued':
      return 'Queued';
    case 'open':
      return 'Open';
    case 'archived':
      return 'Archived';
    default:
      return status ? status.replace(/_/g, ' ') : null;
  }
}

export function formatTaskRoleLabel(role?: Task['role'] | string | null) {
  switch (role) {
    case 'implement':
      return 'Implement';
    case 'review':
      return 'Review';
    case 'verify':
      return 'Verify';
    case 'research':
      return 'Research';
    default:
      return role ? role.replace(/_/g, ' ') : null;
  }
}

export function formatTaskExecutionStrategyLabel(strategy?: Task['execution_strategy'] | string | null) {
  switch (strategy) {
    case 'current_project':
      return 'This Project';
    case 'worktree':
      return 'Worktree';
    case 'handoff':
      return 'Handoff';
    default:
      return strategy ? strategy.replace(/_/g, ' ') : null;
  }
}

export function formatPendingHandoffRuntimeLabel(status?: Task['status'] | string | null) {
  switch (status) {
    case 'dispatched':
      return 'Starting in background';
    case 'open':
    case 'queued':
    default:
      return 'Starts when dispatch begins';
  }
}

export function formatWorktreeTargetLabel(worktreePath?: string | null) {
  const worktreeLabel = compactPathLabel(worktreePath);
  return worktreeLabel ? `${worktreeLabel} worktree` : null;
}

export function formatTaskDispatchTargetLabel(
  task: Pick<DispatchTaskSessionLike, 'execution_strategy' | 'worktree_path'>,
) {
  const worktreeTargetLabel = formatWorktreeTargetLabel(task.worktree_path);
  if (worktreeTargetLabel) {
    return worktreeTargetLabel;
  }

  if (task.execution_strategy === 'worktree') {
    return 'Selected worktree';
  }

  return 'This project';
}

export function resolveTaskExecutionProjectPath(task: Pick<DispatchTaskLike, 'execution_strategy' | 'project_path' | 'worktree_path'>) {
  switch (task.execution_strategy) {
    case 'current_project':
      return task.project_path;
    case 'worktree':
    case 'handoff':
      return task.worktree_path ?? task.project_path;
    default:
      return task.project_path;
  }
}

export function describeTaskExecutionTarget(task: Pick<DispatchTaskLike, 'worktree_path'>) {
  const targetLabel = formatTaskDispatchTargetLabel({
    execution_strategy: task.worktree_path ? 'worktree' : 'current_project',
    worktree_path: task.worktree_path,
  });
  return targetLabel === 'This project' ? 'this project' : `the ${targetLabel}`;
}

export function buildTaskDispatchContextLines(
  task: DispatchTaskSessionLike,
  options: TaskDispatchContextOptions = {},
) {
  const lines: string[] = [];

  if (task.execution_strategy === 'handoff') {
    const sourceSessionSummary = formatTaskSessionSummary(options.sourceSessionLabel)
      ?? (
        options.taskSessionBinding === 'source' || options.taskSessionBinding === 'shared'
          ? 'This session'
          : resolveTaskSourceSessionId(task)
      )
      ?? null;
    const runtimeSessionSummary = formatTaskSessionSummary(options.runtimeSessionLabel)
      ?? (
        options.taskSessionBinding === 'runtime' || options.taskSessionBinding === 'shared'
          ? 'This session'
          : resolveTaskRuntimeSessionId(task)
      )
      ?? null;
    const pendingRuntimeLabel = runtimeSessionSummary ? null : formatPendingHandoffRuntimeLabel(task.status);

    if (sourceSessionSummary && runtimeSessionSummary && sourceSessionSummary === runtimeSessionSummary) {
      lines.push(`Handoff session · ${sourceSessionSummary}`);
    } else {
      if (sourceSessionSummary) {
        lines.push(`Source session · ${sourceSessionSummary}`);
      }
      if (runtimeSessionSummary) {
        lines.push(`Runtime session · ${runtimeSessionSummary}`);
      } else if (pendingRuntimeLabel) {
        lines.push(`Runtime session · ${pendingRuntimeLabel}`);
      }
    }
  }

  lines.push(`Dispatch target · ${formatTaskDispatchTargetLabel(task)}`);

  return lines;
}

export function buildTaskDispatchDetailLines(
  task: DispatchTaskSessionLike,
  options: TaskDispatchContextOptions = {},
) {
  const lines = buildTaskDispatchContextLines(task, options);
  const worktreePathTail = formatPathTail(task.worktree_path);

  if (task.worktree_path) {
    lines.push(`Worktree path · ${worktreePathTail ?? task.worktree_path}`);
  }

  return lines;
}

function resolveRuntimeSessionIdForAction(task: DispatchTaskSessionLike) {
  if (task.execution_strategy === 'handoff') {
    return resolveTaskRuntimeSessionId(task);
  }

  return task.session_id?.trim() || undefined;
}

export function resolveTaskOpenSessionAction(task: DispatchTaskSessionLike): TaskOpenSessionAction | null {
  const runtimeSessionId = resolveRuntimeSessionIdForAction(task);
  if (runtimeSessionId) {
    return {
      kind: 'runtime',
      label: task.execution_strategy === 'handoff' ? 'Open Handoff Session' : 'Open Session',
      sessionId: runtimeSessionId,
    };
  }

  const sourceSessionId = resolveTaskSourceSessionId(task);
  if (sourceSessionId) {
    return {
      kind: 'source',
      label: 'Open Source Session',
      sessionId: sourceSessionId,
    };
  }

  return null;
}

export function buildTaskDispatchPresentation(
  task: DispatchTaskSessionLike,
  options: TaskDispatchPresentationOptions = {},
): TaskDispatchPresentation {
  const sourceSessionId = resolveTaskSourceSessionId(task);
  const runtimeSessionId = resolveRuntimeSessionIdForAction(task);
  const sourceSessionLabel = options.sourceSessionLabel
    ?? (sourceSessionId ? options.sessionLabelsById?.[sourceSessionId] : undefined);
  const runtimeSessionLabel = options.runtimeSessionLabel
    ?? (runtimeSessionId ? options.sessionLabelsById?.[runtimeSessionId] : undefined);
  const effectiveTask = options.fallbackWorktreePath && !normalizePath(task.worktree_path)
    ? {
      ...task,
      worktree_path: options.fallbackWorktreePath,
    }
    : task;
  const dispatchDetailLines = buildTaskDispatchDetailLines(effectiveTask, {
    sourceSessionLabel,
    runtimeSessionLabel,
    taskSessionBinding: options.taskSessionBinding,
  });
  const dispatchTargetLabel = dispatchDetailLines.find((line) => line.startsWith('Dispatch target'));

  return {
    sourceSessionId,
    runtimeSessionId,
    dispatchDetailLines,
    dispatchTargetLabel,
    contextDetailLines: dispatchDetailLines.filter((line) => line !== dispatchTargetLabel),
    openSessionAction: resolveTaskOpenSessionAction(task),
  };
}

export function buildTaskSessionSummaryLine(
  task: DispatchTaskSessionLike,
  sourceSessionLabel?: TaskSessionSummaryInput,
  runtimeSessionLabel?: TaskSessionSummaryInput,
) {
  if (task.execution_strategy !== 'handoff') return null;
  const sessionLines = buildTaskDispatchContextLines(task, {
    sourceSessionLabel,
    runtimeSessionLabel,
  }).filter((line) =>
    line.startsWith('Source session')
    || line.startsWith('Runtime session')
    || line.startsWith('Handoff session'),
  );
  return sessionLines.length > 0 ? sessionLines.join(' · ') : null;
}

export function getTaskSessionBinding(task: DispatchTaskSessionLike, sessionId?: string | null): TaskSessionBinding | null {
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedSessionId) return null;

  const sourceSessionId = resolveTaskSourceSessionId(task);
  const runtimeSessionId = resolveTaskRuntimeSessionId(task) ?? (task.session_id?.trim() || undefined);
  const isSourceSession = sourceSessionId === normalizedSessionId;
  const isRuntimeSession = runtimeSessionId === normalizedSessionId;

  if (isSourceSession && isRuntimeSession) return 'shared';
  if (isRuntimeSession) return 'runtime';
  if (isSourceSession) return 'source';
  return null;
}

export function getTaskSessionBindingLabel(binding?: TaskSessionBinding | null) {
  switch (binding) {
    case 'source':
      return 'Handoff Source';
    case 'runtime':
      return 'Handoff Runtime';
    case 'shared':
      return 'Handoff Session';
    default:
      return null;
  }
}

function getTaskStatusPriority(status: DispatchTaskLike['status']) {
  switch (status) {
    case 'pending_approval':
      return 8;
    case 'in_progress':
      return 7;
    case 'dispatched':
      return 6;
    case 'pending_review':
      return 5;
    case 'queued':
      return 4;
    case 'open':
      return 3;
    case 'done':
      return 2;
    case 'failed':
      return 1;
    case 'cancelled':
      return 0;
    case 'archived':
    default:
      return -1;
  }
}

function getTaskBindingPriority(binding: TaskSessionBinding | null) {
  switch (binding) {
    case 'shared':
      return 3;
    case 'runtime':
      return 2;
    case 'source':
      return 1;
    default:
      return -1;
  }
}

function getTaskTimestamp(task: Pick<DispatchTaskLike, 'created_at' | 'updated_at'>) {
  const updatedAt = Date.parse(task.updated_at);
  if (Number.isFinite(updatedAt)) return updatedAt;

  const createdAt = Date.parse(task.created_at);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export function findTaskSessionLink<T extends DispatchTaskLike>(tasks: T[], sessionId?: string | null): LinkedTaskSession<T> | undefined {
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedSessionId) return undefined;

  const candidates = tasks
    .map((task) => ({
      task,
      binding: getTaskSessionBinding(task, normalizedSessionId),
    }))
    .filter((candidate): candidate is LinkedTaskSession<T> => candidate.binding !== null);

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((a, b) => {
    const bindingPriorityDelta = getTaskBindingPriority(b.binding) - getTaskBindingPriority(a.binding);
    if (bindingPriorityDelta !== 0) return bindingPriorityDelta;

    const statusPriorityDelta = getTaskStatusPriority(b.task.status) - getTaskStatusPriority(a.task.status);
    if (statusPriorityDelta !== 0) return statusPriorityDelta;

    return getTaskTimestamp(b.task) - getTaskTimestamp(a.task);
  });

  return candidates[0];
}
