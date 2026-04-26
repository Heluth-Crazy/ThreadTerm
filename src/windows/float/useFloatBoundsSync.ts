/**
 * useFloatBoundsSync — debounced persistence of the float window's bounds.
 *
 * Listens to the current Tauri webview window's `onMoved` / `onResized`
 * lifecycle events. When the user drags or resizes the float window we
 * debounce for ~400ms and then invoke `overlay_save_float_bounds` on Rust,
 * which writes the value into the SQLite settings table. On next cold
 * start `overlay::ensure_float` will restore the same bounds.
 *
 * Web/preview mode is a no-op.
 */
import { useEffect, useRef } from 'react';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';

const DEBOUNCE_MS = 400;

export function useFloatBoundsSync() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isTauriEnv()) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();

        const schedulePersist = () => {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(async () => {
            try {
              const pos = await win.outerPosition();
              const size = await win.outerSize();
              const factor = await win.scaleFactor();
              await invoke('overlay_save_float_bounds', {
                bounds: {
                  x: pos.x / factor,
                  y: pos.y / factor,
                  w: size.width / factor,
                  h: size.height / factor,
                },
              });
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[float] persist bounds failed:', e);
            }
          }, DEBOUNCE_MS);
        };

        const offMoved = await win.onMoved(schedulePersist);
        const offResized = await win.onResized(schedulePersist);
        if (cancelled) {
          offMoved();
          offResized();
          return;
        }
        unlisteners.push(offMoved, offResized);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[float] bounds sync init failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      unlisteners.forEach((fn) => {
        try {
          fn();
        } catch {
          /* noop */
        }
      });
    };
  }, []);
}
