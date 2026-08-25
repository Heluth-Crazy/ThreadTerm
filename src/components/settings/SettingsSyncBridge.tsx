import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { listenSettingsChanged } from '../../lib/settingsSync';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  getPreloadedManagedStateItem,
  MANAGED_STATE_KEYS,
} from '../../lib/managedState';

type PersistableTerminalStore = typeof useTerminalStore & {
  persist?: {
    rehydrate: () => void | Promise<void>;
  };
};

function getSavedLanguage(): string | null {
  return getPreloadedManagedStateItem(MANAGED_STATE_KEYS.language);
}

export function SettingsSyncBridge(): null {
  const { i18n } = useTranslation();
  const { applyThemeSettingsSnapshot } = useTheme();

  useEffect(() => {
    return listenSettingsChanged((payload) => {
      if ((payload.domain === 'theme' || payload.domain === 'all') && payload.theme) {
        applyThemeSettingsSnapshot(payload.theme);
      }

      if (payload.domain === 'language' || payload.domain === 'all') {
        const language = payload.language ?? getSavedLanguage();
        if (language && i18n.language !== language) {
          void i18n.changeLanguage(language);
        }
      }

      if (
        (payload.domain === 'terminal-preferences' || payload.domain === 'all')
        && payload.terminalPreferences
      ) {
        useTerminalStore.setState({
          osNotificationsEnabled: payload.terminalPreferences.osNotificationsEnabled,
          osNotificationPreviewEnabled:
            payload.terminalPreferences.osNotificationPreviewEnabled ?? true,
          agentCliCompatibilityCompletionEnabled:
            payload.terminalPreferences.agentCliCompatibilityCompletionEnabled ?? true,
          supervisorEnabled: payload.terminalPreferences.supervisorEnabled,
        });
      }

      if (
        (payload.domain === 'terminal-preferences' || payload.domain === 'all')
        && !payload.terminalPreferences
      ) {
        void (useTerminalStore as PersistableTerminalStore).persist?.rehydrate();
      }

      if (
        (payload.domain === 'all' || payload.domain === 'overlay-preferences')
        && payload.overlayPreferences
      ) {
        useOverlayStore.setState({
          selectorMode: payload.overlayPreferences.selectorMode,
          hotkeyA: payload.overlayPreferences.hotkeyA,
          hotkeyB: payload.overlayPreferences.hotkeyB,
          lightweightMode: payload.overlayPreferences.lightweightMode,
        });
      }
    });
  }, [applyThemeSettingsSnapshot, i18n]);

  return null;
}
