import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, X, Check, Star } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { settings } from '../../lib/tauri-bridge';
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
  const { t } = useTranslation('settings');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [provider, setProvider] = useState<CustomSlashCommand['provider']>(
    initial?.provider ?? 'all',
  );
  const [error, setError] = useState('');

  const validate = () => {
    if (!name.trim()) return t('slashCommands.form.nameRequired');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name.trim())) {
      return t('slashCommands.form.nameInvalid');
    }
    if (!prompt.trim()) return t('slashCommands.form.promptRequired');
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
        <label className="text-xs font-medium text-muted-foreground">{t('slashCommands.form.name')}</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('slashCommands.form.namePlaceholder')}
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('slashCommands.form.description')}</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('slashCommands.form.descriptionPlaceholder')}
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('slashCommands.form.promptTemplate')}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('slashCommands.form.promptPlaceholder')}
          rows={3}
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('slashCommands.form.provider')}</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as CustomSlashCommand['provider'])}
          className="h-9 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.value === 'all' ? t('slashCommands.form.allProviders') : opt.label}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={handleSubmit} className="gap-1.5">
          <Check className="h-3.5 w-3.5" />
          {t('common:buttons.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="gap-1.5">
          <X className="h-3.5 w-3.5" />
          {t('common:buttons.cancel')}
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
      const allSettings = await settings.getAll();
      const cmds = allSettings?.customSlashCommands;
      setCommands(Array.isArray(cmds) ? cmds as CustomSlashCommand[] : []);
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
      const newCmd = { ...cmd, id: crypto.randomUUID() } as CustomSlashCommand;
      const updated = [...commands, newCmd];
      await settings.set('customSlashCommands', updated);
      setIsAdding(false);
      fetchCommands();
    } catch (err) {
      console.error('Failed to create command:', err);
    }
  };

  const handleUpdate = async (id: string, cmd: Omit<CustomSlashCommand, 'id'>) => {
    try {
      const updated = commands.map((c) => (c.id === id ? { ...cmd, id } : c));
      await settings.set('customSlashCommands', updated);
      setEditingId(null);
      fetchCommands();
    } catch (err) {
      console.error('Failed to update command:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const updated = commands.filter((c) => c.id !== id);
      await settings.set('customSlashCommands', updated);
      fetchCommands();
    } catch (err) {
      console.error('Failed to delete command:', err);
    }
  };

  return (
    <div className="rounded-[20px] border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-foreground">{t('slashCommands.title')}</div>
          <div className="text-sm text-muted-foreground">
            {t('slashCommands.description')}
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
            {t('slashCommands.add')}
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {isAdding && (
          <CommandForm onSave={handleCreate} onCancel={() => setIsAdding(false)} />
        )}

        {isLoading && (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('slashCommands.loading')}</p>
        )}

        {!isLoading && commands.length === 0 && !isAdding && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t('slashCommands.empty')}
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
