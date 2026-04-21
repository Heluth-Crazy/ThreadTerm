import React, { useMemo, useState, useCallback } from 'react';
import { Button } from '../ui/button';
import { useTaskStore } from '../../stores/taskStore';
import type { TaskExecutionStrategy, TaskProvider, TaskRole } from '../../lib/tauri-bridge';
import {
  DURABLE_DISPATCH_PROVIDERS,
  buildDispatchPlanPreview,
  buildSessionOptions,
  buildWorktreeOptions,
  getDefaultDurableDispatchProvider,
  getWorktreePlaceholderLabel,
  queueDurableTaskDispatch,
} from '../../lib/task-dispatch-config';
import type { Project } from '../../types/app';

interface TaskQuickAddProps {
  projectPath: string;
  defaultProvider?: TaskProvider;
  onAdded?: () => void;
  selectedProject?: Project;
  availableProjects?: Project[];
}

export function TaskQuickAdd({
  projectPath,
  defaultProvider = 'claude',
  onAdded,
  selectedProject,
  availableProjects = [],
}: TaskQuickAddProps) {
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<TaskProvider>(() => getDefaultDurableDispatchProvider(defaultProvider));
  const [role, setRole] = useState<TaskRole>('implement');
  const [executionStrategy, setExecutionStrategy] = useState<TaskExecutionStrategy | 'auto'>('auto');
  const [worktreePath, setWorktreePath] = useState('');
  const [newWorktreeName, setNewWorktreeName] = useState('');
  const [sourceSessionId, setSourceSessionId] = useState('');
  const [reviewRequired, setReviewRequired] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const createTask = useTaskStore((s) => s.createTask);
  const worktreeOptions = useMemo(() => buildWorktreeOptions(selectedProject, availableProjects), [availableProjects, selectedProject]);
  const sessionOptions = useMemo(() => buildSessionOptions(selectedProject, availableProjects), [availableProjects, selectedProject]);
  const shouldCreateNewWorktree = worktreePath === '__create__';
  const selectedWorktreeOption = useMemo(
    () => worktreeOptions.find((option) => option.path === worktreePath),
    [worktreeOptions, worktreePath],
  );
  const selectedSessionOption = useMemo(
    () => sessionOptions.find((option) => option.id === sourceSessionId),
    [sessionOptions, sourceSessionId],
  );
  const dispatchPlanPreview = useMemo(
    () =>
      buildDispatchPlanPreview({
        provider,
        role,
        reviewRequired,
        executionStrategy,
        shouldCreateNewWorktree,
        newWorktreeName,
        selectedWorktreePath: worktreePath,
        sourceSessionLabel: selectedSessionOption?.label,
        selectedWorktreeLabel: selectedWorktreeOption?.label,
      }),
    [
      executionStrategy,
      newWorktreeName,
      provider,
      reviewRequired,
      role,
      selectedSessionOption?.label,
      selectedWorktreeOption?.label,
      shouldCreateNewWorktree,
    ],
  );

  const handleAdd = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isSubmitting) return;

    const title = trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await queueDurableTaskDispatch({
        projectPath,
        title,
        description: trimmed,
        provider,
        role,
        reviewRequired,
        executionStrategy,
        selectedWorktreePath: worktreePath,
        shouldCreateNewWorktree,
        newWorktreeName,
        sourceSessionId,
        status: 'queued',
        createTask,
      });
      setPrompt('');
      setRole('implement');
      setExecutionStrategy('auto');
      setWorktreePath('');
      setNewWorktreeName('');
      setSourceSessionId('');
      setReviewRequired(false);
      setProvider(getDefaultDurableDispatchProvider(defaultProvider));
      setErrorMessage(null);
      onAdded?.();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to prepare task dispatch.');
    } finally {
      setIsSubmitting(false);
    }
  }, [createTask, executionStrategy, isSubmitting, newWorktreeName, onAdded, projectPath, prompt, provider, reviewRequired, role, shouldCreateNewWorktree, sourceSessionId, worktreePath]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleAdd();
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-2">
      <textarea
        className="w-full h-16 px-2 py-1.5 text-xs rounded-md border border-input bg-background resize-none"
        placeholder="Add a task prompt..."
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setErrorMessage(null);
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between gap-2">
        <select
          aria-label="Task provider"
          className="h-7 px-2 text-xs rounded-md border border-input bg-background"
          value={provider}
          onChange={(e) => setProvider(e.target.value as TaskProvider)}
        >
          {DURABLE_DISPATCH_PROVIDERS.map((providerOption) => (
            <option key={providerOption} value={providerOption}>
              {providerOption === 'claude' ? 'Claude' : 'Codex'}
            </option>
          ))}
        </select>
        <select
          aria-label="Task role"
          className="h-7 px-2 text-xs rounded-md border border-input bg-background"
          value={role}
          onChange={(e) => setRole(e.target.value as TaskRole)}
        >
          <option value="implement">Implement</option>
          <option value="review">Review</option>
          <option value="verify">Verify</option>
          <option value="research">Research</option>
        </select>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => void handleAdd()}
          disabled={!prompt.trim() || isSubmitting}
        >
          {isSubmitting ? 'Adding…' : 'Add to Queue'}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <select
          aria-label="Dispatch worktree"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          value={worktreePath}
          onChange={(e) => {
            setWorktreePath(e.target.value);
            if (e.target.value !== '__create__') {
              setNewWorktreeName('');
            }
            setErrorMessage(null);
          }}
        >
          <option value="">{getWorktreePlaceholderLabel(executionStrategy, worktreeOptions.length)}</option>
          {worktreeOptions.map((option) => (
            <option key={option.path} value={option.path}>{option.label}</option>
          ))}
          <option value="__create__">Create new worktree…</option>
        </select>
        <select
          aria-label="Task execution strategy"
          className="h-7 w-32 px-2 text-xs rounded-md border border-input bg-background"
          value={executionStrategy}
          onChange={(e) => {
            const nextStrategy = e.target.value as TaskExecutionStrategy | 'auto';
            setExecutionStrategy(nextStrategy);
            setErrorMessage(null);
            if (nextStrategy === 'current_project') {
              setWorktreePath('');
              setNewWorktreeName('');
              setSourceSessionId('');
            } else if (nextStrategy === 'worktree') {
              setSourceSessionId('');
            }
          }}
        >
          <option value="auto">Auto</option>
          <option value="current_project">This project</option>
          <option value="worktree">Worktree</option>
          <option value="handoff">Handoff</option>
        </select>
      </div>
      {shouldCreateNewWorktree ? (
        <input
          aria-label="New worktree name"
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          value={newWorktreeName}
          onChange={(e) => {
            setNewWorktreeName(e.target.value);
            setErrorMessage(null);
          }}
          placeholder="Optional new worktree name…"
        />
      ) : null}
      <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
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
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            aria-label="Review required"
            type="checkbox"
            checked={reviewRequired}
            onChange={(e) => setReviewRequired(e.target.checked)}
          />
          Review required
        </label>
        {executionStrategy === 'handoff' ? (
          <div className="min-w-0 flex-1">
            <select
              aria-label="Source session id"
              className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs"
              value={sourceSessionId}
              onChange={(e) => {
                setSourceSessionId(e.target.value);
                setErrorMessage(null);
              }}
            >
              <option value="">
                {sessionOptions.length > 0 ? 'Select source session…' : 'No sessions available'}
              </option>
              {sessionOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Handoff keeps the chosen source session as context and can optionally continue inside a selected worktree.
            </p>
          </div>
        ) : null}
      </div>
      {errorMessage ? (
        <p className="text-[11px] text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
