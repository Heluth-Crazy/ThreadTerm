/**
 * KeyboardBridge — global keyboard shortcut dispatcher.
 *
 * Single source of truth for all terminal-manager hotkeys. Listens in the
 * capture phase so it wins over xterm-js (which otherwise swallows most
 * combinations) and uses `e.code` where possible so physical-key mapping
 * on Windows/Linux/macOS stays consistent.
 *
 * Shortcuts (cross-platform, Ctrl=Cmd on macOS):
 *   Ctrl+`                  toggle radial switcher
 *   Ctrl+1..9               jump directly to that card
 *   Ctrl+Tab / Shift+Tab    cycle forward / backward
 *   double-tap Ctrl (<300ms) switch to last active card
 *   Ctrl+N                  open "create terminal" dialog
 *   Ctrl+W                  close the currently focused card
 *   Ctrl+B                  toggle notification centre
 *   Escape                  close drawers / return to grid
 */
import { useEffect, useRef } from 'react';
import { useTerminalStore } from '../../stores/terminalStore';

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

      // Ctrl+`  (or Ctrl+Backquote / physical backquote key)
      if (mod && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        e.stopPropagation();
        const st = s.getState();
        if (st.switcherVisible) st.closeSwitcher();
        else st.openSwitcher();
        return;
      }

      // If the switcher is open it owns navigation keys (handled inside the
      // component). We still need to let Ctrl-release double-tap through,
      // so do nothing here.
      if (s.getState().switcherVisible) return;

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

      // Escape — return to grid / close drawers
      if (e.key === 'Escape') {
        const st = s.getState();
        if (st.notificationCentreOpen) {
          e.preventDefault();
          e.stopPropagation();
          st.toggleNotificationCentre(false);
          return;
        }
        if (st.focusedCardId) {
          e.preventDefault();
          e.stopPropagation();
          st.focusCard(null);
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
