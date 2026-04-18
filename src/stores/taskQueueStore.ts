import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ───────────────────────────────────────────────────────────────────

export type TaskQueueProvider = 'claude' | 'codex' | 'cursor';
export type TaskQueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueuedTask {
  id: string;
  title: string;
  prompt: string;
  projectPath: string;
  provider: TaskQueueProvider;
  status: TaskQueueStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  error?: string;
}

interface TaskQueueState {
  queue: QueuedTask[];
  autoExecute: boolean;
  maxConcurrent: number;

  // Actions
  addTask: (task: Omit<QueuedTask, 'id' | 'status' | 'createdAt'>) => string;
  removeTask: (id: string) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
  setAutoExecute: (enabled: boolean) => void;
  setMaxConcurrent: (max: number) => void;

  // State transitions
  claimNext: () => QueuedTask | null;
  markRunning: (id: string, sessionId?: string) => void;
  markDone: (id: string) => void;
  markFailed: (id: string, error?: string) => void;
  markCancelled: (id: string) => void;
  retryTask: (id: string) => void;
  clearCompleted: () => void;

  // Queries
  getRunningCount: () => number;
  getQueuedCount: () => number;
  getTasksByStatus: (status: TaskQueueStatus) => QueuedTask[];
  hasCapacity: () => boolean;
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useTaskQueueStore = create<TaskQueueState>()(
  persist(
    (set, get) => ({
      queue: [],
      autoExecute: false,
      maxConcurrent: 3,

      addTask: (taskInput) => {
        const id = `tq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const task: QueuedTask = {
          ...taskInput,
          id,
          status: 'queued',
          createdAt: Date.now(),
        };
        set((state) => ({ queue: [...state.queue, task] }));
        return id;
      },

      removeTask: (id) =>
        set((state) => ({
          queue: state.queue.filter((t) => t.id !== id),
        })),

      reorder: (fromIndex, toIndex) =>
        set((state) => {
          const newQueue = [...state.queue];
          const [moved] = newQueue.splice(fromIndex, 1);
          if (moved) {
            newQueue.splice(toIndex, 0, moved);
          }
          return { queue: newQueue };
        }),

      setAutoExecute: (enabled) => set({ autoExecute: enabled }),
      setMaxConcurrent: (max) => set({ maxConcurrent: Math.max(1, Math.min(max, 9)) }),

      claimNext: () => {
        const state = get();
        const runningCount = state.queue.filter((t) => t.status === 'running').length;
        if (runningCount >= state.maxConcurrent) return null;

        const next = state.queue.find((t) => t.status === 'queued');
        if (!next) return null;

        set((s) => ({
          queue: s.queue.map((t) =>
            t.id === next.id
              ? { ...t, status: 'running' as const, startedAt: Date.now() }
              : t
          ),
        }));
        return { ...next, status: 'running' as const, startedAt: Date.now() };
      },

      markRunning: (id, sessionId) =>
        set((state) => ({
          queue: state.queue.map((t) =>
            t.id === id
              ? { ...t, status: 'running', startedAt: Date.now(), sessionId }
              : t
          ),
        })),

      markDone: (id) =>
        set((state) => ({
          queue: state.queue.map((t) =>
            t.id === id
              ? { ...t, status: 'done', completedAt: Date.now() }
              : t
          ),
        })),

      markFailed: (id, error) =>
        set((state) => ({
          queue: state.queue.map((t) =>
            t.id === id
              ? { ...t, status: 'failed', completedAt: Date.now(), error }
              : t
          ),
        })),

      markCancelled: (id) =>
        set((state) => ({
          queue: state.queue.map((t) =>
            t.id === id
              ? { ...t, status: 'cancelled', completedAt: Date.now() }
              : t
          ),
        })),

      retryTask: (id) =>
        set((state) => ({
          queue: state.queue.map((t) =>
            t.id === id
              ? { ...t, status: 'queued', startedAt: undefined, completedAt: undefined, error: undefined, sessionId: undefined }
              : t
          ),
        })),

      clearCompleted: () =>
        set((state) => ({
          queue: state.queue.filter((t) => t.status !== 'done' && t.status !== 'cancelled'),
        })),

      getRunningCount: () => get().queue.filter((t) => t.status === 'running').length,
      getQueuedCount: () => get().queue.filter((t) => t.status === 'queued').length,
      getTasksByStatus: (status) => get().queue.filter((t) => t.status === status),
      hasCapacity: () => {
        const state = get();
        return state.queue.filter((t) => t.status === 'running').length < state.maxConcurrent;
      },
    }),
    {
      name: 'openwork-task-queue',
      partialize: (state) => ({
        queue: state.queue,
        autoExecute: state.autoExecute,
        maxConcurrent: state.maxConcurrent,
      }),
    },
  ),
);
