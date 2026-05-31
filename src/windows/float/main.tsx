/**
 * Float webview entry point.
 *
 * Bundled as a separate Vite input (`float.html`) so the floating-terminal
 * window starts with the smallest JS footprint — only the bits needed to
 * host a single session's xterm. Shares the main app's i18n + Tailwind
 * styles for visual consistency with the main window.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../index.css';
import '../../i18n/config.js';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { applySavedTheme } from '../../theme/applyTheme';
import { installNativeDesktopBehavior, installOverlayKeepWarmLoop } from '../../lib/nativeDesktop';
import { FloatApp } from './FloatApp';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('[float] missing #root element');
}

applySavedTheme();
installNativeDesktopBehavior();
installOverlayKeepWarmLoop();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <FloatApp />
    </ThemeProvider>
  </React.StrictMode>,
);
