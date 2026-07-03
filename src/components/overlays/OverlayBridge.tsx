/**
 * OverlayBridge — the main-window-side integration point for the global
 * overlay system. Mounted once near the root of `App.tsx`.
 *
 * Responsibilities:
 *   • Subscribe to the global-hotkey events emitted by Rust
 *     (`overlay://hotkey-a`, `overlay://hotkey-b`) and translate them into
 *     overlayStore transitions.
 *   • Host the *inline* overlay selector (SelectorSurface) inside the
 *     main window, so users can use the same card-picking UX via the
 *     familiar `Ctrl+\`` without needing the separate webview.
 *   • Hydrate overlay settings from Rust on app start so the hotkey UI
 *     shown in the settings pane matches the actual OS registration.
 *
 * The floating-terminal window is owned by its own webview (FloatApp),
 * so this bridge does not render float UI directly — it only flips the
 * overlayStore flags when recycling to main is requested.
 */
import { useCallback, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { SelectorSurface } from '../../windows/selector/SelectorApp';

interface OverlaySettingsPayload {
  hotkey_a: string;
  hotkey_b: string;
  lightweight_mode?: boolean;
}

export function OverlayBridge(): JSX.Element | null {
  const selectorOpen = useOverlayStore((s) => s.selectorOpen);
  const selectorSurface = useOverlayStore((s) => s.selectorSurface);
  const selectorMode = useOverlayStore((s) => s.selectorMode);
  const selectedIndex = useOverlayStore((s) => s.selectorSelectedIndex);
  const setSelectorMode = useOverlayStore((s) => s.setSelectorMode);
  const setSelectedIndex = useOverlayStore((s) => s.setSelectedIndex);
  const openSelector = useOverlayStore((s) => s.openSelector);
  const closeSelector = useOverlayStore((s) => s.closeSelector);
  const confirmSelector = useOverlayStore((s) => s.confirmSelector);
  const recycleToMain = useOverlayStore((s) => s.recycleToMain);
  const setHotkeys = useOverlayStore((s) => s.setHotkeys);
  const lightweightMode = useOverlayStore((s) => s.lightweightMode);

  // Hydrate hotkey bindings from Rust settings on mount so the UI shows
  // what's actually registered at the OS level (may differ from the
  // default if the user rebinds and the setting was persisted).
  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    (async () => {
      try {
        const settings = await invoke<OverlaySettingsPayload>('overlay_get_settings');
        if (cancelled || !settings) return;
        setHotkeys(settings.hotkey_a, settings.hotkey_b);
        if (typeof settings.lightweight_mode === 'boolean') {
          useOverlayStore.setState({ lightweightMode: settings.lightweight_mode });
        }
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setHotkeys]);

  // Subscribe to Rust hotkey events. A is a toggle; B always recycles.
  useEffect(() => {
    if (!isTauriEnv()) return;
    const offs: UnlistenFn[] = [];

    (async () => {
      offs.push(
        await listen('overlay://hotkey-a', () => {
          // Hotkey A is now handled DIRECTLY by the Rust side: it toggles
          // the dedicated selector webview which is always-on-top and
          // appears above whatever app the user is currently in (e.g.
          // Windsurf). This listener exists purely to keep overlayStore
          // in sync — without it, the `openSelector`/`closeSelector` flags
          // would drift from the actual OS window state.
          const st = useOverlayStore.getState();
          if (st.selectorOpen) {
            // Mirror the Rust hide — don't call invoke again, it already happened.
            useOverlayStore.setState({
              selectorOpen: false,
              floatHiddenByOverlay: false,
            });
          } else {
            // Mirror the Rust show — surface is the dedicated webview window.
            useOverlayStore.setState({
              selectorOpen: true,
              selectorSurface: 'window',
              selectorSelectedIndex: 0,
            });
          }
        }),
      );
      offs.push(
        await listen('overlay://hotkey-b', () => {
          // B also handled in Rust (overlay_show_main); keep UI state in sync.
          useOverlayStore.setState({
            selectorOpen: false,
            floatOpen: false,
            floatHiddenByOverlay: false,
          });
        }),
      );
      offs.push(
        await listen('overlay://float-shown', (e) => {
          const cardId = typeof e.payload === 'string' ? e.payload : null;
          useOverlayStore.setState({
            floatOpen: true,
            floatCardId: cardId ?? useOverlayStore.getState().floatCardId,
            floatHiddenByOverlay: false,
            selectorOpen: false,
          });
        }),
      );
      offs.push(
        await listen('overlay://float-hidden', () => {
          useOverlayStore.setState({ floatOpen: false });
        }),
      );
      offs.push(
        await listen('overlay://main-shown', () => {
          useOverlayStore.setState({
            selectorOpen: false,
            floatOpen: false,
            floatHiddenByOverlay: false,
          });
        }),
      );
    })();

    return () => {
      offs.forEach((off) => off());
    };
  }, []);

  const onSelect = useCallback(
    (i: number) => {
      // total is not known here; setSelectedIndex handles clamping.
      setSelectedIndex(i);
    },
    [setSelectedIndex],
  );

  const onConfirmId = useCallback(
    (cardId: string) => {
      if (lightweightMode) {
        const terminalStore = useTerminalStore.getState();
        recycleToMain();
        terminalStore.setPendingFocusCardId(cardId);
        terminalStore.focusCard(cardId);
        return;
      }
      confirmSelector(cardId);
    },
    [confirmSelector, lightweightMode, recycleToMain],
  );

  const onClose = useCallback(() => {
    closeSelector();
  }, [closeSelector]);

  const onToggleMode = useCallback(() => {
    setSelectorMode(selectorMode === 'tile' ? 'carousel' : 'tile');
  }, [selectorMode, setSelectorMode]);

  // Inline surface: we render the overlay inside the main window so the
  // user can invoke it via Ctrl+` without a separate webview. The window
  // surface (Rust-owned webview) is handled by SelectorApp in a different
  // bundle.
  if (selectorSurface !== 'inline') {
    // Referencing openSelector keeps the closure ergonomics consistent;
    // hiding it behind a noop avoids the unused-var lint.
    void openSelector;
    return null;
  }

  return (
    <SelectorSurface
      visible={selectorOpen}
      mode={selectorMode}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      onConfirm={onConfirmId}
      onClose={onClose}
      onToggleMode={onToggleMode}
    />
  );
}
