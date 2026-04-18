import React, { useState, useCallback } from 'react';
import { Button } from '../ui/button';
import { useTaskQueueStore } from '../../stores/taskQueueStore';
import { TaskQueueItem } from './TaskQueueItem';
import { TaskQuickAdd } from './TaskQuickAdd';

interface TaskQueuePanelProps {
  projectPath?: string;
}

export function TaskQueuePanel({ projectPath }: TaskQueuePanelProps) {
  const queue = useTaskQueueStore((s) => s.queue);
  const autoExecute = useTaskQueueStore((s) => s.autoExecute);
  const maxConcurrent = useTaskQueueStore((s) => s.maxConcurrent);
  const setAutoExecute = useTaskQueueStore((s) => s.setAutoExecute);
  const setMaxConcurrent = useTaskQueueStore((s) => s.setMaxConcurrent);
  const removeTask = useTaskQueueStore((s) => s.removeTask);
  const retryTask = useTaskQueueStore((s) => s.retryTask);
  const markCancelled = useTaskQueueStore((s) => s.markCancelled);
  const clearCompleted = useTaskQueueStore((s) => s.clearCompleted);

  const [showAdd, setShowAdd] = useState(false);

  const runningCount = queue.filter((t) => t.status === 'running').length;
  const queuedCount = queue.filter((t) => t.status === 'queued').length;
  const completedCount = queue.filter((t) => t.status === 'done' || t.status === 'cancelled').length;

  const handleCancel = useCallback(
    (id: string) => {
      markCancelled(id);
    },
    [markCancelled],
  );

  if (!projectPath) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <h3 className="text-sm font-semibold">Task Queue</h3>
        <p className="text-xs text-muted-foreground">Select a project to manage the task queue.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Task Queue
          {queue.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground font-normal">
              ({runningCount} running · {queuedCount} queued)
            </span>
          )}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setShowAdd(!showAdd)}
        >
          + Add
        </Button>
      </div>

      {/* Quick add */}
      {showAdd && (
        <TaskQuickAdd
          projectPath={projectPath}
          onAdded={() => setShowAdd(false)}
        />
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 px-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={autoExecute}
            onChange={(e) => setAutoExecute(e.target.checked)}
            className="w-3 h-3 rounded border-input"
          />
          Auto-execute
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Max:
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
            onClick={clearCompleted}
          >
            Clear done
          </Button>
        )}
      </div>

      {/* Task list */}
      {queue.length === 0 && (
        <p className="text-xs text-muted-foreground px-2">No tasks in queue.</p>
      )}

      <div className="flex flex-col gap-0.5">
        {queue.map((task) => (
          <TaskQueueItem
            key={task.id}
            task={task}
            onRemove={removeTask}
            onRetry={retryTask}
            onCancel={handleCancel}
          />
        ))}
      </div>
    </div>
  );
}
