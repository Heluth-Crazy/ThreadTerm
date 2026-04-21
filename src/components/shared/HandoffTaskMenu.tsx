import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskRole } from '../../lib/tauri-bridge';
import {
  DURABLE_DISPATCH_PROVIDERS,
  buildDispatchPlanPreview,
  buildProjectSessionLookup,
  buildWorktreeOptions,
  getDefaultDurableDispatchProvider,
  queueDurableTaskDispatch,
} from '../../lib/task-dispatch-config';
import { formatProviderLabel, normalizePath } from '../../lib/task-dispatch';
import { useTaskStore } from '../../stores/taskStore';
import { useToastStore } from '../../stores/toastStore';
import type { Project } from '../../types/app';

const HANDOFF_ROLES: TaskRole[] = ['implement', 'review', 'verify', 'research'];

function buildQueuedHandoffTitle(sessionTitle: string, targetProvider: string, taskDescription: string) {
  const trimmedDescription = taskDescription.trim();
  const fallbackTitle = `Handoff ${sessionTitle || 'session'} to ${formatProviderLabel(targetProvider)}`;
  const baseTitle = trimmedDescription || fallbackTitle;
  return baseTitle.length > 60 ? `${baseTitle.slice(0, 60)}...` : baseTitle;
}

function buildQueuedHandoffPrompt(sessionTitle: string, targetProvider: string, taskDescription: string) {
  const trimmedDescription = taskDescription.trim();
  if (trimmedDescription) {
    return trimmedDescription;
  }

  return `Continue the current ${sessionTitle || 'session'} in ${formatProviderLabel(targetProvider)}.`;
}

interface HandoffTaskMenuProps {
  currentProvider: string;
  sessionId: string;
  sessionTitle: string;
  projectPath: string;
  worktreePath?: string;
  selectedProject?: Project;
  availableProjects?: Project[];
  onQueuedTask?: (projectPath: string) => void;
  buttonTitle?: string;
  buttonClassName?: string;
}

export default function HandoffTaskMenu({
  currentProvider,
  sessionId,
  sessionTitle,
  projectPath,
  worktreePath,
  selectedProject,
  availableProjects = [],
  onQueuedTask,
  buttonTitle,
  buttonClassName = 'rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground',
}: HandoffTaskMenuProps) {
  const { t } = useTranslation('common');
  const [taskDesc, setTaskDesc] = useState('');
  const [targetProvider, setTargetProvider] = useState<string>('');
  const [role, setRole] = useState<TaskRole>('implement');
  const [selectedWorktreePath, setSelectedWorktreePath] = useState(normalizePath(worktreePath) || '');
  const [newWorktreeName, setNewWorktreeName] = useState('');
  const [reviewRequired, setReviewRequired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const targets = DURABLE_DISPATCH_PROVIDERS.filter((provider) => provider !== currentProvider);
  const worktreeOptions = useMemo(
    () => buildWorktreeOptions(selectedProject, availableProjects, worktreePath),
    [availableProjects, selectedProject, worktreePath],
  );
  const sessionLookup = useMemo(
    () => buildProjectSessionLookup(availableProjects),
    [availableProjects],
  );
  const sourceSessionLabel = sessionLookup.get(sessionId)?.summaryContext ?? { sessionId, title: sessionTitle };
  const shouldCreateNewWorktree = selectedWorktreePath === '__create__';
  const selectedWorktreeOption = useMemo(
    () => worktreeOptions.find((option) => option.path === selectedWorktreePath),
    [selectedWorktreePath, worktreeOptions],
  );
  const dispatchPlanPreview = useMemo(
    () =>
      buildDispatchPlanPreview({
        provider: getDefaultDurableDispatchProvider(targetProvider || currentProvider),
        role,
        reviewRequired,
        executionStrategy: 'handoff',
        shouldCreateNewWorktree,
        newWorktreeName,
        selectedWorktreePath,
        sourceSessionLabel,
        selectedWorktreeLabel: selectedWorktreeOption?.label,
      }),
    [
      currentProvider,
      newWorktreeName,
      reviewRequired,
      role,
      selectedWorktreePath,
      selectedWorktreeOption?.label,
      sourceSessionLabel,
      shouldCreateNewWorktree,
      targetProvider,
    ],
  );
  const createTask = useTaskStore((s) => s.createTask);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    if (targets.length === 0) {
      setTargetProvider('');
      return;
    }

    setTargetProvider((current) => (current && targets.includes(current as typeof targets[number]) ? current : targets[0]));
  }, [targets]);

  const resetForm = () => {
    setTaskDesc('');
    setRole('implement');
    setSelectedWorktreePath(normalizePath(worktreePath) || '');
    setNewWorktreeName('');
    setReviewRequired(false);
    setError(null);
  };

  const handleHandoff = async () => {
    if (!targetProvider || loading) return;
    setLoading(true);
    setError(null);
    const prompt = buildQueuedHandoffPrompt(sessionTitle, targetProvider, taskDesc);
    const title = buildQueuedHandoffTitle(sessionTitle, targetProvider, taskDesc);

    try {
      await queueDurableTaskDispatch({
        projectPath,
        title,
        description: prompt,
        prompt,
        provider: targetProvider,
        role,
        reviewRequired,
        executionStrategy: 'handoff',
        selectedWorktreePath,
        shouldCreateNewWorktree,
        newWorktreeName,
        sourceSessionId: sessionId,
        status: 'queued',
        createTask,
      });
      addToast(`Queued handoff task to ${targetProvider}.`, 'success', 3000);
      resetForm();
      setIsOpen(false);
      onQueuedTask?.(projectPath);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((current) => !current);
        }}
        className={buttonClassName}
        title={buttonTitle ?? t('handoffMenu.queueHandoff', 'Queue handoff task')}
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
      {isOpen ? (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-2 shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2">
            <p className="text-[11px] font-medium text-foreground">{t('handoffMenu.queueHandoff', 'Queue handoff task')}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {t('handoffMenu.handoffLabel', 'Keep this session as the source context, then pick the target provider, worktree, and review path for the follow-up.')}
            </p>
          </div>

          <textarea
            className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('handoffMenu.taskContextPlaceholder', 'Task context for the queued handoff (optional)')}
            rows={2}
            value={taskDesc}
            onChange={(event) => setTaskDesc(event.target.value)}
          />

          <div className="mb-2 grid grid-cols-2 gap-2">
            <select
              aria-label="Handoff target provider"
              className="h-7 rounded border border-border bg-background px-2 text-[11px] text-foreground"
              value={targetProvider}
              onChange={(event) => setTargetProvider(event.target.value)}
            >
              {targets.map((provider) => (
                <option key={provider} value={provider}>
                  {formatProviderLabel(provider)}
                </option>
              ))}
            </select>
            <select
              aria-label="Handoff role"
              className="h-7 rounded border border-border bg-background px-2 text-[11px] text-foreground"
              value={role}
              onChange={(event) => setRole(event.target.value as TaskRole)}
            >
              {HANDOFF_ROLES.map((value) => (
                <option key={value} value={value}>
                  {formatProviderLabel(value)}
                </option>
              ))}
            </select>
          </div>

          <select
            aria-label="Handoff worktree target"
            className="mb-2 h-7 w-full rounded border border-border bg-background px-2 text-[11px] text-foreground"
            value={selectedWorktreePath}
            onChange={(event) => {
              setSelectedWorktreePath(event.target.value);
              if (event.target.value !== '__create__') {
                setNewWorktreeName('');
              }
              setError(null);
            }}
          >
            <option value="">
              {worktreeOptions.length > 0
                ? t('handoffMenu.optionalWorktree', 'Optional handoff target worktree…')
                : t('handoffMenu.defaultWorktree', 'Handoff stays in this project by default')}
            </option>
            {worktreeOptions.map((option) => (
              <option key={option.path} value={option.path}>
                {option.label}
              </option>
            ))}
            <option value="__create__">Create new worktree…</option>
          </select>

          {shouldCreateNewWorktree ? (
            <input
              aria-label="Handoff new worktree name"
              className="mb-2 h-7 w-full rounded border border-border bg-background px-2 text-[11px] text-foreground"
              value={newWorktreeName}
              onChange={(event) => {
                setNewWorktreeName(event.target.value);
                setError(null);
              }}
              placeholder={t('handoffMenu.newWorktreePlaceholder', 'Optional new worktree name…')}
            />
          ) : null}

          <div className="mb-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[10px] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-foreground">Dispatch plan</span>
              <span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-medium text-foreground">
                {dispatchPlanPreview.completionLabel}
              </span>
            </div>
            <p className="mt-1 text-muted-foreground">{dispatchPlanPreview.summary}</p>
            <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
              {dispatchPlanPreview.details.map((detail) => (
                <p key={detail}>{detail}</p>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">{dispatchPlanPreview.completionSummary}</p>
          </div>

          <label className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              aria-label="Handoff review required"
              type="checkbox"
              checked={reviewRequired}
              onChange={(event) => setReviewRequired(event.target.checked)}
            />
            Review required
          </label>

          <button
            type="button"
            disabled={loading || !targetProvider}
            onClick={() => void handleHandoff()}
            className="flex w-full items-center justify-center gap-2 rounded bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <ArrowUpRight className="h-3 w-3" />
            Queue handoff
          </button>

          {error ? <p className="mt-1 text-[10px] text-red-500">{error}</p> : null}
          <button
            type="button"
            onClick={() => {
              resetForm();
              setIsOpen(false);
            }}
            className="mt-1 w-full text-center text-[10px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
