import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { logger } from './lib/logger'
import { applySavedTheme } from './theme/applyTheme'
import { installNativeDesktopBehavior } from './lib/nativeDesktop'

// Initialize i18n
import './i18n/config'

installNativeDesktopBehavior(document, { platformMaterial: true });
applySavedTheme();

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

ReactDOM.createRoot(root).render(<App />);
