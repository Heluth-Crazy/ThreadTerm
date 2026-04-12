import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { useTaskPanel } from '../hooks/useTaskPanel';
import { TaskItem } from './TaskItem';
import type { Task } from '../../../lib/tauri-bridge';

interface TaskPanelProps {
  projectPath?: string;
}

const STATUS_ORDER: Task['status'][] = ['in_progress', 'open', 'failed', 'done'];

export function TaskPanel({ projectPath }: TaskPanelProps) {
  const { t } = useTranslation('common');
  const { tasks, loading, createTask, updateTask, deleteTask } = useTaskPanel(projectPath);
  const [newTitle, setNewTitle] = useState('');
  const [showInput, setShowInput] = useState(false);

  const grouped = STATUS_ORDER.reduce<Record<string, Task[]>>((acc, status) => {
    acc[status] = tasks.filter((t) => t.status === status);
    return acc;
  }, {});

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title) return;
    await createTask(title);
    setNewTitle('');
    setShowInput(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    } else if (e.key === 'Escape') {
      setShowInput(false);
      setNewTitle('');
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('localTasks.title')}</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setShowInput(!showInput)}
        >
          + {t('localTasks.add')}
        </Button>
      </div>

      {showInput && (
        <div className="flex gap-1">
          <input
            type="text"
            className="flex-1 h-7 px-2 text-xs rounded-md border border-input bg-background"
            placeholder={t('localTasks.add')}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={handleCreate}>
            {t('buttons.create')}
          </Button>
        </div>
      )}

      {loading && <p className="text-xs text-muted-foreground">{t('status.loading')}</p>}

      {!loading && tasks.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('localTasks.noTasks')}</p>
      )}

      {STATUS_ORDER.map((status) => {
        const items = grouped[status];
        if (!items || items.length === 0) return null;
        return (
          <div key={status} className="flex flex-col gap-0.5">
            {items.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onStatusChange={(id, newStatus) => updateTask(id, { status: newStatus })}
                onDelete={deleteTask}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
