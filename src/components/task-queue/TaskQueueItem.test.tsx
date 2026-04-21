import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskQueueItem } from './TaskQueueItem';
import type { Task } from '../../lib/tauri-bridge';
import type { TaskMainPathBadge } from '../../lib/task-main-path';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Review queue metadata',
    description: 'Review queue metadata',
    prompt: 'Review queue metadata',
    status: 'queued',
    provider: 'codex',
    execution_strategy: 'handoff',
    project_path: '/tmp/openwork',
    created_at: '2026-04-20T08:00:00.000Z',
    updated_at: '2026-04-20T08:00:05.000Z',
    deps: [],
    review_required: false,
    ...overrides,
  };
}

describe('TaskQueueItem', () => {
  it('shows productized session labels plus the primary handoff action', () => {
    const mainPathBadge: TaskMainPathBadge = {
      kind: 'surface',
      label: 'Background Runs',
      surfaceTarget: 'background-runs',
    };

    render(
      <TaskQueueItem
        task={makeTask({
          role: 'review',
          worktree_path: '/tmp/openwork-worktrees/review-a',
          source_session_id: 'source-session-1',
          session_id: 'runtime-session-1',
        })}
        primaryAction={{ label: 'Open Handoff Session', onClick: vi.fn() }}
        mainPathBadge={mainPathBadge}
        sourceSessionLabel="OpenWork · Claude · Source Session"
        runtimeSessionLabel="OpenWork · Codex · Runtime Session"
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText((content) => content.includes('Codex') && content.includes('Handoff'))).toBeInTheDocument();
    expect(screen.getByText('Background Runs')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('Dispatch target · review-a worktree'))).toBeInTheDocument();
    expect(screen.getByText('Source session · OpenWork · Claude · Source Session')).toBeInTheDocument();
    expect(screen.getByText('Runtime session · OpenWork · Codex · Runtime Session')).toBeInTheDocument();
    expect(screen.getByText('Worktree path · openwork-worktrees/review-a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Handoff Session' })).toBeInTheDocument();
  });
});
