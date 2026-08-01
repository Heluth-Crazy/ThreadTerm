import { FolderOpen, Loader2, SearchCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  DataDirectoryStatus,
  DataMigrationPreflight,
} from '../../lib/dataDirectory';
import { SettingsSection } from './SettingsSection';
import { formatDataBytes, formatDataPathForDisplay } from './dataDirectoryUi';

interface DataMigrationFormProps {
  status: DataDirectoryStatus | null;
  targetRoot: string;
  preflight: DataMigrationPreflight | null;
  retainSource: boolean;
  disabled: boolean;
  checking: boolean;
  onTargetRootChange: (value: string) => void;
  onChooseTarget: () => void;
  onInspectTarget: () => void;
  onRetainSourceChange: (value: boolean) => void;
  onScheduleLater: () => void;
  onScheduleNow: () => void;
}

export function DataMigrationForm({
  status,
  targetRoot,
  preflight,
  retainSource,
  disabled,
  checking,
  onTargetRootChange,
  onChooseTarget,
  onInspectTarget,
  onRetainSourceChange,
  onScheduleLater,
  onScheduleNow,
}: DataMigrationFormProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection>
      <h3 className="text-sm font-semibold text-foreground">
        {t('dataDirectory.move.title', {
          defaultValue: 'Move ThreadTerm data',
        })}
      </h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {t('dataDirectory.move.description', {
          defaultValue:
            'Choose a new or empty folder. The actual copy starts only after ThreadTerm has closed.',
        })}
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          value={formatDataPathForDisplay(targetRoot)}
          onChange={(event) => onTargetRootChange(event.target.value)}
          placeholder={
            status ? formatDataPathForDisplay(status.recommendedRoot) : undefined
          }
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={onChooseTarget}
          disabled={disabled}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t('dataDirectory.choose', { defaultValue: 'Browse' })}
        </button>
        <button
          type="button"
          onClick={onInspectTarget}
          disabled={disabled || targetRoot.trim().length === 0}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SearchCheck className="h-3.5 w-3.5" />}
          {t('dataDirectory.preflight.action', {
            defaultValue: 'Check folder',
          })}
        </button>
      </div>

      {preflight && (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <span>
              {t('dataDirectory.preflight.sourceSize', {
                size: formatDataBytes(preflight.sourceBytes),
                defaultValue: 'Data to copy: {{size}}',
              })}
            </span>
            <span>
              {t('dataDirectory.preflight.requiredSpace', {
                size: formatDataBytes(preflight.requiredBytes),
                defaultValue: 'Space required: {{size}}',
              })}
            </span>
            <span>
              {t('dataDirectory.preflight.availableSpace', {
                size: formatDataBytes(preflight.availableBytes),
                defaultValue: 'Space available: {{size}}',
              })}
            </span>
          </div>
          {preflight.warnings.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {preflight.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label className="mt-4 flex items-start gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={retainSource}
          onChange={(event) => onRetainSourceChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        <span>
          <span className="font-medium">
            {t('dataDirectory.retain.label', {
              defaultValue: 'Keep the old data copy after migration',
            })}
          </span>
          <span className="mt-0.5 block text-muted-foreground">
            {t('dataDirectory.retain.description', {
              defaultValue:
                'Recommended. You can verify the new folder, then delete the old copy manually from this page.',
            })}
          </span>
        </span>
      </label>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onScheduleLater}
          disabled={!preflight || disabled}
          className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('dataDirectory.schedule.later', {
            defaultValue: 'Move after I close ThreadTerm',
          })}
        </button>
        <button
          type="button"
          onClick={onScheduleNow}
          disabled={!preflight || disabled}
          className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs font-medium text-warning hover:bg-warning/10 disabled:opacity-50"
        >
          {t('dataDirectory.schedule.now', {
            defaultValue: 'Restart and move now',
          })}
        </button>
      </div>
    </SettingsSection>
  );
}
