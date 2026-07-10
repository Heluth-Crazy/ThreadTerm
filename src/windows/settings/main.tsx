import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../../index.css';
import '../../i18n/config';
import { ThemeProvider } from '../../theme/ThemeContext';
import Settings from '../../components/settings/Settings';
import { applySavedTheme } from '../../theme/applyTheme';
import { installNativeDesktopBehavior } from '../../lib/nativeDesktop';
import {
  SETTINGS_OPEN_EVENT,
  normalizeSettingsOpenPayload,
  normalizeSettingsTab,
  type SettingsTab,
} from '../../lib/settingsWindow';
import { isTauriEnv } from '../../lib/tauri-bridge';

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

applySavedTheme();
installNativeDesktopBehavior();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <SettingsWindowApp />
    </ThemeProvider>
  </React.StrictMode>,
);
