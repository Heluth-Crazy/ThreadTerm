import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LiveCard from './LiveCard';
import { tasks, type Task } from '../../../lib/tauri-bridge';
import { useLiveGridStore } from '../../../stores/liveGridStore';
import { useSessionStatusStore } from '../../../stores/sessionStatusStore';
import { useAttentionStore } from '../../../stores/attentionStore';
import { useBackgroundRunStore } from '../../../stores/backgroundRunStore';
import { useTaskStore } from '../../../stores/taskStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../../SessionProviderLogo', () => ({
  default: () => <div data-testid="provider-logo" />,
}));

vi.mock('./CardMessageList', () => ({
  default: () => <div data-testid="card-message-list" />,
}));

vi.mock('./MiniInputBar', () => ({
  default: () => <div data-testid="mini-input-bar" />,
}));

vi.mock('../../../hooks/useCardHistory', () => ({
  useCardHistory: () => undefined,
}));

describe('LiveCard handoff flow', () => {
  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: 'task-handoff-1',
      title: 'Handoff Source Session to Codex',
      description: 'Continue the current Source Session in Codex.',
      prompt: 'Continue the current Source Session in Codex.',
      status: 'queued',
      provider: 'codex',
      execution_strategy: 'handoff',
      project_path: '/repo-a',
      created_at: '2026-04-21T09:00:00.000Z',
      updated_at: '2026-04-21T09:00:00.000Z',
      deps: [],
      review_required: false,
      source_session_id: 'session-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    localStorage.clear();
    useLiveGridStore.setState({
      layout: '2x2',
      cards: [],
      focusedCardId: null,
      messageSnapshots: {},
    });
    useSessionStatusStore.setState({
      statuses: {
        'session-1': {
          status: 'processing',
          updatedAt: Date.now(),
        },
      },
    });
    useAttentionStore.setState({
      attentionItems: {},
      approvalRequests: {},
    });
    useTaskStore.setState({
      tasksByProject: {},
      loadingByProject: {},
      errorByProject: {},
    });
    vi.restoreAllMocks();
  });

  it('queues a durable handoff task with the current worktree context instead of starting a hidden runtime handoff', async () => {
    vi.spyOn(tasks, 'create').mockResolvedValue(
      makeTask({
        worktree_path: '/repo-a/.worktrees/review-dispatch',
      }),
    );

    render(
      <LiveCard
        sessionId="session-1"
        projectId="project-1"
        provider="claude"
        sessionTitle="Source Session"
        projectPath="/repo-a"
        worktreePath="/repo-a/.worktrees/review-dispatch"
        onSend={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('Queue handoff task'));
    fireEvent.click(screen.getByRole('button', { name: 'Queue handoff' }));

    await waitFor(() => {
      expect(tasks.create).toHaveBeenCalledWith('/repo-a', {
        title: 'Handoff Source Session to Codex',
        description: 'Continue the current Source Session in Codex.',
        prompt: 'Continue the current Source Session in Codex.',
        provider: 'codex',
        role: 'implement',
        execution_strategy: 'handoff',
        worktree_path: '/repo-a/.worktrees/review-dispatch',
        source_session_id: 'session-1',
        review_required: false,
        status: 'queued',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Task · Handoff Source Session to Codex')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Handoff').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Handoff Source')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · review-dispatch worktree')).toBeInTheDocument();
    expect(screen.getByText('Source session · This session')).toBeInTheDocument();
    expect(useLiveGridStore.getState().cards).toEqual([]);
    expect(useTaskStore.getState().getTasksForProject('/repo-a')).toEqual([
      expect.objectContaining({
        execution_strategy: 'handoff',
        worktree_path: '/repo-a/.worktrees/review-dispatch',
        source_session_id: 'session-1',
      }),
    ]);
  });

  it('shows the linked control-plane surface for post-run handoff tasks on the live card', () => {
    useTaskStore.setState({
      tasksByProject: {
        '/repo-a': [
          makeTask({
            id: 'task-review-surface',
            status: 'pending_review',
            session_id: 'session-1',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
            result_summary: 'Awaiting review',
          }),
        ],
      },
      loadingByProject: {},
      errorByProject: {},
    });

    render(
      <LiveCard
        sessionId="session-1"
        projectId="project-1"
        provider="claude"
        sessionTitle="Source Session"
        projectPath="/repo-a"
        worktreePath="/repo-a/.worktrees/review-dispatch"
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByText('Review Queue')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
  });

  it('routes queued handoff cards into Task Queue as the stable main path', () => {
    useTaskStore.setState({
      tasksByProject: {
        '/repo-a': [
          makeTask({
            id: 'task-queued-main-path',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
          }),
        ],
      },
      loadingByProject: {},
      errorByProject: {},
    });
    const onOpenTaskQueue = vi.fn();

    render(
      <LiveCard
        sessionId="session-1"
        projectId="project-1"
        provider="claude"
        sessionTitle="Source Session"
        projectPath="/repo-a"
        worktreePath="/repo-a/.worktrees/review-dispatch"
        onSend={vi.fn()}
        onOpenTaskQueue={onOpenTaskQueue}
      />,
    );

    expect(screen.getAllByText('Handoff').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open Handoff Task' }));

    expect(onOpenTaskQueue).toHaveBeenCalledWith('/repo-a');
  });

  it('reuses the live-grid worktree context for queued handoff metadata when the durable task has not stored it yet', () => {
    useTaskStore.setState({
      tasksByProject: {
        '/repo-a': [
          makeTask({
            id: 'task-live-grid-fallback',
            source_session_id: 'session-1',
            worktree_path: undefined,
          }),
        ],
      },
      loadingByProject: {},
      errorByProject: {},
    });

    render(
      <LiveCard
        sessionId="session-1"
        projectId="project-1"
        provider="claude"
        sessionTitle="Source Session"
        projectPath="/repo-a"
        worktreePath="/repo-a/.worktrees/review-dispatch"
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByText('Dispatch target · review-dispatch worktree')).toBeInTheDocument();
    expect(screen.getByText('Runtime session · Starts when dispatch begins')).toBeInTheDocument();
  });

  it('keeps pre-runtime handoff bootstrap on Background Runs until a runtime session exists', () => {
    const onOpenMissionControlSurface = vi.fn();
    useTaskStore.setState({
      tasksByProject: {
        '/repo-a': [
          makeTask({
            id: 'task-bootstrap-main-path',
            status: 'dispatched',
            source_session_id: 'session-1',
            session_id: '',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
          }),
        ],
      },
      loadingByProject: {},
      errorByProject: {},
    });
    useBackgroundRunStore.setState({
      runs: {
        'run-bootstrap': {
          id: 'run-bootstrap',
          provider: 'codex',
          title: 'Bootstrap review worktree',
          source: 'task-queue',
          status: 'running',
          taskId: 'task-bootstrap-main-path',
        },
      },
    });

    render(
      <LiveCard
        sessionId="session-1"
        projectId="project-1"
        provider="claude"
        sessionTitle="Source Session"
        projectPath="/repo-a"
        worktreePath="/repo-a/.worktrees/review-dispatch"
        onSend={vi.fn()}
        onOpenMissionControlSurface={onOpenMissionControlSurface}
      />,
    );

    expect(screen.getByText('Background Runs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Background Runs' }));
    expect(onOpenMissionControlSurface).toHaveBeenCalledWith('background-runs', { runId: 'run-bootstrap' });
  });

  it('shows project-family worktree targets in the live-grid handoff menu when project context is provided', async () => {
    render(
      <LiveCard
        sessionId="session-1"
        projectId="project-1"
        provider="claude"
        sessionTitle="Source Session"
        projectPath="/repo-a"
        worktreePath="/repo-a/.worktrees/review-dispatch"
        selectedProject={{
          name: 'repo-a',
          displayName: 'Repo A',
          fullPath: '/repo-a',
          path: '/repo-a',
          worktreeBaseRoot: '/repo-a/.worktrees',
          sessions: [{ id: 'session-1', title: 'Source Session', __provider: 'claude' }],
          codexSessions: [],
        }}
        availableProjects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            path: '/repo-a',
            worktreeBaseRoot: '/repo-a/.worktrees',
            sessions: [{ id: 'session-1', title: 'Source Session', __provider: 'claude' }],
            codexSessions: [],
          },
          {
            name: 'repo-a-review',
            displayName: 'Review A',
            fullPath: '/repo-a/.worktrees/review-a',
            path: '/repo-a/.worktrees/review-a',
            isGitWorktree: true,
            branch: 'feat/review-a',
            worktreeBaseRoot: '/repo-a/.worktrees',
            sessions: [],
            codexSessions: [],
          },
        ]}
        onSend={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('Queue handoff task'));

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Review A · feat/review-a · review-a' })).toBeInTheDocument();
    });
  });
});
