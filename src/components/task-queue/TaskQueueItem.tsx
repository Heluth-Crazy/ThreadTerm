import React from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { QueuedTask, TaskQueueStatus } from '../../stores/taskQueueStore';

const STATUS_COLORS: Record<TaskQueueStatus, string> = {
  queued: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  running: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  done: 'bg-green-500/20 text-green-400 border-green-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
  cancelled: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
};

const STATUS_LABELS: Record<TaskQueueStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface TaskQueueItemProps {
  task: QueuedTask;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
}

export function TaskQueueItem({ task, onRemove, onRetry, onCancel }: TaskQueueItemProps) {
  const colorClass = STATUS_COLORS[task.status];
  const elapsed =
    task.startedAt && !task.completedAt
      ? `${Math.round((Date.now() - task.startedAt) / 1000)}s`
      : task.startedAt && task.completedAt
        ? `${Math.round((task.completedAt - task.startedAt) / 1000)}s`
        : null;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 group">
      <Badge className={`text-[10px] px-1.5 py-0 shrink-0 ${colorClass}`}>
        {STATUS_LABELS[task.status]}
      </Badge>
      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block" title={task.title}>
          {task.title}
        </span>
        <span className="text-[10px] text-muted-foreground truncate block">
          {task.provider} · {task.projectPath.split('/').pop()}
          {elapsed && ` · ${elapsed}`}
        </span>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {task.status === 'running' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onCancel(task.id)}
            title="Cancel"
          >
            ■
          </Button>
        )}
        {task.status === 'failed' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onRetry(task.id)}
            title="Retry"
          >
            ↻
          </Button>
        )}
        {(task.status === 'queued' || task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px] text-destructive"
            onClick={() => onRemove(task.id)}
            title="Remove"
          >
            ✕
          </Button>
        )}
      </div>
    </div>
  );
}
