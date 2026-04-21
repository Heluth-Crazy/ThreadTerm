import { useEffect, useRef, useCallback } from 'react';
import { git, handoff, type Task, type TaskStatus, type GitStatus } from '../lib/tauri-bridge';
import {
  RESULT_INBOX_ARCHIVE_COMPLETED_NEXT_STEP,
  RESULT_INBOX_CHANGED_FILES_NEXT_STEP,
  REVIEW_QUEUE_NEXT_STEP,
  REVIEW_REQUIRED_RESULT_RISK_SUMMARY,
} from '../lib/control-plane';
import {
  describeTaskExecutionTarget,
  resolveTaskExecutionProjectPath,
  resolveTaskSourceSessionId,
} from '../lib/task-dispatch';
import { isSupportedDurableDispatchProvider } from '../lib/task-dispatch-config';
import type { BackgroundRun } from '../types/background-run';
import { useBackgroundRunStore } from '../stores/backgroundRunStore';
import { orderProjectedTasks, useTaskQueueStore } from '../stores/taskQueueStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import { useTaskStore } from '../stores/taskStore';

/**
 * Phase 2 compatibility dispatcher: durable tasks live in Rust-backed storage,
 * while taskQueueStore remains only for queue UI settings and projection.
 */

export function createAutoExecutorSessionId(provider: Task['provider']) {
  return `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAutoExecutorBackgroundRunId(taskId: string) {
  return `background-run-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRunnableTask(task: Task) {
  return task.status === 'queued' || task.status === 'open';
}

function isExecutionInFlightTask(task: Task) {
  return task.status === 'dispatched' || task.status === 'in_progress' || task.status === 'pending_approval';
}

function shouldRouteTaskToReview(task: Task) {
  return task.review_required;
}

function projectTaskBinding(task: Task, sessionId: string, taskStatus: Task['status'] = task.status) {
  useSessionStatusStore.getState().setRuntimeProjection(sessionId, {
    taskId: task.id,
    taskTitle: task.title,
    taskStatus,
    taskRole: task.role,
    taskExecutionStrategy: task.execution_strategy,
    projectPath: task.project_path,
    worktreePath: task.worktree_path,
  });
}

function clearTaskBinding(sessionId: string) {
  useSessionStatusStore.getState().setRuntimeProjection(sessionId, {
    taskId: undefined,
    taskTitle: undefined,
    taskStatus: undefined,
    taskRole: undefined,
    taskExecutionStrategy: undefined,
    projectPath: undefined,
    worktreePath: undefined,
  });
}

function mapTaskProviderToBackgroundRunProvider(provider: Task['provider']): BackgroundRun['provider'] {
  if (provider === 'codex' || provider === 'claude') {
    return provider;
  }
  return 'custom';
}

function resolveAutoExecutorMessageType(provider: Task['provider']) {
  switch (provider) {
    case 'claude':
      return 'claude-command';
    case 'codex':
      return 'codex-command';
    default:
      return null;
  }
}

const TRANSIENT_RESULT_SUMMARIES = new Set([
  '',
  'Waiting for approval',
  'Cancellation requested',
  'Session requires attention',
  'Session aborted',
]);

function collectChangedFiles(status: GitStatus): string[] {
  return Array.from(
    new Set(
      [
        ...status.staged.map((entry) => entry.path),
        ...status.unstaged.map((entry) => entry.path),
        ...status.untracked,
      ]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

async function buildTerminalResultPatch(
  task: Task,
  nextStatus: TaskStatus,
  wasCancellationFlow: boolean,
) {
  const fallbackSummary = wasCancellationFlow
    ? 'Cancelled'
    : nextStatus === 'pending_review' || nextStatus === 'done'
      ? 'Completed'
      : task.result_summary || 'Completed';
  const currentSummary = task.result_summary?.trim() ?? '';
  const resolvedSummary = currentSummary && !TRANSIENT_RESULT_SUMMARIES.has(currentSummary)
    ? currentSummary
    : fallbackSummary;

  if (wasCancellationFlow) {
    return {
      result_summary: resolvedSummary,
      result_changed_files: [],
      result_risk_summary: '',
      result_suggested_next_step: 'Re-queue the task if you want to resume the work.',
    };
  }

  let resultChangedFiles = task.result_changed_files ?? [];
  try {
    const status = await git.status(resolveTaskExecutionProjectPath(task));
    resultChangedFiles = collectChangedFiles(status);
  } catch {
    resultChangedFiles = task.result_changed_files ?? [];
  }

  const resultRiskSummary = nextStatus === 'pending_review'
    ? REVIEW_REQUIRED_RESULT_RISK_SUMMARY
    : resultChangedFiles.length > 0
      ? 'Unreviewed repository changes were detected for this completed task.'
      : '';
  const resultSuggestedNextStep = nextStatus === 'pending_review'
    ? REVIEW_QUEUE_NEXT_STEP
    : resultChangedFiles.length > 0
      ? RESULT_INBOX_CHANGED_FILES_NEXT_STEP
      : RESULT_INBOX_ARCHIVE_COMPLETED_NEXT_STEP;

  return {
    result_summary: resolvedSummary,
    result_changed_files: resultChangedFiles,
    result_risk_summary: resultRiskSummary,
    result_suggested_next_step: resultSuggestedNextStep,
  };
}

export function useAutoExecutor(sendMessage: (message: unknown) => boolean) {
  const previousStatuses = useRef<Record<string, string>>({});
  const inFlightTaskIds = useRef<Set<string>>(new Set());
  const autoExecute = useTaskQueueStore((s) => s.autoExecute);
  const queueControlDigest = useTaskQueueStore((s) => `${s.maxConcurrent}:${s.queueOrder.join('|')}`);
  const taskDispatchDigest = useTaskStore((s) =>
    Object.values(s.tasksByProject)
      .flatMap((tasksForProject) => tasksForProject)
      .map((task) => `${task.id}:${task.status}:${task.session_id ?? ''}:${task.source_session_id ?? ''}:${task.execution_strategy}`)
      .join('|'),
  );

  const executeTask = useCallback(
    async (task: Task) => {
      if (inFlightTaskIds.current.has(task.id)) return;
      inFlightTaskIds.current.add(task.id);

      const taskStore = useTaskStore.getState();
      const backgroundRunStore = useBackgroundRunStore.getState();
      const sessionId = createAutoExecutorSessionId(task.provider);
      const backgroundRunId = createAutoExecutorBackgroundRunId(task.id);
      const directDispatchMessageType = resolveAutoExecutorMessageType(task.provider);
      const executionProjectPath = resolveTaskExecutionProjectPath(task);
      const sourceSessionId = resolveTaskSourceSessionId(task);
      let activeSessionId =
        task.execution_strategy === 'handoff'
          ? sessionId
          : task.session_id?.trim() || sessionId;
      const startedAt = new Date().toISOString();
      const initialRunSessionRef = task.execution_strategy === 'handoff' ? sourceSessionId : sessionId;

      backgroundRunStore.createRun({
        id: backgroundRunId,
        taskId: task.id,
        provider: mapTaskProviderToBackgroundRunProvider(task.provider),
        title: task.title,
        source: 'task-queue',
        projectId: executionProjectPath,
        sourceSessionId,
        sessionId: initialRunSessionRef,
        taskRole: task.role,
        executionStrategy: task.execution_strategy,
        worktreePath: task.worktree_path,
        processRef: initialRunSessionRef,
        startedAt,
        status: 'starting',
        lastOutputExcerpt:
          task.execution_strategy === 'handoff'
            ? `Starting handoff from the source session into ${describeTaskExecutionTarget(task)}.`
            : `Dispatching task into ${describeTaskExecutionTarget(task)}.`,
      });

      if (!isSupportedDurableDispatchProvider(task.provider)) {
        const message = `Unsupported durable dispatch provider: ${task.provider}`;
        await taskStore.updateTask(task.project_path, task.id, {
          status: 'failed',
          session_id: '',
          source_session_id: task.execution_strategy === 'handoff' ? sourceSessionId ?? '' : '',
          review_required: false,
          result_summary: message,
        });
        backgroundRunStore.markRunFailed(backgroundRunId, message);
        inFlightTaskIds.current.delete(task.id);
        return;
      }

      if (task.execution_strategy === 'handoff' && !sourceSessionId) {
        const message = 'Handoff task is missing a source session id';
        await taskStore.updateTask(task.project_path, task.id, {
          status: 'failed',
          session_id: '',
          source_session_id: task.source_session_id ?? '',
          review_required: false,
          result_summary: message,
        });
        backgroundRunStore.markRunFailed(backgroundRunId, message);
        inFlightTaskIds.current.delete(task.id);
        return;
      }

      let runtimeStartFailed = false;
      const handleRuntimeStartError = async (error: unknown, failedSessionId = activeSessionId) => {
        runtimeStartFailed = true;
        const message = error instanceof Error ? error.message : String(error || 'Failed to dispatch task');
        const latestTask = useTaskStore.getState().getTaskById(task.project_path, task.id);
        const currentStatus = latestTask?.status;
        const currentSessionId = latestTask?.session_id;
        if (currentStatus && !isExecutionInFlightTask(latestTask!)) {
          return;
        }
        if (currentSessionId && failedSessionId && currentSessionId !== failedSessionId) {
          return;
        }
        await taskStore.updateTask(task.project_path, task.id, {
          status: 'failed',
          session_id: failedSessionId,
          source_session_id: '',
          review_required: false,
          result_summary: message,
        });
        projectTaskBinding(latestTask ?? task, failedSessionId, 'failed');
        backgroundRunStore.markRunFailed(backgroundRunId, message);
      };

      try {
        if (task.execution_strategy === 'handoff' && sourceSessionId) {
          await taskStore.updateTask(task.project_path, task.id, {
            status: 'dispatched',
            session_id: '',
            source_session_id: sourceSessionId,
            result_summary: '',
            result_changed_files: [],
            result_verification_summary: '',
            result_risk_summary: '',
            result_suggested_next_step: '',
          });
          clearTaskBinding(sourceSessionId);
          backgroundRunStore.updateRun(backgroundRunId, {
            status: 'starting',
            sessionId: sourceSessionId,
            processRef: sourceSessionId,
          });

          const handoffResult = await handoff.session({
            sourcePtyId: sourceSessionId,
            targetProvider: task.provider,
            projectPath: executionProjectPath,
            taskDescription: task.prompt,
          });
          activeSessionId = handoffResult.newPtyId;

          const latestTask = taskStore.getTaskById(task.project_path, task.id);
          if (latestTask?.status === 'cancelled') {
            sendMessage({
              type: 'abort-session',
              sessionId: activeSessionId,
              provider: task.provider,
            });
            backgroundRunStore.updateRun(backgroundRunId, {
              sessionId: activeSessionId,
              processRef: activeSessionId,
            });
            backgroundRunStore.markRunCancelledForTask(
              task.id,
              latestTask.result_summary || 'Cancelled before handoff started',
            );
            clearTaskBinding(sourceSessionId);
            return;
          }

          await taskStore.updateTask(task.project_path, task.id, {
            status: 'in_progress',
            session_id: activeSessionId,
            source_session_id: sourceSessionId,
            result_summary: '',
            result_changed_files: [],
            result_verification_summary: '',
            result_risk_summary: '',
            result_suggested_next_step: '',
          });
          clearTaskBinding(sourceSessionId);
          projectTaskBinding(task, activeSessionId, 'in_progress');
          backgroundRunStore.updateRun(backgroundRunId, {
            status: 'running',
            sessionId: activeSessionId,
            processRef: activeSessionId,
            lastOutputExcerpt: `Handoff launched in the target runtime session for ${describeTaskExecutionTarget(task)}.`,
          });
        } else {
          await taskStore.updateTask(task.project_path, task.id, {
            status: 'dispatched',
            session_id: sessionId,
            result_summary: '',
            result_changed_files: [],
            result_verification_summary: '',
            result_risk_summary: '',
            result_suggested_next_step: '',
          });
          projectTaskBinding(task, sessionId, 'dispatched');
          backgroundRunStore.updateRun(backgroundRunId, {
            status: 'starting',
            sessionId,
            processRef: sessionId,
          });

          const sent = sendMessage({
            type: directDispatchMessageType ?? 'claude-command',
            command: task.prompt,
            options: {
              sessionId,
              projectPath: executionProjectPath,
              provider: task.provider,
              onRuntimeStartError: (error: unknown) => {
                void handleRuntimeStartError(error, sessionId);
              },
            },
          });

          if (sent && !runtimeStartFailed) {
            await taskStore.updateTask(task.project_path, task.id, {
              status: 'in_progress',
              result_changed_files: [],
              result_verification_summary: '',
              result_risk_summary: '',
              result_suggested_next_step: '',
            });
            projectTaskBinding(task, sessionId, 'in_progress');
            backgroundRunStore.updateRun(backgroundRunId, {
              status: 'running',
              sessionId,
              processRef: sessionId,
            });
          } else if (!sent) {
            await taskStore.updateTask(task.project_path, task.id, {
              status: 'failed',
              session_id: sessionId,
              result_summary: 'Failed to dispatch task',
            });
            projectTaskBinding(task, sessionId, 'failed');
            backgroundRunStore.markRunFailed(backgroundRunId, 'Failed to dispatch task');
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to dispatch task';
        const failedDuringHandoffBootstrap =
          task.execution_strategy === 'handoff' && sourceSessionId && activeSessionId === sourceSessionId;
        await taskStore.updateTask(task.project_path, task.id, {
          status: 'failed',
          session_id: failedDuringHandoffBootstrap ? '' : activeSessionId,
          source_session_id: task.execution_strategy === 'handoff' ? sourceSessionId ?? '' : '',
          result_summary: message,
        });
        if (failedDuringHandoffBootstrap && sourceSessionId) {
          clearTaskBinding(sourceSessionId);
        } else {
          projectTaskBinding(task, activeSessionId, 'failed');
        }
        backgroundRunStore.markRunFailed(backgroundRunId, message);
      } finally {
        inFlightTaskIds.current.delete(task.id);
      }
    },
    [sendMessage],
  );

  const triggerNext = useCallback(() => {
    const taskQueue = useTaskQueueStore.getState();
    const taskStore = useTaskStore.getState();
    const allTasks = taskStore.getAllTasks();
    const activeCount = allTasks.filter(
      (task) => isExecutionInFlightTask(task) || inFlightTaskIds.current.has(task.id),
    ).length;
    if (activeCount >= taskQueue.maxConcurrent) return;

    const orderedTasks = orderProjectedTasks(allTasks, taskQueue.queueOrder);
    const nextTask = orderedTasks.find(
      (task) => isRunnableTask(task) && !inFlightTaskIds.current.has(task.id),
    );

    if (nextTask) {
      void executeTask(nextTask);
    }
  }, [executeTask]);

  useEffect(() => {
    const unsubscribe = useSessionStatusStore.subscribe((state) => {
      const taskQueue = useTaskQueueStore.getState();
      const taskStore = useTaskStore.getState();
      const backgroundRunStore = useBackgroundRunStore.getState();
      const currentStatuses = state.statuses;
      const terminalTransitions: Promise<void>[] = [];

      for (const [sessionId, entry] of Object.entries(currentStatuses)) {
        const prevStatus = previousStatuses.current[sessionId];
        const task = taskStore.getTaskBySessionId(sessionId);
        if (!task) continue;

        if (entry.status === 'needs_attention') {
          if (entry.attentionReason === 'aborted') {
            if (task.status === 'cancelled') {
              projectTaskBinding(task, sessionId, 'cancelled');
              backgroundRunStore.markRunCancelledForSession(sessionId, 'Cancelled');
              continue;
            }
            if (task.result_summary === 'Cancellation requested') {
              void taskStore.updateTask(task.project_path, task.id, {
                status: 'cancelled',
                session_id: sessionId,
                review_required: false,
                result_summary: 'Cancelled',
              });
              projectTaskBinding(task, sessionId, 'cancelled');
              backgroundRunStore.markRunCancelledForSession(sessionId, 'Cancelled');
              continue;
            }
          }
          const nextStatus = entry.attentionReason === 'permission' ? 'pending_approval' : 'failed';
          const summary = entry.attentionReason === 'permission'
            ? 'Waiting for approval'
            : entry.attentionReason === 'aborted'
              ? 'Session aborted'
              : 'Session requires attention';
          if (task.status !== nextStatus) {
            void taskStore.updateTask(task.project_path, task.id, {
              status: nextStatus,
              session_id: sessionId,
              review_required: task.review_required,
              result_summary: summary,
            });
          }
          projectTaskBinding(task, sessionId, nextStatus);
          if (entry.attentionReason === 'permission') {
            backgroundRunStore.updateRunForSession(sessionId, {
              status: 'needs_attention',
              sessionId,
              processRef: sessionId,
              summary,
              attentionReason: 'approval',
              requiresApproval: true,
              awaitingInput: false,
              finishedAt: undefined,
            });
          } else {
            backgroundRunStore.markRunFailedForSession(sessionId, summary);
          }
          continue;
        }

        if (entry.status === 'processing' && prevStatus === 'needs_attention') {
          if (task.status === 'pending_approval') {
            void taskStore.updateTask(task.project_path, task.id, {
              status: 'in_progress',
              session_id: sessionId,
              review_required: task.review_required,
              result_summary: '',
            });
          }
          projectTaskBinding(task, sessionId, 'in_progress');
          backgroundRunStore.updateRunForSession(sessionId, {
            status: 'running',
            sessionId,
            processRef: sessionId,
            attentionReason: undefined,
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: undefined,
          });
        }

        const isTerminalSessionStatus = entry.status === 'completed' || entry.status === 'idle';
        const enteredTerminalStatus =
          isTerminalSessionStatus &&
          prevStatus !== undefined &&
          prevStatus !== entry.status &&
          prevStatus !== 'completed' &&
          prevStatus !== 'idle';

        if (enteredTerminalStatus && isExecutionInFlightTask(task)) {
          const wasCancellationFlow = entry.status === 'idle' && task.result_summary === 'Cancellation requested';
          const nextStatus = wasCancellationFlow
            ? 'cancelled'
            : shouldRouteTaskToReview(task)
              ? 'pending_review'
              : 'done';
          terminalTransitions.push((async () => {
            const terminalResultPatch = await buildTerminalResultPatch(task, nextStatus, wasCancellationFlow);
            await taskStore.updateTask(task.project_path, task.id, {
              status: nextStatus,
              session_id: sessionId,
              review_required: nextStatus === 'pending_review',
              ...terminalResultPatch,
            });
            projectTaskBinding(task, sessionId, nextStatus);
            if (nextStatus === 'cancelled') {
              backgroundRunStore.markRunCancelledForSession(sessionId, terminalResultPatch.result_summary);
            } else {
              backgroundRunStore.markRunCompletedForSession(sessionId, terminalResultPatch.result_summary);
            }
          })());
        }
      }

      const snapshot: Record<string, string> = {};
      for (const [id, entry] of Object.entries(currentStatuses)) {
        snapshot[id] = entry.status;
      }
      previousStatuses.current = snapshot;

      if (taskQueue.autoExecute && terminalTransitions.length > 0) {
        void Promise.allSettled(terminalTransitions).then((results) => {
          const hasFailure = results.some((result) => result.status === 'rejected');
          if (hasFailure) {
            return;
          }
          const nextTask = orderProjectedTasks(useTaskStore.getState().getAllTasks(), taskQueue.queueOrder).find(
            (task) => isRunnableTask(task) && !inFlightTaskIds.current.has(task.id),
          );
          if (nextTask) {
            void executeTask(nextTask);
          }
        });
      }
    });

    return unsubscribe;
  }, [executeTask]);

  useEffect(() => {
    if (!autoExecute) return;
    triggerNext();
  }, [autoExecute, queueControlDigest, taskDispatchDigest, triggerNext]);

  return { triggerNext };
}
