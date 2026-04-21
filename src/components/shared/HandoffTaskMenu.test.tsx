import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HandoffTaskMenu from './HandoffTaskMenu';
import { git, tasks, type Task } from '../../lib/tauri-bridge';
import { useTaskStore } from '../../stores/taskStore';
import type { Project } from '../../types/app';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-handoff-1',
    title: 'Continue with review context',
    description: 'Continue with review context',
    prompt: 'Continue with review context',
    status: 'queued',
    provider: 'codex',
    execution_strategy: 'handoff',
    project_path: '/tmp/project',
    created_at: '2026-04-21T09:00:00.000Z',
    updated_at: '2026-04-21T09:00:00.000Z',
    deps: [],
    review_required: false,
    source_session_id: 'session-claude-1',
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
          title: 'Claude implementation',
          lastActivity: '2026-04-21T08:00:00.000Z',
          __provider: 'claude',
        },
      ],
      codexSessions: [],
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
      codexSessions: [],
    },
  ];
}

describe('HandoffTaskMenu', () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasksByProject: {},
      loadingByProject: {},
      errorByProject: {},
    });
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('limits handoff targets to the providers with stable control-plane runtime surfaces', () => {
    render(
      <HandoffTaskMenu
        currentProvider="claude"
        sessionId="session-claude-1"
        sessionTitle="Claude implementation"
        projectPath="/tmp/project"
      />,
    );

    fireEvent.click(screen.getByTitle('Queue handoff task'));

    expect(screen.getByRole('option', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Cursor' })).not.toBeInTheDocument();
  });

  it('queues a durable handoff with shared role/worktree/review semantics', async () => {
    const onQueuedTask = vi.fn();
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        role: 'review',
        worktree_path: '/tmp/project-worktrees/review-a',
        review_required: true,
      }),
    );
    const projects = makeProjects();

    render(
      <HandoffTaskMenu
        currentProvider="claude"
        sessionId="session-claude-1"
        sessionTitle="Claude implementation"
        projectPath="/tmp/project"
        selectedProject={projects[0]}
        availableProjects={projects}
        onQueuedTask={onQueuedTask}
      />,
    );

    fireEvent.click(screen.getByTitle('Queue handoff task'));
    fireEvent.change(screen.getByLabelText('Handoff role'), {
      target: { value: 'review' },
    });
    fireEvent.change(screen.getByLabelText('Handoff worktree target'), {
      target: { value: '/tmp/project-worktrees/review-a' },
    });
    fireEvent.click(screen.getByLabelText('Handoff review required'));
    fireEvent.change(screen.getByPlaceholderText('Task context for the queued handoff (optional)'), {
      target: { value: 'Continue with review context' },
    });
    expect(screen.getByText('Source session · Project · Claude · Claude implementation')).toBeInTheDocument();
    expect(screen.getByText('Runtime session · Starts when dispatch begins')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · review-a worktree')).toBeInTheDocument();
    expect(screen.getByText('Worktree selection · Project Review A · review-a · review-a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Queue handoff' }));

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/tmp/project', {
        title: 'Continue with review context',
        description: 'Continue with review context',
        prompt: 'Continue with review context',
        provider: 'codex',
        role: 'review',
        execution_strategy: 'handoff',
        worktree_path: '/tmp/project-worktrees/review-a',
        source_session_id: 'session-claude-1',
        review_required: true,
        status: 'queued',
      });
    });

    expect(onQueuedTask).toHaveBeenCalledWith('/tmp/project');
  });

  it('creates a new worktree inline before persisting the handoff task', async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
    vi.spyOn(git, 'worktreeAdd').mockResolvedValue('/tmp/project-worktrees/handoff-target');
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        worktree_path: '/tmp/project-worktrees/handoff-target',
      }),
    );
    const projects = makeProjects();

    render(
      <HandoffTaskMenu
        currentProvider="claude"
        sessionId="session-claude-1"
        sessionTitle="Claude implementation"
        projectPath="/tmp/project"
        selectedProject={projects[0]}
        availableProjects={projects}
      />,
    );

    fireEvent.click(screen.getByTitle('Queue handoff task'));
    fireEvent.change(screen.getByLabelText('Handoff worktree target'), {
      target: { value: '__create__' },
    });
    fireEvent.change(screen.getByLabelText('Handoff new worktree name'), {
      target: { value: 'handoff-target' },
    });
    expect(screen.getByText('Runtime session · Starts when dispatch begins')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · handoff-target worktree')).toBeInTheDocument();
    expect(screen.getByText('Worktree plan · Create handoff-target')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Queue handoff' }));

    await waitFor(() => {
      expect(git.worktreeAdd).toHaveBeenCalledWith('/tmp/project', 'handoff-target');
    });

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/tmp/project', expect.objectContaining({
        execution_strategy: 'handoff',
        worktree_path: '/tmp/project-worktrees/handoff-target',
        source_session_id: 'session-claude-1',
      }));
    });
  });
});
