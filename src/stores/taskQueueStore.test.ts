import { beforeEach, describe, expect, it } from 'vitest';
import {
  orderProjectedTasks,
  syncQueueOrderWithTasks,
  useTaskQueueStore,
} from './taskQueueStore';

describe('taskQueueStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useTaskQueueStore.setState({
      queueOrder: [],
      autoExecute: false,
      maxConcurrent: 3,
    });
  });

  it('keeps only queue projection controls in persisted state', () => {
    useTaskQueueStore.setState({
      queueOrder: ['task-b', 'task-a'],
      autoExecute: true,
      maxConcurrent: 9,
    });

    const state = useTaskQueueStore.getState();
    const persisted = JSON.parse(localStorage.getItem('openwork-task-queue') ?? '{}');

    expect(Object.keys(state).sort()).toEqual([
      'autoExecute',
      'maxConcurrent',
      'queueOrder',
      'removeFromQueueOrder',
      'reorder',
      'setAutoExecute',
      'setMaxConcurrent',
      'syncQueueOrder',
    ]);
    expect(persisted.state).toEqual({
      queueOrder: ['task-b', 'task-a'],
      autoExecute: true,
      maxConcurrent: 9,
    });
  });

  it('syncs queue order against durable task ids without reviving task payload state', () => {
    const syncedOrder = syncQueueOrderWithTasks(
      [
        { id: 'task-a', created_at: '2026-04-21T10:00:00.000Z' },
        { id: 'task-c', created_at: '2026-04-21T10:02:00.000Z' },
      ],
      ['task-c', 'missing-task'],
    );

    expect(syncedOrder).toEqual(['task-c', 'task-a', 'missing-task']);
  });

  it('reorders projected durable tasks by queue order and falls back to created_at', () => {
    const ordered = orderProjectedTasks(
      [
        { id: 'task-b', created_at: '2026-04-21T10:01:00.000Z' },
        { id: 'task-a', created_at: '2026-04-21T10:00:00.000Z' },
        { id: 'task-c', created_at: '2026-04-21T10:02:00.000Z' },
      ],
      ['task-c'],
    );

    expect(ordered.map((task) => task.id)).toEqual(['task-c', 'task-a', 'task-b']);
  });

  it('clamps concurrency controls while keeping queue order untouched', () => {
    useTaskQueueStore.setState({ queueOrder: ['task-a', 'task-b'] });

    useTaskQueueStore.getState().setMaxConcurrent(99);
    expect(useTaskQueueStore.getState().maxConcurrent).toBe(9);
    expect(useTaskQueueStore.getState().queueOrder).toEqual(['task-a', 'task-b']);

    useTaskQueueStore.getState().setMaxConcurrent(0);
    expect(useTaskQueueStore.getState().maxConcurrent).toBe(1);
    expect(useTaskQueueStore.getState().queueOrder).toEqual(['task-a', 'task-b']);
  });
});
