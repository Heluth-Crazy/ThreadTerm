import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countActiveDurableTasks,
  durableTaskStatusToQueueStatus,
  isDurableQueuedTaskStatus,
  isDurableReviewTaskStatus,
  isDurableRunningTaskStatus,
  isDurableTerminalTaskStatus,
  useTaskStore,
} from './taskStore';
import { useTaskQueueStore } from './taskQueueStore';
import { tasks, type Task } from '../lib/tauri-bridge';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Draft release notes',
    description: 'Draft release notes',
    prompt: 'Draft release notes',
    status: 'queued',
    provider: 'claude',
    execution_strategy: 'current_project',
    project_path: '/tmp/project',
    created_at: '2026-04-19T10:00:00.000Z',
    updated_at: '2026-04-19T10:00:00.000Z',
    deps: [],
    review_required: false,
    ...overrides,
  };
}

beforeEach(() => {
  useTaskStore.setState({
    tasksByProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
  useTaskQueueStore.setState({
    queueOrder: [],
    autoExecute: false,
    maxConcurrent: 3,
  });
  vi.restoreAllMocks();
});

describe('taskStore', () => {
  it('treats archived as terminal without reviving it into active counts', () => {
    const archivedTask = makeTask({ status: 'archived' });
    const reviewTask = makeTask({ id: 'task-2', status: 'pending_review' });
    const queuedTask = makeTask({ id: 'task-3', status: 'queued' });

    expect(isDurableTerminalTaskStatus('archived')).toBe(true);
    expect(isDurableRunningTaskStatus('archived')).toBe(false);
    expect(isDurableQueuedTaskStatus('archived')).toBe(false);
    expect(isDurableRunningTaskStatus('pending_review')).toBe(false);
    expect(isDurableReviewTaskStatus('pending_review')).toBe(true);
    expect(durableTaskStatusToQueueStatus('pending_review')).toBe('review');
    expect(durableTaskStatusToQueueStatus('archived')).toBe('archived');
    expect(countActiveDurableTasks([archivedTask, reviewTask, queuedTask])).toBe(2);
  });

  it('refresh loads durable tasks and syncs the queue projection', async () => {
    vi.spyOn(tasks, 'list').mockResolvedValue([
      makeTask({ id: 'task-2', created_at: '2026-04-19T10:01:00.000Z' }),
      makeTask({ id: 'task-1', created_at: '2026-04-19T10:00:00.000Z', status: 'in_progress', session_id: 'session-1' }),
      makeTask({ id: 'task-3', created_at: '2026-04-19T10:02:00.000Z', updated_at: '2026-04-19T10:02:00.000Z', status: 'archived' }),
    ]);

    const loaded = await useTaskStore.getState().refresh('/tmp/project');

    expect(loaded).toHaveLength(3);
    expect(useTaskStore.getState().getTasksForProject('/tmp/project').map((task) => task.id)).toEqual(['task-1', 'task-2', 'task-3']);
    expect(useTaskQueueStore.getState().queueOrder).toEqual(['task-1', 'task-2', 'task-3']);
    expect(useTaskQueueStore.getState().queueOrder[0]).toBe('task-1');
    expect(useTaskQueueStore.getState().queueOrder[2]).toBe('task-3');
  });

  it('preserves queue ordering for tasks from other projects while syncing the loaded project', async () => {
    useTaskQueueStore.setState({ queueOrder: ['other-project-task'], autoExecute: false, maxConcurrent: 3 });
    vi.spyOn(tasks, 'list').mockResolvedValue([makeTask({ id: 'task-loaded' })]);

    await useTaskStore.getState().refresh('/tmp/project');

    expect(useTaskQueueStore.getState().queueOrder).toEqual(['task-loaded', 'other-project-task']);
  });

  it('createTask appends the durable task and updates queue counters', async () => {
    vi.spyOn(tasks, 'create').mockResolvedValue(makeTask({ id: 'task-created' }));

    const created = await useTaskStore.getState().createTask('/tmp/project', {
      title: 'Draft release notes',
      prompt: 'Draft release notes',
      provider: 'claude',
      execution_strategy: 'current_project',
      status: 'queued',
    });

    expect(created.id).toBe('task-created');
    expect(useTaskStore.getState().getTasksForProject('/tmp/project')).toEqual([created]);
    expect(useTaskQueueStore.getState().queueOrder).toEqual(['task-created']);
  });
});
