import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { useWebSocket } from '../../contexts/TauriEventContext';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget } from '../../lib/mission-control';
import { buildProjectSessionLookup } from '../../lib/task-dispatch-config';
import { resolveTaskRuntimeSessionId, resolveTaskSourceSessionId } from '../../lib/task-dispatch';
import { useAttentionStore } from '../../stores/attentionStore';
import { useBackgroundRunStore } from '../../stores/backgroundRunStore';
import { orderProjectedTasks, useTaskQueueStore } from '../../stores/taskQueueStore';
import { countRunningDurableTasks, useTaskStore } from '../../stores/taskStore';
import { TaskQueueItem } from './TaskQueueItem';
import { TaskQuickAdd } from './TaskQuickAdd';
import type { Task } from '../../lib/tauri-bridge';
import type { Project } from '../../types/app';
import { getTaskTimelineStage } from '../../lib/control-plane';
import { describeTaskMainPath } from '../../lib/task-main-path';

interface TaskQueuePanelProps {
  projectPath?: string;
  selectedProject?: Project;
  projects?: Project[];
  onOpenSessionById?: (sessionId: string) => void;
  onOpenMissionControlSurface?: (target: MissionControlSurfaceTarget, locator?: MissionControlSurfaceLocator) => void;
}

export function TaskQueuePanel({
  projectPath,
  selectedProject,
  projects = [],
  onOpenSessionById,
  onOpenMissionControlSurface,
}: TaskQueuePanelProps) {
  const { t } = useTranslation('common');
  const { sendMessage } = useWebSocket();
  const autoExecute = useTaskQueueStore((s) => s.autoExecute);
  const maxConcurrent = useTaskQueueStore((s) => s.maxConcurrent);
  const queueOrder = useTaskQueueStore((s) => s.queueOrder);
  const setAutoExecute = useTaskQueueStore((s) => s.setAutoExecute);
  const setMaxConcurrent = useTaskQueueStore((s) => s.setMaxConcurrent);

  const refresh = useTaskStore((s) => s.refresh);
  const updateTask = useTaskStore((s) => s.updateTask);
  const tasks = useTaskStore((s) => (projectPath ? s.tasksByProject[projectPath] ?? [] : []));
  const backgroundRuns = useBackgroundRunStore((s) => s.runs);
  const approvalRequests = useAttentionStore((s) => s.approvalRequests);
  const queueVisibleTasks = useMemo(() => tasks.filter((task) => task.status !== 'archived'), [tasks]);
  const orderedTasks = useMemo(() => orderProjectedTasks(queueVisibleTasks, queueOrder), [queueVisibleTasks, queueOrder]);
  const isLoading = useTaskStore((s) => (projectPath ? s.loadingByProject[projectPath] ?? false : false));
  const error = useTaskStore((s) => (projectPath ? s.errorByProject[projectPath] : null));
  const sessionLookup = useMemo(() => buildProjectSessionLookup(projects), [projects]);
  const availableSessionIds = useMemo(
    () => new Set(sessionLookup.keys()),
    [sessionLookup],
  );
  const pendingApprovalSessionIds = useMemo(
    () =>
      new Set(
        Object.values(approvalRequests)
          .filter((request) => request.status === 'pending')
          .map((request) => request.sessionId),
      ),
    [approvalRequests],
  );
  const backgroundRunIdsByTaskId = useMemo(() => {
    const nextMap = new Map<string, string>();

    for (const run of Object.values(backgroundRuns)) {
      const taskId = run.taskId?.trim();
      if (!taskId || nextMap.has(taskId)) {
        continue;
      }

      nextMap.set(taskId, run.id);
    }

    return nextMap;
  }, [backgroundRuns]);

  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    if (!projectPath) return;
    refresh(projectPath).catch(() => undefined);
  }, [projectPath, refresh]);

  const runningCount = useMemo(
    () => countRunningDurableTasks(orderedTasks),
    [orderedTasks],
  );
  const queuedCount = useMemo(
    () => orderedTasks.filter((task) => task.status === 'open' || task.status === 'queued').length,
    [orderedTasks],
  );
  const reviewCount = useMemo(
    () => orderedTasks.filter((task) => getTaskTimelineStage(task) === 'review').length,
    [orderedTasks],
  );
  const completedCount = useMemo(
    () => orderedTasks.filter((task) => getTaskTimelineStage(task) === 'completed').length,
    [orderedTasks],
  );

  const handleCancel = useCallback(
    async (task: Task) => {
      if (!projectPath) return;
      const isActiveTask = ['dispatched', 'in_progress', 'pending_approval'].includes(task.status);
      const isPreRuntimeHandoff = task.execution_strategy === 'handoff' && task.status === 'dispatched';

      if (isPreRuntimeHandoff) {
        await updateTask(projectPath, task.id, {
          status: 'cancelled',
          session_id: '',
          source_session_id: task.source_session_id ?? task.session_id ?? '',
          result_summary: 'Cancelled before handoff started',
          review_required: false,
        });
        return;
      }

      if (task.session_id && isActiveTask) {
        sendMessage({
          type: 'abort-session',
          sessionId: task.session_id,
          provider: task.provider,
        });
        await updateTask(projectPath, task.id, {
          result_summary: 'Cancellation requested',
          review_required: task.review_required,
        });
        return;
      }

      await updateTask(projectPath, task.id, {
        status: task.status === 'done' || task.status === 'cancelled' || task.status === 'failed' ? 'archived' : 'cancelled',
        result_summary: task.result_summary ?? 'Archived from Task Queue',
        review_required: false,
      });
    },
    [projectPath, sendMessage, updateTask],
  );

  const handleRetry = useCallback(
    async (task: Task) => {
      if (!projectPath) return;
      await updateTask(projectPath, task.id, {
        status: 'queued',
        session_id: '',
        source_session_id: task.execution_strategy === 'handoff'
          ? task.source_session_id ?? task.session_id ?? ''
          : '',
        result_summary: '',
        review_required: task.review_required,
      });
    },
    [projectPath, updateTask],
  );

  const handleRemove = useCallback(
    async (task: Task) => {
      if (!projectPath) return;
      await updateTask(projectPath, task.id, {
        status: 'archived',
        result_summary: task.result_summary ?? 'Archived from Task Queue',
        review_required: false,
      });
    },
    [projectPath, updateTask],
  );

  const handleClearCompleted = useCallback(async () => {
    if (!projectPath) return;
    const completedTasks = orderedTasks.filter((task) => getTaskTimelineStage(task) === 'completed');
    await Promise.all(completedTasks.map((task) => updateTask(projectPath, task.id, {
      status: 'archived',
      result_summary: task.result_summary ?? 'Archived from Task Queue',
      review_required: false,
    })));
  }, [orderedTasks, projectPath, updateTask]);

  const getMainPathDescriptor = useCallback((task: Task) => (
    describeTaskMainPath(task, {
      pendingApprovalSessionIds,
      backgroundRunId: backgroundRunIdsByTaskId.get(task.id),
      availableSessionIds,
    })
  ), [availableSessionIds, backgroundRunIdsByTaskId, pendingApprovalSessionIds]);

  const getPrimaryAction = useCallback((task: Task) => {
    const { action } = getMainPathDescriptor(task);

    if (action.kind === 'surface' && action.surfaceTarget && onOpenMissionControlSurface) {
      return {
        label: action.label,
        onClick: () => onOpenMissionControlSurface(action.surfaceTarget!, action.focusLocator),
      };
    }

    if (action.kind === 'session' && action.sessionId && onOpenSessionById) {
      return {
        label: action.label,
        onClick: () => onOpenSessionById(action.sessionId!),
      };
    }

    return undefined;
  }, [getMainPathDescriptor, onOpenMissionControlSurface, onOpenSessionById]);

  const getSourceSessionLabel = useCallback((task: Task) => {
    const sourceSessionId = resolveTaskSourceSessionId(task);
    return sourceSessionId ? sessionLookup.get(sourceSessionId)?.summaryContext ?? null : null;
  }, [sessionLookup]);

  const getRuntimeSessionLabel = useCallback((task: Task) => {
    const runtimeSessionId = resolveTaskRuntimeSessionId(task) ?? task.session_id?.trim() ?? undefined;
    return runtimeSessionId ? sessionLookup.get(runtimeSessionId)?.summaryContext ?? null : null;
  }, [sessionLookup]);

  if (!projectPath) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <h3 className="text-sm font-semibold">{t('taskQueue.title', 'Task Queue')}</h3>
        <p className="text-xs text-muted-foreground">{t('taskQueue.selectProject', 'Select a project to manage the task queue.')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {t('taskQueue.title', 'Task Queue')}
          {orderedTasks.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground font-normal">
              ({runningCount} {t('taskQueue.running', 'running')} · {queuedCount} {t('taskQueue.queued', 'queued')}{reviewCount > 0 ? ` · ${reviewCount} ${t('taskQueue.review', 'review')}` : ''})
            </span>
          )}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setShowAdd(!showAdd)}
        >
          {t('taskQueue.add', '+ Add')}
        </Button>
      </div>

      <p className="px-2 text-[11px] text-muted-foreground">
        {t('taskQueue.subtitle', 'Queue work, choose where it should run, and follow it through review or results.')}
      </p>

      {showAdd && (
        <TaskQuickAdd
          projectPath={projectPath}
          selectedProject={selectedProject}
          availableProjects={projects}
          onAdded={() => setShowAdd(false)}
        />
      )}

      <div className="flex items-center gap-2 px-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={autoExecute}
            onChange={(e) => setAutoExecute(e.target.checked)}
            className="w-3 h-3 rounded border-input"
          />
          {t('taskQueue.autoExecute', 'Auto-execute')}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('taskQueue.max', 'Max:')}
          <select
            className="h-5 px-1 text-xs rounded border border-input bg-background"
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        {completedCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] ml-auto"
            onClick={() => void handleClearCompleted()}
          >
            {t('taskQueue.clearCompleted', 'Clear completed')}
          </Button>
        )}
      </div>

      {isLoading && <p className="text-xs text-muted-foreground px-2">{t('taskQueue.loading', 'Loading tasks…')}</p>}
      {!isLoading && error && <p className="text-xs text-destructive px-2">{error}</p>}
      {!isLoading && !error && orderedTasks.length === 0 && (
        <p className="text-xs text-muted-foreground px-2">{t('taskQueue.empty', 'No tasks in queue.')}</p>
      )}

      <div className="flex flex-col gap-0.5">
        {orderedTasks.map((task) => (
          <TaskQueueItem
            key={task.id}
            task={task}
            primaryAction={getPrimaryAction(task)}
            mainPathBadge={getMainPathDescriptor(task).badge}
            sourceSessionLabel={getSourceSessionLabel(task)}
            runtimeSessionLabel={getRuntimeSessionLabel(task)}
            onRemove={(nextTask) => void handleRemove(nextTask)}
            onRetry={(nextTask) => void handleRetry(nextTask)}
            onCancel={(nextTask) => void handleCancel(nextTask)}
          />
        ))}
      </div>
    </div>
  );
}
