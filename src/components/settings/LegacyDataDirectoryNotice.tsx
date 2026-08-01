import { useEffect, useState } from 'react';
import { FolderCog, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { dataDirectory } from '../../lib/dataDirectory';
import { openSettingsWindow } from '../../lib/settingsWindow';
import { isTauriEnv } from '../../lib/tauri-bridge';

export function LegacyDataDirectoryNotice() {
  const { t } = useTranslation('settings');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isTauriEnv()) return undefined;
    let disposed = false;
    void Promise.all([dataDirectory.status(), dataDirectory.migrationStatus()])
      .then(([status, migration]) => {
        if (!disposed && status.mode === 'legacy_split' && migration === null) {
          setVisible(true);
        }
      })
      .catch(() => {
        // The settings page owns detailed diagnostics; this reminder stays non-blocking.
      });
    return () => {
      disposed = true;
    };
  }, []);

  if (!visible) return null;

  return (
    <aside className="fixed bottom-4 left-4 z-modal w-[min(420px,calc(100vw-2rem))] rounded-xl border border-border bg-card/95 p-4 text-foreground shadow-xl backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FolderCog className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {t('dataDirectory.legacyPrompt.title', {
              defaultValue: 'Choose one place for ThreadTerm data',
            })}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('dataDirectory.legacyPrompt.description', {
              defaultValue:
                'This installation still uses older, separate folders. You can consolidate ThreadTerm data when convenient; terminals and Agent data will not be moved now.',
            })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setVisible(false);
                void openSettingsWindow('data');
              }}
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('dataDirectory.legacyPrompt.manage', {
                defaultValue: 'Review data location',
              })}
            </button>
            <button
              type="button"
              onClick={() => setVisible(false)}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
            >
              {t('dataDirectory.legacyPrompt.later', {
                defaultValue: 'Later',
              })}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t('dataDirectory.legacyPrompt.dismiss', {
            defaultValue: 'Dismiss reminder',
          })}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
