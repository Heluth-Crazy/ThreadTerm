/**
 * SelectorApp — the root component for the selector webview window.
 *
 * Responsibilities:
 *   • Subscribe to localStorage ("storage" DOM event) to keep zustand state
 *     in sync when the main window mutates the pinned list or cards.
 *   • Listen to Tauri events pushed by the Rust overlay:
 *       - `overlay://selector-shown`     → reset selection to 0 & enter anim
 *       - `overlay://hotkey-b`           → recycle to main
 *   • Delegate rendering to TileMode or CarouselMode depending on mode.
 *   • On confirm, invoke the Rust overlay to hide the selector and show the
 *     float window with the chosen card id.
 *
 * The selector component is ALSO reusable inline inside the main window —
 * callers can import `SelectorSurface` and pass `surface="inline"` to skip
 * the Tauri-specific plumbing and the clip-reveal shell.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { useOverlayStore, type SelectorMode } from '../../stores/overlayStore';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';
import { TileMode } from './TileMode';
import { CarouselMode } from './CarouselMode';
import { SelectorKeyboardBridge } from './SelectorKeyboardBridge';
import { ExpandFromCornerShell } from './ExpandFromCornerShell';

/**
 * `SelectorSurface` is the inner view layer shared between the webview and
 * the inline (main-window) mount. It renders Tile/Carousel inside the
 * ExpandFromCorner animation shell and owns keyboard handling, but does NOT
 * own Tauri event subscriptions or webview lifecycle — those live in the
 * outer `SelectorApp` (webview) or are wired up by the main-window caller.
 */
export interface SelectorSurfaceProps {
  visible: boolean;
  mode: SelectorMode;
  selectedIndex: number;
  onSelect: (i: number) => void;
  onConfirm: (cardId: string) => void;
  onClose: () => void;
  onToggleMode: () => void;
  /** Clip-reveal origin. Defaults to top-right. */
  origin?: { x: string; y: string };
}

export function SelectorSurface({
  visible,
  mode,
  selectedIndex,
  onSelect,
  onConfirm,
  onClose,
  onToggleMode,
  origin,
}: SelectorSurfaceProps) {
  const { t } = useTranslation('overlay');
  // Compose a stable pinned-cards array from raw state slices so zustand's
  // referential-equality check can short-circuit re-renders when unrelated
  // store fields change.
  const pinnedIds = useTerminalStore((s) => s.pinnedCardIds);
  const cards = useTerminalStore((s) => s.cards);
  const pinnedCards = useMemo(
    () =>
      pinnedIds
        .map((id) => cards.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c),
    [pinnedIds, cards],
  );
  const total = pinnedCards.length;

  const handleConfirmIndex = useCallback(
    (i: number) => {
      const card = pinnedCards[i];
      if (!card) return;
      onConfirm(card.id);
    },
    [pinnedCards, onConfirm],
  );

  return (
    <ExpandFromCornerShell visible={visible} onBackdropClick={onClose} origin={origin}>
      {/* Top-left hint badge */}
      <div className="pointer-events-none absolute left-6 top-6 select-none text-white/70">
        <div className="text-[11px] uppercase tracking-widest opacity-60">
          {t('selector.title')}
        </div>
        <div className="mt-0.5 font-mono text-xs">
          {mode === 'tile' ? t('selector.tileMode') : t('selector.carouselMode')}
        </div>
      </div>

      {/* Mode content */}
      {mode === 'tile' ? (
        <TileMode
          cards={pinnedCards}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onConfirm={handleConfirmIndex}
        />
      ) : (
        <CarouselMode
          cards={pinnedCards}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onConfirm={handleConfirmIndex}
        />
      )}

      {/* Bottom help line */}
      <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 select-none rounded-full bg-black/50 px-4 py-1.5 text-[11px] text-white/85 backdrop-blur">
        {t('selector.help')}
      </div>

      {visible && (
        <SelectorKeyboardBridge
          total={total}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onConfirm={handleConfirmIndex}
          onClose={onClose}
          onToggleMode={onToggleMode}
        />
      )}
    </ExpandFromCornerShell>
  );
}

// ── Webview-facing root ──────────────────────────────────────────────────────

export function SelectorApp() {
  const mode = useOverlayStore((s) => s.selectorMode);
  const selectedIndex = useOverlayStore((s) => s.selectorSelectedIndex);
  const setSelectorMode = useOverlayStore((s) => s.setSelectorMode);
  const setSelectedIndex = useOverlayStore((s) => s.setSelectedIndex);
  const pinnedIds = useTerminalStore((s) => s.pinnedCardIds);
  const cards = useTerminalStore((s) => s.cards);
  const pinnedCards = useMemo(
    () =>
      pinnedIds
        .map((id) => cards.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c),
    [pinnedIds, cards],
  );

  // Selector webview is implicitly "visible" whenever its window is shown.
  // We drive the animation off a local flag so the reveal plays on each
  // show; the Tauri event `selector-shown` pulses it back to true.
  const [visible, setVisible] = useState(true);

  // Keep the pinned card count so keyboard wrap is correct.
  const total = pinnedCards.length;

  useEffect(() => {
    // Clamp selection to available cards in case the pinned list shrank
    // while the selector was hidden.
    if (total === 0 && selectedIndex !== 0) setSelectedIndex(0);
    else if (total > 0 && selectedIndex >= total) setSelectedIndex(total - 1, total);
  }, [total, selectedIndex, setSelectedIndex]);

  // Cross-webview sync: when the main window mutates localStorage, zustand's
  // persist layer in this webview won't automatically pick it up. The
  // `storage` event fires on *other* windows/webviews when localStorage
  // changes, so we rehydrate both stores when we see relevant keys.
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

  // Tauri events from Rust.
  useEffect(() => {
    if (!isTauriEnv()) return;
    const unlisten: UnlistenFn[] = [];

    (async () => {
      unlisten.push(
        await listen('overlay://selector-shown', () => {
          setVisible(true);
          setSelectedIndex(0, total);
          // Pull fresh data from localStorage in case it just changed.
          useTerminalStore.persist.rehydrate();
          useOverlayStore.persist.rehydrate();
        }),
      );
      unlisten.push(
        await listen('overlay://selector-hidden', () => {
          setVisible(false);
        }),
      );
      unlisten.push(
        await listen('overlay://hotkey-b', () => {
          doRecycle();
        }),
      );
    })();

    return () => {
      unlisten.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── action handlers ───────────────────────────────────────────────────────

  const onSelect = useCallback(
    (i: number) => {
      setSelectedIndex(i, total);
    },
    [setSelectedIndex, total],
  );

  const onConfirm = useCallback(async (cardId: string) => {
    setVisible(false);
    // Persist the card id BEFORE asking Rust to show the float window. With
    // lazy float creation (Windows skips prewarm) the window may be built
    // right now, and its page loads too late to catch the
    // `overlay://float-shown` event — it falls back to the persisted
    // overlayStore.floatCardId instead, which must already hold this value.
    useOverlayStore.setState({
      selectorOpen: false,
      floatOpen: true,
      floatCardId: cardId,
      floatHiddenByOverlay: false,
    });
    // Direct invoke: selector and float are both Rust-owned windows.
    try {
      await invoke('overlay_hide_selector');
      await invoke('overlay_show_float', { cardId });
    } catch (e) {
      console.warn('[selector] confirm failed', e);
    }
  }, []);

  const doClose = useCallback(async () => {
    setVisible(false);
    try {
      await invoke('overlay_hide_selector');
    } catch {
      /* noop */
    }
    // If float was hidden by selector taking over, restore it.
    const st = useOverlayStore.getState();
    if (st.floatHiddenByOverlay && st.floatCardId) {
      try {
        await invoke('overlay_show_float', { cardId: st.floatCardId });
      } catch {
        /* noop */
      }
    }
    useOverlayStore.setState({ selectorOpen: false, floatHiddenByOverlay: false });
  }, []);

  const doRecycle = useCallback(async () => {
    setVisible(false);
    try {
      await invoke('overlay_show_main');
    } catch {
      /* noop */
    }
    useOverlayStore.setState({
      selectorOpen: false,
      floatOpen: false,
      floatHiddenByOverlay: false,
    });
  }, []);

  const onToggleMode = useCallback(() => {
    setSelectorMode(mode === 'tile' ? 'carousel' : 'tile');
  }, [mode, setSelectorMode]);

  // Origin set near the top-right (where a menubar tray icon would live on
  // macOS); could later be driven by a mouse-position probe in Rust.
  const origin = useMemo(() => ({ x: '92%', y: '6%' }), []);

  return (
    <div className="h-screen w-screen overflow-hidden">
      <SelectorSurface
        visible={visible}
        mode={mode}
        selectedIndex={Math.min(selectedIndex, Math.max(0, total - 1))}
        onSelect={onSelect}
        onConfirm={onConfirm}
        onClose={doClose}
        onToggleMode={onToggleMode}
        origin={origin}
      />
    </div>
  );
}
