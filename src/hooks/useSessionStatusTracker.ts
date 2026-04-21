import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/TauriEventContext';
import { useAttentionStore, buildAttentionItemId, getAttentionKind, getAttentionRiskLevel } from '../stores/attentionStore';
import { useBackgroundRunStore } from '../stores/backgroundRunStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import { useTaskStore } from '../stores/taskStore';
import type { AttentionReason } from '../stores/sessionStatusStore';
import type { Task } from '../lib/tauri-bridge';
import type { BackgroundRun } from '../types/background-run';

function isTerminalRunStatus(status: BackgroundRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isRunForSession(run: BackgroundRun, sessionId: string): boolean {
  return run.sessionId === sessionId || run.id === sessionId;
}

function updateBackgroundRunsForSession(
  sessionId: string,
  updater: (run: BackgroundRun) => BackgroundRun,
): void {
  useBackgroundRunStore.setState((state) => {
    let changed = false;
    const runs = { ...state.runs };

    for (const [runId, run] of Object.entries(state.runs)) {
      if (!isRunForSession(run, sessionId) || isTerminalRunStatus(run.status)) {
        continue;
      }

      const nextRun = updater(run);
      if (nextRun !== run) {
        runs[runId] = nextRun;
        changed = true;
      }
    }

    return changed ? { runs } : state;
  });
}

function rebindBackgroundRunsForSession(fromSessionId: string, toSessionId: string): void {
  useBackgroundRunStore.setState((state) => {
    let changed = false;
    const runs = { ...state.runs };

    for (const [runId, run] of Object.entries(state.runs)) {
      if (run.sessionId !== fromSessionId && run.processRef !== fromSessionId) {
        continue;
      }

      runs[runId] = {
        ...run,
        sessionId: run.sessionId === fromSessionId ? toSessionId : run.sessionId,
        processRef: run.processRef === fromSessionId ? toSessionId : run.processRef,
      };
      changed = true;
    }

    return changed ? { runs } : state;
  });
}

function projectBackgroundRunsAwaitingInput(sessionId: string): void {
  updateBackgroundRunsForSession(sessionId, (run) => ({
    ...run,
    status: 'awaiting_input',
    attentionReason: 'input',
    requiresApproval: false,
    awaitingInput: true,
  }));
}

function hasBlockingBackgroundRun(sessionId: string): boolean {
  const runs = useBackgroundRunStore.getState().runs;
  return Object.values(runs).some(
    (run) =>
      isRunForSession(run, sessionId) &&
      !isTerminalRunStatus(run.status) &&
      (run.status === 'awaiting_input' || run.status === 'needs_attention' || run.requiresApproval || run.awaitingInput),
  );
}

function buildTaskProjection(task?: Task) {
  if (!task) return {};
  return {
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
    taskRole: task.role,
    taskExecutionStrategy: task.execution_strategy,
    projectPath: task.project_path,
    worktreePath: task.worktree_path,
  };
}

function syncTaskProjection(sessionId: string, taskOverride?: Task): void {
  const task = taskOverride ?? useTaskStore.getState().getTaskBySessionId(sessionId);
  useSessionStatusStore.getState().setRuntimeProjection(sessionId, buildTaskProjection(task));
}

function rebindTaskSession(fromSessionId: string, toSessionId: string): Task | undefined {
  const taskStore = useTaskStore.getState();
  const matchingTask = taskStore.getTaskBySessionId(fromSessionId);
  if (!matchingTask) {
    return undefined;
  }

  const reboundTask = {
    ...matchingTask,
    session_id: toSessionId,
  };

  useTaskStore.setState((state) => ({
    tasksByProject: {
      ...state.tasksByProject,
      [matchingTask.project_path]: (state.tasksByProject[matchingTask.project_path] ?? []).map((task) =>
        task.id === matchingTask.id ? reboundTask : task,
      ),
    },
  }));

  return reboundTask;
}

export function useSessionStatusTracker(): void {
  const { latestMessage, messageSequence } = useWebSocket();
  const lastProcessedSequenceRef = useRef(0);

  useEffect(() => {
    useSessionStatusStore.getState().pruneStale();
  }, []);

  useEffect(() => {
    if (!latestMessage || messageSequence <= lastProcessedSequenceRef.current) return;
    lastProcessedSequenceRef.current = messageSequence;

    const msg = latestMessage as Record<string, unknown>;
    const type = typeof msg.type === 'string' ? msg.type : '';
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
    if (!sessionId) return;

    const provider = type.startsWith('codex-') ? 'codex' as const
      : type.startsWith('claude-') ? 'claude' as const
      : undefined;

    const sessionStore = useSessionStatusStore.getState();
    const attentionStore = useAttentionStore.getState();
    switch (type) {
      case 'session-created': {
        const originalSessionId = typeof msg.originalSessionId === 'string' ? msg.originalSessionId : undefined;
        if (originalSessionId && originalSessionId !== sessionId) {
          rebindBackgroundRunsForSession(originalSessionId, sessionId);
          const matchingTask = rebindTaskSession(originalSessionId, sessionId);
          if (matchingTask) {
            void useTaskStore.getState().updateTask(matchingTask.project_path, matchingTask.id, {
              session_id: sessionId,
            });
          }

          const previousStatus = sessionStore.statuses[originalSessionId];
          if (previousStatus) {
            sessionStore.rebindSession(originalSessionId, sessionId, provider ?? previousStatus.provider);
            sessionStore.setProcessing(sessionId, provider ?? previousStatus.provider);
            syncTaskProjection(sessionId, matchingTask);
            break;
          }
        }

        sessionStore.setProcessing(sessionId, provider);
        syncTaskProjection(sessionId);
        break;
      }
      case 'claude-response':
      case 'codex-response':
        sessionStore.setProcessing(sessionId, provider);
        syncTaskProjection(sessionId);
        break;
      case 'session-state-changed':
        if (msg.state === 'WaitingForInput') {
          sessionStore.setNeedsAttention(sessionId, 'permission');
          syncTaskProjection(sessionId);
          projectBackgroundRunsAwaitingInput(sessionId);
          break;
        }
        if (msg.state === 'Completed') {
          sessionStore.setCompleted(sessionId, { force: true });
          syncTaskProjection(sessionId);
          attentionStore.clearApprovalRequest(sessionId);
          attentionStore.resolveAttentionItemsForSession(sessionId);
          updateBackgroundRunsForSession(sessionId, (run) => ({
            ...run,
            status: 'completed',
            attentionReason: undefined,
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: run.finishedAt ?? new Date().toISOString(),
          }));
          break;
        }
        if (msg.state === 'Failed') {
          sessionStore.setNeedsAttention(sessionId, 'error');
          syncTaskProjection(sessionId);
          updateBackgroundRunsForSession(sessionId, (run) => ({
            ...run,
            status: 'failed',
            attentionReason: 'error',
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: run.finishedAt ?? new Date().toISOString(),
          }));
          break;
        }
        if (msg.state === 'Idle') {
          const hasOutstandingApproval = attentionStore.approvalRequests[sessionId]?.status === 'pending';
          const hasBlockingAttention = hasOutstandingApproval || hasBlockingBackgroundRun(sessionId);
          if (!hasBlockingAttention) {
            sessionStore.setIdle(sessionId);
            syncTaskProjection(sessionId);
            attentionStore.clearApprovalRequest(sessionId);
            attentionStore.resolveAttentionItemsForSession(sessionId);
          }
          // `Idle` is a coarse runtime state, not a reliable terminal event for
          // background runs. Preserve the existing run projection until a more
          // explicit completed/failed/cancelled signal arrives.
          break;
        }
        sessionStore.setProcessing(sessionId, provider);
        syncTaskProjection(sessionId);
        break;
      case 'claude-complete':
      case 'codex-complete':
        sessionStore.setCompleted(sessionId, { force: true });
        syncTaskProjection(sessionId);
        attentionStore.clearApprovalRequest(sessionId);
        attentionStore.resolveAttentionItemsForSession(sessionId);
        updateBackgroundRunsForSession(sessionId, (run) => ({
          ...run,
          status: 'completed',
          attentionReason: undefined,
          requiresApproval: false,
          awaitingInput: false,
          finishedAt: run.finishedAt ?? new Date().toISOString(),
        }));
        break;
      case 'claude-error':
      case 'codex-error':
      case 'error':
      case 'attention-required': {
        const reason = (type === 'attention-required' && msg.attentionType === 'waiting'
          ? 'permission'
          : 'error') as AttentionReason;
        sessionStore.setNeedsAttention(sessionId, reason);
        syncTaskProjection(sessionId);
        attentionStore.upsertAttentionItem({
          id: buildAttentionItemId(sessionId, reason),
          sessionId,
          kind: getAttentionKind(reason),
          reason,
          title: reason === 'permission' ? 'Waiting for input' : 'Session requires attention',
          message: typeof msg.error === 'string' ? msg.error : typeof msg.message === 'string' ? msg.message : undefined,
          riskLevel: getAttentionRiskLevel(reason),
        });
        if (reason === 'error') {
          const errorMessage =
            typeof msg.error === 'string'
              ? msg.error
              : typeof msg.message === 'string'
                ? msg.message
                : undefined;
          updateBackgroundRunsForSession(sessionId, (run) => ({
            ...run,
            status: 'failed',
            attentionReason: 'error',
            lastOutputExcerpt: errorMessage ?? run.lastOutputExcerpt,
            requiresApproval: false,
            awaitingInput: false,
            finishedAt: run.finishedAt ?? new Date().toISOString(),
          }));
        } else {
          projectBackgroundRunsAwaitingInput(sessionId);
        }
        break;
      }
      case 'claude-permission-request': {
        const pendingRequest = {
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          toolName: typeof msg.toolName === 'string' ? msg.toolName : '',
          input: (typeof msg.input === 'object' && msg.input !== null ? msg.input : {}) as Record<string, unknown>,
          sessionId,
        };
        sessionStore.setNeedsAttention(sessionId, 'permission');
        syncTaskProjection(sessionId);
        attentionStore.upsertApprovalRequest(pendingRequest);
        attentionStore.upsertAttentionItem({
          id: buildAttentionItemId(sessionId, 'permission', pendingRequest.requestId),
          sessionId,
          kind: 'approval',
          reason: 'permission',
          requestId: pendingRequest.requestId,
          title: pendingRequest.toolName || 'Approval required',
          message: pendingRequest.toolName
            ? `${pendingRequest.toolName} is waiting for approval.`
            : 'A tool call is waiting for approval.',
          riskLevel: getAttentionRiskLevel('permission', pendingRequest.toolName),
        });
        updateBackgroundRunsForSession(sessionId, (run) => ({
          ...run,
          status: 'needs_attention',
          requiresApproval: true,
          awaitingInput: false,
          attentionReason: 'approval',
        }));
        break;
      }
      case 'claude-permission-cancelled': {
        attentionStore.expireRequest(sessionId);
        attentionStore.resolveAttentionItemsForSession(sessionId);
        sessionStore.setProcessing(sessionId, provider);
        syncTaskProjection(sessionId);
        updateBackgroundRunsForSession(sessionId, (run) => ({
          ...run,
          status: 'running',
          attentionReason: undefined,
          requiresApproval: false,
          awaitingInput: false,
          finishedAt: undefined,
        }));
        break;
      }
      case 'session-aborted': {
        const matchingTask = useTaskStore.getState().getTaskBySessionId(sessionId);
        const isCancellationFlow = matchingTask?.result_summary === 'Cancellation requested' || matchingTask?.status === 'cancelled';

        attentionStore.expireRequest(sessionId);

        if (isCancellationFlow) {
          sessionStore.setIdle(sessionId);
          syncTaskProjection(sessionId);
          attentionStore.resolveAttentionItemsForSession(sessionId);
        } else {
          sessionStore.setNeedsAttention(sessionId, 'aborted' as AttentionReason);
          syncTaskProjection(sessionId);
          attentionStore.upsertAttentionItem({
            id: buildAttentionItemId(sessionId, 'aborted'),
            sessionId,
            kind: 'aborted',
            reason: 'aborted',
            title: 'Session aborted',
            message: typeof msg.message === 'string' ? msg.message : 'A session stopped before completion.',
            riskLevel: getAttentionRiskLevel('aborted'),
          });
        }

        updateBackgroundRunsForSession(sessionId, (run) => ({
          ...run,
          status: 'cancelled',
          attentionReason: undefined,
          requiresApproval: false,
          awaitingInput: false,
          finishedAt: run.finishedAt ?? new Date().toISOString(),
        }));
        break;
      }
    }
  }, [latestMessage, messageSequence]);
}
