import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Task } from '../lib/tauri-bridge';

// Phase 2 migration boundary: this store is only queue UI state. Durable tasks
// live in the Rust-backed task store; this store keeps view controls and the
// user's queue ordering projection, not a second persisted task truth.

export interface TaskQueueProjectionState {
  queueOrder: string[];
  autoExecute: boolean;
  maxConcurrent: number;
}

interface TaskQueueState extends TaskQueueProjectionState {
  setAutoExecute: (enabled: boolean) => void;
  setMaxConcurrent: (max: number) => void;
  syncQueueOrder: (tasks: Task[]) => void;
  reorder: (visibleTaskIds: string[], fromIndex: number, toIndex: number) => void;
  removeFromQueueOrder: (taskId: string) => void;
}

function sanitizeQueueOrder(taskIds: string[], queueOrder: string[]) {
  const taskIdSet = new Set(taskIds);
  const seen = new Set<string>();
  const nextQueueOrder: string[] = [];
  const unknownQueueOrder: string[] = [];

  for (const taskId of queueOrder) {
    if (seen.has(taskId)) continue;
    if (!taskIdSet.has(taskId)) {
      unknownQueueOrder.push(taskId);
      seen.add(taskId);
      continue;
    }
    nextQueueOrder.push(taskId);
    seen.add(taskId);
  }

  for (const taskId of taskIds) {
    if (seen.has(taskId)) continue;
    nextQueueOrder.push(taskId);
    seen.add(taskId);
  }

  return [...nextQueueOrder, ...unknownQueueOrder];
}

export function syncQueueOrderWithTasks<T extends Pick<Task, 'id' | 'created_at'>>(tasks: T[], queueOrder: string[]) {
  const taskIds = [...tasks]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((task) => task.id);
  return sanitizeQueueOrder(taskIds, queueOrder);
}

export function orderProjectedTasks<T extends Pick<Task, 'id' | 'created_at'>>(tasks: T[], queueOrder: string[]) {
  const sanitizedQueueOrder = syncQueueOrderWithTasks(tasks, queueOrder);
  const orderIndex = new Map(sanitizedQueueOrder.map((taskId, index) => [taskId, index]));

  return [...tasks].sort((a, b) => {
    const aIndex = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.created_at.localeCompare(b.created_at);
  });
}

export const useTaskQueueStore = create<TaskQueueState>()(
  persist(
    (set, get) => ({
      queueOrder: [],
      autoExecute: false,
      maxConcurrent: 3,

      setAutoExecute: (enabled) => set({ autoExecute: enabled }),
      setMaxConcurrent: (max) => set({ maxConcurrent: Math.max(1, Math.min(max, 9)) }),
      syncQueueOrder: (tasks) =>
        set((state) => ({
          queueOrder: syncQueueOrderWithTasks(tasks, state.queueOrder),
        })),
      reorder: (visibleTaskIds, fromIndex, toIndex) =>
        set((state) => {
          const scopedTaskIds = visibleTaskIds.filter((taskId) => state.queueOrder.includes(taskId));
          const nextScopedTaskIds = [...scopedTaskIds];
          const [movedTaskId] = nextScopedTaskIds.splice(fromIndex, 1);
          if (!movedTaskId) {
            return { queueOrder: state.queueOrder };
          }
          nextScopedTaskIds.splice(toIndex, 0, movedTaskId);

          const scopedTaskIdSet = new Set(scopedTaskIds);
          const remainder = state.queueOrder.filter((taskId) => !scopedTaskIdSet.has(taskId));
          return {
            queueOrder: [...nextScopedTaskIds, ...remainder],
          };
        }),
      removeFromQueueOrder: (taskId) =>
        set((state) => ({
          queueOrder: state.queueOrder.filter((queuedTaskId) => queuedTaskId !== taskId),
        })),
    }),
    {
      name: 'openwork-task-queue',
      partialize: (state) => ({
        queueOrder: state.queueOrder,
        autoExecute: state.autoExecute,
        maxConcurrent: state.maxConcurrent,
      }),
    },
  ),
);
