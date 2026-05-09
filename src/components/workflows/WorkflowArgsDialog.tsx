import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Workflow } from '../../lib/workflows/parseWorkflow';

interface WorkflowArgsDialogProps {
  open: boolean;
  workflow: Workflow | null;
  missingArgs: string[];
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

export function WorkflowArgsDialog({
  open,
  workflow,
  missingArgs,
  onCancel,
  onSubmit,
}: WorkflowArgsDialogProps) {
  const { t } = useTranslation('terminal');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setValues({});
  }, [open, workflow?.name]);

  const fields = useMemo(
    () =>
      missingArgs.map((name) => ({
        name,
        description: workflow?.arguments?.find((arg) => arg.name === name)?.description,
      })),
    [missingArgs, workflow?.arguments],
  );

  const canRun = fields.every((field) => values[field.name]?.trim().length > 0);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canRun) return;
    const cleaned: Record<string, string> = {};
    for (const field of fields) {
      cleaned[field.name] = values[field.name].trim();
    }
    onSubmit(cleaned);
  };

  if (!open || !workflow) return null;

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-args-title"
        data-testid="workflow-args-dialog"
        className="w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-popover text-popover-foreground shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="border-b border-white/10 px-4 py-3">
          <h2 id="workflow-args-title" className="text-sm font-semibold">
            {t('workflow.argsDialogTitle', {
              workflow: workflow.name,
              defaultValue: 'Workflow arguments',
            })}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{workflow.command}</p>
        </div>

        <div className="space-y-3 p-4">
          {fields.map((field, index) => (
            <label key={field.name} className="block space-y-1.5">
              <span className="text-xs font-medium">{field.name}</span>
              {field.description && (
                <span className="block text-[11px] text-muted-foreground">
                  {field.description}
                </span>
              )}
              <input
                autoFocus={index === 0}
                value={values[field.name] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
                className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 bg-muted/30 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {t('workflow.argsDialogCancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            disabled={!canRun}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('workflow.argsDialogRun', { defaultValue: 'Run' })}
          </button>
        </div>
      </form>
    </div>
  );
}
