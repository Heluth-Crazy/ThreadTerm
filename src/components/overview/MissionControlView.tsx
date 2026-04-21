import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAttentionStore } from '../../stores/attentionStore';
import { useBackgroundRunStore } from '../../stores/backgroundRunStore';
import { orderProjectedTasks, useTaskQueueStore } from '../../stores/taskQueueStore';
import { useSessionStatusStore, type SessionRuntimeStatus } from '../../stores/sessionStatusStore';
import {
  countQueuedDurableTasks,
  countRunningDurableTasks,
  useTaskStore,
} from '../../stores/taskStore';
import { useMissionControlStore } from '../../stores/missionControlStore';
import type { Task } from '../../lib/tauri-bridge';
import {
  findTaskSessionLink,
  resolveTaskRuntimeSessionId,
  resolveTaskSourceSessionId,
  type LinkedTaskSession,
  type TaskSessionSummaryContext,
} from '../../lib/task-dispatch';
import type { TaskTimelineStage } from '../../lib/mission-control';
import type { Project, ProjectSession } from '../../types/app';
import type { BackgroundRun } from '../../types/background-run';
import { getStandaloneAttentionItems } from '../../lib/attention-actions';
import {
  buildVisibleControlPlaneItems,
  buildAcceptedReviewResultPatch,
  getTaskTimelineStage,
  isAcceptedResultTask,
} from '../../lib/control-plane';
import { describeTaskMainPath } from '../../lib/task-main-path';
import ApprovalInbox, { type InboxSessionLabel } from './ApprovalInbox';
import AttentionInbox from './AttentionInbox';
import BackgroundRunPanel from './BackgroundRunPanel';
import MissionControlSummaryStrip from './MissionControlSummaryStrip';
import { ResultInboxSection, ReviewQueueSection } from './ReviewQueuePanel';
import SessionCard from './SessionCard';
import TaskTimelineOverview, { type TaskTimelineSurfaceFocusLocator, type TaskTimelineSurfaceTarget } from './TaskTimelineOverview';

export interface MissionControlViewProps {
  projects: Project[];
  isLoading: boolean;
  onSelectSession: (project: Project, session: ProjectSession) => void;
  onNewSession: () => void;
  onCreateProject: () => void;
  onOpenTaskQueue?: (projectPath?: string) => void;
}

const STATUS_PRIORITY: Record<SessionRuntimeStatus, number> = {
  needs_attention: 0,
  processing: 1,
  completed: 2,
  idle: 3,
};

interface SessionEntry {
  project: Project;
  session: ProjectSession;
}

function getSessionDisplayLabel(project: Project, session: ProjectSession): InboxSessionLabel {
  const sessionName = session.title || session.name || session.summary || `Session ${session.id.slice(0, 12)}`;
  const providerLabel = session.__provider === 'codex' ? 'Codex' : 'Claude';

  return {
    title: sessionName,
    subtitle: `${project.displayName} · ${providerLabel}`,
  };
}

function focusElement(element: HTMLElement | null) {
  if (!element) return;

  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  if (typeof element.focus === 'function') {
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
  }
}

function escapeSelectorValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getFocusedTimelineStage(target: TaskTimelineSurfaceTarget | null): TaskTimelineStage | null {
  switch (target) {
    case 'task-backlog':
      return 'backlog';
    case 'task-running':
      return 'running';
    case 'task-review':
      return 'review';
    case 'task-completed':
      return 'completed';
    default:
      return null;
  }
}

function flattenProjectSessions(projects: Project[]): SessionEntry[] {
  const entries: SessionEntry[] = [];

  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      entries.push({ project, session: { ...session, __provider: session.__provider ?? 'claude' } });
    }
    for (const session of project.codexSessions ?? []) {
      entries.push({ project, session: { ...session, __provider: session.__provider ?? 'codex' } });
    }
  }

  return entries;
}

function sortBackgroundRunsByRecency(a: BackgroundRun, b: BackgroundRun): number {
  return (b.startedAt ?? b.finishedAt ?? '').localeCompare(a.startedAt ?? a.finishedAt ?? '') || b.id.localeCompare(a.id);
}

function sortBackgroundRunsByFinishedAtDesc(a: BackgroundRun, b: BackgroundRun): number {
  return (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '');
}

export default function MissionControlView({
  projects,
  isLoading,
  onSelectSession,
  onNewSession,
  onCreateProject,
  onOpenTaskQueue,
}: MissionControlViewProps) {
  const { t } = useTranslation('common');
  const statuses = useSessionStatusStore((s) => s.statuses);
  const attentionItems = useAttentionStore((s) => s.attentionItems);
  const approvalRequests = useAttentionStore((s) => s.approvalRequests);
  const backgroundRuns = useBackgroundRunStore(
    (s) => ((s as typeof s & { runs?: Record<string, BackgroundRun> }).runs ?? {}),
  );
  const queueOrder = useTaskQueueStore((s) => s.queueOrder);
  const refreshTasks = useTaskStore((s) => s.refresh);
  const updateTask = useTaskStore((s) => s.updateTask);
  const loadedTasksByProject = useTaskStore((s) => s.tasksByProject);
  const pendingFocusRequest = useMissionControlStore((s) => s.pendingFocusRequest);
  const clearSurfaceFocus = useMissionControlStore((s) => s.clearSurfaceFocus);
  const projectPaths = useMemo(
    () => [...new Set(projects.map((project) => project.path || project.fullPath).filter((projectPath): projectPath is string => Boolean(projectPath)))],
    [projects],
  );

  useEffect(() => {
    if (projectPaths.length === 0) return;
    void Promise.allSettled(projectPaths.map((projectPath) => refreshTasks(projectPath)));
  }, [projectPaths, refreshTasks]);

  const processingSessions = useMemo(
    () =>
      Object.entries(statuses)
        .filter(([, entry]) => entry.status === 'processing')
        .map(([sessionId]) => sessionId),
    [statuses],
  );
  const activeAttentionItems = useMemo(
    () =>
      Object.values(attentionItems)
        .filter((item) => item.status === 'active')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [attentionItems],
  );
  const pendingApprovals = useMemo(
    () =>
      Object.values(approvalRequests)
        .filter((request) => request.status === 'pending')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [approvalRequests],
  );
  const activeBackgroundRuns = useMemo(
    () =>
      Object.values(backgroundRuns)
        .filter((run) =>
          run.status === 'queued'
          || run.status === 'starting'
          || run.status === 'running'
          || run.status === 'awaiting_input'
          || run.status === 'needs_attention')
        .sort(sortBackgroundRunsByRecency),
    [backgroundRuns],
  );
  const allRecentCompletedBackgroundRuns = useMemo(
    () =>
      Object.values(backgroundRuns)
        .filter((run) =>
          run.status === 'completed'
          || run.status === 'failed'
          || run.status === 'cancelled')
        .sort(sortBackgroundRunsByFinishedAtDesc),
    [backgroundRuns],
  );
  const queuedTasks = useMemo(
    () => countQueuedDurableTasks(projectPaths.flatMap((projectPath) => loadedTasksByProject[projectPath] ?? [])),
    [loadedTasksByProject, projectPaths],
  );
  const allDurableTasks = useMemo(
    () => projectPaths.flatMap((projectPath) => loadedTasksByProject[projectPath] ?? []),
    [loadedTasksByProject, projectPaths],
  );
  const pendingReviewTasks = useMemo(
    () =>
      allDurableTasks
        .filter((task) => getTaskTimelineStage(task) === 'review')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [allDurableTasks],
  );
  const orderedTaskProjection = useMemo(
    () => orderProjectedTasks(allDurableTasks, queueOrder),
    [allDurableTasks, queueOrder],
  );
  const backlogTasks = useMemo(
    () => orderedTaskProjection.filter((task) => getTaskTimelineStage(task) === 'backlog'),
    [orderedTaskProjection],
  );
  const runningDurableTasks = useMemo(
    () => orderedTaskProjection.filter((task) => getTaskTimelineStage(task) === 'running'),
    [orderedTaskProjection],
  );
  const runningTaskCount = useMemo(
    () => countRunningDurableTasks(allDurableTasks),
    [allDurableTasks],
  );
  const completedTimelineTasks = useMemo(
    () =>
      allDurableTasks
        .filter((task) => getTaskTimelineStage(task) === 'completed')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [allDurableTasks],
  );
  const acceptedResultTasks = useMemo(
    () =>
      completedTimelineTasks
        .filter((task) => isAcceptedResultTask(task))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [completedTimelineTasks],
  );
  const hasTaskTimeline = backlogTasks.length > 0
    || runningDurableTasks.length > 0
    || pendingReviewTasks.length > 0
    || completedTimelineTasks.length > 0;
  const standaloneAttentionItems = useMemo(
    () => getStandaloneAttentionItems(activeAttentionItems, pendingApprovals),
    [activeAttentionItems, pendingApprovals],
  );
  const pendingApprovalSessionIds = useMemo(
    () => new Set(pendingApprovals.map((request) => request.sessionId)),
    [pendingApprovals],
  );
  const [focusedSurface, setFocusedSurface] = useState<TaskTimelineSurfaceTarget | null>(null);
  const [focusedSurfaceLocator, setFocusedSurfaceLocator] = useState<TaskTimelineSurfaceFocusLocator | null>(null);
  const attentionInboxRef = useRef<HTMLDivElement>(null);
  const approvalInboxRef = useRef<HTMLDivElement>(null);
  const reviewQueueRef = useRef<HTMLDivElement>(null);
  const resultInboxRef = useRef<HTMLDivElement>(null);
  const backgroundRunsRef = useRef<HTMLDivElement>(null);
  const taskTimelineRef = useRef<HTMLDivElement>(null);
  const focusedTaskTimelineStage = getFocusedTimelineStage(focusedSurface);
  const visibleResultTaskId = pendingFocusRequest?.target === 'result-inbox'
    ? pendingFocusRequest.locator?.taskId
    : focusedSurface === 'result-inbox'
      ? focusedSurfaceLocator?.taskId
      : undefined;
  const visibleBackgroundRunId = pendingFocusRequest?.target === 'background-runs'
    ? pendingFocusRequest.locator?.runId
    : focusedSurface === 'background-runs'
      ? focusedSurfaceLocator?.runId
      : undefined;
  const recentResultTasks = useMemo(
    () => buildVisibleControlPlaneItems(acceptedResultTasks, 6, visibleResultTaskId),
    [acceptedResultTasks, visibleResultTaskId],
  );
  const recentResultTaskIds = useMemo(
    () => new Set(recentResultTasks.map((task) => task.id)),
    [recentResultTasks],
  );
  const hasBackgroundRuns = activeBackgroundRuns.length > 0 || allRecentCompletedBackgroundRuns.length > 0;
  const backgroundRunIdsByTaskId = useMemo(() => {
    const nextMap = new Map<string, string>();

    for (const run of [...activeBackgroundRuns, ...allRecentCompletedBackgroundRuns]) {
      const taskId = run.taskId?.trim();
      if (!taskId || nextMap.has(taskId)) {
        continue;
      }

      nextMap.set(taskId, run.id);
    }

    return nextMap;
  }, [activeBackgroundRuns, allRecentCompletedBackgroundRuns]);
  const linkedTasksByBackgroundRunId = useMemo(() => {
    const nextMap = new Map<string, Task>();
    const allRuns = [...activeBackgroundRuns, ...allRecentCompletedBackgroundRuns];

    for (const run of allRuns) {
      const taskId = run.taskId?.trim();
      if (taskId) {
        const linkedTask = allDurableTasks.find((task) => task.id === taskId);
        if (linkedTask) {
          nextMap.set(run.id, linkedTask);
          continue;
        }
      }

      const fallbackSessionId = run.sessionId?.trim() || run.sourceSessionId?.trim();
      if (!fallbackSessionId) {
        continue;
      }

      const linkedTask = findTaskSessionLink(allDurableTasks, fallbackSessionId)?.task;
      if (linkedTask) {
        nextMap.set(run.id, linkedTask);
      }
    }

    return nextMap;
  }, [activeBackgroundRuns, allDurableTasks, allRecentCompletedBackgroundRuns]);

  const sortedSessions = useMemo(() => {
    const entries = flattenProjectSessions(projects);

    entries.sort((a, b) => {
      const sa = statuses[a.session.id]?.status ?? 'idle';
      const sb = statuses[b.session.id]?.status ?? 'idle';
      const pa = STATUS_PRIORITY[sa] ?? 3;
      const pb = STATUS_PRIORITY[sb] ?? 3;
      if (pa !== pb) return pa - pb;
      const ta = new Date(a.session.lastActivity || a.session.updated_at || a.session.createdAt || 0).getTime();
      const tb = new Date(b.session.lastActivity || b.session.updated_at || b.session.createdAt || 0).getTime();
      return tb - ta;
    });

    return entries;
  }, [projects, statuses]);

  const activeSessions = useMemo(
    () => sortedSessions.filter(({ session }) => {
      const status = statuses[session.id]?.status ?? 'idle';
      return status === 'processing' || status === 'needs_attention';
    }),
    [sortedSessions, statuses],
  );

  const sessionIndex = useMemo(() => {
    const index = new Map<string, SessionEntry>();
    for (const entry of sortedSessions) {
      index.set(entry.session.id, entry);
    }
    return index;
  }, [sortedSessions]);
  const availableSessionIds = useMemo(
    () => new Set(sessionIndex.keys()),
    [sessionIndex],
  );
  const sessionLabels = useMemo(() => {
    const labels: Record<string, InboxSessionLabel> = {};
    for (const entry of sortedSessions) {
      labels[entry.session.id] = getSessionDisplayLabel(entry.project, entry.session);
    }
    return labels;
  }, [sortedSessions]);
  const sessionSummaryContexts = useMemo(() => {
    const contexts: Record<string, TaskSessionSummaryContext> = {};
    for (const entry of sortedSessions) {
      const sessionLabel = getSessionDisplayLabel(entry.project, entry.session);
      contexts[entry.session.id] = {
        sessionId: entry.session.id,
        title: sessionLabel.title,
        subtitle: sessionLabel.subtitle,
      };
    }
    return contexts;
  }, [sortedSessions]);
  const linkedTasksBySessionId = useMemo(() => {
    const nextLinkedTasks = new Map<string, LinkedTaskSession<Task> | undefined>();

    for (const entry of sortedSessions) {
      nextLinkedTasks.set(entry.session.id, findTaskSessionLink(allDurableTasks, entry.session.id));
    }

    return nextLinkedTasks;
  }, [allDurableTasks, sortedSessions]);
  const getLinkedTaskSessionSummary = useCallback(
    (task: Task | undefined, kind: 'source' | 'runtime') => {
      if (!task) {
        return undefined;
      }

      const sessionId = kind === 'source'
        ? resolveTaskSourceSessionId(task)
        : task.execution_strategy === 'handoff'
          ? resolveTaskRuntimeSessionId(task)
          : task.session_id?.trim() || undefined;
      return sessionId ? sessionSummaryContexts[sessionId] : undefined;
    },
    [sessionSummaryContexts],
  );

  const handleOpenSession = useCallback((sessionId: string) => {
    const entry = sessionIndex.get(sessionId);
    if (entry) {
      onSelectSession(entry.project, entry.session);
    }
  }, [onSelectSession, sessionIndex]);

  const handleOpenTaskQueue = useCallback((projectPath: string) => {
    onOpenTaskQueue?.(projectPath);
  }, [onOpenTaskQueue]);

  const getSurfaceElement = useCallback((target: TaskTimelineSurfaceTarget) => {
    const targetMap: Record<TaskTimelineSurfaceTarget, HTMLDivElement | null> = {
      'attention-inbox': attentionInboxRef.current,
      'approval-inbox': approvalInboxRef.current,
      'review-queue': reviewQueueRef.current,
      'result-inbox': resultInboxRef.current,
      'background-runs': backgroundRunsRef.current,
      'task-backlog': taskTimelineRef.current,
      'task-running': taskTimelineRef.current,
      'task-review': taskTimelineRef.current,
      'task-completed': taskTimelineRef.current,
    };

    return targetMap[target];
  }, []);

  const focusSurfaceItem = useCallback((target: TaskTimelineSurfaceTarget, locator?: TaskTimelineSurfaceFocusLocator) => {
    const surfaceElement = getSurfaceElement(target);
    if (!surfaceElement) return false;

    const selector =
      target === 'approval-inbox' && locator?.sessionId
        ? `[data-approval-session-id="${escapeSelectorValue(locator.sessionId)}"]`
        : target === 'review-queue' && locator?.taskId
          ? `[data-review-task-id="${escapeSelectorValue(locator.taskId)}"]`
          : target === 'result-inbox' && locator?.taskId
            ? `[data-result-task-id="${escapeSelectorValue(locator.taskId)}"]`
            : target === 'background-runs' && locator?.runId
              ? `[data-background-run-id="${escapeSelectorValue(locator.runId)}"]`
              : target === 'task-backlog'
                ? '[data-task-timeline-stage="backlog"]'
                : target === 'task-running'
                  ? '[data-task-timeline-stage="running"]'
                  : target === 'task-review'
                    ? '[data-task-timeline-stage="review"]'
                    : target === 'task-completed'
                      ? '[data-task-timeline-stage="completed"]'
                      : null;

    if (!selector) return false;

    const item = surfaceElement.querySelector<HTMLElement>(selector);
    if (!item) return false;

    focusElement(item);
    return true;
  }, [getSurfaceElement]);

  const handleFocusSurface = useCallback((target: TaskTimelineSurfaceTarget, locator?: TaskTimelineSurfaceFocusLocator) => {
    setFocusedSurface(target);
    setFocusedSurfaceLocator(locator ?? null);

    focusElement(getSurfaceElement(target));
    void focusSurfaceItem(target, locator);
  }, [focusSurfaceItem, getSurfaceElement]);

  const getSessionCardMainPath = useCallback(
    (session: ProjectSession, linkedTask?: Task) => {
      if (!linkedTask) {
        return {
          action: undefined,
          badge: null,
        };
      }

      const descriptor = describeTaskMainPath(linkedTask, {
        pendingApprovalSessionIds,
        backgroundRunId: backgroundRunIdsByTaskId.get(linkedTask.id),
        availableSessionIds,
        resultTaskIds: recentResultTaskIds,
      });

      const { action } = descriptor;

      if (action.kind === 'surface' && action.surfaceTarget) {
        return {
          action: {
            label: action.label,
            onClick: () => handleFocusSurface(action.surfaceTarget!, action.focusLocator),
          },
          badge: descriptor.badge,
        };
      }

      if (action.kind === 'task-queue' && onOpenTaskQueue) {
        return {
          action: {
            label: action.label,
            onClick: () => handleOpenTaskQueue(linkedTask.project_path),
          },
          badge: descriptor.badge,
        };
      }

      if (action.kind === 'session' && action.sessionId && action.sessionId !== session.id) {
        return {
          action: {
            label: action.label,
            onClick: () => handleOpenSession(action.sessionId!),
          },
          badge: descriptor.badge,
        };
      }

      return {
        action: undefined,
        badge: descriptor.badge,
      };
    },
    [availableSessionIds, backgroundRunIdsByTaskId, handleFocusSurface, handleOpenSession, handleOpenTaskQueue, onOpenTaskQueue, pendingApprovalSessionIds],
  );

  useEffect(() => {
    if (!focusedSurface || !focusedSurfaceLocator) return;
    void focusSurfaceItem(focusedSurface, focusedSurfaceLocator);
  }, [
    activeBackgroundRuns,
    focusSurfaceItem,
    focusedSurface,
    focusedSurfaceLocator,
    pendingApprovals,
    pendingReviewTasks,
    allRecentCompletedBackgroundRuns,
    recentResultTasks,
  ]);

  useEffect(() => {
    if (!pendingFocusRequest) return;
    handleFocusSurface(pendingFocusRequest.target, pendingFocusRequest.locator);
    clearSurfaceFocus();
  }, [clearSurfaceFocus, handleFocusSurface, pendingFocusRequest]);

  const handleAcceptReview = (task: Task) => {
    handleFocusSurface('result-inbox', { taskId: task.id });
    void updateTask(task.project_path, task.id, {
      status: 'done',
      review_required: false,
      ...buildAcceptedReviewResultPatch(task),
    });
  };

  const handleRequestRework = (task: Task) => {
    void updateTask(task.project_path, task.id, {
      status: 'open',
      session_id: '',
      source_session_id: task.execution_strategy === 'handoff'
        ? task.source_session_id ?? task.session_id ?? ''
        : '',
      review_required: true,
      result_summary: task.result_summary ?? 'Rework requested from Mission Control',
      result_changed_files: [],
      result_verification_summary: '',
      result_risk_summary: '',
      result_suggested_next_step: '',
    });
  };

  const handleArchiveTask = (task: Task) => {
    void updateTask(task.project_path, task.id, {
      status: 'archived',
      review_required: false,
    });
  };

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent" style={{ animation: 'spin 0.8s linear infinite' }} />
          <span className="text-sm text-muted-foreground">{t('status.loading', 'Loading...')}</span>
        </div>
      </div>
    );
  }

  if (
    sortedSessions.length === 0
    && !hasBackgroundRuns
    && !hasTaskTimeline
    && recentResultTasks.length === 0
  ) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/60">
            <svg className="h-8 w-8 text-muted-foreground/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            {t('overview.noSessions', 'No active sessions')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('overview.noSessionsHint', 'Create a project and start your first AI agent session')}
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={onCreateProject}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              {t('overviewSections.addProject', 'Add Project')}
            </button>
            <button
              type="button"
              onClick={onNewSession}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t('overview.newSession', 'New Session')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-6 py-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              {t('overview.title', 'Mission Control')}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t('overviewSections.subtitle', 'Structured attention first. {{total}} sessions, {{active}} currently active.', { total: sortedSessions.length, active: activeSessions.length })}
            </p>
          </div>
          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <span className="text-sm leading-none">+</span>
            {t('overview.newSession', 'New Session')}
          </button>
        </div>

        <MissionControlSummaryStrip
          pendingApprovals={pendingApprovals.length}
          activeAttentionItems={standaloneAttentionItems.length}
          runningTasks={runningTaskCount}
          queuedTasks={queuedTasks}
          pendingReviewTasks={pendingReviewTasks.length}
          acceptedResults={acceptedResultTasks.length}
          onFocusSurface={handleFocusSurface}
        />

        <section
          role="region"
          aria-label="Mission Control control plane"
          className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.1fr)_minmax(0,0.95fr)]"
        >
          <div role="region" aria-label="Mission Control active column" className="space-y-6">
            <div
              ref={attentionInboxRef}
              tabIndex={-1}
              data-surface-focused={focusedSurface === 'attention-inbox' ? 'true' : 'false'}
              className={focusedSurface === 'attention-inbox' ? 'rounded-[20px] ring-2 ring-primary/30 ring-offset-2 ring-offset-background' : undefined}
            >
              <AttentionInbox items={standaloneAttentionItems} onOpenSession={handleOpenSession} sessionLabels={sessionLabels} />
            </div>

            <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">{t('overviewSections.activeSessions', 'Active Sessions')}</h2>
                  <p className="text-xs text-muted-foreground">{t('overviewSections.activeSessionsSubtitle', 'Sessions needing attention or actively processing.')}</p>
                </div>
                <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{activeSessions.length}</span>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                {activeSessions.map(({ project, session }) => {
                  const linkedTaskSession = linkedTasksBySessionId.get(session.id);
                  const sessionCardMainPath = getSessionCardMainPath(session, linkedTaskSession?.task);
                  return (
                    <SessionCard
                      key={session.id}
                      session={session}
                      project={project}
                      linkedTask={linkedTaskSession?.task}
                      taskSessionBinding={linkedTaskSession?.binding}
                      mainPathAction={sessionCardMainPath.action}
                      mainPathBadge={sessionCardMainPath.badge}
                      sourceSessionLabel={getLinkedTaskSessionSummary(linkedTaskSession?.task, 'source')}
                      runtimeSessionLabel={getLinkedTaskSessionSummary(linkedTaskSession?.task, 'runtime')}
                      availableProjects={projects}
                      onClick={() => onSelectSession(project, session)}
                      showHandoffAction
                      onQueueHandoffTask={handleOpenTaskQueue}
                    />
                  );
                })}
                <button
                  type="button"
                  onClick={onNewSession}
                  className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/60 bg-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted/30 hover:text-foreground"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted/60 text-lg">+</span>
                  <span className="text-sm font-medium">{t('overview.newSession', 'New Session')}</span>
                </button>
              </div>
            </section>
          </div>

          <div role="region" aria-label="Mission Control operations column" className="space-y-6">
            {hasTaskTimeline ? (
              <div
                ref={taskTimelineRef}
                tabIndex={-1}
                data-surface-focused={focusedTaskTimelineStage ? 'true' : 'false'}
                className={focusedTaskTimelineStage ? 'rounded-[20px] ring-2 ring-primary/30 ring-offset-2 ring-offset-background' : undefined}
              >
                <TaskTimelineOverview
                  backlogTasks={backlogTasks}
                  runningTasks={runningDurableTasks}
                  reviewTasks={pendingReviewTasks}
                  completedTasks={completedTimelineTasks}
                  backgroundRuns={activeBackgroundRuns}
                  sessionLabels={sessionSummaryContexts}
                  pendingApprovalSessionIds={pendingApprovalSessionIds}
                  resultTaskIds={recentResultTaskIds}
                  onOpenSession={handleOpenSession}
                  onOpenTaskQueue={handleOpenTaskQueue}
                  onFocusSurface={handleFocusSurface}
                  focusedStage={focusedTaskTimelineStage}
                />
              </div>
            ) : null}

            {hasBackgroundRuns ? (
              <div
                ref={backgroundRunsRef}
                tabIndex={-1}
                data-surface-focused={focusedSurface === 'background-runs' ? 'true' : 'false'}
                className={focusedSurface === 'background-runs' ? 'rounded-[20px] ring-2 ring-primary/30 ring-offset-2 ring-offset-background' : undefined}
              >
                <BackgroundRunPanel
                  activeRuns={activeBackgroundRuns}
                  recentRuns={allRecentCompletedBackgroundRuns}
                  onOpenSession={handleOpenSession}
                  sessionLabels={sessionLabels}
                  linkedTasksByRunId={linkedTasksByBackgroundRunId}
                  pendingApprovalSessionIds={pendingApprovalSessionIds}
                  availableSessionIds={availableSessionIds}
                  resultTaskIds={recentResultTaskIds}
                  onOpenTaskQueue={handleOpenTaskQueue}
                  onFocusSurface={handleFocusSurface}
                  layout="stacked"
                  focusedRunId={focusedSurface === 'background-runs' ? focusedSurfaceLocator?.runId : undefined}
                />
              </div>
            ) : null}

            <div
              ref={resultInboxRef}
              tabIndex={-1}
              data-surface-focused={focusedSurface === 'result-inbox' ? 'true' : 'false'}
              className={focusedSurface === 'result-inbox' ? 'rounded-[20px] ring-2 ring-primary/30 ring-offset-2 ring-offset-background' : undefined}
            >
              <ResultInboxSection
                recentResults={recentResultTasks}
                sessionLabels={sessionLabels}
                onArchiveTask={handleArchiveTask}
                onOpenSession={handleOpenSession}
                focusedTaskId={focusedSurface === 'result-inbox' ? focusedSurfaceLocator?.taskId : undefined}
              />
            </div>
          </div>

          <div role="region" aria-label="Mission Control decisions column" className="space-y-6">
            <div
              ref={approvalInboxRef}
              tabIndex={-1}
              data-surface-focused={focusedSurface === 'approval-inbox' ? 'true' : 'false'}
              className={focusedSurface === 'approval-inbox' ? 'rounded-[20px] ring-2 ring-primary/30 ring-offset-2 ring-offset-background' : undefined}
            >
              <ApprovalInbox
                requests={pendingApprovals}
                onOpenSession={handleOpenSession}
                sessionLabels={sessionLabels}
                focusedSessionId={focusedSurface === 'approval-inbox' ? focusedSurfaceLocator?.sessionId : undefined}
              />
            </div>

            <div
              ref={reviewQueueRef}
              tabIndex={-1}
              data-surface-focused={focusedSurface === 'review-queue' ? 'true' : 'false'}
              className={focusedSurface === 'review-queue' ? 'rounded-[20px] ring-2 ring-primary/30 ring-offset-2 ring-offset-background' : undefined}
            >
              <ReviewQueueSection
                reviewTasks={pendingReviewTasks}
                sessionLabels={sessionLabels}
                onAcceptReview={handleAcceptReview}
                onRequestRework={handleRequestRework}
                onArchiveTask={handleArchiveTask}
                onOpenSession={handleOpenSession}
                focusedTaskId={focusedSurface === 'review-queue' ? focusedSurfaceLocator?.taskId : undefined}
              />
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('overviewSections.allSessions', 'All Sessions')}</h2>
              <p className="text-xs text-muted-foreground">{t('overviewSections.allSessionsSubtitle', 'Overview of all sessions across projects.')}</p>
            </div>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{sortedSessions.length}</span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sortedSessions.map(({ project, session }) => {
              const linkedTaskSession = linkedTasksBySessionId.get(session.id);
              const sessionCardMainPath = getSessionCardMainPath(session, linkedTaskSession?.task);
              return (
                <SessionCard
                  key={session.id}
                  session={session}
                  project={project}
                  linkedTask={linkedTaskSession?.task}
                  taskSessionBinding={linkedTaskSession?.binding}
                  mainPathAction={sessionCardMainPath.action}
                  mainPathBadge={sessionCardMainPath.badge}
                  sourceSessionLabel={getLinkedTaskSessionSummary(linkedTaskSession?.task, 'source')}
                  runtimeSessionLabel={getLinkedTaskSessionSummary(linkedTaskSession?.task, 'runtime')}
                  availableProjects={projects}
                  onClick={() => onSelectSession(project, session)}
                  showHandoffAction
                  onQueueHandoffTask={handleOpenTaskQueue}
                />
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
