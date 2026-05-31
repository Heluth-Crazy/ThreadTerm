/**
 * overlayPreferenceSync — keep the selector/float overlay webviews in sync with
 * overlay-preference changes made in the (separate, native) settings window.
 *
 * Background: settings is its own Tauri `WebviewWindow`, and per-window
 * localStorage is not guaranteed to be shared across Tauri webviews, so the
 * `storage` DOM event path the overlay windows relied on does not fire
 * reliably. We instead reuse the existing `settings://changed` broadcast
 * (`emitSettingsChanged`, which `emit`s to every window) and apply the
 * overlay-preference snapshot directly into `overlayStore`.
 *
 * Anti-loop: we write via `useOverlayStore.setState(...)` rather than the
 * `setSelectorMode` / `updateHotkey` actions. Those actions re-emit a
 * `settings://changed` event; `setState` does not. This mirrors the existing
 * `SettingsSyncBridge` technique (it also applies overlay preferences via
 * `setState`) so a change broadcast from settings is applied exactly once per
 * receiving window and never echoed back.
 */
import { listenSettingsChanged, type SettingsChangedPayload } from './settingsSync';
import { useOverlayStore } from '../stores/overlayStore';

/**
 * Pure reducer: given an incoming settings-change payload, return the
 * overlay-store fields to apply, or `null` when the payload does not carry an
 * overlay-preference update. Exported for unit testing without the Tauri
 * bridge.
 */
export function overlayPreferencePatchFromPayload(
  payload: SettingsChangedPayload,
): Pick<ReturnType<typeof useOverlayStore.getState>, 'selectorMode' | 'hotkeyA' | 'hotkeyB'> | null {
  const isOverlayDomain =
    payload.domain === 'overlay-preferences' || payload.domain === 'all';
  if (!isOverlayDomain || !payload.overlayPreferences) return null;

  return {
    selectorMode: payload.overlayPreferences.selectorMode,
    hotkeyA: payload.overlayPreferences.hotkeyA,
    hotkeyB: payload.overlayPreferences.hotkeyB,
  };
}

/**
 * Subscribe an overlay webview (selector/float) to overlay-preference changes
 * broadcast from the settings window. Applies the snapshot directly via
 * `setState` to avoid re-emitting. Returns an unlisten function.
 */
export function installOverlayPreferenceSync(): () => void {
  return listenSettingsChanged((payload) => {
    const patch = overlayPreferencePatchFromPayload(payload);
    if (patch) {
      useOverlayStore.setState(patch);
    }
  });
}
