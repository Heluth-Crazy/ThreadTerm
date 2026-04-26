/**
 * FloatApp — root component for the float webview window.
 *
 * Responsibilities:
 *   • Track the current card id (driven by overlayStore.floatCardId and by
 *     Tauri `overlay://float-shown` events pushed from Rust when the user
 *     activates the window with a new selection).
 *   • Render FloatHeader (draggable) + FloatSession (xterm host).
 *   • Persist window bounds via useFloatBoundsSync.
 *   • Toggle always-on-top via the local webview window handle.
 *   • Respond to `overlay://hotkey-b` events by recycling the session back
 *     into the main window.
 *
 * This window does NOT create or own the native window — Rust does
 * (`overlay::ensure_float`). We just drive UI state and react to events.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTerminalStore } from '../../stores/terminalStore';
import { useOverlayStore } from '../../stores/overlayStore';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';
import { FloatHeader } from './FloatHeader';
import { FloatSession } from './FloatSession';
import { useFloatBoundsSync } from './useFloatBoundsSync';

export function FloatApp() {
  useFloatBoundsSync();

  const floatCardId = useOverlayStore((s) => s.floatCardId);
  const cards = useTerminalStore((s) => s.cards);

  const [localCardId, setLocalCardId] = useState<string | null>(floatCardId);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);

  const card = useMemo(
    () => (localCardId ? cards.find((c) => c.id === localCardId) ?? null : null),
    [cards, localCardId],
  );

  const notifyTerminalSurfaceShown = useCallback(() => {
    const fire = () => {
      window.dispatchEvent(new CustomEvent('threadterm-terminal-surface-shown'));
    };
    requestAnimationFrame(fire);
    window.setTimeout(fire, 80);
    window.setTimeout(fire, 220);
  }, []);

  // Rehydrate stores when the main window mutates localStorage (different
  // webviews otherwise keep stale snapshots).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'threadterm-terminal-store') {
        useTerminalStore.persist.rehydrate();
      } else if (e.key === 'threadterm-overlay') {
        useOverlayStore.persist.rehydrate();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Tauri event wiring.
  useEffect(() => {
    if (!isTauriEnv()) {
      return;
    }
    const offs: UnlistenFn[] = [];

    (async () => {
      offs.push(
        await listen<string>('overlay://float-shown', (e) => {
          // Rust emits the card id as the payload.
          const incoming = typeof e.payload === 'string' ? e.payload : null;
          if (incoming) setLocalCardId(incoming);
          // Pull fresh state in case the main window's store is newer.
          useTerminalStore.persist.rehydrate();
          useOverlayStore.persist.rehydrate();
          notifyTerminalSurfaceShown();
        }),
      );
      offs.push(
        await listen('overlay://float-hidden', () => {
          // Nothing to do visually — window just becomes invisible.
        }),
      );
      offs.push(
        await listen('overlay://hotkey-b', () => {
          void doRecycle();
        }),
      );
    })();

    return () => {
      offs.forEach((off) => off());
    };
  }, [notifyTerminalSurfaceShown]);

  // Keep localCardId in sync with overlayStore.floatCardId if the user
  // confirms a new selection from the main window.
  useEffect(() => {
    if (floatCardId && floatCardId !== localCardId) {
      setLocalCardId(floatCardId);
    }
  }, [floatCardId, localCardId]);

  useEffect(() => {
    if (localCardId) {
      notifyTerminalSurfaceShown();
    }
  }, [localCardId, notifyTerminalSurfaceShown]);

  // Apply always-on-top on mount and when toggled.
  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (cancelled) return;
        await getCurrentWindow().setAlwaysOnTop(alwaysOnTop);
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [alwaysOnTop]);

  // Escape is intentionally not handled here. Focused terminal CLIs use Esc
  // to cancel prompts and inline edits; hiding/recycling the float remains
  // available through the header buttons and the global hotkey.

  // ── actions ───────────────────────────────────────────────────────────────

  const doToggleAlwaysOnTop = useCallback(() => {
    setAlwaysOnTop((v) => !v);
  }, []);

  const doHide = useCallback(async () => {
    try {
      await invoke('overlay_hide_float');
    } catch {
      /* noop */
    }
    useOverlayStore.setState({ floatOpen: false, floatHiddenByOverlay: false });
  }, []);

  const doRecycle = useCallback(async () => {
    try {
      await invoke('overlay_show_main');
    } catch {
      /* noop */
    }
    // Persist pendingFocusCardId so the main window focuses this session
    // once it regains attention.
    if (localCardId) {
      useTerminalStore.setState({ pendingFocusCardId: localCardId });
    }
    useOverlayStore.setState({
      selectorOpen: false,
      floatOpen: false,
      floatHiddenByOverlay: false,
    });
  }, [localCardId]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <FloatHeader
        card={card}
        alwaysOnTop={alwaysOnTop}
        onToggleAlwaysOnTop={doToggleAlwaysOnTop}
        onRecycleToMain={doRecycle}
        onHide={doHide}
      />
      <FloatSession card={card} />
    </div>
  );
}
