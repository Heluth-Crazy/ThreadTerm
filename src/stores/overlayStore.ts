/**
 * overlayStore — single source of truth for the global overlay UI.
 *
 * Owns UI-layer state for:
 *   • selector  window (and inline mode inside main)
 *   • float     window (single shared always-on-top terminal)
 *   • hotkey bindings cached from the Rust side
 *
 * The Rust overlay.rs owns the actual OS windows and shortcut registration;
 * this store mirrors observable state via events emitted by Rust and calls
 * back into Rust via `invoke`. Transitions are expressed as explicit
 * actions (`triggerHotkeyA`, `confirmSelector`, ...) so they can be unit-
 * tested without the Tauri bridge.
 *
 * Mutual exclusion rules (single-window-reuse policy for float):
 *   • opening the selector hides the float (if visible) — float is
 *     "tucked away" but its `floatCardId` is retained so it can be
 *     restored by pressing A again without any confirmation.
 *   • closing the selector (Esc) restores the previously-visible float.
 *   • B always recycles: hide selector, hide float, bring main to front,
 *     focus the last float card in main.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke, isTauriEnv } from '../lib/tauri-bridge';
import { emitSettingsChanged, type OverlayPreferenceSnapshot } from '../lib/settingsSync';

export type SelectorMode = 'tile' | 'carousel';
export type SelectorSurface = 'inline' | 'window';

interface FloatBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FloatLaunchMode = 'floating' | 'maximized' | 'fullscreen';

interface OverlayStoreInternal {
  // Selector
  selectorOpen: boolean;
  selectorMode: SelectorMode;
  selectorSurface: SelectorSurface;
  selectorSelectedIndex: number;

  // Float
  floatOpen: boolean;
  /** Whether the float window was hidden because selector took over. Used to
   *  decide whether Esc should restore it. */
  floatHiddenByOverlay: boolean;
  floatCardId: string | null;
  floatWindowBounds: FloatBounds | null;
  /** How the float window opens (floating / maximized / fullscreen). Mirror of
   *  the Rust-persisted `overlay.float_launch_mode`. */
  floatLaunchMode: FloatLaunchMode;

  // Hotkeys
  hotkeyA: string;
  hotkeyB: string;

  // Actions
  openSelector: (surface?: SelectorSurface) => void;
  closeSelector: () => void;
  toggleSelector: () => void;
  setSelectorMode: (mode: SelectorMode) => void;
  setSelectedIndex: (i: number, total?: number) => void;

  confirmSelector: (cardId: string) => void;

  openFloat: (cardId: string) => void;
  closeFloat: () => void;

  /** User pressed hotkey B — recycle float into main. */
  recycleToMain: () => void;

  setFloatBounds: (bounds: FloatBounds | null) => void;
  setFloatLaunchMode: (mode: FloatLaunchMode) => void;

  setHotkeys: (a: string, b: string) => void;
  updateHotkey: (slot: 'A' | 'B', accelerator: string) => Promise<void>;
}

// Default accelerators mirror the Rust defaults. Persisted values override.
const DEFAULT_HOTKEY_A = 'CmdOrCtrl+Shift+Space';
const DEFAULT_HOTKEY_B = 'CmdOrCtrl+Shift+O';

function overlayPreferenceSnapshotFromState(
  state: Pick<OverlayStoreInternal, 'selectorMode' | 'hotkeyA' | 'hotkeyB'>,
): OverlayPreferenceSnapshot {
  return {
    selectorMode: state.selectorMode,
    hotkeyA: state.hotkeyA,
    hotkeyB: state.hotkeyB,
  };
}

function notifyOverlayPreferencesChanged(snapshot: OverlayPreferenceSnapshot) {
  void emitSettingsChanged({
    domain: 'overlay-preferences',
    sourceWindow: 'settings',
    overlayPreferences: snapshot,
  });
}

async function tauriInvoke<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriEnv()) return null;
  try {
    return await invoke<T>(cmd, args ?? {});
  } catch (e) {
    // Non-fatal in UI layer.
    // eslint-disable-next-line no-console
    console.warn(`[overlay] invoke ${cmd} failed:`, e);
    return null;
  }
}

export const useOverlayStore = create<OverlayStoreInternal>()(
  persist(
    (set, get) => ({
      selectorOpen: false,
      selectorMode: 'tile',
      selectorSurface: 'inline',
      selectorSelectedIndex: 0,

      floatOpen: false,
      floatHiddenByOverlay: false,
      floatCardId: null,
      floatWindowBounds: null,
      floatLaunchMode: 'floating',

      hotkeyA: DEFAULT_HOTKEY_A,
      hotkeyB: DEFAULT_HOTKEY_B,

      openSelector: (surface = 'inline') =>
        set((s) => {
          // Hide float temporarily when selector takes over.
          const wasFloatOpen = s.floatOpen;
          if (surface === 'window') {
            void tauriInvoke('overlay_show_selector');
          }
          if (wasFloatOpen) {
            void tauriInvoke('overlay_hide_float');
          }
          return {
            selectorOpen: true,
            selectorSurface: surface,
            selectorSelectedIndex: 0,
            floatOpen: false,
            floatHiddenByOverlay: wasFloatOpen,
          };
        }),

      closeSelector: () =>
        set((s) => {
          if (!s.selectorOpen) return s;
          if (s.selectorSurface === 'window') {
            void tauriInvoke('overlay_hide_selector');
          }
          // Restore float if we hid it.
          let floatOpen = s.floatOpen;
          if (s.floatHiddenByOverlay && s.floatCardId) {
            floatOpen = true;
            void tauriInvoke('overlay_show_float', { cardId: s.floatCardId });
          }
          return {
            selectorOpen: false,
            floatOpen,
            floatHiddenByOverlay: false,
          };
        }),

      toggleSelector: () => {
        const s = get();
        if (s.selectorOpen) s.closeSelector();
        else s.openSelector(s.selectorSurface);
      },

      setSelectorMode: (mode) => {
        const snapshot = overlayPreferenceSnapshotFromState({
          ...get(),
          selectorMode: mode,
        });
        set({ selectorMode: mode });
        notifyOverlayPreferencesChanged(snapshot);
      },

      setSelectedIndex: (i, total) =>
        set((s) => {
          if (!total || total <= 0) return { selectorSelectedIndex: 0 };
          const n = ((i % total) + total) % total;
          if (n === s.selectorSelectedIndex) return s;
          return { selectorSelectedIndex: n };
        }),

      confirmSelector: (cardId) => {
        const { selectorSurface } = get();
        // Hide selector window (if that's the surface) and open float.
        if (selectorSurface === 'window') {
          void tauriInvoke('overlay_hide_selector');
        }
        void tauriInvoke('overlay_show_float', { cardId });
        set({
          selectorOpen: false,
          floatOpen: true,
          floatCardId: cardId,
          floatHiddenByOverlay: false,
        });
      },

      openFloat: (cardId) => {
        void tauriInvoke('overlay_show_float', { cardId });
        set({
          floatOpen: true,
          floatCardId: cardId,
          selectorOpen: false,
          floatHiddenByOverlay: false,
        });
      },

      closeFloat: () => {
        void tauriInvoke('overlay_hide_float');
        set({ floatOpen: false, floatHiddenByOverlay: false });
      },

      setFloatLaunchMode: (mode) => {
        set({ floatLaunchMode: mode });
        // Rust persists it (overlay.float_launch_mode) and reflows a visible
        // float window; the store is just a mirror for the settings UI.
        void tauriInvoke('overlay_set_float_launch_mode', { mode });
      },

      recycleToMain: () => {
        void tauriInvoke('overlay_show_main');
        set({
          selectorOpen: false,
          floatOpen: false,
          floatHiddenByOverlay: false,
        });
      },

      setFloatBounds: (bounds) => {
        set({ floatWindowBounds: bounds });
        if (bounds) {
          void tauriInvoke('overlay_save_float_bounds', { bounds });
        }
      },

      setHotkeys: (a, b) => set({ hotkeyA: a, hotkeyB: b }),

      updateHotkey: async (slot, accelerator) => {
        await tauriInvoke('overlay_update_shortcut', { label: slot, accelerator });
        const next = slot === 'A'
          ? { ...get(), hotkeyA: accelerator }
          : { ...get(), hotkeyB: accelerator };
        set(slot === 'A' ? { hotkeyA: accelerator } : { hotkeyB: accelerator });
        notifyOverlayPreferencesChanged(overlayPreferenceSnapshotFromState(next));
      },
    }),
    {
      name: 'threadterm-overlay',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        selectorMode: state.selectorMode,
        floatCardId: state.floatCardId,
        floatWindowBounds: state.floatWindowBounds,
        hotkeyA: state.hotkeyA,
        hotkeyB: state.hotkeyB,
      }),
    },
  ),
);
