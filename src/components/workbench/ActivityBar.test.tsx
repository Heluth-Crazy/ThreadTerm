import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../lib/tauri-bridge';
import ActivityBar from './ActivityBar';

const storeState = vi.hoisted(() => ({
  taskStore: {
    tasksByProject: {} as Record<string, Task[]>,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string) => ({
      'workbench.projects': 'Projects',
      'workbench.liveGrid': 'Live Grid',
      'workbench.queue': 'Queue',
      'workbench.extensions': 'Extensions',
      'workbench.settings': 'Settings',
    }[_key] ?? _key),
  }),
}));

vi.mock('../../stores/taskStore', () => ({
  countActiveDurableTasks: (tasks: Task[]) => tasks.filter((task) => ['open', 'queued', 'dispatched', 'in_progress', 'pending_approval', 'pending_review'].includes(task.status)).length,
  useTaskStore: (selector: (state: typeof storeState.taskStore) => unknown) =>
    selector(storeState.taskStore),
}));

describe('ActivityBar', () => {
  beforeEach(() => {
    storeState.taskStore.tasksByProject = {};
  });

  it('shows the queue badge from durable task counts', () => {
    storeState.taskStore.tasksByProject = {
      '/repo-a': [
        { id: 'task-queued', status: 'queued' } as Task,
        { id: 'task-review', status: 'pending_review' } as Task,
        { id: 'task-done', status: 'done' } as Task,
      ],
    };

    render(<ActivityBar activeNav="projects" onSelectNav={vi.fn()} />);

    const queueButton = screen.getByRole('button', { name: 'Queue' });
    expect(queueButton).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
