import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { Task, TaskStatus } from '../../lib/tauri-bridge';
import {
  buildTaskDispatchDetailLines,
  formatProviderLabel,
  formatTaskExecutionStrategyLabel,
  formatTaskRoleLabel,
  type TaskSessionSummaryInput,
} from '../../lib/task-dispatch';
import { formatTaskMainPathBadgeLabel, type TaskMainPathBadge } from '../../lib/task-main-path';

const STATUS_COLORS: Record<TaskStatus, string> = {
  open: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  queued: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  dispatched: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
  in_progress: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  pending_approval: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  pending_review: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  done: 'bg-green-500/20 text-green-400 border-green-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
  cancelled: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  archived: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
};

const STATUS_LABELS_KEYS: Record<TaskStatus, [string, string]> = {
  open: ['taskStatus.open', 'Open'],
  queued: ['taskStatus.queued', 'Queued'],
  dispatched: ['taskStatus.dispatched', 'Dispatched'],
  in_progress: ['taskStatus.in_progress', 'Running'],
  pending_approval: ['taskStatus.pending_approval', 'Pending Approval'],
  pending_review: ['taskStatus.pending_review', 'Pending Review'],
  done: ['taskStatus.done', 'Done'],
  failed: ['taskStatus.failed', 'Failed'],
  cancelled: ['taskStatus.cancelled', 'Cancelled'],
  archived: ['taskStatus.archived', 'Archived'],
};

interface TaskQueueItemProps {
  task: Task;
  onRemove: (task: Task) => void;
  onRetry: (task: Task) => void;
  onCancel: (task: Task) => void;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  mainPathBadge?: TaskMainPathBadge | null;
  sourceSessionLabel?: TaskSessionSummaryInput;
  runtimeSessionLabel?: TaskSessionSummaryInput;
}

export function TaskQueueItem({
  task,
  onRemove,
  onRetry,
  onCancel,
  primaryAction,
  mainPathBadge,
  sourceSessionLabel,
  runtimeSessionLabel,
}: TaskQueueItemProps) {
  const { t } = useTranslation('common');
  const colorClass = STATUS_COLORS[task.status];
  const createdAt = Date.parse(task.created_at);
  const updatedAt = Date.parse(task.updated_at);
  const elapsed =
    Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt >= createdAt
      ? `${Math.max(0, Math.round((updatedAt - createdAt) / 1000))}s`
      : null;
  const roleLabel = formatTaskRoleLabel(task.role);
  const executionStrategyLabel = formatTaskExecutionStrategyLabel(task.execution_strategy) ?? task.execution_strategy;
  const dispatchDetailLines = buildTaskDispatchDetailLines(task, {
    sourceSessionLabel,
    runtimeSessionLabel,
  });
  const mainPathBadgeLabel = formatTaskMainPathBadgeLabel(mainPathBadge);
  const dispatchTargetSummary = dispatchDetailLines.find((line) => line.startsWith('Dispatch target'));
  const contextDetailLines = dispatchDetailLines.filter((line) => line !== dispatchTargetSummary);

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 group">
      <Badge className={`text-[10px] px-1.5 py-0 shrink-0 ${colorClass}`}>
        {t(...STATUS_LABELS_KEYS[task.status])}
      </Badge>
      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block" title={task.title}>
          {task.title}
        </span>
        <span className="text-[10px] text-muted-foreground truncate block">
          {formatProviderLabel(task.provider)}
          {roleLabel && ` · ${roleLabel}`}
          {` · ${executionStrategyLabel}`}
          {elapsed && ` · ${elapsed}`}
        </span>
        {mainPathBadgeLabel ? (
          <span className="text-[10px] text-muted-foreground truncate block">
            {mainPathBadgeLabel}
          </span>
        ) : null}
        {dispatchTargetSummary ? (
          <span className="text-[10px] text-muted-foreground truncate block">
            {dispatchTargetSummary}
          </span>
        ) : null}
        {contextDetailLines.map((line) => (
          <span key={line} className="text-[10px] text-muted-foreground truncate block">
            {line}
          </span>
        ))}
        {task.result_summary && (
          <span className="text-[10px] text-muted-foreground truncate block">
            {task.result_summary}
          </span>
        )}
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {primaryAction ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </Button>
        ) : null}
        {(task.status === 'dispatched' || task.status === 'in_progress' || task.status === 'pending_approval') && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onCancel(task)}
            title={t('taskStatus.cancelAction', 'Cancel')}
          >
            ■
          </Button>
        )}
        {(task.status === 'failed' || task.status === 'cancelled') && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onRetry(task)}
            title={t('taskStatus.retryAction', 'Retry')}
          >
            ↻
          </Button>
        )}
        {(task.status === 'open' || task.status === 'queued' || task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px] text-destructive"
            onClick={() => onRemove(task)}
            title={t('taskStatus.removeAction', 'Remove')}
          >
            ✕
          </Button>
        )}
      </div>
    </div>
  );
}
