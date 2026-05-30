import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import '../i18n/config.js';
import { ThemeProvider } from '../contexts/ThemeContext';
import { applySavedTheme } from '../theme/applyTheme';
import { installNativeDesktopBehavior } from '../lib/nativeDesktop';
import { PetWindow } from './PetWindow';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('[pet] missing #root element');
}

applySavedTheme();
installNativeDesktopBehavior();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <PetWindow />
    </ThemeProvider>
  </React.StrictMode>,
);
