import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApplyPresetEntry } from '../../lib/workflows/dedupWorkflows';

interface ApplyPresetDialogProps {
  open: boolean;
  projectName: string;
  projectPath: string;
  entries: ApplyPresetEntry[];
  loading?: boolean;
  onCancel: () => void;
  onApply: () => void;
}

const STATE_CLASS: Record<ApplyPresetEntry['state'], string> = {
  new: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  duplicate: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  'missing-args': 'border-muted bg-muted text-muted-foreground',
};

export function ApplyPresetDialog({
  open,
  projectName,
  projectPath,
  entries,
  loading = false,
  onCancel,
  onApply,
}: ApplyPresetDialogProps) {
  const { t } = useTranslation('terminal');
  const counts = useMemo(
    () => ({
      create: entries.filter((entry) => entry.state === 'new').length,
      duplicate: entries.filter((entry) => entry.state === 'duplicate').length,
      missingArgs: entries.filter((entry) => entry.state === 'missing-args').length,
    }),
    [entries],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[240] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-preset-title"
        data-testid="apply-preset-dialog"
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id="apply-preset-title" className="text-sm font-semibold">
            {t('workflow.applyPreset', { defaultValue: 'Apply preset' })}
          </h2>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={projectPath}>
            {projectName} · {projectPath}
          </p>
        </div>

        <div className="grid grid-cols-3 border-b border-border bg-muted/30 text-center text-xs">
          <div className="px-3 py-2">
            <div className="font-semibold">{counts.create}</div>
            <div className="text-[10px] text-muted-foreground">
              {t('workflow.applyPresetCreated', { defaultValue: 'Will create' })}
            </div>
          </div>
          <div className="border-x border-border px-3 py-2">
            <div className="font-semibold">{counts.duplicate}</div>
            <div className="text-[10px] text-muted-foreground">
              {t('workflow.applyPresetDuplicate', { defaultValue: 'Duplicates' })}
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="font-semibold">{counts.missingArgs}</div>
            <div className="text-[10px] text-muted-foreground">
              {t('workflow.applyPresetSkippedMissingArgs', {
                defaultValue: 'Needs args',
              })}
            </div>
          </div>
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-2">
          {loading ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {t('workflow.loadingPreset', { defaultValue: 'Loading workflows...' })}
            </div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {t('workflow.emptyPreset', { defaultValue: 'No project workflows found.' })}
            </div>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <li
                  key={`${entry.workflow.filePath}:${entry.workflow.name}`}
                  className="rounded-lg border border-border bg-background px-3 py-2"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">
                        {entry.workflow.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {entry.resolvedCommand ?? entry.workflow.command}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {entry.resolvedCwd ?? projectPath}
                      </div>
                    </div>
                    <span
                      className={[
                        'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                        STATE_CLASS[entry.state],
                      ].join(' ')}
                    >
                      {entry.state === 'new'
                        ? t('workflow.applyPresetCreated', { defaultValue: 'Will create' })
                        : entry.state === 'duplicate'
                          ? t('workflow.applyPresetDuplicate', { defaultValue: 'Duplicate' })
                          : t('workflow.applyPresetSkippedMissingArgs', {
                              defaultValue: 'Needs args',
                            })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
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
            onClick={onApply}
            disabled={loading || counts.create === 0}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('workflow.applyPreset', { defaultValue: 'Apply preset' })}
          </button>
        </div>
      </div>
    </div>
  );
}
