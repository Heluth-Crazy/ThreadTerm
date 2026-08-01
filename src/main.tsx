import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { logger } from './lib/logger'
import { applySavedTheme } from './theme/applyTheme'
import { preloadCustomThemePacks } from './theme/customThemePacks'
import { preloadThemePreference } from './theme/themeStorage'
import { installNativeDesktopBehavior } from './lib/nativeDesktop'
import { ManagedStateBootstrap } from './components/ManagedStateBootstrap'

// Initialize i18n
import './i18n/config'

installNativeDesktopBehavior(document, { platformMaterial: true });
// Warm the managed-state theme cache before painting: with a cold cache
// applySavedTheme resolves to defaults and the boot screen flashes the
// default theme instead of the user's.
void (async () => {
  await Promise.all([preloadThemePreference(), preloadCustomThemePacks()])
  applySavedTheme()
})()

// Clean up stale service workers on app load to prevent caching issues after builds
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => {
      registration.unregister();
    });
  }).catch(err => {
    logger.warn('Failed to unregister service workers:', err);
  });
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root was not found.');
}

ReactDOM.createRoot(root).render(
  <ManagedStateBootstrap>
    <App />
  </ManagedStateBootstrap>,
);
