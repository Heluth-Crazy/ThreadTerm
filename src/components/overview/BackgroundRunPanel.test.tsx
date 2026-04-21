import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundRun } from '../../types/background-run';
import type { Task } from '../../lib/tauri-bridge';
import BackgroundRunPanel from './BackgroundRunPanel';

function makeRun(overrides: Partial<BackgroundRun> = {}): BackgroundRun {
  return {
    id: 'run-1',
    provider: 'codex',
    title: 'Index project docs',
    source: 'mission-control',
    status: 'running',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Review API patch',
    description: 'Review API patch',
    prompt: 'Review API patch',
    status: 'in_progress',
    provider: 'codex',
    execution_strategy: 'handoff',
    project_path: '/repo-a',
    created_at: '2026-04-21T09:00:00.000Z',
    updated_at: '2026-04-21T09:00:00.000Z',
    deps: [],
    review_required: false,
    session_id: 'runtime-session',
    source_session_id: 'source-session',
    ...overrides,
  };
}

describe('BackgroundRunPanel', () => {
  it('displays an active run', () => {
    render(
      <BackgroundRunPanel
        activeRuns={[
          makeRun({
            lastOutputExcerpt: 'Collecting repository context',
          }),
        ]}
        recentRuns={[]}
        onOpenSession={vi.fn()}
      />,
    );

    const activeRegion = screen.getByRole('region', { name: 'Active Background Runs' });
    expect(within(activeRegion).getByText('Index project docs')).toBeInTheDocument();
    expect(within(activeRegion).getByText('Collecting repository context')).toBeInTheDocument();
  });

  it('displays a completed run in the recent section', () => {
    render(
      <BackgroundRunPanel
        activeRuns={[]}
        recentRuns={[
          makeRun({
            id: 'run-2',
            title: 'Summarize logs',
            status: 'completed',
            summary: 'Finished successfully',
          }),
        ]}
        onOpenSession={vi.fn()}
      />,
    );

    const recentRegion = screen.getByRole('region', { name: 'Recently Finished' });
    expect(within(recentRegion).getByText('Summarize logs')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Summary')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Finished successfully')).toBeInTheDocument();
  });

  it('shows only a small recent completed window', () => {
    render(
      <BackgroundRunPanel
        activeRuns={[]}
        recentRuns={[
          makeRun({ id: 'run-1', title: 'Recent item 1', status: 'completed', summary: 'Done 1' }),
          makeRun({ id: 'run-2', title: 'Recent item 2', status: 'completed', summary: 'Done 2' }),
          makeRun({ id: 'run-3', title: 'Recent item 3', status: 'completed', summary: 'Done 3' }),
          makeRun({ id: 'run-4', title: 'Older item', status: 'completed', summary: 'Done 4' }),
        ]}
        onOpenSession={vi.fn()}
      />,
    );

    const recentRegion = screen.getByRole('region', { name: 'Recently Finished' });
    expect(within(recentRegion).getByText('Recent item 1')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Recent item 2')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Recent item 3')).toBeInTheDocument();
    expect(within(recentRegion).queryByText('Older item')).not.toBeInTheDocument();
    expect(within(screen.getByText('Background Runs').closest('section') as HTMLElement).getByText('3')).toBeInTheDocument();
  });

  it('shows summary or last output excerpt for each completed item', () => {
    render(
      <BackgroundRunPanel
        activeRuns={[]}
        recentRuns={[
          makeRun({
            id: 'run-2',
            title: 'Summary-backed run',
            status: 'completed',
            summary: 'Finished successfully',
          }),
          makeRun({
            id: 'run-3',
            title: 'Excerpt-backed run',
            status: 'completed',
            lastOutputExcerpt: 'Indexed 42 files before exit',
          }),
        ]}
        onOpenSession={vi.fn()}
      />,
    );

    const recentRegion = screen.getByRole('region', { name: 'Recently Finished' });
    expect(within(recentRegion).getByText('Summary-backed run')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Summary')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Finished successfully')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Excerpt-backed run')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Last output')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Indexed 42 files before exit')).toBeInTheDocument();
  });

  it('keeps failed runs visible in the recent section', () => {
    render(
      <BackgroundRunPanel
        activeRuns={[]}
        recentRuns={[
          makeRun({
            id: 'run-2',
            title: 'Failed worker',
            status: 'failed',
            lastOutputExcerpt: 'Agent exited with code 1',
          }),
        ]}
        onOpenSession={vi.fn()}
      />,
    );

    const recentRegion = screen.getByRole('region', { name: 'Recently Finished' });
    expect(within(recentRegion).getByText('Failed worker')).toBeInTheDocument();
    expect(within(recentRegion).getByText('failed')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Agent exited with code 1')).toBeInTheDocument();
  });

  it('opens the related session when a run has a session id', () => {
    const onOpenSession = vi.fn();

    render(
      <BackgroundRunPanel
        activeRuns={[
          makeRun({
            sessionId: 'session-42',
          }),
        ]}
        recentRuns={[]}
        onOpenSession={onOpenSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Session for Index project docs' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-42');
  });

  it('shows handoff execution context for worktree-aware background runs', () => {
    render(
      <BackgroundRunPanel
        activeRuns={[
          makeRun({
            id: 'run-handoff',
            title: 'Review API patch',
            status: 'running',
            sessionId: 'runtime-session',
            sourceSessionId: 'source-session',
            taskRole: 'review',
            executionStrategy: 'handoff',
            worktreePath: '/tmp/project-worktrees/review-a',
            lastOutputExcerpt: 'Handoff launched in the target runtime session for the review-a worktree.',
          }),
        ]}
        recentRuns={[]}
        onOpenSession={vi.fn()}
        sessionLabels={{
          'runtime-session': {
            title: 'Review worker',
            subtitle: 'OpenWork · Codex',
          },
          'source-session': {
            title: 'Planning session',
            subtitle: 'OpenWork · Claude',
          },
        }}
      />,
    );

    const activeRegion = screen.getByRole('region', { name: 'Active Background Runs' });
    expect(within(activeRegion).getByText('Review')).toBeInTheDocument();
    expect(within(activeRegion).getByText('Handoff')).toBeInTheDocument();
    expect(within(activeRegion).getByText('review-a worktree')).toBeInTheDocument();
    expect(within(activeRegion).getByText('Source session · OpenWork · Claude · Planning session')).toBeInTheDocument();
    expect(within(activeRegion).getByRole('button', { name: 'Open Handoff Session for Review API patch' })).toBeInTheDocument();
  });

  it('keeps queued handoff runs bound to the source session until a runtime session exists', () => {
    const onOpenSession = vi.fn();

    render(
      <BackgroundRunPanel
        activeRuns={[
          makeRun({
            id: 'run-handoff-queued',
            title: 'Queue follow-up review',
            status: 'starting',
            sessionId: 'source-session',
            sourceSessionId: 'source-session',
            taskRole: 'review',
            executionStrategy: 'handoff',
          }),
        ]}
        recentRuns={[]}
        onOpenSession={onOpenSession}
        sessionLabels={{
          'source-session': {
            title: 'Planning session',
            subtitle: 'OpenWork · Claude',
          },
        }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Open Source Session for Queue follow-up review' });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onOpenSession).toHaveBeenCalledWith('source-session');
  });

  it('routes approval-blocked linked runs into Approval Inbox instead of reopening the runtime session', () => {
    const onOpenSession = vi.fn();
    const onFocusSurface = vi.fn();

    render(
      <BackgroundRunPanel
        activeRuns={[
          makeRun({
            id: 'run-approval',
            title: 'Approval-gated run',
            status: 'awaiting_input',
            sessionId: 'runtime-session',
            sourceSessionId: 'source-session',
            executionStrategy: 'handoff',
            requiresApproval: true,
          }),
        ]}
        recentRuns={[]}
        onOpenSession={onOpenSession}
        onFocusSurface={onFocusSurface}
        linkedTasksByRunId={new Map([
          ['run-approval', makeTask({ id: 'task-approval', status: 'pending_approval' })],
        ])}
        pendingApprovalSessionIds={new Set(['runtime-session'])}
        availableSessionIds={new Set(['runtime-session'])}
        sessionLabels={{
          'runtime-session': {
            title: 'Runtime Session',
            subtitle: 'OpenWork · Codex',
          },
        }}
      />,
    );

    const activeRegion = screen.getByRole('region', { name: 'Active Background Runs' });
    expect(within(activeRegion).getByText('Approval Inbox')).toBeInTheDocument();

    fireEvent.click(within(activeRegion).getByRole('button', { name: 'Open Approval Inbox for Approval-gated run' }));
    expect(onFocusSurface).toHaveBeenCalledWith('approval-inbox', { sessionId: 'runtime-session' });
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('routes completed linked runs into Review Queue and Result Inbox using durable task state', () => {
    const onOpenSession = vi.fn();
    const onFocusSurface = vi.fn();

    render(
      <BackgroundRunPanel
        activeRuns={[]}
        recentRuns={[
          makeRun({
            id: 'run-review',
            title: 'Pending review run',
            status: 'completed',
            sessionId: 'review-session',
            summary: 'Awaiting review.',
          }),
          makeRun({
            id: 'run-result',
            title: 'Accepted result run',
            status: 'completed',
            sessionId: 'result-session',
            summary: 'Accepted result ready to archive.',
          }),
        ]}
        onOpenSession={onOpenSession}
        onFocusSurface={onFocusSurface}
        linkedTasksByRunId={new Map([
          ['run-review', makeTask({ id: 'task-review', status: 'pending_review', session_id: 'review-session', review_required: true })],
          ['run-result', makeTask({
            id: 'task-result',
            status: 'done',
            execution_strategy: 'current_project',
            session_id: 'result-session',
            source_session_id: '',
            review_required: false,
            result_summary: 'Accepted result ready to archive.',
            result_changed_files: ['src/components/overview/BackgroundRunPanel.tsx'],
          })],
        ])}
        availableSessionIds={new Set(['review-session', 'result-session'])}
        resultTaskIds={new Set(['task-result'])}
        sessionLabels={{
          'review-session': {
            title: 'Review Session',
            subtitle: 'OpenWork · Claude',
          },
          'result-session': {
            title: 'Result Session',
            subtitle: 'OpenWork · Codex',
          },
        }}
      />,
    );

    const recentRegion = screen.getByRole('region', { name: 'Recently Finished' });
    expect(within(recentRegion).getByText('Review Queue')).toBeInTheDocument();
    expect(within(recentRegion).getByText('Result Inbox')).toBeInTheDocument();

    fireEvent.click(within(recentRegion).getByRole('button', { name: 'Open Review Queue for Pending review run' }));
    expect(onFocusSurface).toHaveBeenCalledWith('review-queue', { taskId: 'task-review' });

    fireEvent.click(within(recentRegion).getByRole('button', { name: 'Open Result Inbox for Accepted result run' }));
    expect(onFocusSurface).toHaveBeenCalledWith('result-inbox', { taskId: 'task-result' });
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});
