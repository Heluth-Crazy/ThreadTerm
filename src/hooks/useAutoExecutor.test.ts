import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoExecutorSessionId, useAutoExecutor } from './useAutoExecutor';
import { useBackgroundRunStore } from '../stores/backgroundRunStore';
import { useTaskQueueStore } from '../stores/taskQueueStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import { useTaskStore } from '../stores/taskStore';
import { git, handoff, tasks, type Task } from '../lib/tauri-bridge';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Run task',
    description: 'echo hello',
    prompt: 'echo hello',
    status: 'queued',
    provider: 'claude',
    execution_strategy: 'current_project',
    project_path: '/tmp/project',
    created_at: '2026-04-19T10:00:00.000Z',
    updated_at: '2026-04-19T10:00:00.000Z',
    deps: [],
    review_required: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  useTaskQueueStore.setState({
    queueOrder: [],
    autoExecute: false,
    maxConcurrent: 3,
  });
  useTaskStore.setState({
    tasksByProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
  useSessionStatusStore.setState({ statuses: {} });
  useBackgroundRunStore.setState({ runs: {} });

  vi.restoreAllMocks();
  vi.spyOn(tasks, 'update').mockImplementation(async (projectPath, id, updates) => {
    const current = useTaskStore.getState().getTaskById(projectPath, id) ?? makeTask({ id, project_path: projectPath });
    const updated = {
      ...current,
      ...updates,
      updated_at: '2026-04-19T10:05:00.000Z',
    } as Task;

    useTaskStore.setState((state) => ({
      tasksByProject: {
        ...state.tasksByProject,
        [projectPath]: (state.tasksByProject[projectPath] ?? []).map((task) => (task.id === id ? updated : task)),
      },
    }));

    return updated;
  });
  vi.spyOn(git, 'status').mockResolvedValue({
    branch: 'main',
    staged: [],
    unstaged: [],
    untracked: [],
    ahead: 0,
    behind: 0,
  });
  vi.spyOn(handoff, 'session').mockResolvedValue({
    newPtyId: 'handoff-target-session',
    handoffPrompt: '# Task Handoff',
  });
});

describe('useAutoExecutor', () => {
  it('creates provider-scoped session ids for queue-dispatched runs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const sessionId = createAutoExecutorSessionId('codex');
    expect(sessionId).toMatch(/^codex-1234-[a-z0-9]{6}$/);
  });

  it('dispatches the next queued durable task and binds session state', async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask()],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    const updatedTask = useTaskStore.getState().getTaskById('/tmp/project', 'task-1');
    expect(updatedTask).toMatchObject({
      status: 'in_progress',
    });
    expect(updatedTask?.session_id).toMatch(/^claude-\d+-[a-z0-9]{6}$/);
    expect(useSessionStatusStore.getState().getStatus(updatedTask?.session_id ?? '')).toMatchObject({
      taskId: 'task-1',
      taskStatus: 'in_progress',
      taskExecutionStrategy: 'current_project',
      projectPath: '/tmp/project',
    });
    expect(useBackgroundRunStore.getState().getActiveRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        status: 'running',
        sessionId: updatedTask?.session_id,
        processRef: updatedTask?.session_id,
      }),
    ]);
  });

  it('projects permission attention back into durable task and background run state', async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const task = makeTask({ id: 'task-review', review_required: true });
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [task],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    const sessionId = useTaskStore.getState().getTaskById('/tmp/project', 'task-review')?.session_id;
    expect(sessionId).toBeTruthy();

    act(() => {
      useSessionStatusStore.getState().setNeedsAttention(sessionId!, 'permission');
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-review')).toMatchObject({
        status: 'pending_approval',
        review_required: true,
        result_summary: 'Waiting for approval',
      });
    });
    expect(useBackgroundRunStore.getState().getActiveRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-review',
        status: 'needs_attention',
        attentionReason: 'approval',
        requiresApproval: true,
      }),
    ]);

    act(() => {
      useSessionStatusStore.getState().setProcessing(sessionId!);
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-review')).toMatchObject({
        status: 'in_progress',
        review_required: true,
        result_summary: '',
      });
    });
    expect(useBackgroundRunStore.getState().getActiveRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-review',
        status: 'running',
        attentionReason: undefined,
        requiresApproval: false,
      }),
    ]);
  });

  it('routes successful durable task completion into pending review when review is required', async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask({ id: 'task-success', review_required: true })],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    const sessionId = useTaskStore.getState().getTaskById('/tmp/project', 'task-success')?.session_id;
    expect(sessionId).toBeTruthy();

    act(() => {
      useSessionStatusStore.getState().setProcessing(sessionId!);
      useSessionStatusStore.getState().setCompleted(sessionId!);
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-success')).toMatchObject({
        status: 'pending_review',
        review_required: true,
        result_summary: 'Completed',
        result_risk_summary: 'Review required before accepting this task result.',
        result_suggested_next_step: 'Open Review Queue to inspect the changed files and accept or request rework.',
      });
    });
    expect(useBackgroundRunStore.getState().getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-success',
        status: 'completed',
        summary: 'Completed',
      }),
    ]);
  });

  it('marks durable tasks as failed when runtime startup reports an asynchronous error', async () => {
    const sendMessage = vi.fn().mockImplementation((message: any) => {
      message.options?.onRuntimeStartError?.(new Error('Codex startup failed'));
      return true;
    });
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask({ id: 'task-startup-failure', provider: 'codex' })],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-startup-failure')).toMatchObject({
        status: 'failed',
        review_required: false,
        result_summary: 'Codex startup failed',
      });
    });

    const failedTask = useTaskStore.getState().getTaskById('/tmp/project', 'task-startup-failure');
    expect(failedTask?.session_id).toMatch(/^codex-\d+-[a-z0-9]{6}$/);
    expect(useBackgroundRunStore.getState().getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-startup-failure',
        status: 'failed',
        lastOutputExcerpt: 'Codex startup failed',
      }),
    ]);
    expect(useSessionStatusStore.getState().getStatus(failedTask?.session_id ?? '')).toMatchObject({
      taskId: 'task-startup-failure',
      taskStatus: 'failed',
    });
  });

  it('fails handoff tasks that are missing a source session id instead of falling back to direct dispatch', async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    const handoffSpy = vi.mocked(handoff.session);
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask({
          id: 'task-missing-handoff-source',
          provider: 'codex',
          execution_strategy: 'handoff',
          session_id: '',
          source_session_id: '',
        })],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-missing-handoff-source')).toMatchObject({
        status: 'failed',
        review_required: false,
        result_summary: 'Handoff task is missing a source session id',
      });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(handoffSpy).not.toHaveBeenCalled();
    expect(useBackgroundRunStore.getState().getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-missing-handoff-source',
        status: 'failed',
        lastOutputExcerpt: 'Handoff task is missing a source session id',
      }),
    ]);
  });

  it('fails unsupported providers instead of silently dispatching them down the claude path', async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask({
          id: 'task-unsupported-provider',
          provider: 'cursor',
        })],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-unsupported-provider')).toMatchObject({
        status: 'failed',
        review_required: false,
        result_summary: 'Unsupported durable dispatch provider: cursor',
      });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useBackgroundRunStore.getState().getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-unsupported-provider',
        status: 'failed',
        lastOutputExcerpt: 'Unsupported durable dispatch provider: cursor',
      }),
    ]);
  });

  it('dispatches handoff tasks against their selected worktree target and keeps background-run metadata aligned', async () => {
    const sendMessage = vi.fn().mockReturnValue(true);
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask({
          id: 'task-handoff-worktree',
          provider: 'codex',
          execution_strategy: 'handoff',
          worktree_path: '/tmp/project-worktrees/review-a',
          source_session_id: 'source-session-1',
        })],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(vi.mocked(handoff.session)).toHaveBeenCalledWith({
        sourcePtyId: 'source-session-1',
        targetProvider: 'codex',
        projectPath: '/tmp/project-worktrees/review-a',
        taskDescription: 'echo hello',
      });
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-handoff-worktree')).toMatchObject({
        status: 'in_progress',
        session_id: 'handoff-target-session',
        source_session_id: 'source-session-1',
        worktree_path: '/tmp/project-worktrees/review-a',
      });
    });

    expect(useBackgroundRunStore.getState().getActiveRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-handoff-worktree',
        status: 'running',
        sessionId: 'handoff-target-session',
        sourceSessionId: 'source-session-1',
        processRef: 'handoff-target-session',
        projectId: '/tmp/project-worktrees/review-a',
        executionStrategy: 'handoff',
        worktreePath: '/tmp/project-worktrees/review-a',
        lastOutputExcerpt: 'Handoff launched in the target runtime session for the review-a worktree.',
      }),
    ]);
  });

  it('does not revive a handoff task that was cancelled while the target runtime was still starting', async () => {
    let resolveHandoff: ((value: { newPtyId: string; handoffPrompt: string }) => void) | undefined;
    vi.mocked(handoff.session).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHandoff = resolve;
        }),
    );
    const sendMessage = vi.fn().mockReturnValue(true);
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask({
          id: 'task-cancelled-handoff',
          provider: 'codex',
          execution_strategy: 'handoff',
          source_session_id: 'source-session-1',
        })],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(vi.mocked(handoff.session)).toHaveBeenCalledWith({
        sourcePtyId: 'source-session-1',
        targetProvider: 'codex',
        projectPath: '/tmp/project',
        taskDescription: 'echo hello',
      });
    });

    await act(async () => {
      await useTaskStore.getState().updateTask('/tmp/project', 'task-cancelled-handoff', {
        status: 'cancelled',
        session_id: '',
        source_session_id: 'source-session-1',
        review_required: false,
        result_summary: 'Cancelled before handoff started',
      });
    });

    act(() => {
      resolveHandoff?.({
        newPtyId: 'handoff-target-session',
        handoffPrompt: '# Task Handoff',
      });
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-cancelled-handoff')).toMatchObject({
        status: 'cancelled',
        session_id: '',
        source_session_id: 'source-session-1',
        review_required: false,
        result_summary: 'Cancelled before handoff started',
      });
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'abort-session',
      sessionId: 'handoff-target-session',
      provider: 'codex',
    });
    expect(useBackgroundRunStore.getState().getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-cancelled-handoff',
        status: 'cancelled',
        sessionId: 'handoff-target-session',
        processRef: 'handoff-target-session',
        summary: 'Cancelled before handoff started',
      }),
    ]);
  });

  it('routes successful durable task completion into done when review is not required', async () => {
    vi.mocked(git.status).mockResolvedValueOnce({
      branch: 'main',
      staged: [],
      unstaged: [{ path: 'src/components/overview/MissionControlView.tsx', status: 'M' }],
      untracked: [],
      ahead: 0,
      behind: 0,
    });
    const sendMessage = vi.fn().mockReturnValue(true);
    useTaskStore.setState({
      tasksByProject: {
        '/tmp/project': [makeTask({ id: 'task-done', review_required: false })],
      },
    });

    const { result } = renderHook(() => useAutoExecutor(sendMessage));

    act(() => {
      result.current.triggerNext();
    });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    const sessionId = useTaskStore.getState().getTaskById('/tmp/project', 'task-done')?.session_id;
    expect(sessionId).toBeTruthy();

    act(() => {
      useSessionStatusStore.getState().setProcessing(sessionId!);
      useSessionStatusStore.getState().setCompleted(sessionId!);
    });

    await waitFor(() => {
      expect(useTaskStore.getState().getTaskById('/tmp/project', 'task-done')).toMatchObject({
        status: 'done',
        review_required: false,
        result_summary: 'Completed',
        result_changed_files: ['src/components/overview/MissionControlView.tsx'],
        result_risk_summary: 'Unreviewed repository changes were detected for this completed task.',
        result_suggested_next_step: 'Open Result Inbox to inspect the changed files, then archive when satisfied.',
      });
    });
    expect(useBackgroundRunStore.getState().getRecentCompletedRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-done',
        status: 'completed',
        summary: 'Completed',
      }),
    ]);
  });
});
