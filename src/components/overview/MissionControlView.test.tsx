import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundRun } from '../../types/background-run';
import type { Task } from '../../lib/tauri-bridge';
import { useMissionControlStore } from '../../stores/missionControlStore';
import type { SessionStatusEntry } from '../../stores/sessionStatusStore';
import type { Project } from '../../types/app';
import MissionControlView from './MissionControlView';

const storeState = vi.hoisted(() => ({
  sessionStatus: {
    statuses: {} as Record<string, SessionStatusEntry>,
    pendingPermissions: {} as Record<string, unknown>,
    getStatus: (sessionId: string) => storeState.sessionStatus.statuses[sessionId] ?? { status: 'idle' as const, updatedAt: 0 },
  },
  attention: {
    attentionItems: {} as Record<string, { status: 'active' | 'resolved' | 'dismissed'; updatedAt: number }>,
    approvalRequests: {} as Record<string, {
      id?: string;
      requestId?: string;
      toolName?: string;
      input?: Record<string, unknown>;
      riskLevel?: 'low' | 'medium' | 'high';
      sessionId?: string;
      status: 'pending' | 'approved' | 'denied' | 'expired';
      createdAt?: number;
      updatedAt: number;
    }>,
  },
  backgroundRuns: {
    activeRuns: [] as BackgroundRun[],
    recentRuns: [] as BackgroundRun[],
  },
  taskStore: {
    tasksByProject: {} as Record<string, Task[]>,
    refresh: vi.fn(async () => []),
    createTask: vi.fn(async (_projectPath: string, input: Partial<Task>) => ({
      id: 'task-created',
      title: input.title ?? 'Queued handoff task',
      description: input.description,
      prompt: input.prompt ?? input.description ?? 'Queued handoff task',
      status: 'queued' as const,
      provider: input.provider ?? 'codex',
      role: input.role,
      execution_strategy: input.execution_strategy ?? 'handoff',
      worktree_path: input.worktree_path,
      project_path: _projectPath,
      created_at: '2026-04-21T10:00:00.000Z',
      updated_at: '2026-04-21T10:00:00.000Z',
      deps: [],
      session_id: input.session_id,
      source_session_id: input.source_session_id,
      review_required: input.review_required ?? false,
    })),
    updateTask: vi.fn(async (_projectPath: string, _id: string, _updates: Partial<Task>) => undefined),
  },
  taskQueue: {
    queueOrder: [] as string[],
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../../stores/sessionStatusStore', () => ({
  useSessionStatusStore: (selector: (state: typeof storeState.sessionStatus) => unknown) =>
    selector(storeState.sessionStatus),
}));

vi.mock('../../stores/attentionStore', () => ({
  useAttentionStore: (selector: (state: typeof storeState.attention) => unknown) =>
    selector(storeState.attention),
}));

vi.mock('../../stores/backgroundRunStore', () => ({
  useBackgroundRunStore: (selector: (state: {
    runs: Record<string, BackgroundRun>;
    getActiveRuns: () => typeof storeState.backgroundRuns.activeRuns;
    getRecentCompletedRuns: () => typeof storeState.backgroundRuns.recentRuns;
  }) => unknown) =>
    selector({
      runs: Object.fromEntries(
        [...storeState.backgroundRuns.activeRuns, ...storeState.backgroundRuns.recentRuns].map((run) => [run.id, run]),
      ),
      getActiveRuns: () => storeState.backgroundRuns.activeRuns,
      getRecentCompletedRuns: () => storeState.backgroundRuns.recentRuns,
    }),
}));

vi.mock('../../stores/taskStore', () => ({
  countQueuedDurableTasks: (tasks: Array<{ status: string }>) => tasks.filter((task) => task.status === 'open' || task.status === 'queued').length,
  countRunningDurableTasks: (tasks: Array<{ status: string }>) => tasks.filter((task) => ['dispatched', 'in_progress', 'pending_approval'].includes(task.status)).length,
  isDurableQueuedTaskStatus: (status: string) => status === 'open' || status === 'queued',
  isDurableRunningTaskStatus: (status: string) => ['dispatched', 'in_progress', 'pending_approval'].includes(status),
  useTaskStore: (selector: (state: typeof storeState.taskStore) => unknown) =>
    selector(storeState.taskStore),
}));

vi.mock('../../stores/taskQueueStore', () => ({
  orderProjectedTasks: <T extends { id: string; created_at: string }>(tasks: T[], queueOrder: string[]) => {
    const orderIndex = new Map(queueOrder.map((taskId, index) => [taskId, index]));
    return [...tasks].sort((a, b) => {
      const aIndex = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return (a.created_at ?? '').localeCompare(b.created_at ?? '');
    });
  },
  useTaskQueueStore: (selector: (state: typeof storeState.taskQueue) => unknown) =>
    selector(storeState.taskQueue),
}));

describe('MissionControlView', () => {
  beforeEach(() => {
    storeState.sessionStatus.statuses = {};
    storeState.sessionStatus.pendingPermissions = {};
    storeState.attention.attentionItems = {};
    storeState.attention.approvalRequests = {};
    storeState.backgroundRuns.activeRuns = [];
    storeState.backgroundRuns.recentRuns = [];
    storeState.taskStore.tasksByProject = {};
    storeState.taskQueue.queueOrder = [];
    useMissionControlStore.setState({ pendingFocusRequest: null });
    storeState.taskStore.refresh.mockClear();
    storeState.taskStore.createTask.mockClear();
    storeState.taskStore.updateTask.mockClear();
  });

  it('shows the empty-state gate when there are no sessions and no background runs', () => {
    render(
      <MissionControlView
        projects={[]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByText('No active sessions')).toBeInTheDocument();
    expect(screen.queryByText('Background Runs')).not.toBeInTheDocument();
  });

  it('keeps background runs visible when there are no sessions', () => {
    storeState.backgroundRuns.activeRuns = [
      {
        id: 'run-1',
        provider: 'codex',
        title: 'Index project docs',
        source: 'manual',
        status: 'running',
        lastOutputExcerpt: 'Collecting repository context',
      },
    ];

    render(
      <MissionControlView
        projects={[]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByText('Mission Control')).toBeInTheDocument();
    expect(screen.getByText('Background Runs')).toBeInTheDocument();
    expect(screen.getByText('Index project docs')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
  });

  it('keeps failed background runs visible when there are no sessions', () => {
    storeState.backgroundRuns.recentRuns = [
      {
        id: 'run-2',
        provider: 'claude',
        title: 'Review failing worker',
        source: 'agent',
        status: 'failed',
        lastOutputExcerpt: 'Agent exited with code 1',
        finishedAt: '2026-04-20T08:00:00.000Z',
      },
    ];

    render(
      <MissionControlView
        projects={[]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByText('Mission Control')).toBeInTheDocument();
    expect(screen.getByText('Background Runs')).toBeInTheDocument();
    expect(screen.getByText('Review failing worker')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
  });

  it('uses durable tasks for the queued task summary and keeps Mission Control visible without sessions when queued tasks exist', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        { status: 'queued', project_path: '/repo-a' } as Task,
        { status: 'open', project_path: '/repo-a' } as Task,
        { status: 'in_progress', project_path: '/repo-a' } as Task,
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(storeState.taskStore.refresh).toHaveBeenCalledWith('/repo-a');
    expect(screen.getByText('Mission Control')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
    expect(screen.getByText('Queued tasks')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Task flow Backlog' })).getByText('2')).toBeInTheDocument();
  });

  it('keeps Mission Control visible for durable running tasks even without sessions', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-running',
          title: 'Run control-plane migration',
          description: 'Executing the next durable step',
          prompt: 'run it',
          status: 'in_progress',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          review_required: false,
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByText('Mission Control')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
    expect(screen.getByText('Task Timeline')).toBeInTheDocument();
    expect(screen.getByText('Run control-plane migration')).toBeInTheDocument();
  });

  it('keeps terminal task outcomes visible in Mission Control even without sessions', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-failed',
          title: 'Failed durable task',
          description: 'Execution failed after dispatch',
          prompt: 'run it',
          status: 'failed',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          review_required: false,
          result_summary: 'Agent exited with code 1',
        },
        {
          id: 'task-cancelled',
          title: 'Cancelled durable task',
          description: 'Stopped before completion',
          prompt: 'cancel it',
          status: 'cancelled',
          provider: 'claude',
          execution_strategy: 'handoff',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:10:00.000Z',
          updated_at: '2026-04-20T08:40:00.000Z',
          deps: [],
          review_required: false,
          source_session_id: 'session-source',
          result_summary: 'Cancelled before handoff started',
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByText('Mission Control')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Task flow Completed' })).getByText('Failed durable task')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Task flow Completed' })).getByText('Cancelled durable task')).toBeInTheDocument();
  });

  it('keeps queued handoff source semantics visible on the source session card before a runtime session exists', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-handoff',
          title: 'Queue durable handoff',
          description: 'Carry the current session into a review worktree',
          prompt: 'carry it',
          status: 'queued',
          provider: 'codex',
          execution_strategy: 'handoff',
          worktree_path: '/repo-a/.worktrees/review-a',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          source_session_id: 'session-source',
          review_required: false,
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-source', title: 'Source Session', __provider: 'claude' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Queue durable handoff')[0]).toBeInTheDocument();
    expect(screen.getByText('Handoff Source')).toBeInTheDocument();
    expect(screen.getAllByText('Queued')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Dispatch target · review-a worktree')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Source session · Repo A · Claude · Source Session').length).toBeGreaterThan(0);
  });

  it('routes queued handoff source cards into Task Queue as the stable main path before runtime bootstrap', () => {
    const onOpenTaskQueue = vi.fn();

    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-handoff',
          title: 'Queue durable handoff',
          description: 'Carry the current session into a review worktree',
          prompt: 'carry it',
          status: 'queued',
          provider: 'codex',
          execution_strategy: 'handoff',
          worktree_path: '/repo-a/.worktrees/review-a',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          source_session_id: 'session-source',
          review_required: false,
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-source', title: 'Source Session', __provider: 'claude' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenTaskQueue={onOpenTaskQueue}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Handoff Task' })[0]);

    expect(onOpenTaskQueue).toHaveBeenCalledWith('/repo-a');
  });

  it('renders queued handoff session cards without nested button warnings on the Mission Control main path', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-handoff',
          title: 'Queue durable handoff',
          description: 'Carry the current session into a review worktree',
          prompt: 'carry it',
          status: 'queued',
          provider: 'codex',
          execution_strategy: 'handoff',
          worktree_path: '/repo-a/.worktrees/review-a',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          source_session_id: 'session-source',
          review_required: false,
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-source', title: 'Source Session', __provider: 'claude' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenTaskQueue={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Path · Handoff').length).toBeGreaterThan(0);
    expect(
      consoleError.mock.calls.some((args) =>
        args.some((value) => typeof value === 'string' && value.includes('validateDOMNesting')),
      ),
    ).toBe(false);
  });

  it('keeps source and runtime handoff semantics aligned on Mission Control session cards once the runtime exists', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-handoff-runtime',
          title: 'Continue queued handoff',
          description: 'Move the queued handoff into a runtime session',
          prompt: 'continue it',
          status: 'in_progress',
          provider: 'codex',
          execution_strategy: 'handoff',
          worktree_path: '/repo-a/.worktrees/review-a',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:45:00.000Z',
          deps: [],
          session_id: 'session-runtime',
          source_session_id: 'session-source',
          review_required: false,
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-source', title: 'Source Session', __provider: 'claude' },
            ],
            codexSessions: [
              { id: 'session-runtime', title: 'Runtime Session', __provider: 'codex' },
            ],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Continue queued handoff')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Source session · Repo A · Claude · Source Session').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Runtime session · Repo A · Codex · Runtime Session').length).toBeGreaterThan(0);
  });

  it('routes source-session handoff cards into the runtime session once bootstrap finishes', () => {
    const onSelectSession = vi.fn();

    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-handoff-runtime',
          title: 'Continue queued handoff',
          description: 'Move the queued handoff into a runtime session',
          prompt: 'continue it',
          status: 'in_progress',
          provider: 'codex',
          execution_strategy: 'handoff',
          worktree_path: '/repo-a/.worktrees/review-a',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:45:00.000Z',
          deps: [],
          session_id: 'session-runtime',
          source_session_id: 'session-source',
          review_required: false,
        },
      ],
    };

    const projects: Project[] = [
      {
        name: 'repo-a',
        displayName: 'Repo A',
        fullPath: '/repo-a',
        sessions: [
          { id: 'session-source', title: 'Source Session', __provider: 'claude' },
        ],
        codexSessions: [
          { id: 'session-runtime', title: 'Runtime Session', __provider: 'codex' },
        ],
      },
    ];

    render(
      <MissionControlView
        projects={projects}
        isLoading={false}
        onSelectSession={onSelectSession}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Handoff Session' })[0]);

    expect(onSelectSession).toHaveBeenCalledWith(projects[0], projects[0].codexSessions![0]);
  });

  it('shows review queue and result inbox from durable task state', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-review',
          title: 'Review dispatch metadata',
          description: 'Inspect role/worktree mapping',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'claude',
          role: 'review',
          execution_strategy: 'handoff',
          worktree_path: '/repo-a/.worktrees/review-dispatch',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          session_id: 'session-review',
          review_required: true,
          result_summary: 'Changed dispatcher wiring and added coverage.',
          result_changed_files: ['src-tauri/src/tasks.rs'],
          result_verification_summary: 'cargo test --lib tasks',
          result_risk_summary: 'Low risk, review queue only.',
          result_suggested_next_step: 'Accept after reviewing the task file.',
        },
        {
          id: 'task-result',
          title: 'Finish background run panel',
          description: 'Wire up completed state',
          prompt: 'finish it',
          status: 'done',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T07:00:00.000Z',
          updated_at: '2026-04-20T08:10:00.000Z',
          deps: [],
          session_id: 'session-result',
          review_required: false,
          result_summary: 'Background run cards now surface completion summaries.',
          result_changed_files: ['src/components/overview/BackgroundRunPanel.tsx'],
          result_verification_summary: 'npm run vitest BackgroundRunPanel',
        },
        {
          id: 'task-archived',
          title: 'Archived result should stay hidden',
          description: 'Previously archived',
          prompt: 'hide it',
          status: 'archived',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T06:00:00.000Z',
          updated_at: '2026-04-20T06:10:00.000Z',
          deps: [],
          review_required: false,
          result_summary: 'This should not render in active inboxes.',
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-review', title: 'Review Session', __provider: 'claude' },
              { id: 'session-result', title: 'Result Session', __provider: 'codex' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Review Queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Result Inbox' })).toBeInTheDocument();
    expect(screen.getByText('Result inbox')).toBeInTheDocument();
    expect(screen.getByText('Pending review')).toBeInTheDocument();
    expect(screen.getAllByText('Review dispatch metadata')).toHaveLength(2);
    expect(screen.getAllByText('Finish background run panel')).toHaveLength(2);
    expect(screen.getByText('src-tauri/src/tasks.rs')).toBeInTheDocument();
    expect(screen.getByText('cargo test --lib tasks')).toBeInTheDocument();
    expect(screen.getByText('src/components/overview/BackgroundRunPanel.tsx')).toBeInTheDocument();
    expect(screen.queryByText('Archived result should stay hidden')).not.toBeInTheDocument();
  });

  it('groups the top Mission Control surfaces into active, operations, and decisions columns', () => {
    storeState.sessionStatus.statuses = {
      'session-attention': { status: 'needs_attention', updatedAt: 1 },
      'session-result': { status: 'processing', updatedAt: 2 },
    };
    storeState.backgroundRuns.activeRuns = [
      {
        id: 'run-1',
        provider: 'codex',
        title: 'Index project docs',
        source: 'manual',
        status: 'running',
        lastOutputExcerpt: 'Collecting repository context',
      },
    ];
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-review',
          title: 'Review dispatch metadata',
          description: 'Inspect role/worktree mapping',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'claude',
          role: 'review',
          execution_strategy: 'handoff',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          session_id: 'session-attention',
          review_required: true,
          result_summary: 'Changed dispatcher wiring and added coverage.',
        },
        {
          id: 'task-result',
          title: 'Finish background run panel',
          description: 'Wire up completed state',
          prompt: 'finish it',
          status: 'done',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T07:00:00.000Z',
          updated_at: '2026-04-20T08:10:00.000Z',
          deps: [],
          session_id: 'session-result',
          review_required: false,
          result_summary: 'Background run cards now surface completion summaries.',
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-attention', title: 'Attention Session', __provider: 'claude' },
              { id: 'session-result', title: 'Result Session', __provider: 'codex' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const activeColumn = screen.getByRole('region', { name: 'Mission Control active column' });
    const operationsColumn = screen.getByRole('region', { name: 'Mission Control operations column' });
    const decisionsColumn = screen.getByRole('region', { name: 'Mission Control decisions column' });

    expect(within(activeColumn).getByText('Attention Inbox')).toBeInTheDocument();
    expect(within(activeColumn).getByText('Active Sessions')).toBeInTheDocument();

    expect(within(operationsColumn).getByText('Task Timeline')).toBeInTheDocument();
    expect(within(operationsColumn).getByText('Background Runs')).toBeInTheDocument();
    expect(within(operationsColumn).getByRole('heading', { name: 'Result Inbox' })).toBeInTheDocument();

    expect(within(decisionsColumn).getByRole('heading', { name: 'Approval Inbox' })).toBeInTheDocument();
    expect(within(decisionsColumn).getByRole('heading', { name: 'Review Queue' })).toBeInTheDocument();
  });

  it('uses the summary strip as the stable main-path router across attention, timeline, approval, review, and result surfaces', () => {
    storeState.attention.attentionItems = {
      'attention-1': {
        id: 'attention-1',
        sessionId: 'session-attention',
        kind: 'error',
        status: 'active',
        reason: 'error',
        title: 'Attention needed',
        message: 'Follow up on the failing run',
        riskLevel: 'high',
        createdAt: 1,
        updatedAt: 2,
      },
    } as typeof storeState.attention.attentionItems;
    storeState.attention.approvalRequests = {
      'session-approval': {
        id: 'approval-item-1',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'npm run typecheck' },
        riskLevel: 'high',
        sessionId: 'session-approval',
        status: 'pending',
        createdAt: 1,
        updatedAt: 2,
      },
    };
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-backlog',
          title: 'Backlog task',
          description: 'Queued for dispatch',
          prompt: 'queue it',
          status: 'queued',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:01:00.000Z',
          deps: [],
          review_required: false,
        },
        {
          id: 'task-running',
          title: 'Running task',
          description: 'Currently executing',
          prompt: 'run it',
          status: 'in_progress',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:02:00.000Z',
          updated_at: '2026-04-20T08:03:00.000Z',
          deps: [],
          review_required: false,
        },
        {
          id: 'task-review',
          title: 'Review task',
          description: 'Needs review',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:04:00.000Z',
          updated_at: '2026-04-20T08:05:00.000Z',
          deps: [],
          review_required: true,
          result_summary: 'Needs review.',
        },
        {
          id: 'task-result',
          title: 'Result task',
          description: 'Completed result',
          prompt: 'done it',
          status: 'done',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:06:00.000Z',
          updated_at: '2026-04-20T08:07:00.000Z',
          deps: [],
          review_required: false,
          result_summary: 'Completed successfully.',
          result_changed_files: ['src/components/overview/MissionControlView.tsx'],
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-attention', title: 'Attention Session', __provider: 'claude' },
              { id: 'session-approval', title: 'Approval Session', __provider: 'claude' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const summaryStrip = screen.getByRole('button', { name: /Pending approvals/i }).parentElement;
    expect(summaryStrip).not.toBeNull();

    fireEvent.click(within(summaryStrip as HTMLElement).getByRole('button', { name: /Attention items/i }));
    expect(screen.getByRole('heading', { name: 'Attention Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');

    fireEvent.click(within(summaryStrip as HTMLElement).getByRole('button', { name: /Running tasks/i }));
    expect(screen.getByRole('region', { name: 'Task flow Running' })).toHaveAttribute('data-surface-focused', 'true');

    fireEvent.click(within(summaryStrip as HTMLElement).getByRole('button', { name: /Queued tasks/i }));
    expect(screen.getByRole('region', { name: 'Task flow Backlog' })).toHaveAttribute('data-surface-focused', 'true');

    fireEvent.click(within(summaryStrip as HTMLElement).getByRole('button', { name: /Pending approvals/i }));
    expect(screen.getByRole('heading', { name: 'Approval Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');

    fireEvent.click(within(summaryStrip as HTMLElement).getByRole('button', { name: /Pending review/i }));
    expect(screen.getByRole('heading', { name: 'Review Queue' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');

    fireEvent.click(within(summaryStrip as HTMLElement).getByRole('button', { name: /Result inbox/i }));
    expect(screen.getByRole('heading', { name: 'Result Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
  });

  it('uses the task queue projection order for backlog tasks in the timeline', () => {
    storeState.taskQueue.queueOrder = ['task-second', 'task-first'];
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-first',
          title: 'First queued task',
          description: 'Created first',
          prompt: 'first',
          status: 'queued',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:01:00.000Z',
          deps: [],
          review_required: false,
        },
        {
          id: 'task-second',
          title: 'Second queued task',
          description: 'Created second',
          prompt: 'second',
          status: 'queued',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:02:00.000Z',
          updated_at: '2026-04-20T08:03:00.000Z',
          deps: [],
          review_required: false,
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const backlogRegion = screen.getByRole('region', { name: 'Task flow Backlog' });
    const secondTask = within(backlogRegion).getByText('Second queued task');
    const firstTask = within(backlogRegion).getByText('First queued task');

    expect(secondTask.compareDocumentPosition(firstTask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('routes backlog timeline cards into the existing task queue surface', () => {
    const onOpenTaskQueue = vi.fn();

    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-backlog',
          title: 'Queued task',
          description: 'Dispatch from the queue',
          prompt: 'queue it',
          status: 'queued',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:01:00.000Z',
          deps: [],
          review_required: false,
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenTaskQueue={onOpenTaskQueue}
      />,
    );

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Backlog' })).getByRole('button', { name: 'Open Task Queue' }));
    expect(onOpenTaskQueue).toHaveBeenCalledWith('/repo-a');
  });

  it('focuses the existing approval, review, and result surfaces from timeline next-action CTAs', () => {
    storeState.attention.approvalRequests = {
      'session-approval': {
        id: 'approval-item-1',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'npm run typecheck' },
        riskLevel: 'high',
        sessionId: 'session-approval',
        status: 'pending',
        createdAt: 1,
        updatedAt: 2,
      },
    };
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-approval',
          title: 'Approval blocked task',
          description: 'Waiting on approval',
          prompt: 'approve it',
          status: 'pending_approval',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:05:00.000Z',
          deps: [],
          session_id: 'session-approval',
          review_required: false,
        },
        {
          id: 'task-review',
          title: 'Pending review task',
          description: 'Review needed',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:06:00.000Z',
          updated_at: '2026-04-20T08:07:00.000Z',
          deps: [],
          review_required: true,
        },
        {
          id: 'task-result',
          title: 'Accepted result task',
          description: 'Inspect completed result',
          prompt: 'inspect it',
          status: 'done',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:08:00.000Z',
          updated_at: '2026-04-20T08:09:00.000Z',
          deps: [],
          review_required: false,
          result_summary: 'Completed successfully.',
          result_changed_files: ['src/components/overview/MissionControlView.tsx'],
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-approval', title: 'Approval Session', __provider: 'claude' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Running' })).getByRole('button', { name: 'Open Approval Inbox' }));
    expect(screen.getByRole('heading', { name: 'Approval Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
    expect(screen.getByText('Bash').closest('[data-approval-session-id]')).toHaveAttribute('data-control-plane-focused', 'true');

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Pending Review' })).getByRole('button', { name: 'Open Review Queue' }));
    expect(screen.getByRole('heading', { name: 'Review Queue' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
    expect(document.querySelector('[data-review-task-id="task-review"]')).toHaveAttribute('data-control-plane-focused', 'true');

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Completed' })).getByRole('button', { name: 'Open Result Inbox' }));
    expect(screen.getByRole('heading', { name: 'Result Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
    expect(document.querySelector('[data-result-task-id="task-result"]')).toHaveAttribute('data-control-plane-focused', 'true');
  });

  it('routes linked background runs into the existing review surface when that is the stable task main path', () => {
    storeState.backgroundRuns.recentRuns = [
      {
        id: 'run-review',
        provider: 'codex',
        title: 'Review dispatcher follow-up',
        source: 'task-queue',
        status: 'completed',
        taskId: 'task-review-run',
        sessionId: 'session-review-runtime',
        summary: 'Awaiting review.',
      },
    ];
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-review-run',
          title: 'Review dispatcher follow-up',
          description: 'Awaiting review',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:10:00.000Z',
          deps: [],
          session_id: 'session-review-runtime',
          review_required: true,
          result_summary: 'Awaiting review.',
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [
              { id: 'session-review-runtime', title: 'Review Runtime', __provider: 'codex' },
            ],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Review Queue for Review dispatcher follow-up' }));

    expect(screen.getByRole('heading', { name: 'Review Queue' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
    expect(document.querySelector('[data-review-task-id="task-review-run"]')).toHaveAttribute('data-control-plane-focused', 'true');
  });

  it('keeps structured result-only tasks recoverable in the result inbox', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-result-structured',
          title: 'Recoverable result metadata',
          description: 'Structured result payload only',
          prompt: 'recover it',
          status: 'done',
          provider: 'claude',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T07:00:00.000Z',
          updated_at: '2026-04-20T08:10:00.000Z',
          deps: [],
          review_required: false,
          result_changed_files: ['src/components/overview/MissionControlView.tsx'],
          result_verification_summary: 'npm run vitest MissionControlView',
          result_risk_summary: 'Low risk.',
          result_suggested_next_step: 'Archive after sanity check.',
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Result Inbox' })).toBeInTheDocument();
    expect(screen.getAllByText('Recoverable result metadata')).toHaveLength(2);
    expect(screen.getByText('src/components/overview/MissionControlView.tsx')).toBeInTheDocument();
    expect(screen.getByText('Archive after sanity check.')).toBeInTheDocument();
  });

  it('resets the runtime session while preserving the handoff source when requesting rework', async () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-review',
          title: 'Review dispatch metadata',
          description: 'Inspect role/worktree mapping',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'claude',
          role: 'review',
          execution_strategy: 'handoff',
          worktree_path: '/repo-a/.worktrees/review-dispatch',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          session_id: 'session-review',
          source_session_id: 'session-source',
          review_required: true,
          result_summary: 'Changed dispatcher wiring and added coverage.',
          result_changed_files: ['src/hooks/useAutoExecutor.ts'],
          result_verification_summary: 'npx vitest run src/hooks/useAutoExecutor.test.ts',
          result_risk_summary: 'Low risk.',
          result_suggested_next_step: 'Re-run the task after reviewing the dispatcher output.',
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-review', title: 'Review Session', __provider: 'claude' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rework' }));

    await waitFor(() => {
      expect(storeState.taskStore.updateTask).toHaveBeenCalledWith('/repo-a', 'task-review', {
        status: 'open',
        session_id: '',
        source_session_id: 'session-source',
        review_required: true,
        result_summary: 'Changed dispatcher wiring and added coverage.',
        result_changed_files: [],
        result_verification_summary: '',
        result_risk_summary: '',
        result_suggested_next_step: '',
      });
    });
  });

  it('archives review and recent result items without deleting the durable task', async () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-review',
          title: 'Review dispatch metadata',
          description: 'Inspect role/worktree mapping',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'claude',
          role: 'review',
          execution_strategy: 'handoff',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          session_id: 'session-review',
          review_required: true,
          result_summary: 'Changed dispatcher wiring and added coverage.',
        },
        {
          id: 'task-result',
          title: 'Finish background run panel',
          description: 'Wire up completed state',
          prompt: 'finish it',
          status: 'done',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T07:00:00.000Z',
          updated_at: '2026-04-20T08:10:00.000Z',
          deps: [],
          session_id: 'session-result',
          review_required: false,
          result_summary: 'Background run cards now surface completion summaries.',
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [
              { id: 'session-review', title: 'Review Session', __provider: 'claude' },
              { id: 'session-result', title: 'Result Session', __provider: 'codex' },
            ],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(within(screen.getByRole('region', { name: 'Mission Control decisions column' })).getByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Mission Control operations column' })).getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(storeState.taskStore.updateTask).toHaveBeenCalledWith('/repo-a', 'task-review', {
        status: 'archived',
        review_required: false,
      });
      expect(storeState.taskStore.updateTask).toHaveBeenCalledWith('/repo-a', 'task-result', {
        status: 'archived',
        review_required: false,
      });
    });
  });

  it('moves accepted reviews into the post-review result inbox semantics', async () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-review',
          title: 'Review dispatch metadata',
          description: 'Inspect role/worktree mapping',
          prompt: 'review it',
          status: 'pending_review',
          provider: 'claude',
          role: 'review',
          execution_strategy: 'handoff',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          session_id: 'session-review',
          review_required: true,
          result_summary: 'Changed dispatcher wiring and added coverage.',
          result_changed_files: ['src/hooks/useAutoExecutor.ts'],
          result_risk_summary: 'Review required before accepting this task result.',
          result_suggested_next_step: 'Open Review Queue to inspect the changed files and accept or request rework.',
        },
      ],
    };

    const projects = [
      {
        name: 'repo-a',
        displayName: 'Repo A',
        fullPath: '/repo-a',
        sessions: [
          { id: 'session-review', title: 'Review Session', __provider: 'claude' as const },
        ],
        codexSessions: [],
      },
    ];

    const { rerender } = render(
      <MissionControlView
        projects={projects}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(storeState.taskStore.updateTask).toHaveBeenCalledWith('/repo-a', 'task-review', {
        status: 'done',
        review_required: false,
        result_risk_summary: '',
        result_suggested_next_step: 'Open Result Inbox to inspect the accepted result, then archive when satisfied.',
      });
    });

    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-review',
          title: 'Review dispatch metadata',
          description: 'Inspect role/worktree mapping',
          prompt: 'review it',
          status: 'done',
          provider: 'claude',
          role: 'review',
          execution_strategy: 'handoff',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:31:00.000Z',
          deps: [],
          session_id: 'session-review',
          review_required: false,
          result_summary: 'Changed dispatcher wiring and added coverage.',
          result_changed_files: ['src/hooks/useAutoExecutor.ts'],
          result_risk_summary: '',
          result_suggested_next_step: 'Open Result Inbox to inspect the accepted result, then archive when satisfied.',
        },
      ],
    };

    rerender(
      <MissionControlView
        projects={projects}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Result Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
    expect(document.querySelector('[data-result-task-id="task-review"]')).toHaveAttribute('data-control-plane-focused', 'true');
  });

  it('applies pending Mission Control focus requests when the overview opens from queue routing', async () => {
    useMissionControlStore.setState({
      pendingFocusRequest: {
        target: 'result-inbox',
        locator: { taskId: 'task-result' },
        requestId: 1,
      },
    });
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        {
          id: 'task-result',
          title: 'Completed task',
          description: 'Completed task',
          prompt: 'completed task',
          status: 'done',
          provider: 'codex',
          execution_strategy: 'current_project',
          project_path: '/repo-a',
          created_at: '2026-04-20T08:00:00.000Z',
          updated_at: '2026-04-20T08:30:00.000Z',
          deps: [],
          review_required: false,
          result_summary: 'Completed successfully',
          result_changed_files: ['src/components/task-queue/TaskQueuePanel.tsx'],
        },
      ],
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Result Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
    });
    expect(useMissionControlStore.getState().pendingFocusRequest).toBeNull();
  });

  it('keeps a focused off-list result visible when Mission Control opens from queue routing', async () => {
    useMissionControlStore.setState({
      pendingFocusRequest: {
        target: 'result-inbox',
        locator: { taskId: 'task-result-7' },
        requestId: 2,
      },
    });
    storeState.taskStore.tasksByProject = {
      '/repo-a': Array.from({ length: 7 }, (_, index) => ({
        id: `task-result-${index + 1}`,
        title: `Completed task ${index + 1}`,
        description: `Completed task ${index + 1}`,
        prompt: `completed task ${index + 1}`,
        status: 'done' as const,
        provider: index % 2 === 0 ? 'codex' : 'claude',
        execution_strategy: 'current_project' as const,
        project_path: '/repo-a',
        created_at: `2026-04-20T08:0${index}:00.000Z`,
        updated_at: `2026-04-20T09:0${7 - index}:00.000Z`,
        deps: [],
        review_required: false,
        result_summary: `Completed successfully ${index + 1}`,
        result_changed_files: [`src/result-${index + 1}.ts`],
      })),
    };

    render(
      <MissionControlView
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        isLoading={false}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Result Inbox' }).closest('[data-surface-focused]')).toHaveAttribute('data-surface-focused', 'true');
    });
    expect(document.querySelector('[data-result-task-id="task-result-7"]')).toHaveAttribute('data-control-plane-focused', 'true');
    expect(screen.getByText('Completed task 7')).toBeInTheDocument();
  });
});
