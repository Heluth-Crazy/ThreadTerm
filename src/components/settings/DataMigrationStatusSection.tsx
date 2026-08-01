import { CheckCircle2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DataMigrationStatus } from '../../lib/dataDirectory';
import { SettingsSection } from './SettingsSection';
import { formatDataPathForDisplay } from './dataDirectoryUi';

interface DataMigrationStatusSectionProps {
  migration: DataMigrationStatus;
  disabled: boolean;
  onOpenDirectory: (path: string) => void;
  onRestart: () => void;
  onCancel: () => void;
  onRollback: () => void;
  onCleanup: () => void;
}

export function DataMigrationStatusSection({
  migration,
  disabled,
  onOpenDirectory,
  onRestart,
  onCancel,
  onRollback,
  onCleanup,
}: DataMigrationStatusSectionProps) {
  const { t } = useTranslation('settings');
  const migrationPercent = useMemo(() => {
    if (migration.totalBytes <= 0) return 0;
    return Math.min(100, Math.round((migration.copiedBytes / migration.totalBytes) * 100));
  }, [migration.copiedBytes, migration.totalBytes]);
  const visualPercent =
    migration.phase === 'scheduled'
      ? 0
      : migration.phase === 'copying_to_staging' || migration.phase === 'verifying'
        ? migrationPercent
        : 100;

  return (
    <SettingsSection>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              {t('dataDirectory.migration.title', {
                defaultValue: 'Migration status',
              })}
            </h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(`dataDirectory.migration.phases.${migration.phase}`, {
              defaultValue: migration.phase,
            })}
          </p>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
          {visualPercent}%
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={t('dataDirectory.migration.title', {
          defaultValue: 'Migration status',
        })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={visualPercent}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${visualPercent}%` }}
        />
      </div>

      <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
        {migration.sourceRoot && (
          <button
            type="button"
            onClick={() => onOpenDirectory(migration.sourceRoot!)}
            className="break-all rounded-md border border-border bg-background/70 p-2 text-left font-mono text-muted-foreground hover:text-primary"
          >
            {t('dataDirectory.migration.source', { defaultValue: 'From' })}:{' '}
            {formatDataPathForDisplay(migration.sourceRoot)}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpenDirectory(migration.targetRoot)}
          className="break-all rounded-md border border-border bg-background/70 p-2 text-left font-mono text-muted-foreground hover:text-primary"
        >
          {t('dataDirectory.migration.target', { defaultValue: 'To' })}:{' '}
          {formatDataPathForDisplay(migration.targetRoot)}
        </button>
      </div>

      {migration.lastError && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {migration.lastError}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {migration.restartRequired && (
          <button
            type="button"
            onClick={onRestart}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('dataDirectory.restart.now', { defaultValue: 'Restart now' })}
          </button>
        )}
        {migration.canCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            {t('dataDirectory.cancel.action', {
              defaultValue: 'Cancel pending migration',
            })}
          </button>
        )}
        {migration.canRollback && (
          <button
            type="button"
            onClick={onRollback}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('dataDirectory.rollback.action', {
              defaultValue: 'Restore previous folder',
            })}
          </button>
        )}
        {migration.canCleanup && (
          <button
            type="button"
            onClick={onCleanup}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('dataDirectory.cleanup.action', {
              defaultValue: 'Delete retained old data',
            })}
          </button>
        )}
      </div>
    </SettingsSection>
  );
}
