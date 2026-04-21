import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../lib/tauri-bridge';
import type { BackgroundRun } from '../../types/background-run';
import TaskTimelineOverview from './TaskTimelineOverview';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Draft release notes',
    description: 'Draft the customer-facing notes',
    prompt: 'draft release notes',
    status: 'queued',
    provider: 'claude',
    execution_strategy: 'current_project',
    project_path: '/repo-a',
    created_at: '2026-04-20T08:00:00.000Z',
    updated_at: '2026-04-20T08:10:00.000Z',
    deps: [],
    review_required: false,
    ...overrides,
  };
}

function makeRun(overrides: Partial<BackgroundRun> = {}): BackgroundRun {
  return {
    id: 'run-1',
    provider: 'codex',
    title: 'Run draft release notes',
    source: 'mission-control',
    status: 'running',
    ...overrides,
  };
}

describe('TaskTimelineOverview', () => {
  it('renders the durable task flow across backlog, running, review, and completed lanes', () => {
    const onOpenSession = vi.fn();
    const onOpenTaskQueue = vi.fn();
    const onFocusSurface = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[makeTask({ id: 'task-backlog', title: 'Backlog task' })]}
        runningTasks={[
          makeTask({
            id: 'task-running',
            title: 'Running task',
            status: 'in_progress',
            provider: 'codex',
            session_id: 'session-running',
          }),
        ]}
        reviewTasks={[
          makeTask({
            id: 'task-review',
            title: 'Review task',
            status: 'pending_review',
            session_id: 'session-review',
            result_summary: 'Awaiting review before merge.',
            result_changed_files: ['src/components/overview/MissionControlView.tsx'],
          }),
        ]}
        completedTasks={[
          makeTask({
            id: 'task-done',
            title: 'Completed task',
            status: 'done',
            result_summary: 'Finished and ready for archive.',
          }),
        ]}
        backgroundRuns={[
          makeRun({
            taskId: 'task-running',
            sessionId: 'session-running',
            lastOutputExcerpt: 'Collecting task output',
          }),
        ]}
        sessionLabels={{
          'session-running': {
            title: 'Running Session',
            subtitle: 'Repo A · Codex',
          },
          'session-review': {
            title: 'Review Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set(['task-done'])}
        onOpenSession={onOpenSession}
        onOpenTaskQueue={onOpenTaskQueue}
        onFocusSurface={onFocusSurface}
      />,
    );

    expect(screen.getByText('Task Timeline')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task flow Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task flow Running' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task flow Pending Review' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task flow Completed' })).toBeInTheDocument();

    const runningRegion = screen.getByRole('region', { name: 'Task flow Running' });
    expect(within(runningRegion).getByText('Running task')).toBeInTheDocument();
    expect(within(runningRegion).getByText('Collecting task output')).toBeInTheDocument();
    expect(within(runningRegion).getByText('Run · running')).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Backlog' })).getByRole('button', { name: 'Open Task Queue' }));
    expect(onOpenTaskQueue).toHaveBeenCalledWith('/repo-a');

    fireEvent.click(within(runningRegion).getByRole('button', { name: 'Open Session' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-running');

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Pending Review' })).getByRole('button', { name: 'Open Review Queue' }));
    expect(onFocusSurface).toHaveBeenCalledWith('review-queue', { taskId: 'task-review' });

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Completed' })).getByRole('button', { name: 'Open Result Inbox' }));
    expect(onFocusSurface).toHaveBeenCalledWith('result-inbox', { taskId: 'task-done' });
    expect(within(screen.getByRole('region', { name: 'Task flow Completed' })).getByText('Result Inbox')).toBeInTheDocument();
  });

  it('collapses additional tasks behind a simple more-count affordance', () => {
    render(
      <TaskTimelineOverview
        backlogTasks={[
          makeTask({ id: 'task-1', title: 'Backlog one' }),
          makeTask({ id: 'task-2', title: 'Backlog two' }),
          makeTask({ id: 'task-3', title: 'Backlog three' }),
          makeTask({ id: 'task-4', title: 'Backlog four' }),
        ]}
        runningTasks={[]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[]}
        sessionLabels={{}}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={vi.fn()}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={vi.fn()}
      />,
    );

    const backlogRegion = screen.getByRole('region', { name: 'Task flow Backlog' });
    expect(within(backlogRegion).getByText('Backlog one')).toBeInTheDocument();
    expect(within(backlogRegion).getByText('Backlog two')).toBeInTheDocument();
    expect(within(backlogRegion).getByText('Backlog three')).toBeInTheDocument();
    expect(within(backlogRegion).queryByText('Backlog four')).not.toBeInTheDocument();
    expect(within(backlogRegion).getByText('+1 more in backlog')).toBeInTheDocument();
  });

  it('keeps queued handoff follow-up tasks on the same main-path action used elsewhere in Mission Control', () => {
    const onOpenTaskQueue = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[
          makeTask({
            id: 'task-handoff-backlog',
            title: 'Queued handoff follow-up',
            execution_strategy: 'handoff',
            source_session_id: 'session-source',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
          }),
        ]}
        runningTasks={[]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[]}
        sessionLabels={{
          'session-source': {
            title: 'Source Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={vi.fn()}
        onOpenTaskQueue={onOpenTaskQueue}
        onFocusSurface={vi.fn()}
      />,
    );

    const backlogRegion = screen.getByRole('region', { name: 'Task flow Backlog' });
    expect(within(backlogRegion).getAllByText('Handoff')).toHaveLength(2);
    expect(within(backlogRegion).getByText('Source session · Repo A · Claude · Source Session')).toBeInTheDocument();
    expect(within(backlogRegion).getByText('Runtime session · Starts when dispatch begins')).toBeInTheDocument();
    fireEvent.click(within(backlogRegion).getByRole('button', { name: 'Open Handoff Task' }));

    expect(onOpenTaskQueue).toHaveBeenCalledWith('/repo-a');
  });

  it('surfaces control-plane execution metadata for approval and review tasks', () => {
    render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[
          makeTask({
            id: 'task-approval',
            title: 'Approval blocked handoff',
            status: 'pending_approval',
            role: 'review',
            execution_strategy: 'handoff',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
            session_id: 'session-approval',
          }),
        ]}
        reviewTasks={[
          makeTask({
            id: 'task-review',
            title: 'Verify worktree result',
            status: 'pending_review',
            role: 'verify',
            execution_strategy: 'worktree',
            worktree_path: '/repo-a/.worktrees/review-worktree',
            result_summary: 'Awaiting verification sign-off.',
          }),
        ]}
        completedTasks={[]}
        backgroundRuns={[]}
        sessionLabels={{
          'session-approval': {
            title: 'Approval Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set(['session-approval'])}
        resultTaskIds={new Set()}
        onOpenSession={vi.fn()}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={vi.fn()}
      />,
    );

    const runningRegion = screen.getByRole('region', { name: 'Task flow Running' });
    expect(within(runningRegion).getByText('Approval Inbox')).toBeInTheDocument();
    expect(within(runningRegion).getByText('Review')).toBeInTheDocument();
    expect(within(runningRegion).getByText('Handoff')).toBeInTheDocument();
    expect(within(runningRegion).getByText('Dispatch target · review-dispatch worktree')).toBeInTheDocument();
    expect(
      within(runningRegion).getAllByText((content, element) =>
        element?.textContent === 'Worktree path · .worktrees/review-dispatch',
      )[0],
    ).toBeInTheDocument();

    const reviewRegion = screen.getByRole('region', { name: 'Task flow Pending Review' });
    expect(within(reviewRegion).getByText('Review Queue')).toBeInTheDocument();
    expect(within(reviewRegion).getByText('Verify')).toBeInTheDocument();
    expect(within(reviewRegion).getByText('Worktree')).toBeInTheDocument();
    expect(within(reviewRegion).getByText('Dispatch target · review-worktree worktree')).toBeInTheDocument();
    expect(
      within(reviewRegion).getAllByText((content, element) =>
        element?.textContent === 'Worktree path · .worktrees/review-worktree',
      )[0],
    ).toBeInTheDocument();
  });

  it('routes approval-blocked and background-run tasks into the correct existing control surface', () => {
    const onFocusSurface = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[
          makeTask({
            id: 'task-approval',
            title: 'Approval blocked task',
            status: 'pending_approval',
            session_id: 'session-approval',
          }),
          makeTask({
            id: 'task-background',
            title: 'Background-run task',
            status: 'in_progress',
            session_id: undefined,
          }),
        ]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[
          makeRun({
            id: 'run-background',
            taskId: 'task-background',
            status: 'running',
          }),
        ]}
        sessionLabels={{
          'session-approval': {
            title: 'Approval Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set(['session-approval'])}
        resultTaskIds={new Set()}
        onOpenSession={vi.fn()}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={onFocusSurface}
      />,
    );

    const runningRegion = screen.getByRole('region', { name: 'Task flow Running' });
    fireEvent.click(within(runningRegion).getByRole('button', { name: 'Open Approval Inbox' }));
    expect(onFocusSurface).toHaveBeenCalledWith('approval-inbox', { sessionId: 'session-approval' });

    fireEvent.click(within(runningRegion).getByRole('button', { name: 'Open Background Runs' }));
    expect(onFocusSurface).toHaveBeenCalledWith('background-runs', { runId: 'run-background' });
  });

  it('keeps failed and cancelled terminal outcomes in the completed lane with stable follow-up actions', () => {
    const onOpenSession = vi.fn();
    const onOpenTaskQueue = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[]}
        reviewTasks={[]}
        completedTasks={[
          makeTask({
            id: 'task-failed',
            title: 'Failed task',
            status: 'failed',
            session_id: 'session-failed',
            result_summary: 'Agent exited with code 1.',
          }),
          makeTask({
            id: 'task-cancelled',
            title: 'Cancelled handoff',
            status: 'cancelled',
            execution_strategy: 'handoff',
            source_session_id: 'session-source',
            result_summary: 'Cancelled before handoff started',
          }),
        ]}
        backgroundRuns={[]}
        sessionLabels={{
          'session-failed': {
            title: 'Failed Session',
            subtitle: 'Repo A · Codex',
          },
          'session-source': {
            title: 'Source Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={onOpenSession}
        onOpenTaskQueue={onOpenTaskQueue}
        onFocusSurface={vi.fn()}
      />,
    );

    const completedRegion = screen.getByRole('region', { name: 'Task flow Completed' });
    expect(within(completedRegion).getByText('Failed task')).toBeInTheDocument();
    expect(within(completedRegion).getByText('Cancelled handoff')).toBeInTheDocument();
    expect(within(completedRegion).getByText('Agent exited with code 1.')).toBeInTheDocument();
    expect(within(completedRegion).getByText('Cancelled before handoff started')).toBeInTheDocument();

    fireEvent.click(within(completedRegion).getByRole('button', { name: 'Open Session' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-failed');

    fireEvent.click(within(completedRegion).getByRole('button', { name: 'Open Handoff Task' }));
    expect(onOpenTaskQueue).toHaveBeenCalledWith('/repo-a');
  });

  it('prefers Approval Inbox when the approval surface is already visible even before durable task status catches up', () => {
    const onFocusSurface = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[
          makeTask({
            id: 'task-approval-visible',
            title: 'Approval visible task',
            status: 'in_progress',
            session_id: 'session-approval-visible',
          }),
        ]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[]}
        sessionLabels={{
          'session-approval-visible': {
            title: 'Approval Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set(['session-approval-visible'])}
        resultTaskIds={new Set()}
        onOpenSession={vi.fn()}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={onFocusSurface}
      />,
    );

    const runningRegion = screen.getByRole('region', { name: 'Task flow Running' });
    expect(within(runningRegion).getByText('Approval Inbox')).toBeInTheDocument();
    fireEvent.click(within(runningRegion).getByRole('button', { name: 'Open Approval Inbox' }));

    expect(onFocusSurface).toHaveBeenCalledWith('approval-inbox', { sessionId: 'session-approval-visible' });
  });

  it('routes pre-runtime handoff dispatches to background runs instead of the source session', () => {
    const onOpenSession = vi.fn();
    const onFocusSurface = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[
          makeTask({
            id: 'task-handoff-starting',
            title: 'Starting handoff task',
            status: 'dispatched',
            execution_strategy: 'handoff',
            source_session_id: 'source-session-1',
          }),
        ]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[
          makeRun({
            id: 'run-handoff-starting',
            taskId: 'task-handoff-starting',
            sessionId: 'source-session-1',
            processRef: 'source-session-1',
            status: 'starting',
          }),
        ]}
        sessionLabels={{
          'source-session-1': {
            title: 'Source Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={onOpenSession}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={onFocusSurface}
      />,
    );

    const runningRegion = screen.getByRole('region', { name: 'Task flow Running' });
    expect(within(runningRegion).getByText('Background Runs')).toBeInTheDocument();
    expect(within(runningRegion).getByText('Source session · Repo A · Claude · Source Session')).toBeInTheDocument();
    expect(within(runningRegion).getByText('Runtime session · Starting in background')).toBeInTheDocument();
    fireEvent.click(within(runningRegion).getByRole('button', { name: 'Open Background Runs' }));

    expect(onFocusSurface).toHaveBeenCalledWith('background-runs', { runId: 'run-handoff-starting' });
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('keeps worktree-dispatched runs on Background Runs until the runtime session is visible in Mission Control', () => {
    const onOpenSession = vi.fn();
    const onFocusSurface = vi.fn();

    const { rerender } = render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[
          makeTask({
            id: 'task-worktree-starting',
            title: 'Starting worktree task',
            status: 'in_progress',
            execution_strategy: 'worktree',
            session_id: 'synthetic-runtime',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
          }),
        ]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[
          makeRun({
            id: 'run-worktree-starting',
            taskId: 'task-worktree-starting',
            sessionId: 'synthetic-runtime',
            processRef: 'synthetic-runtime',
            status: 'starting',
          }),
        ]}
        sessionLabels={{}}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={onOpenSession}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={onFocusSurface}
      />,
    );

    const runningRegion = screen.getByRole('region', { name: 'Task flow Running' });
    fireEvent.click(within(runningRegion).getByRole('button', { name: 'Open Background Runs' }));

    expect(onFocusSurface).toHaveBeenCalledWith('background-runs', { runId: 'run-worktree-starting' });
    expect(onOpenSession).not.toHaveBeenCalled();

    rerender(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[
          makeTask({
            id: 'task-worktree-starting',
            title: 'Starting worktree task',
            status: 'in_progress',
            execution_strategy: 'worktree',
            session_id: 'synthetic-runtime',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
          }),
        ]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[
          makeRun({
            id: 'run-worktree-starting',
            taskId: 'task-worktree-starting',
            sessionId: 'synthetic-runtime',
            processRef: 'synthetic-runtime',
            status: 'starting',
          }),
        ]}
        sessionLabels={{
          'synthetic-runtime': {
            title: 'Worktree Runtime',
            subtitle: 'Repo A · Codex',
          },
        }}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={onOpenSession}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={onFocusSurface}
      />,
    );

    fireEvent.click(within(screen.getByRole('region', { name: 'Task flow Running' })).getByRole('button', { name: 'Open Session' }));
    expect(onOpenSession).toHaveBeenCalledWith('synthetic-runtime');
  });

  it('falls back to the runtime session when a completed result is outside the visible result inbox slice', () => {
    const onOpenSession = vi.fn();
    const onFocusSurface = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[]}
        reviewTasks={[]}
        completedTasks={[
          makeTask({
            id: 'task-hidden-result',
            title: 'Hidden result task',
            status: 'done',
            session_id: 'session-hidden-result',
            result_summary: 'Finished but not currently surfaced in the inbox.',
          }),
        ]}
        backgroundRuns={[]}
        sessionLabels={{
          'session-hidden-result': {
            title: 'Hidden Result Session',
            subtitle: 'Repo A · Codex',
          },
        }}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={onOpenSession}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={onFocusSurface}
      />,
    );

    const completedRegion = screen.getByRole('region', { name: 'Task flow Completed' });
    expect(within(completedRegion).queryByText('Result Inbox')).not.toBeInTheDocument();
    fireEvent.click(within(completedRegion).getByRole('button', { name: 'Open Session' }));

    expect(onOpenSession).toHaveBeenCalledWith('session-hidden-result');
    expect(onFocusSurface).not.toHaveBeenCalled();
  });

  it('falls back to the runtime session when a pending-approval task no longer has an active approval request', () => {
    const onOpenSession = vi.fn();
    const onFocusSurface = vi.fn();

    render(
      <TaskTimelineOverview
        backlogTasks={[]}
        runningTasks={[
          makeTask({
            id: 'task-stale-approval',
            title: 'Stale approval task',
            status: 'pending_approval',
            session_id: 'session-stale-approval',
          }),
        ]}
        reviewTasks={[]}
        completedTasks={[]}
        backgroundRuns={[]}
        sessionLabels={{
          'session-stale-approval': {
            title: 'Stale Approval Session',
            subtitle: 'Repo A · Claude',
          },
        }}
        pendingApprovalSessionIds={new Set()}
        resultTaskIds={new Set()}
        onOpenSession={onOpenSession}
        onOpenTaskQueue={vi.fn()}
        onFocusSurface={onFocusSurface}
      />,
    );

    const runningRegion = screen.getByRole('region', { name: 'Task flow Running' });
    expect(within(runningRegion).queryByText('Approval Inbox')).not.toBeInTheDocument();
    fireEvent.click(within(runningRegion).getByRole('button', { name: 'Open Session' }));

    expect(onOpenSession).toHaveBeenCalledWith('session-stale-approval');
    expect(onFocusSurface).not.toHaveBeenCalled();
  });
});
