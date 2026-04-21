import { useTranslation } from 'react-i18next';
import type { Task } from '../../lib/tauri-bridge';
import {
  buildTaskDispatchPresentation,
  formatTaskExecutionStrategyLabel,
  formatTaskRoleLabel,
} from '../../lib/task-dispatch';
import type { BackgroundRun } from '../../types/background-run';
import { buildVisibleControlPlaneItems } from '../../lib/control-plane';
import { describeTaskMainPath, formatTaskMainPathBadgeLabel } from '../../lib/task-main-path';
import type { MissionControlSurfaceLocator, MissionControlSurfaceTarget } from '../../lib/mission-control';
import type { InboxSessionLabel } from './ApprovalInbox';

interface BackgroundRunPanelProps {
  activeRuns: BackgroundRun[];
  recentRuns: BackgroundRun[];
  onOpenSession: (sessionId: string) => void;
  sessionLabels?: Record<string, InboxSessionLabel>;
  linkedTasksByRunId?: Map<string, Task>;
  pendingApprovalSessionIds?: Set<string>;
  availableSessionIds?: Set<string>;
  resultTaskIds?: Set<string>;
  onOpenTaskQueue?: (projectPath: string) => void;
  onFocusSurface?: (target: MissionControlSurfaceTarget, locator?: MissionControlSurfaceLocator) => void;
  layout?: 'split' | 'stacked';
  focusedRunId?: string;
}

const PROVIDER_LABEL: Record<BackgroundRun['provider'], string> = {
  codex: 'Codex',
  claude: 'Claude',
  custom: 'Custom',
};
const STATUS_BADGE_CLASS: Record<BackgroundRun['status'], string> = {
  queued: 'bg-slate-500/10 text-slate-700',
  starting: 'bg-slate-500/10 text-slate-700',
  running: 'bg-sky-500/10 text-sky-700',
  awaiting_input: 'bg-amber-500/10 text-amber-700',
  needs_attention: 'bg-amber-500/10 text-amber-700',
  completed: 'bg-emerald-500/10 text-emerald-700',
  failed: 'bg-rose-500/10 text-rose-700',
  cancelled: 'bg-slate-500/10 text-slate-700',
};

const RECENT_COMPLETED_VISIBLE_COUNT = 3;
const EMPTY_TASK_MAP = new Map<string, Task>();
const EMPTY_SESSION_ID_SET = new Set<string>();

interface BackgroundRunPrimaryAction {
  label: string;
  onClick: () => void;
}

function formatStatus(status: BackgroundRun['status']): string {
  return status.replace(/_/g, ' ');
}

function mapRunStatusToTaskStatus(run: BackgroundRun): Task['status'] {
  switch (run.status) {
    case 'queued':
      return 'queued';
    case 'starting':
      return 'dispatched';
    case 'awaiting_input':
    case 'needs_attention':
      return run.requiresApproval ? 'pending_approval' : 'in_progress';
    case 'running':
      return 'in_progress';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

type TFunc = (key: string, fallback: string) => string;

function getRunDetail(run: BackgroundRun, t: TFunc): { label: string; body: string } {
  if (run.summary) {
    return {
      label: t('backgroundRun.summary', 'Summary'),
      body: run.summary,
    };
  }

  if (run.lastOutputExcerpt) {
    return {
      label: t('backgroundRun.lastOutput', 'Last output'),
      body: run.lastOutputExcerpt,
    };
  }

  return {
    label: t('backgroundRun.summary', 'Summary'),
    body: t('backgroundRun.noExtraContext', 'No extra context attached yet.'),
  };
}

function BackgroundRunCard({
  run,
  onOpenSession,
  sessionLabel,
  variant = 'active',
  isFocused = false,
  sessionLabels = {},
  linkedTask,
  pendingApprovalSessionIds = EMPTY_SESSION_ID_SET,
  availableSessionIds = EMPTY_SESSION_ID_SET,
  resultTaskIds = EMPTY_SESSION_ID_SET,
  onOpenTaskQueue,
  onFocusSurface,
}: {
  run: BackgroundRun;
  onOpenSession: (sessionId: string) => void;
  sessionLabel?: InboxSessionLabel;
  variant?: 'active' | 'completed';
  isFocused?: boolean;
  sessionLabels?: Record<string, InboxSessionLabel>;
  linkedTask?: Task;
  pendingApprovalSessionIds?: Set<string>;
  availableSessionIds?: Set<string>;
  resultTaskIds?: Set<string>;
  onOpenTaskQueue?: (projectPath: string) => void;
  onFocusSurface?: (target: MissionControlSurfaceTarget, locator?: MissionControlSurfaceLocator) => void;
}) {
  const { t } = useTranslation('common');
  const detail = getRunDetail(run, t);
  const sessionId = run.sessionId;
  const isCompletedCard = variant === 'completed';
  const roleLabel = formatTaskRoleLabel(run.taskRole);
  const executionStrategyLabel = run.executionStrategy
    ? formatTaskExecutionStrategyLabel(run.executionStrategy)
    : null;
  const dispatchPresentation = run.executionStrategy || run.worktreePath || run.sourceSessionId
    ? buildTaskDispatchPresentation(
      {
        execution_strategy: run.executionStrategy ?? 'current_project',
        worktree_path: run.worktreePath,
        status: mapRunStatusToTaskStatus(run),
        session_id: run.sessionId,
        source_session_id: run.sourceSessionId,
        result_summary: run.summary ?? run.lastOutputExcerpt ?? '',
      },
      {
        sessionLabelsById: sessionLabels,
      },
    )
    : null;
  const dispatchTargetLabel = dispatchPresentation?.dispatchTargetLabel?.replace(/^Dispatch target · /, '');
  const contextDetailLines = dispatchPresentation?.contextDetailLines ?? [];
  const openSessionAction = dispatchPresentation?.openSessionAction;
  const openSessionId = openSessionAction?.sessionId ?? sessionId;
  const openSessionLabel = openSessionAction?.label ?? t('backgroundRun.openSession', 'Open Session');
  const mainPathDescriptor = linkedTask
    ? describeTaskMainPath(linkedTask, {
      pendingApprovalSessionIds,
      backgroundRunId: run.id,
      availableSessionIds,
      resultTaskIds,
    })
    : null;
  const mainPathBadge = mainPathDescriptor?.badge?.kind === 'surface' && mainPathDescriptor.badge.surfaceTarget === 'background-runs'
    ? null
    : mainPathDescriptor?.badge ?? null;
  const mainPathBadgeLabel = formatTaskMainPathBadgeLabel(mainPathBadge);

  let primaryAction: BackgroundRunPrimaryAction | null = null;
  if (
    mainPathDescriptor?.action.kind === 'surface'
    && mainPathDescriptor.action.surfaceTarget
    && mainPathDescriptor.action.surfaceTarget !== 'background-runs'
    && onFocusSurface
  ) {
    primaryAction = {
      label: mainPathDescriptor.action.label,
      onClick: () => onFocusSurface(mainPathDescriptor.action.surfaceTarget!, mainPathDescriptor.action.focusLocator),
    };
  } else if (mainPathDescriptor?.action.kind === 'task-queue' && linkedTask && onOpenTaskQueue) {
    primaryAction = {
      label: mainPathDescriptor.action.label,
      onClick: () => onOpenTaskQueue(linkedTask.project_path),
    };
  } else if (mainPathDescriptor?.action.kind === 'session' && mainPathDescriptor.action.sessionId) {
    primaryAction = {
      label: mainPathDescriptor.action.label,
      onClick: () => onOpenSession(mainPathDescriptor.action.sessionId!),
    };
  } else if (openSessionId) {
    primaryAction = {
      label: openSessionLabel,
      onClick: () => onOpenSession(openSessionId),
    };
  }

  return (
    <div
      tabIndex={-1}
      data-background-run-id={run.id}
      data-control-plane-focused={isFocused ? 'true' : 'false'}
      className={`rounded-xl border bg-background/70 p-3 ${
        isFocused
          ? 'border-primary/40 ring-2 ring-primary/20 ring-offset-2 ring-offset-background'
          : 'border-border/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {sessionLabel ? (
            <div className="mb-2">
              <div className="truncate text-xs font-medium text-foreground">{sessionLabel.title}</div>
              <div className="truncate text-[11px] text-muted-foreground">{sessionLabel.subtitle}</div>
            </div>
          ) : null}

          {mainPathBadgeLabel ? (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                {mainPathBadgeLabel}
              </span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{run.title}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {run.provider === 'codex' ? t('backgroundRun.providerCodex', 'Codex') : run.provider === 'claude' ? t('backgroundRun.providerClaude', 'Claude') : t('backgroundRun.providerCustom', 'Custom')}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE_CLASS[run.status]}`}>
              {formatStatus(run.status)}
            </span>
            {roleLabel ? (
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                {roleLabel}
              </span>
            ) : null}
            {executionStrategyLabel ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                {executionStrategyLabel}
              </span>
            ) : null}
            {dispatchTargetLabel ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {dispatchTargetLabel}
              </span>
            ) : null}
          </div>

          {contextDetailLines.length > 0 ? (
            <div className="mt-2 space-y-1">
              {contextDetailLines.map((line) => (
                <p key={line} className="truncate text-[11px] text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          ) : null}

          {isCompletedCard ? (
            <div className="mt-2 space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{detail.label}</div>
              <p className="text-xs text-muted-foreground">{detail.body}</p>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">{detail.body}</p>
          )}
        </div>

        {primaryAction ? (
          <button
            type="button"
            onClick={primaryAction.onClick}
            aria-label={`${primaryAction.label} for ${run.title}`}
            className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
          >
            {primaryAction.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function BackgroundRunPanel({
  activeRuns,
  recentRuns,
  onOpenSession,
  sessionLabels = {},
  linkedTasksByRunId = EMPTY_TASK_MAP,
  pendingApprovalSessionIds = EMPTY_SESSION_ID_SET,
  availableSessionIds = EMPTY_SESSION_ID_SET,
  resultTaskIds = EMPTY_SESSION_ID_SET,
  onOpenTaskQueue,
  onFocusSurface,
  layout = 'split',
  focusedRunId,
}: BackgroundRunPanelProps) {
  const visibleRecentRuns = buildVisibleControlPlaneItems(recentRuns, RECENT_COMPLETED_VISIBLE_COUNT, focusedRunId);
  const visibleRunCount = activeRuns.length + visibleRecentRuns.length;

  return (
    <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Background Runs</h2>
          <p className="text-xs text-muted-foreground">Minimal visibility for active and recently finished background work.</p>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {visibleRunCount}
        </span>
      </div>

      <div className={layout === 'stacked' ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-4 xl:grid-cols-2'}>
        <div role="region" aria-label="Active Background Runs" className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Active Background Runs</h3>
            <p className="text-xs text-muted-foreground">Queued, starting, running, or blocked on user attention.</p>
          </div>

          {activeRuns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/60 px-4 py-5 text-sm text-muted-foreground">
              No active background runs.
            </div>
          ) : (
            activeRuns.map((run) => (
              <BackgroundRunCard
                key={run.id}
                run={run}
                onOpenSession={onOpenSession}
                sessionLabel={run.sessionId ? sessionLabels[run.sessionId] : undefined}
                sessionLabels={sessionLabels}
                linkedTask={linkedTasksByRunId.get(run.id)}
                pendingApprovalSessionIds={pendingApprovalSessionIds}
                availableSessionIds={availableSessionIds}
                resultTaskIds={resultTaskIds}
                onOpenTaskQueue={onOpenTaskQueue}
                onFocusSurface={onFocusSurface}
                isFocused={focusedRunId === run.id}
              />
            ))
          )}
        </div>

        <div role="region" aria-label="Recently Finished" className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Recently Finished</h3>
            <p className="text-xs text-muted-foreground">Recent completed, failed, or cancelled runs stay visible here until the deeper control plane lands.</p>
          </div>

          {visibleRecentRuns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/60 px-4 py-5 text-sm text-muted-foreground">
              No recent finished runs.
            </div>
          ) : (
            visibleRecentRuns.map((run) => (
              <BackgroundRunCard
                key={run.id}
                run={run}
                onOpenSession={onOpenSession}
                sessionLabel={run.sessionId ? sessionLabels[run.sessionId] : undefined}
                sessionLabels={sessionLabels}
                linkedTask={linkedTasksByRunId.get(run.id)}
                pendingApprovalSessionIds={pendingApprovalSessionIds}
                availableSessionIds={availableSessionIds}
                resultTaskIds={resultTaskIds}
                onOpenTaskQueue={onOpenTaskQueue}
                onFocusSurface={onFocusSurface}
                variant="completed"
                isFocused={focusedRunId === run.id}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}
