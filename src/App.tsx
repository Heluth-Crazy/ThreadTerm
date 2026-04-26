import { I18nextProvider } from 'react-i18next';
import { ThemeProvider } from './contexts/ThemeContext';
import i18n from './i18n/config.js';
import { TerminalManager } from './components/terminal/TerminalManager';
import { TerminalEventBridge } from './components/terminal/TerminalEventBridge';
import { NotificationBridge } from './components/terminal/NotificationBridge';
import { KeyboardBridge } from './components/terminal/KeyboardBridge';
import { OverlayBridge } from './components/overlays/OverlayBridge';
import { NotificationCenter } from './components/terminal/NotificationCenter';

/**
 * Terminal Manager Lite — lightweight terminal orchestrator.
 *
 * Responsibilities:
 *   • render the terminal card grid / full-screen terminal view
 *   • bridge PTY events from Rust into the in-memory store
 *   • dispatch OS notifications and populate the in-app notification center
 *   • handle global keyboard shortcuts and the inline overlay selector
 *   • relay Rust-owned overlay windows (selector / float) via OverlayBridge
 */
export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <TerminalEventBridge />
        <NotificationBridge />
        <KeyboardBridge />
        <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
          <TerminalManager />
          <OverlayBridge />
          <NotificationCenter />
        </div>
      </ThemeProvider>
    </I18nextProvider>
  );
}
