import { useCallback, useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import {
  dataDirectory,
  type DataCacheCleanupStatus,
  type DataDirectoryStatus,
  type DataMigrationPreflight,
  type DataMigrationStatus,
} from '../../lib/dataDirectory';
import { openLocalDirectory } from '../../lib/localDirectory';
import { confirmDialog } from '../../lib/nativeDialog';
import { isTauriEnv, pty } from '../../lib/tauri-bridge';
import { DataCacheSettings } from './DataCacheSettings';
import {
  DataDirectoryOverview,
  type DataDirectoryActionMessage,
} from './DataDirectoryOverview';
import { DataMigrationForm } from './DataMigrationForm';
import { DataMigrationStatusSection } from './DataMigrationStatusSection';
import { SettingsSection } from './SettingsSection';
import { formatDataPathForDisplay } from './dataDirectoryUi';

type BusyAction =
  | 'refresh'
  | 'preflight'
  | 'schedule'
  | 'restart'
  | 'cancel'
  | 'rollback'
  | 'cleanup'
  | 'cache'
  | null;

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

export function DataDirectorySettings() {
  const { t } = useTranslation('settings');
  const desktop = isTauriEnv();
  const [status, setStatus] = useState<DataDirectoryStatus | null>(null);
  const [migration, setMigration] = useState<DataMigrationStatus | null>(null);
  const [cacheStatus, setCacheStatus] = useState<DataCacheCleanupStatus | null>(null);
  const [targetRoot, setTargetRoot] = useState('');
  const [preflight, setPreflight] = useState<DataMigrationPreflight | null>(null);
  const [retainSource, setRetainSource] = useState(true);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<DataDirectoryActionMessage>(null);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setBusy('refresh');
    setMessage(null);
    try {
      const [nextStatus, nextMigration, nextCacheStatus] = await Promise.all([
        dataDirectory.status(),
        dataDirectory.migrationStatus(),
        dataDirectory.cacheCleanupStatus(),
      ]);
      setStatus(nextStatus);
      setMigration(nextMigration);
      setCacheStatus(nextCacheStatus);
      setTargetRoot((current) => current || nextStatus.recommendedRoot);
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }, [desktop]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const chooseTarget = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('dataDirectory.chooseTitle', {
          defaultValue: 'Choose an empty ThreadTerm data folder',
        }),
        defaultPath: targetRoot || status?.recommendedRoot || undefined,
      });
      if (typeof selected === 'string' && selected) {
        setTargetRoot(selected);
        setPreflight(null);
        setMessage(null);
      }
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    }
  };

  const inspectTarget = async () => {
    setBusy('preflight');
    setMessage(null);
    setPreflight(null);
    try {
      const result = await dataDirectory.preflight(targetRoot.trim());
      setPreflight(result);
      setTargetRoot(result.targetRoot);
      setMessage({
        kind: 'success',
        text: t('dataDirectory.preflight.ready', {
          defaultValue: 'This folder is ready for migration.',
        }),
      });
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const confirmRestart = async (): Promise<boolean> => {
    let terminalCount = 0;
    try {
      terminalCount = Object.keys(await pty.getAllSessionStates()).length;
    } catch {
      // The warning remains valid even if the diagnostic count is unavailable.
    }
    return confirmDialog(
      t('dataDirectory.restart.confirm', {
        count: terminalCount,
        defaultValue:
          'ThreadTerm will close and reopen. {{count}} open terminal(s) will be ended. Continue?',
      }),
      {
        title: t('dataDirectory.restart.title', {
          defaultValue: 'Restart ThreadTerm',
        }),
        kind: 'warning',
      },
    );
  };

  const scheduleMigration = async (restartNow: boolean) => {
    if (!preflight) return;
    if (restartNow && !(await confirmRestart())) return;

    setBusy(restartNow ? 'restart' : 'schedule');
    setMessage(null);
    try {
      const nextMigration = await dataDirectory.schedule(
        preflight.targetRoot,
        retainSource,
      );
      setMigration(nextMigration);
      setMessage({
        kind: 'success',
        text: restartNow
          ? t('dataDirectory.restart.starting', {
              defaultValue: 'Restarting ThreadTerm to move the data…',
            })
          : t('dataDirectory.schedule.success', {
              defaultValue:
                'Migration is scheduled. Your current terminals will keep running until you close ThreadTerm.',
            }),
      });
      if (restartNow) {
        await dataDirectory.restart();
      }
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const restartForPendingChange = async () => {
    if (!(await confirmRestart())) return;
    setBusy('restart');
    setMessage(null);
    try {
      await dataDirectory.restart();
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
      setBusy(null);
    }
  };

  const cancelPending = async () => {
    setBusy('cancel');
    setMessage(null);
    try {
      await dataDirectory.cancel();
      setPreflight(null);
      await refresh();
      setMessage({
        kind: 'success',
        text: t('dataDirectory.cancel.success', {
          defaultValue: 'The pending migration was cancelled.',
        }),
      });
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const requestRollback = async () => {
    if (!migration) return;
    const confirmed = await confirmDialog(
      t('dataDirectory.rollback.confirm', {
        defaultValue:
          'Use the retained previous data folder after the next restart? The current folder will not be deleted.',
      }),
      {
        title: t('dataDirectory.rollback.title', {
          defaultValue: 'Restore previous data folder',
        }),
        kind: 'warning',
      },
    );
    if (!confirmed) return;

    setBusy('rollback');
    setMessage(null);
    try {
      const nextMigration = await dataDirectory.requestRollback(migration.transactionId);
      setMigration(nextMigration);
      setMessage({
        kind: 'success',
        text: t('dataDirectory.rollback.success', {
          defaultValue: 'The previous folder will be restored when ThreadTerm restarts.',
        }),
      });
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const cleanupSource = async () => {
    if (!migration) return;
    const confirmed = await confirmDialog(
      t('dataDirectory.cleanup.confirm', {
        path: formatDataPathForDisplay(migration.sourceRoot ?? ''),
        defaultValue:
          'Permanently delete the retained old ThreadTerm data at {{path}}? This cannot be undone.',
      }),
      {
        title: t('dataDirectory.cleanup.title', {
          defaultValue: 'Delete old ThreadTerm data',
        }),
        kind: 'warning',
      },
    );
    if (!confirmed) return;

    setBusy('cleanup');
    setMessage(null);
    try {
      const nextMigration = await dataDirectory.cleanupSource(migration.transactionId);
      setMigration(nextMigration);
      setMessage({
        kind: 'success',
        text: t('dataDirectory.cleanup.success', {
          defaultValue: 'The retained old ThreadTerm data was deleted.',
        }),
      });
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const openDirectory = async (path: string) => {
    try {
      await openLocalDirectory(path);
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    }
  };

  const toggleCacheCleanup = async () => {
    if (!cacheStatus?.supported) return;
    setBusy('cache');
    setMessage(null);
    try {
      const nextStatus = cacheStatus.scheduled
        ? await dataDirectory.cancelCacheCleanup()
        : await dataDirectory.scheduleCacheCleanup();
      setCacheStatus(nextStatus);
      setMessage({
        kind: 'success',
        text: nextStatus.scheduled
          ? t('dataDirectory.cache.scheduled', {
              defaultValue:
                'Rebuildable cache will be cleared after ThreadTerm fully closes.',
            })
          : t('dataDirectory.cache.cancelled', {
              defaultValue: 'The pending cache cleanup was cancelled.',
            }),
      });
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!desktop) {
    return (
      <SettingsSection>
        <h3 className="text-base font-semibold text-foreground">
          {t('dataDirectory.title', { defaultValue: 'ThreadTerm data location' })}
        </h3>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {t('dataDirectory.desktopOnly', {
            defaultValue: 'Data location management is available in the desktop app.',
          })}
        </p>
      </SettingsSection>
    );
  }

  const canStartNewMigration =
    !migration ||
    (!migration.canCancel &&
      !migration.restartRequired &&
      !migration.canRollback &&
      !migration.canCleanup);

  return (
    <div className="space-y-4">
      <DataDirectoryOverview
        status={status}
        message={message}
        refreshing={busy === 'refresh'}
        disabled={busy !== null}
        onRefresh={() => void refresh()}
        onOpenDirectory={(path) => void openDirectory(path)}
      />

      {cacheStatus && (
        <DataCacheSettings
          status={cacheStatus}
          disabled={busy !== null}
          onToggle={() => void toggleCacheCleanup()}
        />
      )}

      {migration && (
        <DataMigrationStatusSection
          migration={migration}
          disabled={busy !== null}
          onOpenDirectory={(path) => void openDirectory(path)}
          onRestart={() => void restartForPendingChange()}
          onCancel={() => void cancelPending()}
          onRollback={() => void requestRollback()}
          onCleanup={() => void cleanupSource()}
        />
      )}

      {canStartNewMigration && (
        <DataMigrationForm
          status={status}
          targetRoot={targetRoot}
          preflight={preflight}
          retainSource={retainSource}
          disabled={busy !== null}
          checking={busy === 'preflight'}
          onTargetRootChange={(value) => {
            setTargetRoot(value);
            setPreflight(null);
          }}
          onChooseTarget={() => void chooseTarget()}
          onInspectTarget={() => void inspectTarget()}
          onRetainSourceChange={setRetainSource}
          onScheduleLater={() => void scheduleMigration(false)}
          onScheduleNow={() => void scheduleMigration(true)}
        />
      )}
    </div>
  );
}
