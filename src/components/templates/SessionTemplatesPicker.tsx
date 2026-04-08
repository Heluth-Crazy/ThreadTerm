import { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../utils/api';
import type { SessionTemplate } from '../../types/templates';

interface SessionTemplatesPickerProps {
  open: boolean;
  onClose: () => void;
  onSelectTemplate: (template: SessionTemplate) => void;
  onSkip: () => void;
}

export default function SessionTemplatesPicker({
  open,
  onClose,
  onSelectTemplate,
  onSkip,
}: SessionTemplatesPickerProps) {
  const { t } = useTranslation('settings');
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setIsLoading(true);
      fetchTemplates();
    }
  }, [open, fetchTemplates]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const builtInTemplates = templates.filter((t) => t.isBuiltIn);
  const userTemplates = templates.filter((t) => !t.isBuiltIn);

  const providerColor: Record<string, string> = {
    claude: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    codex: 'bg-green-500/15 text-green-600 dark:text-green-400',
    cursor: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  };

  const renderTemplateCard = (tpl: SessionTemplate) => (
    <button
      key={tpl.id}
      type="button"
      onClick={() => onSelectTemplate(tpl)}
      className="flex flex-col items-start gap-1.5 rounded-xl border border-border/60 bg-background/50 p-3 text-left transition-all hover:border-primary/40 hover:bg-muted/50 hover:shadow-sm"
    >
      <div className="flex w-full items-center gap-2">
        <span className="text-lg">{tpl.icon}</span>
        <span className="text-sm font-medium text-foreground flex-1 truncate">{tpl.name}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${providerColor[tpl.provider] ?? 'bg-muted text-muted-foreground'}`}>
          {tpl.provider}
        </span>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 pl-[28px]">{tpl.description}</p>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-h-[80vh] overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('templates.picker.title')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('templates.picker.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Start blank button */}
        <button
          type="button"
          onClick={onSkip}
          className="mb-4 flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-border/80 bg-background/30 p-3 text-left transition-all hover:border-primary/40 hover:bg-muted/30"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-base">
            ➕
          </span>
          <div>
            <span className="text-sm font-medium text-foreground">{t('templates.picker.startBlank')}</span>
            <p className="text-xs text-muted-foreground">{t('templates.picker.startBlankDescription')}</p>
          </div>
        </button>

        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('templates.picker.loading')}</p>
        ) : (
          <div className="space-y-4">
            {/* Built-in templates */}
            {builtInTemplates.length > 0 && (
              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('templates.builtIn')}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {builtInTemplates.map(renderTemplateCard)}
                </div>
              </div>
            )}

            {/* User templates */}
            {userTemplates.length > 0 && (
              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('templates.myTemplates')}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {userTemplates.map(renderTemplateCard)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
