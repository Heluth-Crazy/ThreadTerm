import { BellRing } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { SettingsSection } from './SettingsSection';

export function NotificationPreferenceSettings() {
  const { t } = useTranslation('settings');
  const osNotificationsEnabled = useTerminalStore((state) => state.osNotificationsEnabled);
  const setOsNotificationsEnabled = useTerminalStore((state) => state.setOsNotificationsEnabled);

  return (
    <SettingsSection>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('notifications.preference.title')}
            </h3>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('notifications.preference.description')}
          </p>
        </div>
        <label className="inline-flex shrink-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={osNotificationsEnabled}
            onChange={(event) => setOsNotificationsEnabled(event.target.checked)}
          />
          <span>
            {osNotificationsEnabled
              ? t('notifications.preference.enabled')
              : t('notifications.preference.disabled')}
          </span>
        </label>
      </div>
    </SettingsSection>
  );
}
