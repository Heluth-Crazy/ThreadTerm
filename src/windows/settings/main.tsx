import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../../index.css';
import '../../i18n/config';
import { ThemeProvider } from '../../theme/ThemeContext';
import Settings from '../../components/settings/Settings';
import { applySavedTheme } from '../../theme/applyTheme';
import { preloadCustomThemePacks } from '../../theme/customThemePacks';
import { preloadThemePreference } from '../../theme/themeStorage';
import { installNativeDesktopBehavior } from '../../lib/nativeDesktop';
import {
  SETTINGS_OPEN_EVENT,
  normalizeSettingsOpenPayload,
  normalizeSettingsTab,
  type SettingsTab,
} from '../../lib/settingsWindow';
import { isTauriEnv } from '../../lib/tauri-bridge';
import { ManagedStateBootstrap } from '../../components/ManagedStateBootstrap';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('[settings] missing #root element');
}

function getInitialSettingsTab(): SettingsTab {
  return normalizeSettingsTab(new URLSearchParams(window.location.search).get('tab'));
}

function SettingsWindowApp() {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => getInitialSettingsTab());

  useEffect(() => {
    if (!isTauriEnv()) return undefined;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>(SETTINGS_OPEN_EVENT, (event) => {
          setActiveTab(normalizeSettingsOpenPayload(event.payload).tab);
        }),
      )
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error) => {
        console.debug('[settings] failed to listen for settings open events', error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <Settings isOpen embedded initialTab={activeTab} />
    </div>
  );
}

// Warm the managed-state theme cache before painting anything: applying the
// saved theme from a cold cache resolves to defaults and the bootstrap
// loading card would flash the default theme instead of the user's.
void (async () => {
  await Promise.all([preloadThemePreference(), preloadCustomThemePacks()]);
  applySavedTheme();
  installNativeDesktopBehavior();

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ManagedStateBootstrap>
        <ThemeProvider>
          <SettingsWindowApp />
        </ThemeProvider>
      </ManagedStateBootstrap>
    </React.StrictMode>,
  );
})();
