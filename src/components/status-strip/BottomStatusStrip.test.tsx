import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../lib/tauri-bridge';
import BottomStatusStrip from './BottomStatusStrip';

const storeState = vi.hoisted(() => ({
  sessionStatus: {
    statuses: {} as Record<string, { status: 'idle' | 'processing' | 'needs_attention' | 'completed' }>,
  },
  attention: {
    attentionItems: {} as Record<string, { status: 'active' | 'resolved' | 'dismissed'; updatedAt: number; reason: string; sessionId: string }>,
    approvalRequests: {} as Record<string, { status: 'pending' | 'approved' | 'denied' | 'expired'; updatedAt: number; sessionId: string }>,
  },
  taskStore: {
    tasksByProject: {} as Record<string, Task[]>,
    refresh: vi.fn(async () => []),
  },
}));

vi.mock('../../stores/sessionStatusStore', () => ({
  useSessionStatusStore: (selector: (state: typeof storeState.sessionStatus) => unknown) =>
    selector(storeState.sessionStatus),
}));

vi.mock('../../stores/attentionStore', () => ({
  useAttentionStore: (selector: (state: typeof storeState.attention) => unknown) =>
    selector(storeState.attention),
}));

vi.mock('../../stores/taskStore', () => ({
  countRunningDurableTasks: (tasks: Task[]) => tasks.filter((task) => ['dispatched', 'in_progress', 'pending_approval'].includes(task.status)).length,
  countQueuedDurableTasks: (tasks: Task[]) => tasks.filter((task) => ['open', 'queued'].includes(task.status)).length,
  useTaskStore: (selector: (state: typeof storeState.taskStore) => unknown) =>
    selector(storeState.taskStore),
}));

describe('BottomStatusStrip', () => {
  beforeEach(() => {
    storeState.sessionStatus.statuses = {};
    storeState.attention.attentionItems = {};
    storeState.attention.approvalRequests = {};
    storeState.taskStore.tasksByProject = {};
    storeState.taskStore.refresh.mockClear();
  });

  it('renders durable task running and queued counts from taskStore', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        { id: 'task-queued', status: 'queued', project_path: '/repo-a' } as Task,
        { id: 'task-open', status: 'open', project_path: '/repo-a' } as Task,
        { id: 'task-running', status: 'in_progress', project_path: '/repo-a' } as Task,
        { id: 'task-done', status: 'done', project_path: '/repo-a' } as Task,
      ],
    };

    render(
      <BottomStatusStrip
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        selectedSession={null}
        onSelectSession={vi.fn()}
      />,
    );

    expect(storeState.taskStore.refresh).toHaveBeenCalledWith('/repo-a');
    expect(screen.getByRole('button', { name: 'Open Running' })).toHaveTextContent('1Running');
    expect(screen.getByRole('button', { name: 'Open Backlog' })).toHaveTextContent('2Backlog');
    expect(screen.queryByRole('button', { name: 'Open Attention' })).not.toBeInTheDocument();
  });

  it('routes compact control-plane counts into Mission Control surfaces', () => {
    const onOpenMissionControlSurface = vi.fn();
    storeState.attention.approvalRequests = {
      'session-approval': {
        status: 'pending',
        updatedAt: 2,
        sessionId: 'session-approval',
      },
    };
    storeState.attention.attentionItems = {
      'attention-1': {
        status: 'active',
        updatedAt: 1,
        reason: 'error',
        sessionId: 'session-error',
      },
    };
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        { id: 'task-review', status: 'pending_review', project_path: '/repo-a' } as Task,
        {
          id: 'task-result',
          status: 'done',
          review_required: false,
          project_path: '/repo-a',
          result_summary: 'Accepted result',
        } as Task,
      ],
    };

    render(
      <BottomStatusStrip
        projects={[
          {
            name: 'repo-a',
            displayName: 'Repo A',
            fullPath: '/repo-a',
            sessions: [],
            codexSessions: [],
          },
        ]}
        selectedSession={null}
        onSelectSession={vi.fn()}
        onOpenMissionControlSurface={onOpenMissionControlSurface}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Approval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Attention' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Results' }));

    expect(onOpenMissionControlSurface).toHaveBeenNthCalledWith(1, 'approval-inbox');
    expect(onOpenMissionControlSurface).toHaveBeenNthCalledWith(2, 'attention-inbox');
    expect(onOpenMissionControlSurface).toHaveBeenNthCalledWith(3, 'review-queue');
    expect(onOpenMissionControlSurface).toHaveBeenNthCalledWith(4, 'result-inbox');
  });
});
