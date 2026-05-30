/**
 * Selector webview entry point.
 *
 * Bundled as a separate Vite input (`selector.html`) so the overlay window
 * starts with the smallest possible JS footprint — it only needs the
 * overlay-selector code path, not the full main-app bundle.
 *
 * The selector window is created lazily by `overlay.rs::ensure_selector`
 * and shown/hidden on demand; this module is therefore parsed exactly once
 * per app process, on first overlay activation.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../index.css';
import '../../i18n/config.js';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { applySavedTheme } from '../../theme/applyTheme';
import { installNativeDesktopBehavior } from '../../lib/nativeDesktop';
import { SelectorApp } from './SelectorApp';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('[selector] missing #root element');
}

applySavedTheme();
installNativeDesktopBehavior();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <SelectorApp />
    </ThemeProvider>
  </React.StrictMode>,
);
