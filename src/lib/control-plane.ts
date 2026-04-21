import type { Task } from './tauri-bridge';
import type { TaskTimelineStage } from './mission-control';

type TaskResultPayloadLike = Pick<Task, 'status'> & Partial<Pick<
  Task,
  | 'id'
  | 'review_required'
  | 'result_summary'
  | 'result_changed_files'
  | 'result_verification_summary'
  | 'result_risk_summary'
  | 'result_suggested_next_step'
  | 'session_id'
>>;

interface VisibleTaskControlPlaneOptions {
  pendingApprovalSessionIds?: Set<string>;
  resultTaskIds?: Set<string>;
}

export type TaskControlPlaneSurface = 'approval-inbox' | 'review-queue' | 'result-inbox';
export type TaskCompletionSurface = Exclude<TaskControlPlaneSurface, 'approval-inbox'>;

export const REVIEW_REQUIRED_RESULT_RISK_SUMMARY = 'Review required before accepting this task result.';
export const REVIEW_QUEUE_NEXT_STEP = 'Open Review Queue to inspect the changed files and accept or request rework.';
export const RESULT_INBOX_CHANGED_FILES_NEXT_STEP = 'Open Result Inbox to inspect the changed files, then archive when satisfied.';
export const RESULT_INBOX_ACCEPTED_NEXT_STEP = 'Open Result Inbox to inspect the accepted result, then archive when satisfied.';
export const RESULT_INBOX_ARCHIVE_ACCEPTED_NEXT_STEP = 'Archive the accepted result when you are satisfied with this task.';
export const RESULT_INBOX_ARCHIVE_COMPLETED_NEXT_STEP = 'Archive the result when you are satisfied with this completed task.';

export function getTaskTimelineStage(task?: Pick<Task, 'status'> | null): TaskTimelineStage | null {
  if (!task) return null;

  switch (task.status) {
    case 'open':
    case 'queued':
      return 'backlog';
    case 'dispatched':
    case 'in_progress':
    case 'pending_approval':
      return 'running';
    case 'pending_review':
      return 'review';
    case 'done':
    case 'failed':
    case 'cancelled':
      return 'completed';
    default:
      return null;
  }
}

export function isTaskTimelineStage(task: Pick<Task, 'status'> | null | undefined, stage: TaskTimelineStage) {
  return getTaskTimelineStage(task) === stage;
}

export function hasTaskResultPayload(task: TaskResultPayloadLike): boolean {
  return Boolean(
    task.result_summary?.trim()
    || task.result_changed_files?.length
    || task.result_verification_summary?.trim()
    || task.result_risk_summary?.trim()
    || task.result_suggested_next_step?.trim(),
  );
}

export function hasStructuredTaskResultDetails(task: TaskResultPayloadLike): boolean {
  return Boolean(
    task.result_changed_files?.length
    || task.result_verification_summary?.trim()
    || task.result_risk_summary?.trim()
    || task.result_suggested_next_step?.trim(),
  );
}

export function isAcceptedResultTask(task: TaskResultPayloadLike): boolean {
  return task.status === 'done' && !task.review_required && hasTaskResultPayload(task);
}

export function getTaskControlPlaneSurface(task?: TaskResultPayloadLike | null): TaskControlPlaneSurface | null {
  if (!task) return null;
  if (task.status === 'pending_approval') return 'approval-inbox';
  if (task.status === 'pending_review') return 'review-queue';
  if (isAcceptedResultTask(task)) return 'result-inbox';
  return null;
}

export function getVisibleTaskControlPlaneSurface(
  task?: TaskResultPayloadLike | null,
  options: VisibleTaskControlPlaneOptions = {},
): TaskControlPlaneSurface | null {
  if (!task) return null;

  const sessionId = task.session_id?.trim();

  // A session actively waiting for approval always surfaces in the approval inbox,
  // regardless of the task's stored status (may still be 'in_progress').
  if (sessionId && options.pendingApprovalSessionIds?.has(sessionId)) {
    return 'approval-inbox';
  }

  const surface = getTaskControlPlaneSurface(task);

  if (surface === 'approval-inbox') {
    // When a filter set is provided, only show the task if its session is in the set
    // (already handled above); otherwise it is not currently visible.
    if (options.pendingApprovalSessionIds) return null;
    return surface;
  }

  if (surface === 'result-inbox' && options.resultTaskIds) {
    return task.id && options.resultTaskIds.has(task.id) ? surface : null;
  }

  return surface;
}

export function getTaskCompletionSurface(reviewRequired: boolean): TaskCompletionSurface {
  return reviewRequired ? 'review-queue' : 'result-inbox';
}

export function getTaskControlPlaneSurfaceLabel(surface?: TaskControlPlaneSurface | null): string | null {
  switch (surface) {
    case 'approval-inbox':
      return 'Approval Inbox';
    case 'review-queue':
      return 'Review Queue';
    case 'result-inbox':
      return 'Result Inbox';
    default:
      return null;
  }
}

export function getTaskCompletionSurfaceLabel(reviewRequired: boolean): string {
  return getTaskControlPlaneSurfaceLabel(getTaskCompletionSurface(reviewRequired)) ?? 'Result Inbox';
}

export function getTaskCompletionRouteSummary(reviewRequired: boolean): string {
  return reviewRequired
    ? 'Successful completion routes into Review Queue for accept or rework.'
    : 'Successful completion routes into Result Inbox for final review and archive.';
}

export function buildVisibleControlPlaneItems<T extends { id: string }>(
  items: T[],
  maxVisible: number,
  focusedId?: string | null,
): T[] {
  const visibleItems = items.slice(0, maxVisible);
  const normalizedFocusedId = focusedId?.trim();
  if (!normalizedFocusedId || visibleItems.some((item) => item.id === normalizedFocusedId)) {
    return visibleItems;
  }

  const focusedItem = items.find((item) => item.id === normalizedFocusedId);
  if (!focusedItem) {
    return visibleItems;
  }

  return [...visibleItems, focusedItem];
}

export function buildAcceptedReviewResultPatch(task: Pick<Task, 'result_changed_files' | 'result_risk_summary' | 'result_suggested_next_step'>) {
  return {
    result_risk_summary:
      task.result_risk_summary === REVIEW_REQUIRED_RESULT_RISK_SUMMARY
        ? ''
        : task.result_risk_summary,
    result_suggested_next_step:
      task.result_suggested_next_step === REVIEW_QUEUE_NEXT_STEP
        ? task.result_changed_files?.length
          ? RESULT_INBOX_ACCEPTED_NEXT_STEP
          : RESULT_INBOX_ARCHIVE_ACCEPTED_NEXT_STEP
        : task.result_suggested_next_step,
  };
}
