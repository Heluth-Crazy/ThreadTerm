import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionCard from './SessionCard';
import type { Task } from '../../lib/tauri-bridge';

const storeState = vi.hoisted(() => ({
  sessionStatus: {
    getStatus: vi.fn(),
  },
  attention: {
    approvalRequests: {} as Record<string, unknown>,
    attentionItems: {} as Record<string, { sessionId: string; status: 'active' | 'resolved' | 'dismissed'; reason: string }>,
  },
}));

vi.mock('../../stores/sessionStatusStore', () => ({
  useSessionStatusStore: (selector: (state: typeof storeState.sessionStatus) => unknown) => selector(storeState.sessionStatus),
}));

vi.mock('../../stores/attentionStore', () => ({
  useAttentionStore: (selector: (state: typeof storeState.attention) => unknown) => selector(storeState.attention),
}));

describe('SessionCard', () => {
  beforeEach(() => {
    storeState.attention.approvalRequests = {};
    storeState.attention.attentionItems = {};
    storeState.sessionStatus.getStatus.mockReturnValue({
      status: 'processing',
      updatedAt: Date.now(),
      provider: 'claude',
      taskId: 'task-1',
      taskTitle: 'Refine Mission Control handoff state',
      taskStatus: 'pending_review',
      taskRole: 'verify',
      taskExecutionStrategy: 'handoff',
      projectPath: '/tmp/openwork',
      worktreePath: '/tmp/openwork-worktrees/dispatch-a',
    });
  });

  it('shows projected task strategy and worktree metadata on the session card', () => {
    render(
      <SessionCard
        session={{ id: 'session-1', title: 'Dispatch session', __provider: 'claude' }}
        project={{
          name: 'openwork',
          displayName: 'OpenWork',
          fullPath: '/tmp/openwork',
          branch: 'feat/control-plane',
          worktreePath: '/tmp/openwork-worktrees/dispatch-a',
        }}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText((content) => content.includes('Refine Mission Control handoff state'))).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
    expect(screen.getByText('Handoff')).toBeInTheDocument();
    expect(screen.getByText('Review Queue')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · dispatch-a worktree')).toBeInTheDocument();
  });

  it('shows queued handoff source metadata from the durable task when no runtime projection exists yet', () => {
    storeState.sessionStatus.getStatus.mockReturnValue({
      status: 'idle',
      updatedAt: Date.now(),
      provider: 'claude',
    });

    render(
      <SessionCard
        session={{ id: 'session-source', title: 'Source Session', __provider: 'claude' }}
        project={{
          name: 'openwork',
          displayName: 'OpenWork',
          fullPath: '/tmp/openwork',
          branch: 'feat/control-plane',
        }}
        linkedTask={{
          id: 'task-handoff',
          title: 'Queue durable handoff',
          prompt: 'Queue durable handoff',
          status: 'queued',
          provider: 'codex',
          execution_strategy: 'handoff',
          worktree_path: '/tmp/openwork-worktrees/review-a',
          project_path: '/tmp/openwork',
          created_at: '2026-04-21T09:00:00.000Z',
          updated_at: '2026-04-21T09:00:00.000Z',
          deps: [],
          review_required: false,
          source_session_id: 'session-source',
        } as Task}
        taskSessionBinding="source"
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText((content) => content.includes('Queue durable handoff'))).toBeInTheDocument();
    expect(screen.getAllByText('Handoff')).toHaveLength(2);
    expect(screen.getByText('Handoff Source')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · review-a worktree')).toBeInTheDocument();
    expect(screen.getByText('Source session · This session')).toBeInTheDocument();
  });

  it('keeps legacy queued handoff tasks on the source-session workflow until a runtime exists', () => {
    storeState.sessionStatus.getStatus.mockReturnValue({
      status: 'idle',
      updatedAt: Date.now(),
      provider: 'claude',
    });

    render(
      <SessionCard
        session={{ id: 'session-source', title: 'Source Session', __provider: 'claude' }}
        project={{
          name: 'openwork',
          displayName: 'OpenWork',
          fullPath: '/tmp/openwork',
          branch: 'feat/control-plane',
          worktreePath: '/tmp/openwork-worktrees/review-a',
        }}
        linkedTask={{
          id: 'task-handoff-legacy',
          title: 'Legacy queued handoff',
          prompt: 'Legacy queued handoff',
          status: 'queued',
          provider: 'codex',
          execution_strategy: 'handoff',
          project_path: '/tmp/openwork',
          created_at: '2026-04-21T09:00:00.000Z',
          updated_at: '2026-04-21T09:00:00.000Z',
          deps: [],
          review_required: false,
          session_id: 'session-source',
        } as Task}
        taskSessionBinding="source"
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText((content) => content.includes('Legacy queued handoff'))).toBeInTheDocument();
    expect(screen.getByText('Handoff Source')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · review-a worktree')).toBeInTheDocument();
    expect(screen.getByText('Source session · This session')).toBeInTheDocument();
  });

  it('does not invent a worktree badge for current-project runtime projections', () => {
    storeState.sessionStatus.getStatus.mockReturnValue({
      status: 'processing',
      updatedAt: Date.now(),
      provider: 'claude',
      taskId: 'task-current-project',
      taskTitle: 'Current project task',
      taskStatus: 'in_progress',
      taskRole: 'implement',
      taskExecutionStrategy: 'current_project',
      projectPath: '/tmp/openwork',
      worktreePath: undefined,
    });

    render(
      <SessionCard
        session={{ id: 'session-current-project', title: 'Current Project Session', __provider: 'claude' }}
        project={{
          name: 'openwork',
          displayName: 'OpenWork',
          fullPath: '/tmp/openwork',
          branch: 'feat/control-plane',
        }}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('This Project')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · This project')).toBeInTheDocument();
  });
});
