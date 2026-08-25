import { BellRing } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { SettingsSection } from './SettingsSection';

export function NotificationPreferenceSettings() {
  const { t } = useTranslation('settings');
  const osNotificationsEnabled = useTerminalStore((state) => state.osNotificationsEnabled);
  const setOsNotificationsEnabled = useTerminalStore((state) => state.setOsNotificationsEnabled);
  const osNotificationPreviewEnabled = useTerminalStore(
    (state) => state.osNotificationPreviewEnabled,
  );
  const setOsNotificationPreviewEnabled = useTerminalStore(
    (state) => state.setOsNotificationPreviewEnabled,
  );
  const agentCliCompatibilityCompletionEnabled = useTerminalStore(
    (state) => state.agentCliCompatibilityCompletionEnabled,
  );
  const setAgentCliCompatibilityCompletionEnabled = useTerminalStore(
    (state) => state.setAgentCliCompatibilityCompletionEnabled,
  );

  const toggles = [
    {
      id: 'os-notifications-enabled',
      label: t('notifications.preference.osLabel'),
      description: t('notifications.preference.osDescription'),
      checked: osNotificationsEnabled,
      onChange: setOsNotificationsEnabled,
    },
    {
      id: 'os-notification-preview-enabled',
      label: t('notifications.preference.previewLabel'),
      description: t('notifications.preference.previewDescription'),
      checked: osNotificationPreviewEnabled,
      onChange: setOsNotificationPreviewEnabled,
    },
    {
      id: 'agent-cli-compatibility-enabled',
      label: t('notifications.preference.compatibilityLabel'),
      description: t('notifications.preference.compatibilityDescription'),
      checked: agentCliCompatibilityCompletionEnabled,
      onChange: setAgentCliCompatibilityCompletionEnabled,
    },
  ];

  return (
    <SettingsSection>
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
        <div className="mt-4 space-y-3">
          {toggles.map((toggle) => (
            <label
              key={toggle.id}
              htmlFor={toggle.id}
              className="flex cursor-pointer items-start justify-between gap-4 rounded-md border border-border/70 p-3"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  {toggle.label}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {toggle.description}
                </span>
              </span>
              <input
                id={toggle.id}
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={toggle.checked}
                aria-label={toggle.label}
                onChange={(event) => toggle.onChange(event.target.checked)}
              />
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t('notifications.preference.privacyNote')}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('notifications.preference.reliabilityNote')}
        </p>
      </div>
    </SettingsSection>
  );
}
