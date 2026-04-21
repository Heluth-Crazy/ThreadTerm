import {
  git,
  isTauriEnv,
  type CreateTaskInput,
  type TaskExecutionStrategy,
  type TaskProvider,
  type TaskRole,
  type TaskStatus,
} from './tauri-bridge';
import type { Project, ProjectSession, SessionProvider } from '../types/app';
import { getTaskCompletionRouteSummary, getTaskCompletionSurfaceLabel } from './control-plane';
import {
  compactPathLabel,
  formatProviderLabel,
  formatPendingHandoffRuntimeLabel,
  formatWorktreeTargetLabel,
  formatTaskRoleLabel,
  formatTaskSessionSummary,
  normalizePath,
  type TaskSessionSummaryContext,
  type TaskSessionSummaryInput,
} from './task-dispatch';

export interface WorktreeOption {
  path: string;
  label: string;
}

export interface SessionOption {
  id: string;
  label: string;
}

export interface ProjectSessionLookupEntry {
  id: string;
  project: Project;
  provider: SessionProvider;
  session: ProjectSession;
  label: string;
  shortLabel: string;
  subtitle: string;
  summaryContext: TaskSessionSummaryContext;
}

export const DURABLE_DISPATCH_PROVIDERS = ['claude', 'codex'] as const;
export type DurableDispatchProvider = typeof DURABLE_DISPATCH_PROVIDERS[number];

export function isSupportedDurableDispatchProvider(
  provider?: string | null,
): provider is DurableDispatchProvider {
  return DURABLE_DISPATCH_PROVIDERS.includes(provider?.trim() as DurableDispatchProvider);
}

export function getDefaultDurableDispatchProvider(provider?: string | null): DurableDispatchProvider {
  return isSupportedDurableDispatchProvider(provider) ? provider : DURABLE_DISPATCH_PROVIDERS[0];
}

export function getSessionTimestamp(session: ProjectSession) {
  const timestamp = new Date(String(session.lastActivity || session.updated_at || session.createdAt || session.created_at || 0)).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatSessionName(session: ProjectSession) {
  return String(session.title || session.summary || session.name || session.id).trim();
}

export function getProjectFamilyKey(project?: Project) {
  if (!project) return null;
  const worktreeBaseRoot = normalizePath(project.worktreeBaseRoot);
  if (worktreeBaseRoot) return `worktree-base:${worktreeBaseRoot}`;
  const repoRoot = normalizePath(project.repoRoot);
  if (repoRoot) return `repo-root:${repoRoot}`;
  if (project.isGitWorktree && project.sourceProjectName) return `source-name:${project.sourceProjectName}`;
  return `project-path:${normalizePath(project.fullPath || project.path || project.name)}`;
}

export function getProjectFamilyProjects(selectedProject?: Project, availableProjects: Project[] = []) {
  if (!selectedProject) return [];
  const selectedFamilyKey = getProjectFamilyKey(selectedProject);
  if (!selectedFamilyKey) {
    return [selectedProject];
  }

  const familyProjects = availableProjects.filter((project) => getProjectFamilyKey(project) === selectedFamilyKey);
  return familyProjects.length > 0 ? familyProjects : [selectedProject];
}

export function buildWorktreeOptions(
  selectedProject?: Project,
  availableProjects: Project[] = [],
  fallbackWorktreePath?: string,
): WorktreeOption[] {
  const familyProjects = getProjectFamilyProjects(selectedProject, availableProjects);
  const options = familyProjects
    .filter((project) => project.isGitWorktree && normalizePath(project.fullPath || project.path))
    .map((project) => {
      const projectPath = normalizePath(project.fullPath || project.path);
      const projectLabel = project.displayName || project.name;
      const branchLabel = project.branch ? ` · ${project.branch}` : '';
      return {
        path: projectPath,
        label: `${projectLabel}${branchLabel} · ${compactPathLabel(projectPath) ?? projectPath}`,
      };
    });

  const normalizedFallbackWorktreePath = normalizePath(fallbackWorktreePath);
  if (normalizedFallbackWorktreePath && !options.some((option) => option.path === normalizedFallbackWorktreePath)) {
    options.unshift({
      path: normalizedFallbackWorktreePath,
      label: `Current worktree · ${compactPathLabel(normalizedFallbackWorktreePath) ?? normalizedFallbackWorktreePath}`,
    });
  }

  return options;
}

export function buildSessionOptions(selectedProject?: Project, availableProjects: Project[] = []): SessionOption[] {
  return getProjectFamilyProjects(selectedProject, availableProjects)
    .flatMap((project) => {
      const projectLabel = project.displayName || project.name;
      const claudeSessions = (project.sessions ?? []).map((session) => ({
        id: session.id,
        providerLabel: 'Claude',
        projectLabel,
        session,
      }));
      const codexSessions = (project.codexSessions ?? []).map((session) => ({
        id: session.id,
        providerLabel: 'Codex',
        projectLabel,
        session,
      }));
      return [...claudeSessions, ...codexSessions];
    })
    .sort((a, b) => getSessionTimestamp(b.session) - getSessionTimestamp(a.session))
    .map(({ id, providerLabel, projectLabel, session }) => ({
      id,
      label: `${projectLabel} · ${providerLabel} · ${formatSessionName(session) || id}`,
    }));
}

export function buildProjectSessionLookup(projects: Project[] = []) {
  const entries = projects
    .flatMap((project) => {
      const projectLabel = project.displayName || project.name;
      const claudeSessions = (project.sessions ?? []).map((session) => ({
        id: session.id,
        project,
        provider: 'claude' as const,
        session,
        subtitle: `${projectLabel} · ${formatProviderLabel('claude')}`,
      }));
      const codexSessions = (project.codexSessions ?? []).map((session) => ({
        id: session.id,
        project,
        provider: 'codex' as const,
        session,
        subtitle: `${projectLabel} · ${formatProviderLabel('codex')}`,
      }));

      return [...claudeSessions, ...codexSessions];
    })
    .sort((a, b) => getSessionTimestamp(b.session) - getSessionTimestamp(a.session))
    .map((entry) => {
      const sessionName = formatSessionName(entry.session);
      const summaryContext = {
        sessionId: entry.id,
        title: sessionName,
        subtitle: entry.subtitle,
      } satisfies TaskSessionSummaryContext;
      return {
        ...entry,
        shortLabel: `${formatProviderLabel(entry.provider)} · ${sessionName}`,
        label: `${entry.subtitle} · ${sessionName}`,
        summaryContext,
      } satisfies ProjectSessionLookupEntry;
    });

  return new Map(entries.map((entry) => [entry.id, entry]));
}

export function buildDefaultWorktreeName(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return slug || `wt-${Date.now().toString(36)}`;
}

export function resolveDispatchExecutionStrategy(
  executionStrategy: TaskExecutionStrategy | 'auto',
  shouldCreateNewWorktree: boolean,
  normalizedSelectedWorktreePath?: string,
): TaskExecutionStrategy {
  if (executionStrategy !== 'auto') {
    return executionStrategy;
  }

  return shouldCreateNewWorktree || normalizedSelectedWorktreePath
    ? 'worktree'
    : 'current_project';
}

interface PrepareDurableTaskDispatchInput {
  title: string;
  description: string;
  prompt?: string;
  provider: TaskProvider;
  role?: TaskRole;
  reviewRequired: boolean;
  executionStrategy: TaskExecutionStrategy | 'auto';
  selectedWorktreePath?: string;
  shouldCreateNewWorktree?: boolean;
  sourceSessionId?: string;
  status?: TaskStatus;
}

export interface PreparedDurableTaskDispatch {
  resolvedExecutionStrategy: TaskExecutionStrategy;
  normalizedSelectedWorktreePath?: string;
  normalizedSourceSessionId?: string;
  strategySupportsWorktreeTarget: boolean;
  buildCreateTaskInput: (resolvedWorktreePath?: string) => CreateTaskInput;
}

interface QueueDurableTaskDispatchInput extends PrepareDurableTaskDispatchInput {
  projectPath: string;
  newWorktreeName?: string;
  createTask: (projectPath: string, input: CreateTaskInput) => Promise<unknown>;
}

export function prepareDurableTaskDispatch({
  title,
  description,
  prompt,
  provider,
  role,
  reviewRequired,
  executionStrategy,
  selectedWorktreePath,
  shouldCreateNewWorktree = false,
  sourceSessionId,
  status = 'queued',
}: PrepareDurableTaskDispatchInput): PreparedDurableTaskDispatch {
  if (!isSupportedDurableDispatchProvider(provider)) {
    throw new Error('Task Queue dispatch currently supports Claude and Codex only.');
  }

  const normalizedSelectedWorktreePath = shouldCreateNewWorktree
    ? undefined
    : normalizePath(selectedWorktreePath) || undefined;
  const normalizedSourceSessionId = sourceSessionId?.trim() || undefined;
  const resolvedExecutionStrategy = resolveDispatchExecutionStrategy(
    executionStrategy,
    shouldCreateNewWorktree,
    normalizedSelectedWorktreePath,
  );
  const strategySupportsWorktreeTarget =
    resolvedExecutionStrategy === 'worktree' || resolvedExecutionStrategy === 'handoff';

  if (resolvedExecutionStrategy === 'worktree' && !shouldCreateNewWorktree && !normalizedSelectedWorktreePath) {
    throw new Error('Worktree strategy needs a worktree path.');
  }

  if (resolvedExecutionStrategy === 'handoff' && !normalizedSourceSessionId) {
    throw new Error('Handoff strategy needs a source session id.');
  }

  return {
    resolvedExecutionStrategy,
    normalizedSelectedWorktreePath,
    normalizedSourceSessionId,
    strategySupportsWorktreeTarget,
    buildCreateTaskInput: (resolvedWorktreePath) => ({
      title,
      description,
      prompt: prompt ?? description,
      provider: getDefaultDurableDispatchProvider(provider),
      role,
      execution_strategy: resolvedExecutionStrategy,
      worktree_path: strategySupportsWorktreeTarget
        ? resolvedWorktreePath ?? normalizedSelectedWorktreePath
        : undefined,
      session_id: undefined,
      source_session_id: resolvedExecutionStrategy === 'handoff' ? normalizedSourceSessionId : undefined,
      review_required: reviewRequired,
      status,
    }),
  };
}

export async function queueDurableTaskDispatch({
  projectPath,
  newWorktreeName = '',
  createTask,
  ...dispatchInput
}: QueueDurableTaskDispatchInput) {
  const preparedDispatch = prepareDurableTaskDispatch(dispatchInput);
  let createdWorktreePath: string | undefined;
  let taskPersisted = false;

  try {
    if (preparedDispatch.strategySupportsWorktreeTarget && dispatchInput.shouldCreateNewWorktree) {
      createdWorktreePath = await createInlineDispatchWorktree(projectPath, newWorktreeName, dispatchInput.title);
    }

    const createdTask = await createTask(projectPath, preparedDispatch.buildCreateTaskInput(createdWorktreePath));
    taskPersisted = true;
    return createdTask;
  } catch (error) {
    if (createdWorktreePath && !taskPersisted) {
      await cleanupInlineDispatchWorktree(projectPath, createdWorktreePath);
    }
    throw error;
  }
}

export function getWorktreePlaceholderLabel(strategy: TaskExecutionStrategy | 'auto', worktreeCount: number) {
  if (strategy === 'handoff') {
    return worktreeCount > 0 ? 'Optional handoff target worktree…' : 'Handoff stays in this project by default';
  }
  if (strategy === 'worktree') {
    return worktreeCount > 0 ? 'Select worktree…' : 'No worktrees available';
  }
  return worktreeCount > 0 ? 'Optional worktree override…' : 'Stay in this project';
}

function buildPreviewDispatchTargetDescriptor({
  selectedWorktreePath,
  shouldCreateNewWorktree,
  newWorktreeName,
  selectedWorktreeLabel,
}: {
  selectedWorktreePath?: string;
  shouldCreateNewWorktree: boolean;
  newWorktreeName: string;
  selectedWorktreeLabel?: string;
}) {
  const normalizedSelectedWorktreePath = normalizePath(selectedWorktreePath);
  const trimmedNewWorktreeName = newWorktreeName.trim();

  if (shouldCreateNewWorktree) {
    return {
      summaryLabel: trimmedNewWorktreeName ? `${trimmedNewWorktreeName} worktree` : 'New worktree',
      phrase: trimmedNewWorktreeName ? `the ${trimmedNewWorktreeName} worktree` : 'a new worktree',
      details: [
        `Dispatch target · ${trimmedNewWorktreeName ? `${trimmedNewWorktreeName} worktree` : 'New worktree'}`,
        trimmedNewWorktreeName
          ? `Worktree plan · Create ${trimmedNewWorktreeName}`
          : 'Worktree plan · Create a new worktree',
      ],
    };
  }

  const selectedWorktreeTargetLabel = formatWorktreeTargetLabel(normalizedSelectedWorktreePath);
  if (selectedWorktreeTargetLabel) {
    return {
      summaryLabel: selectedWorktreeTargetLabel,
      phrase: `the ${selectedWorktreeTargetLabel}`,
      details: [
        `Dispatch target · ${selectedWorktreeTargetLabel}`,
        selectedWorktreeLabel
          ? `Worktree selection · ${selectedWorktreeLabel}`
          : `Worktree path · ${normalizedSelectedWorktreePath}`,
      ],
    };
  }

  return {
    summaryLabel: 'This project',
    phrase: 'this project',
    details: ['Dispatch target · This project'],
  };
}

export function buildDispatchPlanSummary({
  executionStrategy,
  shouldCreateNewWorktree,
  newWorktreeName,
  selectedWorktreePath,
  sourceSessionLabel,
  selectedWorktreeLabel,
}: {
  executionStrategy: TaskExecutionStrategy | 'auto';
  shouldCreateNewWorktree: boolean;
  newWorktreeName: string;
  selectedWorktreePath?: string;
  sourceSessionLabel?: TaskSessionSummaryInput;
  selectedWorktreeLabel?: string;
}) {
  const formattedSourceSessionLabel = formatTaskSessionSummary(sourceSessionLabel);
  const dispatchTarget = buildPreviewDispatchTargetDescriptor({
    selectedWorktreePath,
    shouldCreateNewWorktree,
    newWorktreeName,
    selectedWorktreeLabel,
  });

  if (executionStrategy === 'handoff') {
    return formattedSourceSessionLabel
      ? `Handoff from ${formattedSourceSessionLabel} into ${dispatchTarget.phrase}.`
      : `Handoff requires a source session, then it will continue in ${dispatchTarget.phrase}.`;
  }

  if (executionStrategy === 'worktree') {
    return `Dispatch directly into ${dispatchTarget.phrase}.`;
  }

  if (executionStrategy === 'current_project') {
    return 'Dispatch directly in this project without using a worktree or handoff.';
  }

  return selectedWorktreePath || shouldCreateNewWorktree
    ? `Auto will dispatch into ${dispatchTarget.phrase}.`
    : 'Auto will dispatch in this project unless you pick a worktree override.';
}

function buildDispatchPlanDetails({
  executionStrategy,
  shouldCreateNewWorktree,
  newWorktreeName,
  selectedWorktreePath,
  sourceSessionLabel,
  selectedWorktreeLabel,
}: {
  executionStrategy: TaskExecutionStrategy | 'auto';
  shouldCreateNewWorktree: boolean;
  newWorktreeName: string;
  selectedWorktreePath?: string;
  sourceSessionLabel?: TaskSessionSummaryInput;
  selectedWorktreeLabel?: string;
}) {
  const formattedSourceSessionLabel = formatTaskSessionSummary(sourceSessionLabel);
  const dispatchTarget = buildPreviewDispatchTargetDescriptor({
    selectedWorktreePath,
    shouldCreateNewWorktree,
    newWorktreeName,
    selectedWorktreeLabel,
  });
  const details = [...dispatchTarget.details];

  if (executionStrategy === 'handoff') {
    details.unshift(
      formattedSourceSessionLabel
        ? `Source session · ${formattedSourceSessionLabel}`
        : 'Source session · Select a source session before dispatch can start',
    );
    details.splice(1, 0, `Runtime session · ${formatPendingHandoffRuntimeLabel('queued')}`);
  }

  return details;
}

export interface DispatchPlanPreview {
  summary: string;
  completionLabel: string;
  completionSummary: string;
  details: string[];
}

export function buildDispatchPlanPreview({
  provider,
  role,
  reviewRequired,
  executionStrategy,
  shouldCreateNewWorktree,
  newWorktreeName,
  selectedWorktreePath,
  sourceSessionLabel,
  selectedWorktreeLabel,
}: {
  provider: string;
  role?: string;
  reviewRequired: boolean;
  executionStrategy: TaskExecutionStrategy | 'auto';
  shouldCreateNewWorktree: boolean;
  newWorktreeName: string;
  selectedWorktreePath?: string;
  sourceSessionLabel?: TaskSessionSummaryInput;
  selectedWorktreeLabel?: string;
}): DispatchPlanPreview {
  const providerLabel = formatProviderLabel(provider);
  const roleLabel = formatTaskRoleLabel(role);
  const formattedSourceSessionLabel = formatTaskSessionSummary(sourceSessionLabel);
  const dispatchTarget = buildPreviewDispatchTargetDescriptor({
    selectedWorktreePath,
    shouldCreateNewWorktree,
    newWorktreeName,
    selectedWorktreeLabel,
  });
  const baseSummary = buildDispatchPlanSummary({
    executionStrategy,
    shouldCreateNewWorktree,
    newWorktreeName,
    selectedWorktreePath,
    sourceSessionLabel,
    selectedWorktreeLabel,
  });

  const summary = executionStrategy === 'handoff'
    ? formattedSourceSessionLabel
      ? `Handoff from ${formattedSourceSessionLabel} to ${providerLabel} in ${dispatchTarget.phrase}.`
      : `Select a source session to hand off into ${providerLabel}. The follow-up will continue in ${dispatchTarget.phrase}.`
    : roleLabel
      ? `${providerLabel} ${roleLabel.toLowerCase()} task. ${baseSummary}`
      : `${providerLabel} task. ${baseSummary}`;

  return {
    summary,
    completionLabel: getTaskCompletionSurfaceLabel(reviewRequired),
    completionSummary: getTaskCompletionRouteSummary(reviewRequired),
    details: buildDispatchPlanDetails({
      executionStrategy,
      shouldCreateNewWorktree,
      newWorktreeName,
      selectedWorktreePath,
      sourceSessionLabel,
      selectedWorktreeLabel,
    }),
  };
}

export async function createInlineDispatchWorktree(projectPath: string, newWorktreeName: string, title: string) {
  if (!isTauriEnv()) {
    throw new Error('Creating a new worktree is only available in the desktop app.');
  }

  const createdWorktreePath = normalizePath(
    await git.worktreeAdd(projectPath, newWorktreeName.trim() || buildDefaultWorktreeName(title)),
  ) || undefined;

  if (!createdWorktreePath) {
    throw new Error('Failed to create worktree.');
  }

  return createdWorktreePath;
}

export async function cleanupInlineDispatchWorktree(projectPath: string, createdWorktreePath?: string) {
  if (!createdWorktreePath) return;
  await git.worktreeRemove(projectPath, createdWorktreePath, true).catch(() => undefined);
}
