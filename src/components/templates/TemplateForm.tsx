import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { SessionTemplate } from '../../types/templates';

const PROVIDER_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
] as const;

const EMOJI_SUGGESTIONS = ['🔍', '🐛', '✨', '📝', '♻️', '🚀', '🧪', '⚡', '🛠️', '📦', '🎨', '🔒'];

interface TemplateFormProps {
  initial?: SessionTemplate;
  onSave: (template: Omit<SessionTemplate, 'id' | 'isBuiltIn'>) => void;
  onCancel: () => void;
}

export default function TemplateForm({ initial, onSave, onCancel }: TemplateFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? '🔍');
  const [provider, setProvider] = useState<SessionTemplate['provider']>(initial?.provider ?? 'claude');
  const [initialMessage, setInitialMessage] = useState(initial?.initialMessage ?? '');
  const [error, setError] = useState('');

  const validate = () => {
    if (!name.trim()) return 'Name is required';
    if (!description.trim()) return 'Description is required';
    if (!icon.trim()) return 'Icon is required';
    return '';
  };

  const handleSubmit = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError('');
    onSave({
      name: name.trim(),
      description: description.trim(),
      icon: icon.trim(),
      provider,
      initialMessage: initialMessage.trim() || undefined,
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Template"
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Description</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this template does..."
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Icon</label>
        <div className="flex items-center gap-2">
          <Input
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            className="h-9 w-16 text-center text-sm"
            maxLength={4}
          />
          <div className="flex flex-wrap gap-1">
            {EMOJI_SUGGESTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => setIcon(emoji)}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors ${
                  icon === emoji ? 'bg-primary/20 ring-1 ring-primary' : 'hover:bg-muted/60'
                }`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as SessionTemplate['provider'])}
          className="h-9 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Initial Message (optional)</label>
        <textarea
          value={initialMessage}
          onChange={(e) => setInitialMessage(e.target.value)}
          placeholder="Pre-filled first message when using this template..."
          rows={3}
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
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
