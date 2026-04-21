import React, { useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ShieldCheck, ShieldX } from 'lucide-react';

import SessionProviderLogo from '../../SessionProviderLogo';
import CardMessageList from './CardMessageList';
import MiniInputBar from './MiniInputBar';
import HandoffTaskMenu from '../../shared/HandoffTaskMenu';
import { useLiveGridStore, type MessageSnapshot } from '../../../stores/liveGridStore';
import { useSessionStatusStore, type SessionRuntimeStatus } from '../../../stores/sessionStatusStore';
import { useAttentionStore } from '../../../stores/attentionStore';
import { useBackgroundRunStore } from '../../../stores/backgroundRunStore';
import { useTaskStore } from '../../../stores/taskStore';
import { useCardHistory } from '../../../hooks/useCardHistory';
import { getProviderBorderClass, getProviderDotClass } from '../../../utils/providerColors';
import { respondToApprovalRequest } from '../../../lib/approval-actions';
import { describeTaskMainPath, formatTaskMainPathBadgeLabel } from '../../../lib/task-main-path';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget } from '../../../lib/mission-control';
import {
  buildTaskDispatchPresentation,
  findTaskSessionLink,
  formatTaskExecutionStrategyLabel,
  formatTaskRoleLabel,
  formatTaskStatusLabel,
  getTaskSessionBindingLabel,
} from '../../../lib/task-dispatch';
import type { Project } from '../../../types/app';

// Stable empty array to prevent Zustand selector from creating new references each render
const EMPTY_SNAPSHOTS: MessageSnapshot[] = [];

type LiveCardProps = {
  sessionId: string;
  projectId: string;
  provider: string;
  sessionTitle: string;
  projectPath: string;
  worktreePath?: string;
  selectedProject?: Project;
  availableProjects?: Project[];
  onSend: (sessionId: string, text: string, projectPath: string, provider: string) => void;
  onOpenTaskQueue?: (projectPath?: string) => void;
  onOpenSessionById?: (sessionId: string) => void;
  onOpenMissionControlSurface?: (target: MissionControlSurfaceTarget, locator?: MissionControlSurfaceLocator) => void;
  isFocused?: boolean;
};

function StatusDot({ status }: { status: SessionRuntimeStatus }) {
  switch (status) {
    case 'needs_attention':
      return <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" title="Needs attention" />;
    case 'processing':
      return (
        <span
          className="inline-block h-2 w-2 rounded-full border-[1.5px] border-emerald-500 border-t-transparent"
          style={{ animation: 'spin 0.8s linear infinite' }}
          title="Running"
        />
      );
    case 'completed':
      return <span className="inline-block h-2 w-2 rounded-full bg-gray-400" title="Completed" />;
    default:
      return <span className="inline-block h-2 w-2 rounded-full bg-zinc-600" title="Idle" />;
  }
}

function statusRingClass(status: SessionRuntimeStatus): string {
  switch (status) {
    case 'needs_attention':
      return 'ring-2 ring-red-500/60 shadow-[0_0_8px_rgba(239,68,68,0.3)]';
    case 'processing':
      return 'ring-1 ring-blue-500/40';
    case 'completed':
      return 'ring-1 ring-emerald-500/40';
    default:
      return '';
  }
}

function LiveCardInner({
  sessionId,
  projectId,
  provider,
  sessionTitle,
  projectPath,
  worktreePath,
  selectedProject,
  availableProjects = [],
  onSend,
  onOpenTaskQueue,
  onOpenSessionById,
  onOpenMissionControlSurface,
  isFocused,
}: LiveCardProps) {
  const { t } = useTranslation('common');
  const cardRef = useRef<HTMLDivElement>(null);
  const removeCard = useLiveGridStore((s) => s.removeCard);
  const setFocusedCard = useLiveGridStore((s) => s.setFocusedCard);
  const snapshots: MessageSnapshot[] = useLiveGridStore(
    (s) => s.messageSnapshots[sessionId] ?? EMPTY_SNAPSHOTS,
  );

  // Load session history from API on mount (restores messages after refresh)
  useCardHistory(sessionId, projectId, provider);

  // Use direct selector on statuses to avoid calling get() inside a selector (which causes stale refs)
  const status: SessionRuntimeStatus = useSessionStatusStore(
    (s) => s.statuses[sessionId]?.status ?? 'idle',
  );
  const pendingPermission = useAttentionStore((s) => {
    const request = s.approvalRequests[sessionId];
    return request?.status === 'pending' ? request : undefined;
  });
  const backgroundRuns = useBackgroundRunStore((s) => s.runs);
  const tasksByProject = useTaskStore((s) => s.tasksByProject);
  const linkedTaskSession = useMemo(
    () =>
      findTaskSessionLink(
        Object.values(tasksByProject).flatMap((tasksForProject) => tasksForProject),
        sessionId,
      ),
    [sessionId, tasksByProject],
  );
  const linkedTask = linkedTaskSession?.task;
  const taskSessionBindingLabel = linkedTask?.execution_strategy === 'handoff'
    ? getTaskSessionBindingLabel(linkedTaskSession?.binding)
    : null;
  const linkedTaskRoleLabel = formatTaskRoleLabel(linkedTask?.role);
  const linkedTaskExecutionStrategyLabel = formatTaskExecutionStrategyLabel(linkedTask?.execution_strategy);
  const linkedTaskStatusLabel = formatTaskStatusLabel(linkedTask?.status);
  const linkedTaskDispatchPresentation = linkedTask
    ? buildTaskDispatchPresentation(linkedTask, {
      taskSessionBinding: linkedTaskSession?.binding,
      fallbackWorktreePath: worktreePath,
    })
    : null;
  const linkedTaskDispatchContextLines = linkedTaskDispatchPresentation?.dispatchDetailLines ?? [];
  const linkedTaskDispatchTargetLabel = linkedTaskDispatchPresentation?.dispatchTargetLabel;
  const pendingApprovalSessionIds = useMemo(
    () => new Set(pendingPermission ? [sessionId] : []),
    [pendingPermission, sessionId],
  );
  const linkedTaskBackgroundRunId = useMemo(() => {
    if (!linkedTask) return undefined;

    const latestRun = Object.values(backgroundRuns)
      .filter((run) => run.taskId === linkedTask.id)
      .sort((a, b) => (b.startedAt ?? b.finishedAt ?? '').localeCompare(a.startedAt ?? a.finishedAt ?? ''))[0];

    return latestRun?.id;
  }, [backgroundRuns, linkedTask]);
  const linkedTaskMainPathDescriptor = useMemo(() => {
    if (!linkedTask) return undefined;

    return describeTaskMainPath(linkedTask, {
      pendingApprovalSessionIds,
      backgroundRunId: linkedTaskBackgroundRunId,
    });
  }, [
    linkedTask,
    linkedTaskBackgroundRunId,
    pendingApprovalSessionIds,
  ]);
  const linkedTaskMainPathAction = useMemo(() => {
    if (!linkedTaskMainPathDescriptor) return undefined;

    const { action } = linkedTaskMainPathDescriptor;

    if (action.kind === 'surface' && action.surfaceTarget && onOpenMissionControlSurface) {
      return {
        label: action.label,
        onClick: () => onOpenMissionControlSurface(action.surfaceTarget!, action.focusLocator),
      };
    }

    if (action.kind === 'task-queue' && onOpenTaskQueue && linkedTask) {
      return {
        label: action.label,
        onClick: () => onOpenTaskQueue(linkedTask.project_path),
      };
    }

    if (action.kind === 'session' && action.sessionId && action.sessionId !== sessionId && onOpenSessionById) {
      return {
        label: action.label,
        onClick: () => onOpenSessionById(action.sessionId!),
      };
    }

    return undefined;
  }, [
    linkedTask,
    linkedTaskMainPathDescriptor,
    onOpenMissionControlSurface,
    onOpenSessionById,
    onOpenTaskQueue,
    sessionId,
  ]);
  const linkedTaskMainPathBadgeLabel = formatTaskMainPathBadgeLabel(linkedTaskMainPathDescriptor?.badge);

  const handleDoubleClick = useCallback(() => {
    setFocusedCard(sessionId);
  }, [sessionId, setFocusedCard]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeCard(sessionId);
    },
    [sessionId, removeCard],
  );

  const handleSend = useCallback(
    (text: string) => {
      onSend(sessionId, text, projectPath, provider);
    },
    [sessionId, projectPath, provider, onSend],
  );

  const handlePermission = useCallback(
    async (approved: boolean) => {
      if (!pendingPermission) return;
      try {
        await respondToApprovalRequest(sessionId, pendingPermission.requestId, approved);
      } catch {
        // Silently fail — status store will handle retry
      }
    },
    [pendingPermission, sessionId],
  );

  const statusKey =
    status === 'needs_attention'
      ? 'liveGrid.status.needsAttention'
      : `liveGrid.status.${status}`;

  // Auto-scroll focused card into view
  useEffect(() => {
    if (isFocused && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isFocused]);

  return (
    <div
      ref={cardRef}
      className={`flex h-full flex-col overflow-hidden rounded-xl border border-border/60 border-l-4 ${getProviderBorderClass(provider)} bg-card/90 transition-shadow ${statusRingClass(status)} ${isFocused ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
      onDoubleClick={handleDoubleClick}
      tabIndex={isFocused ? 0 : -1}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5">
        <SessionProviderLogo provider={provider} className="h-4 w-4" />
        <span className={`inline-block h-2 w-2 rounded-full ${getProviderDotClass(provider)}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {sessionTitle}
        </span>
        {worktreePath && (
          <span className="truncate rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-500" title={worktreePath}>
            🌿 {worktreePath.split('/').pop()}
          </span>
        )}
        <StatusDot status={status} />
        <span className="text-[10px] text-muted-foreground">{t(statusKey)}</span>
        <HandoffTaskMenu
          currentProvider={provider}
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          projectPath={projectPath}
          worktreePath={worktreePath}
          selectedProject={selectedProject}
          availableProjects={availableProjects}
          onQueuedTask={onOpenTaskQueue}
          buttonTitle="Queue handoff task"
        />
        <button
          type="button"
          onClick={handleRemove}
          className="ml-1 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
          title={t('liveGrid.removeCard')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {linkedTask ? (
        <div className="border-b border-border/40 bg-muted/20 px-2.5 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="rounded-full bg-primary/8 px-2 py-0.5 font-medium text-primary">
              Task · {linkedTask.title}
            </span>
            {linkedTaskRoleLabel ? (
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-600">
                Role · {linkedTaskRoleLabel}
              </span>
            ) : null}
            {linkedTaskExecutionStrategyLabel ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600">
                Exec · {linkedTaskExecutionStrategyLabel}
              </span>
            ) : null}
            {taskSessionBindingLabel ? (
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 font-medium text-sky-700">
                {taskSessionBindingLabel}
              </span>
            ) : null}
            {linkedTaskMainPathBadgeLabel ? (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700">
                {linkedTaskMainPathBadgeLabel}
              </span>
            ) : null}
            {linkedTaskStatusLabel ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                {linkedTaskStatusLabel}
              </span>
            ) : null}
            {linkedTaskDispatchTargetLabel ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                {linkedTaskDispatchTargetLabel}
              </span>
            ) : null}
          </div>
          {linkedTaskDispatchContextLines.length > 1 ? (
            <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              {linkedTaskDispatchPresentation?.contextDetailLines.map((line) => (
                <p key={line} className="truncate">{line}</p>
              ))}
            </div>
          ) : null}
          {linkedTaskMainPathAction ? (
            <div className="mt-1 flex items-center">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  linkedTaskMainPathAction.onClick();
                }}
                className="inline-flex h-6 items-center rounded-md border border-border/60 bg-background px-2 text-[10px] font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                {linkedTaskMainPathAction.label}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Message stream */}
      <CardMessageList snapshots={snapshots} />

      {/* Inline permission request */}
      {pendingPermission && (
        <div className="flex items-center gap-2 border-t border-border/40 bg-amber-500/5 px-2.5 py-1.5">
          <span className="flex-1 truncate text-[11px] text-amber-600">
            {pendingPermission.toolName}
          </span>
          <button
            type="button"
            onClick={() => handlePermission(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10"
          >
            <ShieldCheck className="h-3 w-3" /> Allow
          </button>
          <button
            type="button"
            onClick={() => handlePermission(false)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-500 transition-colors hover:bg-red-500/10"
          >
            <ShieldX className="h-3 w-3" /> Deny
          </button>
        </div>
      )}

      {/* Input */}
      <MiniInputBar onSend={handleSend} disabled={status === 'processing'} />
    </div>
  );
}

const LiveCard = React.memo(LiveCardInner);
export default LiveCard;
