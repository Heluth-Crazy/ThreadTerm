import { create } from 'zustand';
import { tasks, type CreateTaskInput, type Task, type TaskStatus, type TaskUpdateInput } from '../lib/tauri-bridge';
import { useTaskQueueStore } from './taskQueueStore';

export const DURABLE_RUNNING_TASK_STATUSES: TaskStatus[] = ['dispatched', 'in_progress', 'pending_approval'];
export const DURABLE_QUEUED_TASK_STATUSES: TaskStatus[] = ['open', 'queued'];
export const DURABLE_REVIEW_TASK_STATUSES: TaskStatus[] = ['pending_review'];
export const DURABLE_TERMINAL_TASK_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled', 'archived'];

export function isDurableRunningTaskStatus(status: TaskStatus) {
  return DURABLE_RUNNING_TASK_STATUSES.includes(status);
}

export function isDurableQueuedTaskStatus(status: TaskStatus) {
  return DURABLE_QUEUED_TASK_STATUSES.includes(status);
}

export function isDurableReviewTaskStatus(status: TaskStatus) {
  return DURABLE_REVIEW_TASK_STATUSES.includes(status);
}

export function isDurableTerminalTaskStatus(status: TaskStatus) {
  return DURABLE_TERMINAL_TASK_STATUSES.includes(status);
}

export function countRunningDurableTasks(taskList: Task[]) {
  return taskList.filter((task) => isDurableRunningTaskStatus(task.status)).length;
}

export function countQueuedDurableTasks(taskList: Task[]) {
  return taskList.filter((task) => isDurableQueuedTaskStatus(task.status)).length;
}

export function countActiveDurableTasks(taskList: Task[]) {
  return taskList.filter((task) =>
    isDurableRunningTaskStatus(task.status)
    || isDurableQueuedTaskStatus(task.status)
    || isDurableReviewTaskStatus(task.status)).length;
}

interface TaskStoreState {
  tasksByProject: Record<string, Task[]>;
  loadingByProject: Record<string, boolean>;
  errorByProject: Record<string, string | null>;
  refresh: (projectPath: string) => Promise<Task[]>;
  createTask: (projectPath: string, input: CreateTaskInput) => Promise<Task>;
  updateTask: (projectPath: string, id: string, updates: TaskUpdateInput) => Promise<Task>;
  deleteTask: (projectPath: string, id: string) => Promise<void>;
  getTasksForProject: (projectPath?: string) => Task[];
  getAllTasks: () => Task[];
  getTaskById: (projectPath: string, id: string) => Task | undefined;
  getTaskBySessionId: (sessionId: string) => Task | undefined;
}

function sortTasks(tasksForProject: Task[]): Task[] {
  return [...tasksForProject].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function syncQueueProjection(tasksByProject: Record<string, Task[]>) {
  const projected = Object.values(tasksByProject).flatMap((tasksForProject) => tasksForProject);
  useTaskQueueStore.getState().syncQueueOrder(projected);
}

function setProjectTasks(
  projectPath: string,
  nextTasks: Task[],
  set: (partial: Partial<TaskStoreState> | ((state: TaskStoreState) => Partial<TaskStoreState>)) => void,
  get: () => TaskStoreState,
) {
  const sorted = sortTasks(nextTasks);
  const previousProjectTasks = get().tasksByProject[projectPath] ?? [];
  const nextTaskIdSet = new Set(sorted.map((task) => task.id));
  const removedTaskIds = previousProjectTasks
    .map((task) => task.id)
    .filter((taskId) => !nextTaskIdSet.has(taskId));

  if (removedTaskIds.length > 0) {
    const queueProjectionStore = useTaskQueueStore.getState();
    for (const removedTaskId of removedTaskIds) {
      queueProjectionStore.removeFromQueueOrder(removedTaskId);
    }
  }

  set((state) => {
    const tasksByProject = {
      ...state.tasksByProject,
      [projectPath]: sorted,
    };
    syncQueueProjection(tasksByProject);
    return {
      tasksByProject,
      errorByProject: {
        ...state.errorByProject,
        [projectPath]: null,
      },
    };
  });
}

export function durableTaskStatusToQueueStatus(status: TaskStatus): 'queued' | 'running' | 'review' | 'done' | 'failed' | 'cancelled' | 'archived' {
  switch (status) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'archived':
      return 'archived';
    case 'dispatched':
    case 'in_progress':
    case 'pending_approval':
      return 'running';
    case 'pending_review':
      return 'review';
    case 'open':
    case 'queued':
    default:
      return 'queued';
  }
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasksByProject: {},
  loadingByProject: {},
  errorByProject: {},

  refresh: async (projectPath) => {
    set((state) => ({
      loadingByProject: {
        ...state.loadingByProject,
        [projectPath]: true,
      },
      errorByProject: {
        ...state.errorByProject,
        [projectPath]: null,
      },
    }));

    try {
      const taskList = await tasks.list(projectPath);
      setProjectTasks(projectPath, taskList, set, get);
      return taskList;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load tasks';
      set((state) => ({
        errorByProject: {
          ...state.errorByProject,
          [projectPath]: message,
        },
      }));
      throw error;
    } finally {
      set((state) => ({
        loadingByProject: {
          ...state.loadingByProject,
          [projectPath]: false,
        },
      }));
    }
  },

  createTask: async (projectPath, input) => {
    const createdTask = await tasks.create(projectPath, input);
    const currentTasks = get().tasksByProject[projectPath] ?? [];
    setProjectTasks(projectPath, [...currentTasks, createdTask], set, get);
    return createdTask;
  },

  updateTask: async (projectPath, id, updates) => {
    const updatedTask = await tasks.update(projectPath, id, updates);
    const currentTasks = get().tasksByProject[projectPath] ?? [];
    const nextTasks = currentTasks.some((task) => task.id === id)
      ? currentTasks.map((task) => (task.id === id ? updatedTask : task))
      : [...currentTasks, updatedTask];
    setProjectTasks(projectPath, nextTasks, set, get);
    return updatedTask;
  },

  deleteTask: async (projectPath, id) => {
    await tasks.delete(projectPath, id);
    useTaskQueueStore.getState().removeFromQueueOrder(id);
    const currentTasks = get().tasksByProject[projectPath] ?? [];
    setProjectTasks(
      projectPath,
      currentTasks.filter((task) => task.id !== id),
      set,
      get,
    );
  },

  getTasksForProject: (projectPath) => {
    if (!projectPath) return [];
    return get().tasksByProject[projectPath] ?? [];
  },

  getAllTasks: () => Object.values(get().tasksByProject).flatMap((tasksForProject) => tasksForProject),

  getTaskById: (projectPath, id) => (get().tasksByProject[projectPath] ?? []).find((task) => task.id === id),

  getTaskBySessionId: (sessionId) =>
    get()
      .getAllTasks()
      .find(
        (task) =>
          task.session_id === sessionId ||
          (task.source_session_id !== '' && task.source_session_id === sessionId),
      ),
}));
