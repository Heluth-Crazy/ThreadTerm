/**
 * SelectorKeyboardBridge — global keyboard handler for the selector overlay.
 *
 * Mounted only while the selector is open. Uses capture-phase listeners so
 * xterm / input elements within embedded previews cannot swallow the keys.
 *
 *   ←/↑              previous card (wrap)
 *   →/↓              next card (wrap)
 *   Tab / Shift+Tab  next / previous card (wrap)
 *   1-9              jump to index & confirm
 *   Enter / Space    confirm current selection → float
 *   Escape           close selector
 *   `m`              toggle mode (tile ⇄ carousel)
 */
import { useEffect, useRef } from 'react';

export interface SelectorKeyboardBridgeProps {
  total: number;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onConfirm: (index: number) => void;
  onClose: () => void;
  onToggleMode: () => void;
}

export function SelectorKeyboardBridge({
  total,
  selectedIndex,
  onSelect,
  onConfirm,
  onClose,
  onToggleMode,
}: SelectorKeyboardBridgeProps) {
  // Keep the latest props in a ref so the listener needn't be re-bound on
  // every render — `total` can change frequently as card activity updates.
  const propsRef = useRef({ total, selectedIndex, onSelect, onConfirm, onClose, onToggleMode });
  propsRef.current = { total, selectedIndex, onSelect, onConfirm, onClose, onToggleMode };

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const {
        total: t,
        selectedIndex: i,
        onSelect: sel,
        onConfirm: conf,
        onClose: close,
        onToggleMode: tog,
      } = propsRef.current;

      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      const wrap = (n: number) => (t > 0 ? ((n % t) + t) % t : 0);

      switch (e.key) {
        case 'Escape':
          stop();
          close();
          return;
        case 'Enter':
        case ' ':
          stop();
          if (t > 0) conf(i);
          return;
        case 'ArrowRight':
        case 'ArrowDown':
          stop();
          if (t > 0) sel(wrap(i + 1));
          return;
        case 'ArrowLeft':
        case 'ArrowUp':
          stop();
          if (t > 0) sel(wrap(i - 1));
          return;
        case 'Tab':
          stop();
          if (t > 0) sel(wrap(i + (e.shiftKey ? -1 : 1)));
          return;
        case 'm':
        case 'M':
          stop();
          tog();
          return;
        default: {
          // Number keys 1-9 jump + confirm.
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            const n = Number(e.key);
            if (Number.isFinite(n) && n >= 1 && n <= 9 && n <= t) {
              stop();
              conf(n - 1);
            }
          }
        }
      }
    };

    window.addEventListener('keydown', handle, { capture: true });
    return () => {
      window.removeEventListener('keydown', handle, { capture: true } as EventListenerOptions);
    };
  }, []);

  return null;
}
