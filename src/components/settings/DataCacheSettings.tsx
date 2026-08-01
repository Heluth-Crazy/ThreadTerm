import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DataCacheCleanupStatus } from '../../lib/dataDirectory';
import { SettingsSection } from './SettingsSection';
import { formatDataBytes } from './dataDirectoryUi';

interface DataCacheSettingsProps {
  status: DataCacheCleanupStatus;
  disabled: boolean;
  onToggle: () => void;
}

export function DataCacheSettings({
  status,
  disabled,
  onToggle,
}: DataCacheSettingsProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              {t('dataDirectory.cache.title', {
                defaultValue: 'Rebuildable desktop cache',
              })}
            </h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {status.supported
              ? t('dataDirectory.cache.description', {
                  size: formatDataBytes(status.bytes),
                  defaultValue:
                    'Browser-engine cache can be rebuilt and currently uses {{size}}. Cards, settings, database records, and login data are not included.',
                })
              : t('dataDirectory.cache.systemManaged', {
                  defaultValue:
                    'macOS manages WebKit engine cache outside the selectable ThreadTerm data folder.',
                })}
          </p>
          {status.scheduled && (
            <p className="mt-2 text-xs font-medium text-primary">
              {t('dataDirectory.cache.pending', {
                defaultValue:
                  'Cleanup is scheduled for the next time ThreadTerm starts.',
              })}
            </p>
          )}
        </div>
        {status.supported && (
          <button
            type="button"
            onClick={onToggle}
            disabled={disabled}
            className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            {status.scheduled
              ? t('dataDirectory.cache.cancel', {
                  defaultValue: 'Cancel cache cleanup',
                })
              : t('dataDirectory.cache.action', {
                  defaultValue: 'Clear after restart',
                })}
          </button>
        )}
      </div>
    </SettingsSection>
  );
}
