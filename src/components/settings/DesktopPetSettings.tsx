import { BellRing } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';

/**
 * System notification toggle. Formerly the desktop-pet panel; the pet feature
 * was removed (OS notifications cover the same need without a second webview),
 * so this is now just the OS-notification switch.
 */
export function DesktopPetSettings() {
  const { t } = useTranslation('settings');
  const osNotificationsEnabled = useTerminalStore((state) => state.osNotificationsEnabled);
  const setOsNotificationsEnabled = useTerminalStore((state) => state.setOsNotificationsEnabled);

  return (
    <section className="rounded-[var(--radius)] border border-white/10 bg-white/5 backdrop-blur-md p-4 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('desktopPet.notify.label')}
            </h3>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('desktopPet.notify.os')}
          </p>
        </div>
        <label className="inline-flex shrink-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={osNotificationsEnabled}
            onChange={(event) => setOsNotificationsEnabled(event.target.checked)}
          />
          <span>{osNotificationsEnabled ? t('desktopPet.enabled') : t('desktopPet.disabled')}</span>
        </label>
      </div>
    </section>
  );
}
