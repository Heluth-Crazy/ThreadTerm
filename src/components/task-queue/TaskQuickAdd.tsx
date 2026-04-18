import React, { useState, useCallback } from 'react';
import { Button } from '../ui/button';
import { useTaskQueueStore } from '../../stores/taskQueueStore';
import type { TaskQueueProvider } from '../../stores/taskQueueStore';

interface TaskQuickAddProps {
  projectPath: string;
  defaultProvider?: TaskQueueProvider;
  onAdded?: () => void;
}

export function TaskQuickAdd({ projectPath, defaultProvider = 'claude', onAdded }: TaskQuickAddProps) {
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState<TaskQueueProvider>(defaultProvider);
  const addTask = useTaskQueueStore((s) => s.addTask);

  const handleAdd = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) return;

    const title = trimmed.length > 60 ? trimmed.slice(0, 60) + '...' : trimmed;
    addTask({
      title,
      prompt: trimmed,
      projectPath,
      provider,
    });
    setPrompt('');
    onAdded?.();
  }, [prompt, projectPath, provider, addTask, onAdded]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-2">
      <textarea
        className="w-full h-16 px-2 py-1.5 text-xs rounded-md border border-input bg-background resize-none"
        placeholder="Add a task prompt..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between gap-2">
        <select
          className="h-7 px-2 text-xs rounded-md border border-input bg-background"
          value={provider}
          onChange={(e) => setProvider(e.target.value as TaskQueueProvider)}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="cursor">Cursor</option>
        </select>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={handleAdd}
          disabled={!prompt.trim()}
        >
          Add to Queue
        </Button>
      </div>
    </div>
  );
}
