import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskQuickAdd } from './TaskQuickAdd';
import { useTaskStore } from '../../stores/taskStore';
import { git, tasks, type Task } from '../../lib/tauri-bridge';
import type { Project } from '../../types/app';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Write docs',
    description: 'Write docs',
    prompt: 'Write docs',
    status: 'queued',
    provider: 'codex',
    execution_strategy: 'current_project',
    project_path: '/tmp/project',
    created_at: '2026-04-19T10:00:00.000Z',
    updated_at: '2026-04-19T10:00:00.000Z',
    deps: [],
    review_required: false,
    ...overrides,
  };
}

function makeProjects(): Project[] {
  return [
    {
      name: 'project',
      displayName: 'Project',
      fullPath: '/tmp/project',
      path: '/tmp/project',
      repoRoot: '/tmp/project',
      worktreeBaseRoot: '/tmp/project-worktrees',
      sessions: [
        {
          id: 'session-claude-1',
          title: 'Claude bug bash',
          lastActivity: '2026-04-20T08:05:00.000Z',
          __provider: 'claude',
        },
      ],
      codexSessions: [
        {
          id: 'session-codex-1',
          summary: 'Codex implementation run',
          lastActivity: '2026-04-20T09:00:00.000Z',
          __provider: 'codex',
        },
      ],
    },
    {
      name: 'project-review-a',
      displayName: 'Project Review A',
      fullPath: '/tmp/project-worktrees/review-a',
      path: '/tmp/project-worktrees/review-a',
      isGitWorktree: true,
      sourceProjectName: 'project',
      repoRoot: '/tmp/project',
      worktreeBaseRoot: '/tmp/project-worktrees',
      branch: 'review-a',
      sessions: [],
      codexSessions: [
        {
          id: 'session-codex-worktree',
          summary: 'Worktree review session',
          lastActivity: '2026-04-20T07:00:00.000Z',
          __provider: 'codex',
        },
      ],
    },
    {
      name: 'project',
      displayName: 'Other Project With Same Name',
      fullPath: '/tmp/other-project',
      path: '/tmp/other-project',
      repoRoot: '/tmp/other-project',
      worktreeBaseRoot: '/tmp/other-project-worktrees',
      sessions: [
        {
          id: 'session-foreign',
          summary: 'Foreign session',
          lastActivity: '2026-04-20T10:00:00.000Z',
          __provider: 'codex',
        },
      ],
      codexSessions: [],
    },
  ];
}

beforeEach(() => {
  useTaskStore.setState({
    tasksByProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('TaskQuickAdd', () => {
  it('limits durable dispatch provider choices to the control-plane providers with stable session surfaces', () => {
    render(<TaskQuickAdd projectPath="/tmp/project" defaultProvider="cursor" />);

    expect(screen.getByLabelText('Task provider')).toHaveValue('claude');
    expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Cursor' })).not.toBeInTheDocument();
  });

  it('creates a durable queued task through taskStore with role/worktree execution metadata', async () => {
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        role: 'review',
        execution_strategy: 'worktree',
        worktree_path: '/tmp/project-worktrees/review-a',
      }),
    );
    const onAdded = vi.fn();
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        onAdded={onAdded}
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Write docs' },
    });
    fireEvent.change(screen.getByLabelText('Task role'), {
      target: { value: 'review' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch worktree'), {
      target: { value: '/tmp/project-worktrees/review-a' },
    });
    expect(screen.getByText('Dispatch target · review-a worktree')).toBeInTheDocument();
    expect(screen.getByText('Worktree selection · Project Review A · review-a · review-a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/tmp/project', {
        title: 'Write docs',
        description: 'Write docs',
        prompt: 'Write docs',
        provider: 'codex',
        role: 'review',
        execution_strategy: 'worktree',
        worktree_path: '/tmp/project-worktrees/review-a',
        session_id: undefined,
        source_session_id: undefined,
        review_required: false,
        status: 'queued',
      });
    });

    expect(useTaskStore.getState().getTasksForProject('/tmp/project')).toHaveLength(1);
    expect(useTaskStore.getState().getTasksForProject('/tmp/project')[0]).toMatchObject({
      role: 'review',
      execution_strategy: 'worktree',
      worktree_path: '/tmp/project-worktrees/review-a',
    });
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('creates a new worktree inline before persisting a worktree-dispatch task', async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
    vi.spyOn(git, 'worktreeAdd').mockResolvedValue('/tmp/project-worktrees/fresh-task');
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        execution_strategy: 'worktree',
        worktree_path: '/tmp/project-worktrees/fresh-task',
      }),
    );
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Implement the queue bridge' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch worktree'), {
      target: { value: '__create__' },
    });
    fireEvent.change(screen.getByLabelText('New worktree name'), {
      target: { value: 'fresh-task' },
    });
    expect(screen.getByText('Dispatch target · fresh-task worktree')).toBeInTheDocument();
    expect(screen.getByText('Worktree plan · Create fresh-task')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(git.worktreeAdd).toHaveBeenCalledWith('/tmp/project', 'fresh-task');
    });

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/tmp/project', {
        title: 'Implement the queue bridge',
        description: 'Implement the queue bridge',
        prompt: 'Implement the queue bridge',
        provider: 'codex',
        role: 'implement',
        execution_strategy: 'worktree',
        worktree_path: '/tmp/project-worktrees/fresh-task',
        session_id: undefined,
        source_session_id: undefined,
        review_required: false,
        status: 'queued',
      });
    });

    expect(useTaskStore.getState().getTasksForProject('/tmp/project')[0]).toMatchObject({
      execution_strategy: 'worktree',
      worktree_path: '/tmp/project-worktrees/fresh-task',
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('New worktree name')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Dispatch worktree')).toHaveValue('');
    });
  });

  it('removes a newly created worktree if durable task creation fails', async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
    vi.spyOn(git, 'worktreeAdd').mockResolvedValue('/tmp/project-worktrees/fresh-task');
    vi.spyOn(git, 'worktreeRemove').mockResolvedValue();
    vi.spyOn(tasks, 'create').mockRejectedValue(new Error('Task create failed'));
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Implement the queue bridge' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch worktree'), {
      target: { value: '__create__' },
    });
    fireEvent.change(screen.getByLabelText('New worktree name'), {
      target: { value: 'fresh-task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(git.worktreeRemove).toHaveBeenCalledWith('/tmp/project', '/tmp/project-worktrees/fresh-task', true);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Task create failed');
  });

  it('blocks inline worktree creation outside the desktop app', async () => {
    const createSpy = vi.spyOn(tasks, 'create').mockResolvedValue(makeTask());
    const worktreeAddSpy = vi.spyOn(git, 'worktreeAdd').mockResolvedValue('/tmp/project-worktrees/fresh-task');
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Implement the queue bridge' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch worktree'), {
      target: { value: '__create__' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    expect(worktreeAddSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Creating a new worktree is only available in the desktop app.');
    });
  });

  it('offers project-family worktrees and only reveals source sessions when handoff is selected', () => {
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    expect(screen.getByRole('option', { name: 'Project Review A · review-a · review-a' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Create new worktree…' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Source session id')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Task execution strategy'), {
      target: { value: 'handoff' },
    });

    expect(screen.getByRole('option', { name: 'Project · Codex · Codex implementation run' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Project · Claude · Claude bug bash' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Project Review A · Codex · Worktree review session' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Other Project With Same Name · Codex · Foreign session' })).not.toBeInTheDocument();
  });

  it('previews the stable completion surface for handoff tasks before they are queued', () => {
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByLabelText('Task execution strategy'), {
      target: { value: 'handoff' },
    });
    fireEvent.change(screen.getByLabelText('Source session id'), {
      target: { value: 'session-claude-1' },
    });

    expect(screen.getByText('Result Inbox')).toBeInTheDocument();
    expect(screen.getByText(/Handoff from Project · Claude · Claude bug bash to Codex in this project\./)).toBeInTheDocument();
    expect(screen.getByText('Runtime session · Starts when dispatch begins')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Review required'));

    expect(screen.getByText('Review Queue')).toBeInTheDocument();
    expect(screen.getByText('Successful completion routes into Review Queue for accept or rework.')).toBeInTheDocument();
  });

  it('sends handoff session context, target worktree, and review intent when requested, then resets the controls', async () => {
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        execution_strategy: 'handoff',
        worktree_path: '/tmp/project-worktrees/review-a',
        source_session_id: 'session-codex-1',
        review_required: true,
      }),
    );
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Pick up the prior handoff' },
    });
    fireEvent.change(screen.getByLabelText('Task execution strategy'), {
      target: { value: 'handoff' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch worktree'), {
      target: { value: '/tmp/project-worktrees/review-a' },
    });
    fireEvent.change(screen.getByLabelText('Source session id'), {
      target: { value: 'session-codex-1' },
    });
    expect(screen.getByText('Source session · Project · Codex · Codex implementation run')).toBeInTheDocument();
    expect(screen.getByText('Runtime session · Starts when dispatch begins')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · review-a worktree')).toBeInTheDocument();
    expect(screen.getByText('Worktree selection · Project Review A · review-a · review-a')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Review required'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/tmp/project', {
        title: 'Pick up the prior handoff',
        description: 'Pick up the prior handoff',
        prompt: 'Pick up the prior handoff',
        provider: 'codex',
        role: 'implement',
        execution_strategy: 'handoff',
        worktree_path: '/tmp/project-worktrees/review-a',
        session_id: undefined,
        source_session_id: 'session-codex-1',
        review_required: true,
        status: 'queued',
      });
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Add a task prompt...')).toHaveValue('');
      expect(screen.getByLabelText('Task execution strategy')).toHaveValue('auto');
      expect(screen.queryByLabelText('Source session id')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Review required')).not.toBeChecked();
    });
  });

  it('creates a new worktree inline before persisting a handoff-dispatch task', async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
    vi.spyOn(git, 'worktreeAdd').mockResolvedValue('/tmp/project-worktrees/handoff-target');
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        execution_strategy: 'handoff',
        worktree_path: '/tmp/project-worktrees/handoff-target',
        source_session_id: 'session-codex-1',
      }),
    );
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Continue in a fresh handoff target' },
    });
    fireEvent.change(screen.getByLabelText('Task execution strategy'), {
      target: { value: 'handoff' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch worktree'), {
      target: { value: '__create__' },
    });
    fireEvent.change(screen.getByLabelText('New worktree name'), {
      target: { value: 'handoff-target' },
    });
    fireEvent.change(screen.getByLabelText('Source session id'), {
      target: { value: 'session-codex-1' },
    });
    expect(screen.getByText('Runtime session · Starts when dispatch begins')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(git.worktreeAdd).toHaveBeenCalledWith('/tmp/project', 'handoff-target');
    });

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/tmp/project', expect.objectContaining({
        execution_strategy: 'handoff',
        worktree_path: '/tmp/project-worktrees/handoff-target',
        source_session_id: 'session-codex-1',
      }));
    });
  });

  it('normalizes explicit current-project tasks so they do not persist stale worktree metadata', async () => {
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        execution_strategy: 'current_project',
      }),
    );
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Write docs' },
    });
    fireEvent.change(screen.getByLabelText('Dispatch worktree'), {
      target: { value: '/tmp/project-worktrees/review-a' },
    });
    fireEvent.change(screen.getByLabelText('Task execution strategy'), {
      target: { value: 'current_project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/tmp/project', expect.objectContaining({
        execution_strategy: 'current_project',
        worktree_path: undefined,
        source_session_id: undefined,
        review_required: false,
      }));
    });
  });

  it('blocks handoff tasks without a source session id', async () => {
    const createSpy = vi.spyOn(tasks, 'create').mockResolvedValue(makeTask());
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Continue the previous handoff' },
    });
    fireEvent.change(screen.getByLabelText('Task execution strategy'), {
      target: { value: 'handoff' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(createSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Handoff strategy needs a source session id.');
    });
  });

  it('blocks worktree tasks without a worktree path', async () => {
    const createSpy = vi.spyOn(tasks, 'create').mockResolvedValue(makeTask());
    const projects = makeProjects();

    render(
      <TaskQuickAdd
        projectPath="/tmp/project"
        defaultProvider="codex"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a task prompt...'), {
      target: { value: 'Run in a worktree' },
    });
    fireEvent.change(screen.getByLabelText('Task execution strategy'), {
      target: { value: 'worktree' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Queue' }));

    await waitFor(() => {
      expect(createSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Worktree strategy needs a worktree path.');
    });
  });
});
