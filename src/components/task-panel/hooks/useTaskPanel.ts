import { useState, useEffect, useCallback } from 'react';
import { tasks as tasksApi } from '../../../lib/tauri-bridge';
import type { Task } from '../../../lib/tauri-bridge';

export function useTaskPanel(projectPath: string | undefined) {
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setTaskList([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await tasksApi.list(projectPath);
      setTaskList(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createTask = useCallback(
    async (title: string, description?: string, deps: string[] = []) => {
      if (!projectPath) return;
      try {
        await tasksApi.create(projectPath, title, description, deps);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectPath, refresh],
  );

  const updateTask = useCallback(
    async (id: string, updates: Partial<Pick<Task, 'title' | 'description' | 'status' | 'session_id'>>) => {
      if (!projectPath) return;
      try {
        await tasksApi.update(projectPath, id, updates);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectPath, refresh],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      if (!projectPath) return;
      try {
        await tasksApi.delete(projectPath, id);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [projectPath, refresh],
  );

  return { tasks: taskList, loading, error, refresh, createTask, updateTask, deleteTask };
}
