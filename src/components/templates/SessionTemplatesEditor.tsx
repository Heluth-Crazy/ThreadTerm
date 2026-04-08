import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { authenticatedFetch } from '../../utils/api';
import type { SessionTemplate } from '../../types/templates';
import TemplateForm from './TemplateForm';

export default function SessionTemplatesEditor() {
  const { t } = useTranslation('settings');
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
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
    fetchTemplates();
  }, [fetchTemplates]);

  const userTemplates = templates.filter((t) => !t.isBuiltIn);
  const builtInTemplates = templates.filter((t) => t.isBuiltIn);

  const handleCreate = async (tpl: Omit<SessionTemplate, 'id' | 'isBuiltIn'>) => {
    try {
      const res = await authenticatedFetch('/api/templates', {
        method: 'POST',
        body: JSON.stringify(tpl),
      });
      if (res.ok) {
        setIsAdding(false);
        fetchTemplates();
      } else {
        const err = await res.json();
        console.error('Create failed:', err.error);
      }
    } catch (err) {
      console.error('Failed to create template:', err);
    }
  };

  const handleUpdate = async (id: string, tpl: Omit<SessionTemplate, 'id' | 'isBuiltIn'>) => {
    try {
      const res = await authenticatedFetch(`/api/templates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(tpl),
      });
      if (res.ok) {
        setEditingId(null);
        fetchTemplates();
      }
    } catch (err) {
      console.error('Failed to update template:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await authenticatedFetch(`/api/templates/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        fetchTemplates();
      }
    } catch (err) {
      console.error('Failed to delete template:', err);
    }
  };

  const renderTemplateRow = (tpl: SessionTemplate) => (
    <div
      key={tpl.id}
      className="flex items-start justify-between rounded-xl border border-border/40 bg-background/50 px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base flex-shrink-0">{tpl.icon}</span>
          <span className="text-sm font-medium text-foreground">{tpl.name}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {tpl.provider}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground pl-[28px]">{tpl.description}</p>
      </div>
      {!tpl.isBuiltIn && (
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => {
              setEditingId(tpl.id);
              setIsAdding(false);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => handleDelete(tpl.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="rounded-[20px] border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-foreground">{t('templates.title')}</div>
          <div className="text-sm text-muted-foreground">
            {t('templates.description')}
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
            {t('templates.add')}
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {isAdding && (
          <TemplateForm onSave={handleCreate} onCancel={() => setIsAdding(false)} />
        )}

        {isLoading && (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('templates.loading')}</p>
        )}

        {/* User templates */}
        {!isLoading && userTemplates.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('templates.myTemplates')}
            </h4>
            {userTemplates.map((tpl) =>
              editingId === tpl.id ? (
                <TemplateForm
                  key={tpl.id}
                  initial={tpl}
                  onSave={(updated) => handleUpdate(tpl.id, updated)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                renderTemplateRow(tpl)
              ),
            )}
          </div>
        )}

        {/* Built-in templates */}
        {!isLoading && builtInTemplates.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('templates.builtIn')}
            </h4>
            {builtInTemplates.map(renderTemplateRow)}
          </div>
        )}
      </div>
    </div>
  );
}
