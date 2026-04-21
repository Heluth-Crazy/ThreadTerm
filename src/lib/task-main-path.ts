import type { Task } from './tauri-bridge';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget } from './mission-control';
import { getVisibleTaskControlPlaneSurface } from './control-plane';
import { resolveTaskOpenSessionAction } from './task-dispatch';

export interface TaskMainPathAction {
  kind: 'surface' | 'session' | 'task-queue';
  label: string;
  surfaceTarget?: MissionControlSurfaceTarget;
  focusLocator?: MissionControlSurfaceLocator;
  sessionId?: string;
}

export interface TaskMainPathBadge {
  kind: 'surface' | 'path';
  label: string;
  surfaceTarget?: MissionControlSurfaceTarget;
}

export interface TaskMainPathDescriptor {
  action: TaskMainPathAction;
  badge: TaskMainPathBadge | null;
}

interface ResolveTaskMainPathActionOptions {
  pendingApprovalSessionIds?: Set<string>;
  backgroundRunId?: string | null;
  taskQueueLabel?: string;
  availableSessionIds?: Set<string>;
  resultTaskIds?: Set<string>;
}

function hasAvailableSession(
  action: ReturnType<typeof resolveTaskOpenSessionAction>,
  availableSessionIds?: Set<string>,
) {
  if (!action?.sessionId) return false;
  if (!availableSessionIds) return true;
  return availableSessionIds.has(action.sessionId);
}

function getSurfaceActionLabel(surface: MissionControlSurfaceTarget) {
  switch (surface) {
    case 'approval-inbox':
      return 'Open Approval Inbox';
    case 'review-queue':
      return 'Open Review Queue';
    case 'result-inbox':
      return 'Open Result Inbox';
    case 'background-runs':
      return 'Open Background Runs';
    default:
      return 'Open Mission Control';
  }
}

export function resolveTaskMainPathAction(
  task: Pick<Task, 'execution_strategy' | 'id' | 'session_id' | 'source_session_id' | 'status'>,
  options: ResolveTaskMainPathActionOptions = {},
): TaskMainPathAction {
  if (task.session_id?.trim() && options.pendingApprovalSessionIds?.has(task.session_id.trim())) {
    return {
      kind: 'surface',
      label: getSurfaceActionLabel('approval-inbox'),
      surfaceTarget: 'approval-inbox',
      focusLocator: {
        sessionId: task.session_id,
      },
    };
  }

  const controlPlaneSurface = getVisibleTaskControlPlaneSurface(task, {
    pendingApprovalSessionIds: options.pendingApprovalSessionIds,
    resultTaskIds: options.resultTaskIds,
  });
  if (controlPlaneSurface === 'approval-inbox' && task.session_id?.trim()) {
    return {
      kind: 'surface',
      label: getSurfaceActionLabel(controlPlaneSurface),
      surfaceTarget: controlPlaneSurface,
      focusLocator: {
        sessionId: task.session_id,
      },
    };
  }

  if (controlPlaneSurface === 'review-queue' || controlPlaneSurface === 'result-inbox') {
    return {
      kind: 'surface',
      label: getSurfaceActionLabel(controlPlaneSurface),
      surfaceTarget: controlPlaneSurface,
      focusLocator: {
        taskId: task.id,
      },
    };
  }

  const openSessionAction = resolveTaskOpenSessionAction(task);
  const canOpenSession = hasAvailableSession(openSessionAction, options.availableSessionIds);

  if (options.backgroundRunId && (!canOpenSession || openSessionAction?.kind !== 'runtime')) {
    return {
      kind: 'surface',
      label: getSurfaceActionLabel('background-runs'),
      surfaceTarget: 'background-runs',
      focusLocator: {
        runId: options.backgroundRunId,
      },
    };
  }

  if (task.execution_strategy === 'handoff' && (!canOpenSession || openSessionAction?.kind !== 'runtime')) {
    return {
      kind: 'task-queue',
      label: options.taskQueueLabel ?? 'Open Handoff Task',
    };
  }

  if (openSessionAction && canOpenSession) {
    return {
      kind: 'session',
      label: openSessionAction.label,
      sessionId: openSessionAction.sessionId,
    };
  }

  return {
    kind: 'task-queue',
    label: options.taskQueueLabel ?? 'Open Task Queue',
  };
}

function toSurfaceBadgeLabel(label: string) {
  return label.startsWith('Open ') ? label.slice(5) : label;
}

export function formatTaskMainPathBadgeLabel(badge?: TaskMainPathBadge | null) {
  if (!badge) return null;
  return `${badge.kind === 'surface' ? 'Surface' : 'Path'} · ${badge.label}`;
}

export function describeTaskMainPath(
  task: Pick<Task, 'execution_strategy' | 'id' | 'session_id' | 'source_session_id' | 'status'>,
  options: ResolveTaskMainPathActionOptions = {},
): TaskMainPathDescriptor {
  const action = resolveTaskMainPathAction(task, options);

  if (action.kind === 'surface' && action.surfaceTarget) {
    return {
      action,
      badge: {
        kind: 'surface',
        label: toSurfaceBadgeLabel(action.label),
        surfaceTarget: action.surfaceTarget,
      },
    };
  }

  if (task.execution_strategy === 'handoff') {
    return {
      action,
      badge: {
        kind: 'path',
        label: 'Handoff',
      },
    };
  }

  return {
    action,
    badge: null,
  };
}
