import { useEffect, useRef, useCallback } from 'react';
import { useTaskQueueStore } from '../stores/taskQueueStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import type { QueuedTask } from '../stores/taskQueueStore';

/**
 * Auto-executor hook: watches for session completions and
 * automatically claims and dispatches the next queued task.
 *
 * @param sendMessage - The sendMessage function from TauriEventContext
 */
export function useAutoExecutor(sendMessage: (message: unknown) => boolean) {
  const previousStatuses = useRef<Record<string, string>>({});

  const executeTask = useCallback(
    (task: QueuedTask) => {
      const taskQueue = useTaskQueueStore.getState();

      // Determine message type based on provider
      const type = task.provider === 'codex' ? 'codex-command' : 'claude-command';

      const sent = sendMessage({
        type,
        command: task.prompt,
        options: {
          projectPath: task.projectPath,
          provider: task.provider,
        },
      });

      if (sent) {
        taskQueue.markRunning(task.id);
      } else {
        taskQueue.markFailed(task.id, 'Failed to dispatch task');
      }
    },
    [sendMessage],
  );

  // Watch for session completions → auto-claim next task
  useEffect(() => {
    const unsubscribe = useSessionStatusStore.subscribe((state) => {
      const taskQueue = useTaskQueueStore.getState();
      if (!taskQueue.autoExecute) return;

      // Check if any session transitioned to completed/failed
      const currentStatuses = state.statuses;
      let sessionCompleted = false;

      for (const [sessionId, entry] of Object.entries(currentStatuses)) {
        const prevStatus = previousStatuses.current[sessionId];
        if (
          prevStatus === 'processing' &&
          (entry.status === 'completed' || entry.status === 'idle')
        ) {
          sessionCompleted = true;

          // Mark the corresponding queued task as done
          const runningTask = taskQueue.queue.find(
            (t) => t.status === 'running' && t.sessionId === sessionId,
          );
          if (runningTask) {
            taskQueue.markDone(runningTask.id);
          }
        }
      }

      // Snapshot current statuses for next comparison
      const snapshot: Record<string, string> = {};
      for (const [id, entry] of Object.entries(currentStatuses)) {
        snapshot[id] = entry.status;
      }
      previousStatuses.current = snapshot;

      // If a session completed and we have capacity, claim next
      if (sessionCompleted && taskQueue.hasCapacity()) {
        const next = taskQueue.claimNext();
        if (next) {
          executeTask(next);
        }
      }
    });

    return unsubscribe;
  }, [executeTask]);

  // Manual trigger: attempt to claim and execute next task
  const triggerNext = useCallback(() => {
    const taskQueue = useTaskQueueStore.getState();
    if (!taskQueue.hasCapacity()) return;

    const next = taskQueue.claimNext();
    if (next) {
      executeTask(next);
    }
  }, [executeTask]);

  return { triggerNext };
}
