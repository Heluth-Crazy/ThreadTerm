import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, X, Check, Star } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { authenticatedFetch } from '../../utils/api';
import type { CustomSlashCommand } from '../../types/slashCommands';

const PROVIDER_OPTIONS = [
  { value: 'all', label: 'All Providers' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
] as const;

function CommandForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CustomSlashCommand;
  onSave: (cmd: Omit<CustomSlashCommand, 'id'>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [provider, setProvider] = useState<CustomSlashCommand['provider']>(
    initial?.provider ?? 'all',
  );
  const [error, setError] = useState('');

  const validate = () => {
    if (!name.trim()) return 'Name is required';
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name.trim())) {
      return 'Name must start with a letter and contain only letters, numbers, hyphens, underscores';
    }
    if (!prompt.trim()) return 'Prompt is required';
    return '';
  };

  const handleSubmit = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError('');
    onSave({ name: name.trim(), description: description.trim(), prompt: prompt.trim(), provider });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Name (no spaces)</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="deploy"
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Description</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Deploy to staging"
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Prompt template</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Run the deployment pipeline for staging environment..."
          rows={3}
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as CustomSlashCommand['provider'])}
          className="h-9 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={handleSubmit} className="gap-1.5">
          <Check className="h-3.5 w-3.5" />
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="gap-1.5">
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default function CustomSlashCommandsEditor() {
  const { t } = useTranslation('settings');
  const [commands, setCommands] = useState<CustomSlashCommand[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchCommands = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/slash-commands');
      if (res.ok) {
        const data = await res.json();
        setCommands(data);
      }
    } catch (err) {
      console.error('Failed to load custom slash commands:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCommands();
  }, [fetchCommands]);

  const handleCreate = async (cmd: Omit<CustomSlashCommand, 'id'>) => {
    try {
      const res = await authenticatedFetch('/api/slash-commands', {
        method: 'POST',
        body: JSON.stringify(cmd),
      });
      if (res.ok) {
        setIsAdding(false);
        fetchCommands();
      } else {
        const err = await res.json();
        console.error('Create failed:', err.error);
      }
    } catch (err) {
      console.error('Failed to create command:', err);
    }
  };

  const handleUpdate = async (id: string, cmd: Omit<CustomSlashCommand, 'id'>) => {
    try {
      const res = await authenticatedFetch(`/api/slash-commands/${id}`, {
        method: 'PUT',
        body: JSON.stringify(cmd),
      });
      if (res.ok) {
        setEditingId(null);
        fetchCommands();
      }
    } catch (err) {
      console.error('Failed to update command:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await authenticatedFetch(`/api/slash-commands/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        fetchCommands();
      }
    } catch (err) {
      console.error('Failed to delete command:', err);
    }
  };

  return (
    <div className="rounded-[20px] border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-foreground">Custom Slash Commands</div>
          <div className="text-sm text-muted-foreground">
            Define custom /<span className="font-mono">commands</span> that insert prompt templates
          </div>
        </div>
        {!isAdding && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setIsAdding(true);
              setEditingId(null);
            }}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {isAdding && (
          <CommandForm onSave={handleCreate} onCancel={() => setIsAdding(false)} />
        )}

        {isLoading && (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading...</p>
        )}

        {!isLoading && commands.length === 0 && !isAdding && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No custom commands yet. Click "Add" to create one.
          </p>
        )}

        {commands.map((cmd) =>
          editingId === cmd.id ? (
            <CommandForm
              key={cmd.id}
              initial={cmd}
              onSave={(updated) => handleUpdate(cmd.id, updated)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div
              key={cmd.id}
              className="flex items-start justify-between rounded-xl border border-border/40 bg-background/50 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Star className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                  <span className="font-mono text-sm text-foreground">/{cmd.name}</span>
                  {cmd.provider !== 'all' && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {cmd.provider}
                    </span>
                  )}
                </div>
                {cmd.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground pl-[22px]">
                    {cmd.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={() => {
                    setEditingId(cmd.id);
                    setIsAdding(false);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(cmd.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
