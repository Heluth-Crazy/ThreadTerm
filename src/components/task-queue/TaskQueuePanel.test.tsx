import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../lib/tauri-bridge';
import { useTaskQueueStore } from '../../stores/taskQueueStore';
import { TaskQueuePanel } from './TaskQueuePanel';

const taskStoreState = vi.hoisted(() => ({
  tasksByProject: {} as Record<string, Task[]>,
  loadingByProject: {} as Record<string, boolean>,
  errorByProject: {} as Record<string, string | null>,
  refresh: vi.fn(async () => []),
  updateTask: vi.fn(async () => undefined),
  deleteTask: vi.fn(async () => undefined),
}));
const websocketState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));
const attentionState = vi.hoisted(() => ({
  approvalRequests: {} as Record<string, { sessionId: string; status: 'pending' | 'approved' | 'denied' | 'expired' }>,
}));
const backgroundRunState = vi.hoisted(() => ({
  runs: {} as Record<string, { id: string; taskId?: string }>,
}));

vi.mock('../../contexts/TauriEventContext', () => ({
  useWebSocket: () => ({
    sendMessage: websocketState.sendMessage,
  }),
}));

vi.mock('../../stores/taskStore', () => ({
  countRunningDurableTasks: (tasks: Task[]) => tasks.filter((task) => ['dispatched', 'in_progress', 'pending_approval'].includes(task.status)).length,
  useTaskStore: (selector: (state: typeof taskStoreState) => unknown) => selector(taskStoreState),
}));

vi.mock('../../stores/attentionStore', () => ({
  useAttentionStore: (selector: (state: typeof attentionState) => unknown) => selector(attentionState),
}));

vi.mock('../../stores/backgroundRunStore', () => ({
  useBackgroundRunStore: (selector: (state: typeof backgroundRunState) => unknown) => selector(backgroundRunState),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Retry handoff review',
    description: 'Retry handoff review',
    prompt: 'Retry handoff review',
    status: 'failed',
    provider: 'codex',
    execution_strategy: 'handoff',
    project_path: '/repo-a',
    created_at: '2026-04-20T08:00:00.000Z',
    updated_at: '2026-04-20T08:05:00.000Z',
    deps: [],
    review_required: true,
    source_session_id: 'source-session-1',
    result_summary: 'Previous handoff failed',
    ...overrides,
  };
}

describe('TaskQueuePanel', () => {
  beforeEach(() => {
    useTaskQueueStore.setState({ queueOrder: [], autoExecute: false, maxConcurrent: 3 });
    taskStoreState.tasksByProject = {};
    taskStoreState.loadingByProject = {};
    taskStoreState.errorByProject = {};
    attentionState.approvalRequests = {};
    backgroundRunState.runs = {};
    taskStoreState.refresh.mockClear();
    taskStoreState.updateTask.mockClear();
    taskStoreState.deleteTask.mockClear();
    websocketState.sendMessage.mockClear();
  });

  it('preserves the source session when retrying handoff tasks', async () => {
    taskStoreState.tasksByProject = {
      '/repo-a': [makeTask()],
    };

    render(<TaskQueuePanel projectPath="/repo-a" />);

    fireEvent.click(screen.getByTitle('Retry'));

    await waitFor(() => {
      expect(taskStoreState.updateTask).toHaveBeenCalledWith('/repo-a', 'task-1', {
        status: 'queued',
        session_id: '',
        source_session_id: 'source-session-1',
        result_summary: '',
        review_required: true,
      });
    });
  });

  it('clears the stale session binding when retrying non-handoff tasks', async () => {
    taskStoreState.tasksByProject = {
      '/repo-a': [makeTask({ execution_strategy: 'current_project', session_id: 'old-session' })],
    };

    render(<TaskQueuePanel projectPath="/repo-a" />);

    fireEvent.click(screen.getByTitle('Retry'));

    await waitFor(() => {
      expect(taskStoreState.updateTask).toHaveBeenCalledWith('/repo-a', 'task-1', {
        status: 'queued',
        session_id: '',
        source_session_id: '',
        result_summary: '',
        review_required: true,
      });
    });
  });

  it('archives queued tasks when removing them from the queue UI', async () => {
    taskStoreState.tasksByProject = {
      '/repo-a': [makeTask({ status: 'queued', title: 'Queued task' })],
    };

    render(<TaskQueuePanel projectPath="/repo-a" />);

    fireEvent.click(screen.getByTitle('Remove'));

    await waitFor(() => {
      expect(taskStoreState.updateTask).toHaveBeenCalledWith('/repo-a', 'task-1', {
        status: 'archived',
        result_summary: 'Previous handoff failed',
        review_required: false,
      });
    });
  });

  it('cancels handoff tasks before the target runtime exists without aborting the source session', async () => {
    taskStoreState.tasksByProject = {
      '/repo-a': [makeTask({ status: 'dispatched' })],
    };

    render(<TaskQueuePanel projectPath="/repo-a" />);

    fireEvent.click(screen.getByTitle('Cancel'));

    await waitFor(() => {
      expect(taskStoreState.updateTask).toHaveBeenCalledWith('/repo-a', 'task-1', {
        status: 'cancelled',
        session_id: '',
        source_session_id: 'source-session-1',
        result_summary: 'Cancelled before handoff started',
        review_required: false,
      });
    });
    expect(websocketState.sendMessage).not.toHaveBeenCalled();
  });

  it('hides archived durable tasks from the queue projection', () => {
    taskStoreState.tasksByProject = {
      '/repo-a': [
        makeTask({ id: 'task-visible', status: 'queued', title: 'Visible task' }),
        makeTask({ id: 'task-archived', status: 'archived', title: 'Archived task' }),
      ],
    };

    render(<TaskQueuePanel projectPath="/repo-a" />);

    expect(screen.getByText('Visible task')).toBeInTheDocument();
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument();
  });

  it('shows pending review tasks as a separate queue summary state', () => {
    taskStoreState.tasksByProject = {
      '/repo-a': [
        makeTask({ id: 'task-review', status: 'pending_review', title: 'Pending review task' }),
        makeTask({ id: 'task-queued', status: 'queued', title: 'Queued task' }),
      ],
    };

    render(<TaskQueuePanel projectPath="/repo-a" />);

    expect(screen.getByText(/\(0 running · 1 queued · 1 review\)/)).toBeInTheDocument();
  });

  it('clears done, failed, and cancelled terminal outcomes through the same completed action', async () => {
    taskStoreState.tasksByProject = {
      '/repo-a': [
        makeTask({ id: 'task-done', status: 'done', title: 'Done task', review_required: false }),
        makeTask({ id: 'task-failed', status: 'failed', title: 'Failed task' }),
        makeTask({ id: 'task-cancelled', status: 'cancelled', title: 'Cancelled task' }),
      ],
    };

    render(<TaskQueuePanel projectPath="/repo-a" />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));

    await waitFor(() => {
      expect(taskStoreState.updateTask).toHaveBeenCalledTimes(3);
    });

    expect(taskStoreState.updateTask).toHaveBeenCalledWith('/repo-a', 'task-done', {
      status: 'archived',
      result_summary: 'Previous handoff failed',
      review_required: false,
    });
    expect(taskStoreState.updateTask).toHaveBeenCalledWith('/repo-a', 'task-failed', {
      status: 'archived',
      result_summary: 'Previous handoff failed',
      review_required: false,
    });
    expect(taskStoreState.updateTask).toHaveBeenCalledWith('/repo-a', 'task-cancelled', {
      status: 'archived',
      result_summary: 'Previous handoff failed',
      review_required: false,
    });
  });

  it('routes review and result tasks into Mission Control instead of leaving routing implicit', () => {
    const onOpenMissionControlSurface = vi.fn();
    taskStoreState.tasksByProject = {
      '/repo-a': [
        makeTask({ id: 'task-review', status: 'pending_review', title: 'Review task' }),
        makeTask({
          id: 'task-result',
          status: 'done',
          title: 'Result task',
          review_required: false,
          execution_strategy: 'current_project',
          result_summary: 'Completed successfully',
          result_changed_files: ['src/components/task-queue/TaskQueuePanel.tsx'],
        }),
      ],
    };

    render(
      <TaskQueuePanel
        projectPath="/repo-a"
        onOpenMissionControlSurface={onOpenMissionControlSurface}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Review Queue' }));
    expect(onOpenMissionControlSurface).toHaveBeenCalledWith('review-queue', { taskId: 'task-review' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Result Inbox' }));
    expect(onOpenMissionControlSurface).toHaveBeenCalledWith('result-inbox', { taskId: 'task-result' });
  });

  it('uses readable session labels while keeping pre-runtime handoffs anchored to the queue main path', () => {
    const onOpenSessionById = vi.fn();
    taskStoreState.tasksByProject = {
      '/repo-a': [
        makeTask({
          id: 'task-runtime',
          status: 'in_progress',
          session_id: 'runtime-session-1',
        }),
        makeTask({
          id: 'task-source-only',
          status: 'queued',
          session_id: '',
          source_session_id: 'source-session-1',
        }),
      ],
    };

    render(
      <TaskQueuePanel
        projectPath="/repo-a"
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            path: '/repo-a',
            sessions: [
              { id: 'source-session-1', title: 'Source Session', __provider: 'claude' },
            ],
            codexSessions: [
              { id: 'runtime-session-1', title: 'Runtime Session', __provider: 'codex' },
            ],
          },
        ]}
        onOpenSessionById={onOpenSessionById}
      />,
    );

    expect(screen.getAllByText('Source session · Repo A · Claude · Source Session').length).toBeGreaterThan(0);
    expect(screen.getByText('Runtime session · Repo A · Codex · Runtime Session')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Handoff Session' }));
    expect(onOpenSessionById).toHaveBeenCalledWith('runtime-session-1');
    expect(screen.queryByRole('button', { name: 'Open Source Session' })).not.toBeInTheDocument();
  });

  it('treats pre-runtime handoff runs as a first-class queue surface', () => {
    const onOpenMissionControlSurface = vi.fn();
    taskStoreState.tasksByProject = {
      '/repo-a': [
        makeTask({
          id: 'task-background-run',
          status: 'dispatched',
          session_id: '',
          source_session_id: 'source-session-1',
        }),
      ],
    };
    backgroundRunState.runs = {
      'run-background': {
        id: 'run-background',
        taskId: 'task-background-run',
      },
    };

    render(
      <TaskQueuePanel
        projectPath="/repo-a"
        onOpenMissionControlSurface={onOpenMissionControlSurface}
      />,
    );

    expect(screen.getByText('Background Runs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Background Runs' }));
    expect(onOpenMissionControlSurface).toHaveBeenCalledWith('background-runs', { runId: 'run-background' });
  });

  it('keeps worktree runtime bootstrap on Background Runs until the actual runtime session appears', () => {
    const onOpenMissionControlSurface = vi.fn();
    const onOpenSessionById = vi.fn();
    taskStoreState.tasksByProject = {
      '/repo-a': [
        makeTask({
          id: 'task-worktree-starting',
          status: 'in_progress',
          execution_strategy: 'worktree',
          session_id: 'synthetic-runtime',
          source_session_id: '',
        }),
      ],
    };
    backgroundRunState.runs = {
      'run-worktree-starting': {
        id: 'run-worktree-starting',
        taskId: 'task-worktree-starting',
      },
    };

    const { rerender } = render(
      <TaskQueuePanel
        projectPath="/repo-a"
        onOpenMissionControlSurface={onOpenMissionControlSurface}
        onOpenSessionById={onOpenSessionById}
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            path: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
      />,
    );

    expect(screen.getByText('Background Runs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Background Runs' }));
    expect(onOpenMissionControlSurface).toHaveBeenCalledWith('background-runs', { runId: 'run-worktree-starting' });
    expect(onOpenSessionById).not.toHaveBeenCalled();

    rerender(
      <TaskQueuePanel
        projectPath="/repo-a"
        onOpenMissionControlSurface={onOpenMissionControlSurface}
        onOpenSessionById={onOpenSessionById}
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            path: '/repo-a',
            sessions: [],
            codexSessions: [
              { id: 'synthetic-runtime', title: 'Worktree Runtime', __provider: 'codex' },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Session' }));
    expect(onOpenSessionById).toHaveBeenCalledWith('synthetic-runtime');
  });
});
