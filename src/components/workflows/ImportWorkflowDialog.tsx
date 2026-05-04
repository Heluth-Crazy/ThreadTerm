import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  previewProjectWorkflowUrlImport,
  saveProjectWorkflowImportPlan,
} from '../../lib/workflows/tauriWorkflowImport';
import type {
  WorkflowImportError,
  WorkflowImportErrorReason,
  WorkflowImportPlan,
} from '../../lib/workflows/importWorkflow';

interface ImportWorkflowDialogProps {
  open: boolean;
  projectName: string;
  projectPath: string;
  onCancel: () => void;
  onImported: (plan: WorkflowImportPlan) => void;
}

const ERROR_I18N_KEY: Record<WorkflowImportErrorReason, string> = {
  'invalid-url': 'importWorkflowInvalidUrl',
  'unsupported-scheme': 'importWorkflowUnsupportedScheme',
  'credentials-not-allowed': 'importWorkflowCredentialsNotAllowed',
  'fetch-failed': 'importWorkflowFetchFailed',
  timeout: 'importWorkflowTimeout',
  'http-status': 'importWorkflowHttpStatus',
  'empty-body': 'importWorkflowEmptyBody',
  'too-large': 'importWorkflowTooLarge',
  'parse-failed': 'importWorkflowParseFailed',
  'read-existing-failed': 'importWorkflowReadExistingFailed',
};

const ACTION_CLASS: Record<WorkflowImportPlan['action'], string> = {
  create: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  overwrite: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
};

function errorMessage(error: WorkflowImportError, t: ReturnType<typeof useTranslation>['t']) {
  const key = ERROR_I18N_KEY[error.reason];
  return t(`workflow.${key}`, {
    status: error.status,
    statusText: error.statusText,
    defaultValue: error.message,
  });
}

export function ImportWorkflowDialog({
  open,
  projectName,
  projectPath,
  onCancel,
  onImported,
}: ImportWorkflowDialogProps) {
  const { t } = useTranslation('terminal');
  const [url, setUrl] = useState('');
  const [plan, setPlan] = useState<WorkflowImportPlan | null>(null);
  const [error, setError] = useState<WorkflowImportError | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) return;
    setUrl('');
    setPlan(null);
    setError(null);
    setLoading(false);
    setSaving(false);
  }, [open]);

  const workflowCount = plan?.workflows.length ?? 0;
  const droppedFieldCount = useMemo(
    () => plan?.droppedFields.reduce((sum, entry) => sum + entry.fields.length, 0) ?? 0,
    [plan],
  );

  if (!open) return null;

  const handlePreview = async () => {
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const result = await previewProjectWorkflowUrlImport(url, projectPath);
      if (result.kind === 'error') {
        setError(result.error);
      } else {
        setPlan(result.value);
      }
    } catch (err) {
      setError({
        reason: 'fetch-failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!plan) return;
    setSaving(true);
    setError(null);
    try {
      await saveProjectWorkflowImportPlan(plan);
      onImported(plan);
    } catch (err) {
      setError({
        reason: 'fetch-failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[240] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-workflow-title"
        data-testid="import-workflow-dialog"
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id="import-workflow-title" className="text-sm font-semibold">
            {t('workflow.importWorkflowTitle', {
              defaultValue: 'Import workflow from URL',
            })}
          </h2>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={projectPath}>
            {projectName} - {projectPath}
          </p>
        </div>

        <div className="space-y-3 p-4">
          <label className="block text-xs font-medium" htmlFor="workflow-import-url">
            {t('workflow.importWorkflowUrl', { defaultValue: 'Workflow URL' })}
          </label>
          <div className="flex gap-2">
            <input
              id="workflow-import-url"
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setPlan(null);
                setError(null);
              }}
              placeholder={t('workflow.importWorkflowUrlPlaceholder', {
                defaultValue: 'https://example.com/workflow.yaml',
              })}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={handlePreview}
              disabled={loading || saving || url.trim().length === 0}
              className="rounded-md bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              {loading
                ? t('workflow.importWorkflowPreviewing', { defaultValue: 'Previewing...' })
                : t('workflow.importWorkflowPreview', { defaultValue: 'Preview' })}
            </button>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errorMessage(error, t)}
            </div>
          )}

          {!plan && !error && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
              {t('workflow.importWorkflowEmptyPreview', {
                defaultValue: 'Preview a workflow URL before importing.',
              })}
            </div>
          )}

          {plan && (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-3 border-b border-border bg-muted/30 text-center text-xs">
                <div className="px-3 py-2">
                  <div className="font-semibold">{workflowCount}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {t('workflow.importWorkflowCount', { defaultValue: 'Workflows' })}
                  </div>
                </div>
                <div className="border-x border-border px-3 py-2">
                  <div className="font-semibold">
                    {plan.action === 'create'
                      ? t('workflow.importWorkflowCreate', { defaultValue: 'Create' })
                      : t('workflow.importWorkflowOverwrite', {
                          defaultValue: 'Overwrite',
                        })}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {t('workflow.importWorkflowAction', { defaultValue: 'Action' })}
                  </div>
                </div>
                <div className="px-3 py-2">
                  <div className="font-semibold">{droppedFieldCount}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {t('workflow.importWorkflowWarnings', { defaultValue: 'Warnings' })}
                  </div>
                </div>
              </div>

              <div className="space-y-2 p-3">
                <div className="rounded-md border border-border bg-background px-3 py-2">
                  <div className="text-[10px] uppercase text-muted-foreground">
                    {t('workflow.importWorkflowTarget', { defaultValue: 'Target file' })}
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px]" title={plan.targetFilePath}>
                    {plan.targetFilePath}
                  </div>
                  <span
                    className={[
                      'mt-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium',
                      ACTION_CLASS[plan.action],
                    ].join(' ')}
                  >
                    {plan.action === 'create'
                      ? t('workflow.importWorkflowCreateFile', {
                          defaultValue: 'Will create file',
                        })
                      : t('workflow.importWorkflowOverwriteFile', {
                          defaultValue: 'Will overwrite file',
                        })}
                  </span>
                </div>

                <ul className="max-h-[28vh] space-y-1 overflow-y-auto">
                  {plan.workflows.map((workflow) => (
                    <li
                      key={workflow.name}
                      className="rounded-md border border-border bg-background px-3 py-2"
                    >
                      <div className="truncate text-xs font-medium">{workflow.name}</div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {workflow.command}
                      </div>
                    </li>
                  ))}
                </ul>

                {plan.droppedFields.length > 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700">
                    {plan.droppedFields.map((entry) => (
                      <div key={`${entry.documentIndex}:${entry.workflowName}`}>
                        {entry.workflowName}: {entry.fields.join(', ')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {t('workflow.argsDialogCancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!plan || loading || saving}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving
              ? t('workflow.importWorkflowImporting', { defaultValue: 'Importing...' })
              : t('workflow.importWorkflowImport', { defaultValue: 'Import' })}
          </button>
        </div>
      </div>
    </div>
  );
}
