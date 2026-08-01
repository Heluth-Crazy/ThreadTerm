import {
  AlertTriangle,
  AppWindow,
  Database,
  FolderCog,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DataDirectoryStatus } from '../../lib/dataDirectory';
import { SettingsSection } from './SettingsSection';
import {
  CATEGORY_DEFAULT_LABELS,
  formatDataBytes,
  formatDataPathForDisplay,
  parentDirectory,
} from './dataDirectoryUi';

export type DataDirectoryActionMessage = {
  kind: 'success' | 'error';
  text: string;
} | null;

interface DataDirectoryOverviewProps {
  status: DataDirectoryStatus | null;
  message: DataDirectoryActionMessage;
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
  onOpenDirectory: (path: string) => void;
}

export function DataDirectoryOverview({
  status,
  message,
  refreshing,
  disabled,
  onRefresh,
  onOpenDirectory,
}: DataDirectoryOverviewProps) {
  const { t } = useTranslation('settings');

  return (
    <SettingsSection>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FolderCog className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('dataDirectory.title', { defaultValue: 'ThreadTerm data location' })}
            </h3>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('dataDirectory.description', {
              defaultValue:
                'Choose where ThreadTerm keeps its own database, interface state, and window state. Projects and Agent data are never moved.',
            })}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {t('dataDirectory.refresh', { defaultValue: 'Refresh' })}
        </button>
      </div>

      {message && (
        <div
          className={[
            'mt-4 rounded-md border px-3 py-2 text-xs leading-5',
            message.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-primary/30 bg-primary/10 text-foreground',
          ].join(' ')}
        >
          {message.text}
        </div>
      )}

      {!status ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('dataDirectory.loading', { defaultValue: 'Reading data locations…' })}
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-background/70 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <AppWindow className="h-3.5 w-3.5" />
                {t('dataDirectory.application.label', {
                  defaultValue: 'Application location',
                })}
              </div>
              <div className="mt-2 break-all font-mono text-xs text-foreground">
                {formatDataPathForDisplay(status.applicationPath)}
              </div>
              <button
                type="button"
                onClick={() => onOpenDirectory(parentDirectory(status.applicationPath))}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('dataDirectory.open', { defaultValue: 'Open folder' })}
              </button>
            </div>

            <div className="rounded-lg border border-border bg-background/70 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <HardDrive className="h-3.5 w-3.5" />
                {t('dataDirectory.current.label', {
                  defaultValue: 'ThreadTerm data location',
                })}
              </div>
              <div className="mt-2 break-all font-mono text-xs text-foreground">
                {status.root
                  ? formatDataPathForDisplay(status.root)
                  : t('dataDirectory.current.legacy', {
                      defaultValue: 'Legacy locations (not yet consolidated)',
                    })}
              </div>
              {status.root && (
                <button
                  type="button"
                  onClick={() => onOpenDirectory(status.root!)}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('dataDirectory.open', { defaultValue: 'Open folder' })}
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="text-xs font-medium text-muted-foreground">
              {t('dataDirectory.pointer.label', {
                defaultValue: 'Startup location pointer',
              })}
            </div>
            <div className="mt-1 break-all font-mono text-xs text-foreground">
              {formatDataPathForDisplay(status.bootstrapPointerPath)}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t('dataDirectory.pointer.description', {
                defaultValue:
                  'This tiny file stays in the system configuration folder so ThreadTerm can find your selected data folder before it starts.',
              })}
            </p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {status.categories.map((category) => (
              <div
                key={category.category}
                className="rounded-lg border border-border bg-background/70 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {category.category === 'database' ? (
                      <Database className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <HardDrive className="h-4 w-4 text-muted-foreground" />
                    )}
                    {t(`dataDirectory.categories.${category.category}`, {
                      defaultValue: CATEGORY_DEFAULT_LABELS[category.category],
                    })}
                  </span>
                  <span className="text-xs font-semibold text-foreground">
                    {category.measurable
                      ? formatDataBytes(category.bytes)
                      : t('dataDirectory.systemManaged', {
                          defaultValue: 'System managed',
                        })}
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  {category.paths.length > 0 ? (
                    category.paths.map((path) => (
                      <button
                        key={path}
                        type="button"
                        onClick={() => onOpenDirectory(path)}
                        className="block w-full break-all text-left font-mono text-[11px] leading-4 text-muted-foreground hover:text-primary"
                      >
                        {formatDataPathForDisplay(path)}
                      </button>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t('dataDirectory.noDirectPath', {
                        defaultValue: 'No user-selectable path',
                      })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t('dataDirectory.total', {
                size: formatDataBytes(status.totalBytes),
                defaultValue: 'Total managed data: {{size}}',
              })}
            </span>
            <span>
              {t('dataDirectory.boundary', {
                defaultValue:
                  'Agent sessions, credentials, projects, repositories, and worktrees stay where they are.',
              })}
            </span>
          </div>

          {status.platformNotes.length > 0 && (
            <div className="mt-3 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>
                {t('dataDirectory.platform.macos', {
                  defaultValue:
                    'macOS keeps WebKit engine caches in a system-managed location. ThreadTerm business data still moves to your selected folder.',
                })}
              </span>
            </div>
          )}
        </>
      )}
    </SettingsSection>
  );
}
