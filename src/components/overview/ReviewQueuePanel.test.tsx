import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../lib/tauri-bridge';

const { gitDiffMock } = vi.hoisted(() => ({
  gitDiffMock: vi.fn<(projectPath: string, filePath?: string) => Promise<string>>(),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  git: {
    diff: gitDiffMock,
  },
}));

import ReviewQueuePanel from './ReviewQueuePanel';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Review durable archive flow',
    description: 'Review durable archive flow',
    prompt: 'Review durable archive flow',
    status: 'pending_review',
    provider: 'claude',
    execution_strategy: 'handoff',
    project_path: '/repo-a',
    created_at: '2026-04-20T08:00:00.000Z',
    updated_at: '2026-04-20T08:05:00.000Z',
    deps: [],
    review_required: true,
    result_summary: 'Result summary',
    ...overrides,
  };
}

describe('ReviewQueuePanel', () => {
  beforeEach(() => {
    gitDiffMock.mockReset();
    gitDiffMock.mockResolvedValue('diff --git a/file b/file\n+new line');
  });

  it('exposes archive actions for both review and recent result items', () => {
    const onArchiveTask = vi.fn();

    render(
      <ReviewQueuePanel
        reviewTasks={[makeTask({ id: 'review-task', session_id: 'session-review' })]}
        recentResults={[makeTask({ id: 'result-task', status: 'done', review_required: false, session_id: 'session-result' })]}
        sessionLabels={{
          'session-review': { title: 'Review Session', subtitle: 'Repo A · Claude' },
          'session-result': { title: 'Result Session', subtitle: 'Repo A · Claude' },
        }}
        onAcceptReview={vi.fn()}
        onRequestRework={vi.fn()}
        onArchiveTask={onArchiveTask}
        onOpenSession={vi.fn()}
      />,
    );

    const archiveButtons = screen.getAllByRole('button', { name: 'Archive' });
    expect(archiveButtons).toHaveLength(2);

    fireEvent.click(archiveButtons[0]);
    fireEvent.click(archiveButtons[1]);

    expect(onArchiveTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'review-task' }));
    expect(onArchiveTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'result-task' }));
  });

  it('renders structured result metadata when present', () => {
    render(
      <ReviewQueuePanel
        reviewTasks={[
          makeTask({
            id: 'review-task',
            result_changed_files: ['src-tauri/src/tasks.rs', 'src/components/overview/ReviewQueuePanel.tsx'],
            result_verification_summary: 'cargo test --lib tasks',
            result_risk_summary: 'Low risk, scoped to task metadata and UI presentation.',
            result_suggested_next_step: 'Approve after checking the changed files list.',
          }),
        ]}
        recentResults={[
          makeTask({
            id: 'result-task',
            status: 'done',
            review_required: false,
            result_summary: undefined,
            result_changed_files: ['src/components/overview/MissionControlView.tsx'],
            result_verification_summary: 'npm run vitest MissionControlView',
          }),
        ]}
        sessionLabels={{}}
        onAcceptReview={vi.fn()}
        onRequestRework={vi.fn()}
        onArchiveTask={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Changed files')).toHaveLength(2);
    expect(screen.getByText('src-tauri/src/tasks.rs')).toBeInTheDocument();
    expect(screen.getByText('src/components/overview/ReviewQueuePanel.tsx')).toBeInTheDocument();
    expect(screen.getByText('cargo test --lib tasks')).toBeInTheDocument();
    expect(screen.getByText('Low risk, scoped to task metadata and UI presentation.')).toBeInTheDocument();
    expect(screen.getByText('Approve after checking the changed files list.')).toBeInTheDocument();
    expect(screen.getByText('src/components/overview/MissionControlView.tsx')).toBeInTheDocument();
    expect(screen.getByText('npm run vitest MissionControlView')).toBeInTheDocument();
  });

  it('renders execution metadata on result inbox cards when available', () => {
    render(
      <ReviewQueuePanel
        reviewTasks={[]}
        recentResults={[
          makeTask({
            id: 'result-task',
            status: 'done',
            review_required: false,
            role: 'verify',
            execution_strategy: 'handoff',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
            session_id: 'session-runtime',
            source_session_id: 'session-source',
          }),
        ]}
        sessionLabels={{
          'session-source': { title: 'Source Session', subtitle: 'Repo A · Claude' },
          'session-runtime': { title: 'Runtime Session', subtitle: 'Repo A · Codex' },
        }}
        onAcceptReview={vi.fn()}
        onRequestRework={vi.fn()}
        onArchiveTask={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
    expect(screen.getByText('Handoff')).toBeInTheDocument();
    expect(screen.getByText('Dispatch target · review-dispatch worktree')).toBeInTheDocument();
    expect(
      screen.getByText((content, element) =>
        element?.textContent === 'Worktree path · .worktrees/review-dispatch',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        element?.textContent === 'Source session · Repo A · Claude · Source Session',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        element?.textContent === 'Runtime session · Repo A · Codex · Runtime Session',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Handoff Session' })).toBeInTheDocument();
  });

  it('keeps simple cards compact when structured metadata is absent', () => {
    render(
      <ReviewQueuePanel
        reviewTasks={[makeTask({ id: 'review-task', result_summary: undefined })]}
        recentResults={[]}
        sessionLabels={{}}
        onAcceptReview={vi.fn()}
        onRequestRework={vi.fn()}
        onArchiveTask={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.queryByText('Changed files')).not.toBeInTheDocument();
    expect(screen.queryByText('Verification')).not.toBeInTheDocument();
    expect(screen.queryByText('Risk')).not.toBeInTheDocument();
    expect(screen.queryByText('Next step')).not.toBeInTheDocument();
  });

  it('loads compare diffs for review and result tasks when changed files exist', async () => {
    gitDiffMock.mockImplementation(async (projectPath, filePath) => {
      if (projectPath === '/repo-a/.worktrees/review-dispatch' && filePath === 'src-tauri/src/tasks.rs') {
        return 'diff --git a/src-tauri/src/tasks.rs b/src-tauri/src/tasks.rs\n+review change';
      }
      if (projectPath === '/repo-a/.worktrees/review-dispatch' && filePath === 'src/components/overview/ReviewQueuePanel.tsx') {
        return 'diff --git a/src/components/overview/ReviewQueuePanel.tsx b/src/components/overview/ReviewQueuePanel.tsx\n+panel change';
      }
      if (projectPath === '/repo-a' && filePath === 'src/components/overview/BackgroundRunPanel.tsx') {
        return 'diff --git a/src/components/overview/BackgroundRunPanel.tsx b/src/components/overview/BackgroundRunPanel.tsx\n+result change';
      }
      return '';
    });

    render(
      <ReviewQueuePanel
        reviewTasks={[
          makeTask({
            id: 'review-task',
            worktree_path: '/repo-a/.worktrees/review-dispatch',
            result_changed_files: ['src-tauri/src/tasks.rs', 'src/components/overview/ReviewQueuePanel.tsx'],
          }),
        ]}
        recentResults={[
          makeTask({
            id: 'result-task',
            status: 'done',
            review_required: false,
            result_changed_files: ['src/components/overview/BackgroundRunPanel.tsx'],
          }),
        ]}
        sessionLabels={{}}
        onAcceptReview={vi.fn()}
        onRequestRework={vi.fn()}
        onArchiveTask={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    const compareButtons = screen.getAllByRole('button', { name: 'Compare' });
    expect(compareButtons).toHaveLength(2);

    fireEvent.click(compareButtons[0]);

    expect(await screen.findByText('Changed-file compare')).toBeInTheDocument();
    expect(await screen.findByText('+review change')).toBeInTheDocument();
    expect(screen.getByText('+panel change')).toBeInTheDocument();

    await waitFor(() => {
      expect(gitDiffMock).toHaveBeenCalledWith('/repo-a/.worktrees/review-dispatch', 'src-tauri/src/tasks.rs');
      expect(gitDiffMock).toHaveBeenCalledWith('/repo-a/.worktrees/review-dispatch', 'src/components/overview/ReviewQueuePanel.tsx');
    });

    fireEvent.click(compareButtons[1]);

    expect(await screen.findByText('+result change')).toBeInTheDocument();
    expect(gitDiffMock).toHaveBeenCalledWith('/repo-a', 'src/components/overview/BackgroundRunPanel.tsx');
  });

  it('shows empty and error compare states clearly', async () => {
    gitDiffMock.mockImplementation(async (_projectPath, filePath) => {
      if (filePath === 'src-tauri/src/tasks.rs') {
        return '';
      }
      throw new Error('git diff failed');
    });

    render(
      <ReviewQueuePanel
        reviewTasks={[
          makeTask({
            id: 'review-task',
            result_changed_files: ['src-tauri/src/tasks.rs', 'src/components/overview/ReviewQueuePanel.tsx'],
          }),
        ]}
        recentResults={[]}
        sessionLabels={{}}
        onAcceptReview={vi.fn()}
        onRequestRework={vi.fn()}
        onArchiveTask={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));

    expect(await screen.findByText('No git diff output is currently available for these changed files.')).toBeInTheDocument();
    expect(screen.getByText('No diff output available for this file.')).toBeInTheDocument();
    expect(screen.getByText('Unable to load diff for this file: git diff failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
