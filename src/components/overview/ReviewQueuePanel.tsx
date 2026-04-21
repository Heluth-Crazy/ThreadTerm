import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import DiffViewer from '../DiffViewer.jsx';
import { git, type Task } from '../../lib/tauri-bridge';
import { hasStructuredTaskResultDetails } from '../../lib/control-plane';
import {
  buildTaskDispatchPresentation,
  compactPathLabel,
  formatTaskExecutionStrategyLabel,
  formatTaskRoleLabel,
} from '../../lib/task-dispatch';
import type { InboxSessionLabel } from './ApprovalInbox';

interface ReviewQueuePanelProps {
  reviewTasks: Task[];
  recentResults: Task[];
  sessionLabels: Record<string, InboxSessionLabel>;
  onAcceptReview: (task: Task) => void;
  onRequestRework: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
}

interface ReviewQueueSectionProps {
  reviewTasks: Task[];
  sessionLabels: Record<string, InboxSessionLabel>;
  onAcceptReview: (task: Task) => void;
  onRequestRework: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
  focusedTaskId?: string;
}

interface ResultInboxSectionProps {
  recentResults: Task[];
  sessionLabels: Record<string, InboxSessionLabel>;
  onArchiveTask: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
  focusedTaskId?: string;
}

function formatRelativeTime(dateString?: string) {
  if (!dateString) return 'now';
  const diff = Date.now() - new Date(dateString).getTime();
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type CompareFileDiffState =
  | { filePath: string; status: 'ready'; diff: string }
  | { filePath: string; status: 'empty' }
  | { filePath: string; status: 'error'; message: string };

function getChangedFiles(task: Task) {
  return Array.from(
    new Set(
      (task.result_changed_files ?? [])
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function getCompareProjectPath(task: Task) {
  return task.worktree_path || task.project_path;
}

function getErrorMessage(error: unknown, unknownFallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return unknownFallback;
}

function ResultDetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs text-foreground">{children}</dd>
    </div>
  );
}

function ResultMetadata({ task }: { task: Task }) {
  const { t } = useTranslation('common');
  const changedFiles = getChangedFiles(task);

  if (!hasStructuredTaskResultDetails(task)) {
    return null;
  }

  return (
    <dl className="mt-3 space-y-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-3">
      {changedFiles.length > 0 ? (
        <ResultDetailRow label={t('reviewQueue.changedFiles', 'Changed files')}>
          <div className="flex flex-wrap gap-1.5">
            {changedFiles.map((file) => (
              <code
                key={file}
                className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {file}
              </code>
            ))}
          </div>
        </ResultDetailRow>
      ) : null}

      {task.result_verification_summary ? (
        <ResultDetailRow label={t('reviewQueue.verification', 'Verification')}>
          <span className="text-muted-foreground">{task.result_verification_summary}</span>
        </ResultDetailRow>
      ) : null}

      {task.result_risk_summary ? (
        <ResultDetailRow label={t('reviewQueue.risk', 'Risk')}>
          <span className="text-muted-foreground">{task.result_risk_summary}</span>
        </ResultDetailRow>
      ) : null}

      {task.result_suggested_next_step ? (
        <ResultDetailRow label={t('reviewQueue.nextStep', 'Next step')}>
          <span className="text-muted-foreground">{task.result_suggested_next_step}</span>
        </ResultDetailRow>
      ) : null}
    </dl>
  );
}

function ResultExecutionContext({
  task,
  sessionLabels,
}: {
  task: Task;
  sessionLabels: Record<string, InboxSessionLabel>;
}) {
  const roleLabel = formatTaskRoleLabel(task.role);
  const executionStrategyLabel = formatTaskExecutionStrategyLabel(task.execution_strategy);
  const dispatchPresentation = buildTaskDispatchPresentation(task, {
    sessionLabelsById: sessionLabels,
  });
  const dispatchTargetLabel = dispatchPresentation.dispatchTargetLabel;
  const contextDetailLines = dispatchPresentation.contextDetailLines;

  if (!roleLabel && !executionStrategyLabel && !dispatchTargetLabel && contextDetailLines.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {roleLabel ? (
          <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-600">
            Role · {roleLabel}
          </span>
        ) : null}
        {executionStrategyLabel ? (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600">
            Exec · {executionStrategyLabel}
          </span>
        ) : null}
        {dispatchTargetLabel ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
            {dispatchTargetLabel}
          </span>
        ) : null}
      </div>

      {contextDetailLines.map((line) => (
        <p key={line} className="truncate text-[11px] text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}

function CompareDiffList({ items }: { items: CompareFileDiffState[] }) {
  const hasReadyDiff = items.some((item) => item.status === 'ready');

  return (
    <div className="space-y-3">
      {!hasReadyDiff ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/70 px-3 py-4 text-xs text-muted-foreground">
          No git diff output is currently available for these changed files.
        </div>
      ) : null}

      {items.map((item) => (
        <section key={item.filePath} className="overflow-hidden rounded-xl border border-border/60 bg-background/80">
          <div className="border-b border-border/50 bg-muted/40 px-3 py-2">
            <code className="text-[11px] text-foreground">{item.filePath}</code>
          </div>

          {item.status === 'ready' ? (
            <div className="max-h-80 overflow-auto">
              <DiffViewer diff={item.diff} wrapText />
            </div>
          ) : item.status === 'empty' ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">No diff output available for this file.</div>
          ) : (
            <div className="px-3 py-4 text-xs text-red-600 dark:text-red-300">
              Unable to load diff for this file: {item.message}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function TaskCompareInline({
  task,
  buttonClassName,
}: {
  task: Task;
  buttonClassName: string;
}) {
  const { t } = useTranslation('common');
  const changedFiles = getChangedFiles(task);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [fileDiffs, setFileDiffs] = useState<CompareFileDiffState[] | null>(null);
  const compareProjectPath = getCompareProjectPath(task);

  if (changedFiles.length === 0) {
    return null;
  }

  const loadDiffs = async () => {
    setIsLoading(true);

    const settled = await Promise.allSettled(
      changedFiles.map(async (filePath) => ({
        filePath,
        diff: await git.diff(compareProjectPath, filePath),
      })),
    );

    setFileDiffs(
      settled.map((result, index) => {
        const filePath = changedFiles[index];
        if (result.status === 'rejected') {
          return {
            filePath,
            status: 'error',
            message: getErrorMessage(result.reason, t('reviewQueue.unknownError', 'Unknown error')),
          } satisfies CompareFileDiffState;
        }

        const diff = result.value.diff.trimEnd();
        if (!diff.trim()) {
          return {
            filePath,
            status: 'empty',
          } satisfies CompareFileDiffState;
        }

        return {
          filePath,
          status: 'ready',
          diff,
        } satisfies CompareFileDiffState;
      }),
    );

    setIsLoading(false);
  };

  const handleToggleCompare = () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);

    if (nextOpen && !fileDiffs && !isLoading) {
      void loadDiffs();
    }
  };

  const hasLoadErrors = fileDiffs?.some((item) => item.status === 'error') ?? false;

  return (
    <>
      <button
        type="button"
        onClick={handleToggleCompare}
        aria-expanded={isOpen}
        className={buttonClassName}
      >
        {isOpen ? t('reviewQueue.hideCompare', 'Hide Compare') : t('reviewQueue.compare', 'Compare')}
      </button>

      {isOpen ? (
        <div className="basis-full">
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-foreground">Changed-file compare</p>
                <p className="text-[11px] text-muted-foreground">
                  {changedFiles.length} file{changedFiles.length === 1 ? '' : 's'} from{' '}
                  <code>{compactPathLabel(compareProjectPath) ?? compareProjectPath}</code>
                </p>
              </div>

              {hasLoadErrors && !isLoading ? (
                <button
                  type="button"
                  onClick={() => void loadDiffs()}
                  className="inline-flex h-7 items-center rounded-lg border border-border/60 bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60"
                >
                  Retry
                </button>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {changedFiles.map((filePath) => (
                <code
                  key={filePath}
                  className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {filePath}
                </code>
              ))}
            </div>

            <div className="mt-3">
              {isLoading ? (
                <div className="rounded-xl border border-dashed border-border/60 bg-background/70 px-3 py-4 text-xs text-muted-foreground">
                  Loading git diff for changed files…
                </div>
              ) : fileDiffs ? (
                <CompareDiffList items={fileDiffs} />
              ) : (
                <div className="rounded-xl border border-dashed border-border/60 bg-background/70 px-3 py-4 text-xs text-muted-foreground">
                  Compare is ready when you want to inspect the changed files.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ReviewTaskCard({
  task,
  sessionLabels,
  onAcceptReview,
  onRequestRework,
  onArchiveTask,
  onOpenSession,
  isFocused = false,
}: {
  task: Task;
  sessionLabels: Record<string, InboxSessionLabel>;
  onAcceptReview: (task: Task) => void;
  onRequestRework: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
  isFocused?: boolean;
}) {
  const sessionLabel = task.session_id ? sessionLabels[task.session_id] : null;
  const roleLabel = formatTaskRoleLabel(task.role);
  const dispatchPresentation = buildTaskDispatchPresentation(task, {
    sessionLabelsById: sessionLabels,
  });
  const dispatchTargetLabel = dispatchPresentation.dispatchTargetLabel;
  const openSessionAction = dispatchPresentation.openSessionAction;

  return (
    <article
      tabIndex={-1}
      data-review-task-id={task.id}
      data-control-plane-focused={isFocused ? 'true' : 'false'}
      className={`rounded-2xl border bg-background/80 p-4 shadow-sm ${
        isFocused
          ? 'border-primary/40 ring-2 ring-primary/20 ring-offset-2 ring-offset-background'
          : 'border-border/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className="rounded-full bg-purple-500/10 px-2 py-0.5 font-semibold text-purple-600">Pending Review</span>
            <span>{task.provider}</span>
            {roleLabel ? <span>{roleLabel}</span> : null}
            <span>{compactPathLabel(task.project_path)}</span>
            {dispatchTargetLabel ? <span>{dispatchTargetLabel}</span> : null}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-foreground">{task.title}</h3>
          {task.description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description}</p> : null}
          {task.result_summary ? <p className="mt-2 rounded-xl bg-muted/70 px-3 py-2 text-xs text-muted-foreground">{task.result_summary}</p> : null}
          <ResultMetadata task={task} />
          <ResultExecutionContext task={task} sessionLabels={sessionLabels} />
          {sessionLabel ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Session · {sessionLabel.title}
              {sessionLabel.subtitle ? ` · ${sessionLabel.subtitle}` : ''}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(task.updated_at)}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <TaskCompareInline
          task={task}
          buttonClassName="inline-flex h-8 items-center rounded-lg border border-border/60 bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
        />
        {openSessionAction?.sessionId ? (
          <button
            type="button"
            onClick={() => onOpenSession(openSessionAction.sessionId)}
            className="inline-flex h-8 items-center rounded-lg border border-border/60 bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
          >
            {openSessionAction.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onAcceptReview(task)}
          className="inline-flex h-8 items-center rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => onRequestRework(task)}
          className="inline-flex h-8 items-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
        >
          Rework
        </button>
        <button
          type="button"
          onClick={() => onArchiveTask(task)}
          className="inline-flex h-8 items-center rounded-lg border border-border/60 bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          Archive
        </button>
      </div>
    </article>
  );
}

function ResultItem({
  task,
  sessionLabels,
  onArchiveTask,
  onOpenSession,
  isFocused = false,
}: {
  task: Task;
  sessionLabels: Record<string, InboxSessionLabel>;
  onArchiveTask: (task: Task) => void;
  onOpenSession: (sessionId: string) => void;
  isFocused?: boolean;
}) {
  const { t } = useTranslation('common');
  const sessionLabel = task.session_id ? sessionLabels[task.session_id] : null;
  const tone = 'text-emerald-600 bg-emerald-500/10';
  const statusLabel = t('reviewQueue.accepted', 'Accepted');
  const openSessionAction = buildTaskDispatchPresentation(task, {
    sessionLabelsById: sessionLabels,
  }).openSessionAction;

  return (
    <article
      tabIndex={-1}
      data-result-task-id={task.id}
      data-control-plane-focused={isFocused ? 'true' : 'false'}
      className={`rounded-2xl border bg-background/70 p-3 shadow-sm ${
        isFocused
          ? 'border-primary/40 ring-2 ring-primary/20 ring-offset-2 ring-offset-background'
          : 'border-border/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className={`rounded-full px-2 py-0.5 font-semibold ${tone}`}>{statusLabel}</span>
            <span>{task.provider}</span>
            <span>{compactPathLabel(task.project_path)}</span>
          </div>
          <h3 className="mt-2 truncate text-sm font-medium text-foreground">{task.title}</h3>
          {task.result_summary ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.result_summary}</p> : null}
          <ResultExecutionContext task={task} sessionLabels={sessionLabels} />
          <ResultMetadata task={task} />
          {sessionLabel ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {sessionLabel.title}
              {sessionLabel.subtitle ? ` · ${sessionLabel.subtitle}` : ''}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(task.updated_at)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <TaskCompareInline
          task={task}
          buttonClassName="inline-flex h-7 items-center rounded-lg border border-border/60 bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60"
        />
        {openSessionAction?.sessionId ? (
          <button
            type="button"
            onClick={() => onOpenSession(openSessionAction.sessionId)}
            className="inline-flex h-7 items-center rounded-lg border border-border/60 bg-background px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60"
          >
            {openSessionAction.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onArchiveTask(task)}
          className="inline-flex h-7 items-center rounded-lg border border-border/60 bg-background px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          Archive
        </button>
      </div>
    </article>
  );
}

export function ReviewQueueSection({
  reviewTasks,
  sessionLabels,
  onAcceptReview,
  onRequestRework,
  onArchiveTask,
  onOpenSession,
  focusedTaskId,
}: ReviewQueueSectionProps) {
  return (
    <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Review Queue</h2>
          <p className="text-xs text-muted-foreground">Successful task runs land here first and wait for a human accept, rework, or archive decision.</p>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{reviewTasks.length}</span>
      </div>

      {reviewTasks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-background/60 px-4 py-8 text-center text-xs text-muted-foreground">
          No tasks waiting for review.
        </div>
      ) : (
        <div className="space-y-3">
          {reviewTasks.map((task) => (
            <ReviewTaskCard
              key={task.id}
              task={task}
              sessionLabels={sessionLabels}
              onAcceptReview={onAcceptReview}
              onRequestRework={onRequestRework}
              onArchiveTask={onArchiveTask}
              onOpenSession={onOpenSession}
              isFocused={focusedTaskId === task.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ResultInboxSection({
  recentResults,
  sessionLabels,
  onArchiveTask,
  onOpenSession,
  focusedTaskId,
}: ResultInboxSectionProps) {
  return (
    <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Result Inbox</h2>
          <p className="text-xs text-muted-foreground">Accepted task results stay here until you inspect them and archive the finished outcome.</p>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{recentResults.length}</span>
      </div>

      {recentResults.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-background/60 px-4 py-8 text-center text-xs text-muted-foreground">
          No accepted task results yet.
        </div>
      ) : (
        <div className="space-y-3">
          {recentResults.map((task) => (
            <ResultItem
              key={task.id}
              task={task}
              sessionLabels={sessionLabels}
              onArchiveTask={onArchiveTask}
              onOpenSession={onOpenSession}
              isFocused={focusedTaskId === task.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function ReviewQueuePanel({
  reviewTasks,
  recentResults,
  sessionLabels,
  onAcceptReview,
  onRequestRework,
  onArchiveTask,
  onOpenSession,
}: ReviewQueuePanelProps) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
      <ReviewQueueSection
        reviewTasks={reviewTasks}
        sessionLabels={sessionLabels}
        onAcceptReview={onAcceptReview}
        onRequestRework={onRequestRework}
        onArchiveTask={onArchiveTask}
        onOpenSession={onOpenSession}
      />
      <ResultInboxSection
        recentResults={recentResults}
        sessionLabels={sessionLabels}
        onArchiveTask={onArchiveTask}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}
