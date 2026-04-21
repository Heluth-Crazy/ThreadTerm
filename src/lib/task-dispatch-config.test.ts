import { beforeEach, describe, expect, it, vi } from 'vitest';

import { git } from './tauri-bridge';
import { queueDurableTaskDispatch } from './task-dispatch-config';

describe('queueDurableTaskDispatch', () => {
  beforeEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('shares the same handoff persistence semantics across dispatch entry points', async () => {
    const createTask = vi.fn().mockResolvedValue({ id: 'task-1' });

    await queueDurableTaskDispatch({
      projectPath: '/tmp/project',
      title: 'Queue durable handoff',
      description: 'Queue durable handoff',
      prompt: 'Queue durable handoff',
      provider: 'codex',
      role: 'review',
      reviewRequired: true,
      executionStrategy: 'handoff',
      selectedWorktreePath: '/tmp/project-worktrees/review-a',
      sourceSessionId: 'session-source',
      status: 'queued',
      createTask,
    });

    expect(createTask).toHaveBeenCalledWith('/tmp/project', {
      title: 'Queue durable handoff',
      description: 'Queue durable handoff',
      prompt: 'Queue durable handoff',
      provider: 'codex',
      role: 'review',
      execution_strategy: 'handoff',
      worktree_path: '/tmp/project-worktrees/review-a',
      session_id: undefined,
      source_session_id: 'session-source',
      review_required: true,
      status: 'queued',
    });
  });

  it('removes a freshly created worktree when durable task persistence fails', async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
    vi.spyOn(git, 'worktreeAdd').mockResolvedValue('/tmp/project-worktrees/fresh-task');
    vi.spyOn(git, 'worktreeRemove').mockResolvedValue();
    const createTask = vi.fn().mockRejectedValue(new Error('Task create failed'));

    await expect(queueDurableTaskDispatch({
      projectPath: '/tmp/project',
      title: 'Implement queue bridge',
      description: 'Implement queue bridge',
      provider: 'codex',
      reviewRequired: false,
      executionStrategy: 'worktree',
      shouldCreateNewWorktree: true,
      newWorktreeName: 'fresh-task',
      status: 'queued',
      createTask,
    })).rejects.toThrow('Task create failed');

    expect(git.worktreeAdd).toHaveBeenCalledWith('/tmp/project', 'fresh-task');
    expect(git.worktreeRemove).toHaveBeenCalledWith('/tmp/project', '/tmp/project-worktrees/fresh-task', true);
  });
});
