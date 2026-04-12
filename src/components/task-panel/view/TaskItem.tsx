import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import type { Task } from '../../../lib/tauri-bridge';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  in_progress: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  done: 'bg-green-500/20 text-green-400 border-green-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
};

interface TaskItemProps {
  task: Task;
  onStatusChange: (id: string, status: Task['status']) => void;
  onDelete: (id: string) => void;
}

export function TaskItem({ task, onStatusChange, onDelete }: TaskItemProps) {
  const { t } = useTranslation('common');

  const statusKey = `localTasks.status.${task.status}` as const;
  const statusLabel = t(statusKey, task.status);
  const colorClass = STATUS_COLORS[task.status] ?? STATUS_COLORS.open;

  const nextStatus = (): Task['status'] | null => {
    switch (task.status) {
      case 'open': return 'in_progress';
      case 'in_progress': return 'done';
      default: return null;
    }
  };

  const next = nextStatus();

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 group">
      <Badge className={`text-[10px] px-1.5 py-0 shrink-0 ${colorClass}`}>
        {statusLabel}
      </Badge>
      <span className="flex-1 text-sm truncate" title={task.title}>
        {task.title}
      </span>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {next && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onStatusChange(task.id, next)}
          >
            →
          </Button>
        )}
        {task.status === 'failed' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onStatusChange(task.id, 'open')}
          >
            ↻
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[10px] text-destructive"
          onClick={() => onDelete(task.id)}
        >
          ✕
        </Button>
      </div>
    </div>
  );
}
