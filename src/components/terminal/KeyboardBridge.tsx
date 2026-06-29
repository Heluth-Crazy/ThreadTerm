/**
 * KeyboardBridge — global keyboard shortcut dispatcher.
 *
 * Single source of truth for all terminal-manager hotkeys. Listens in the
 * capture phase so it wins over xterm-js (which otherwise swallows most
 * combinations) and uses `e.code` where possible so physical-key mapping
 * on Windows/Linux/macOS stays consistent.
 *
 * Shortcuts (cross-platform, Ctrl=Cmd on macOS):
 *   Ctrl+`                  toggle inline overlay selector
 *   Ctrl+1..9               jump directly to that card
 *   Ctrl+Tab / Shift+Tab    cycle forward / backward
 *   double-tap Ctrl (<300ms) switch to last active card
 *   Ctrl+N                  open "create terminal" dialog
 *   Ctrl+W                  close the currently focused card
 *   Ctrl+B                  toggle notification centre
 *   Ctrl+E                  open / close the focus-mode session dock
 *   Ctrl+Shift+M            return focused terminal to grid
 *   Escape                  close non-terminal drawers only; terminal Esc is reserved for CLIs
 *
 * The *global* overlay hotkeys (default Cmd/Ctrl+Shift+Space and
 * Cmd/Ctrl+Shift+O) are registered on the Rust side via
 * `tauri-plugin-global-shortcut` and dispatched through `OverlayBridge`.
 */
import { useEffect, useRef } from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useOverlayStore } from '../../stores/overlayStore';

const DOUBLE_TAP_WINDOW_MS = 300;

export function KeyboardBridge(): null {
  const lastCtrlUpRef = useRef<number>(0);
  const ctrlComboUsedRef = useRef<boolean>(false);

  useEffect(() => {
    const s = useTerminalStore;

    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;

      // Track whether a Ctrl chord was used — if any other key is pressed
      // while Ctrl is held, the double-tap detector should not fire on the
      // following Ctrl release.
      if (mod && e.key !== 'Control' && e.key !== 'Meta') {
        ctrlComboUsedRef.current = true;
      }

      // Ctrl+`  (or Ctrl+Backquote / physical backquote key) — toggle the
      // inline overlay selector inside the main window.
      if (mod && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        e.stopPropagation();
        const ov = useOverlayStore.getState();
        if (ov.selectorOpen) ov.closeSelector();
        else ov.openSelector('inline');
        return;
      }

      // Ctrl/Cmd+E — open / close the focus-mode session dock.
      if (mod && (e.key === 'e' || e.key === 'E') && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        s.getState().toggleDockPin();
        return;
      }

      // If the selector is open it owns navigation keys (handled by
      // SelectorKeyboardBridge inside the overlay). Let Ctrl-release
      // double-tap fall through without any terminal-store mutation.
      if (useOverlayStore.getState().selectorOpen) return;

      // Ctrl+1-9 — jump to card
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        s.getState().jumpToIndex(Number(e.key) - 1);
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle
      if (mod && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) s.getState().prevCard();
        else s.getState().nextCard();
        return;
      }

      // Ctrl+K — open command palette (Stage 5.2)
      if (mod && (e.key === 'k' || e.key === 'K') && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        window.__terminalManager?.openPalette();
        return;
      }

      // Ctrl+F — open cross-session block search (Stage 5.1).
      // Capture phase + stopPropagation lets us win over xterm-js, which
      // would otherwise interpret Ctrl+F as terminal input on Linux/Windows.
      if (mod && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        window.__terminalManager?.openSearch();
        return;
      }

      // Ctrl+N — open create dialog
      if (mod && (e.key === 'n' || e.key === 'N') && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        window.__terminalManager?.openCreate();
        return;
      }

      // Ctrl+W — close focused card
      if (mod && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        e.stopPropagation();
        const { focusedCardId, removeCard } = s.getState();
        if (focusedCardId) removeCard(focusedCardId);
        return;
      }

      // Ctrl+B — toggle notification centre
      if (mod && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        e.stopPropagation();
        s.getState().toggleNotificationCentre();
        return;
      }

      // Ctrl/Cmd+Shift+M — return the focused terminal view to the card grid.
      // Escape must stay available to terminal CLIs such as Codex/Claude.
      if (mod && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        const st = s.getState();
        if (st.focusedCardId) {
          e.preventDefault();
          e.stopPropagation();
          st.focusCard(null);
        }
        return;
      }

      // Ctrl+, (comma) — open Settings (shortcuts tab by default so users
      // can immediately discover / rebind overlay hotkeys).
      if (mod && e.key === ',') {
        e.preventDefault();
        e.stopPropagation();
        window.__terminalManager?.openSettings('shortcuts');
        return;
      }

      // Escape — close non-terminal drawers only.
      // Do not use Escape for focused terminal navigation: CLIs rely on it
      // to cancel prompts, leave alternate modes, or dismiss inline UIs.
      if (e.key === 'Escape') {
        const st = s.getState();
        if (st.notificationCentreOpen) {
          e.preventDefault();
          e.stopPropagation();
          st.toggleNotificationCentre(false);
          return;
        }
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.key !== 'Control' && e.key !== 'Meta') return;
      if (ctrlComboUsedRef.current) {
        ctrlComboUsedRef.current = false;
        lastCtrlUpRef.current = 0;
        return;
      }
      const now = Date.now();
      if (now - lastCtrlUpRef.current < DOUBLE_TAP_WINDOW_MS) {
        lastCtrlUpRef.current = 0;
        s.getState().switchToLast();
      } else {
        lastCtrlUpRef.current = now;
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('keyup', handleKeyUp, { capture: true } as EventListenerOptions);
    };
  }, []);

  return null;
}
