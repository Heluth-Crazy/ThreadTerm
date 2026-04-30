use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use super::commands::{overlay_hide_selector, overlay_show_main, overlay_show_selector};
use super::state::OVERLAY_SETTINGS;
use super::window::SELECTOR_LABEL;

/// Public re-export so `lib.rs` can filter press vs release without
/// importing the plugin crate directly in more places than necessary.
pub use tauri_plugin_global_shortcut::ShortcutState as PluginShortcutState;

/// Label of the currently active hotkey binding, so we can unregister
/// before swapping in a new accelerator.
static REGISTERED_A: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static REGISTERED_B: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// Shortcut id → slot label ("A"/"B") map used by the central handler.
/// Keyed on `Shortcut::id()` rather than the accelerator string because
/// the latter doesn't round-trip (see `register_hotkey` for details).
pub(super) static HOTKEY_MAP: Lazy<Mutex<HashMap<u32, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Register the two global shortcuts. Safe to call from `setup`; logs but
/// does not panic on failure (a user may have a conflicting binding).
pub fn register_default_shortcuts(app: &AppHandle) {
    let settings = OVERLAY_SETTINGS.lock().unwrap().clone();
    let _ = register_hotkey(app, "A", &settings.hotkey_a);
    let _ = register_hotkey(app, "B", &settings.hotkey_b);
}

pub(super) fn register_hotkey(app: &AppHandle, label: &str, accel: &str) -> Result<(), String> {
    let shortcut: Shortcut = accel
        .parse()
        .map_err(|e| format!("invalid accelerator {accel}: {e:?}"))?;

    // Unregister the previous binding for this slot (A/B), if any.
    let slot = match label {
        "A" => &REGISTERED_A,
        "B" => &REGISTERED_B,
        _ => return Err(format!("unknown slot {label}")),
    };
    let prev = slot.lock().unwrap().clone();
    if let Some(prev_accel) = prev {
        if let Ok(prev_shortcut) = prev_accel.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(prev_shortcut);
        }
    }

    // Grab the stable numeric id of the shortcut *before* registering.
    // We key `HOTKEY_MAP` on this id because the user-facing accelerator
    // string (e.g. "CmdOrCtrl+Shift+Space") does NOT round-trip through
    // `Shortcut::into_string()` — the latter returns a lowercase canonical
    // form such as "shift+super+Space" on macOS, so a string-based lookup
    // in `dispatch_hotkey` would always miss and the event would silently
    // vanish. `Shortcut::id() -> u32` is guaranteed stable for the lifetime
    // of the shortcut, which is all we need.
    let shortcut_id = shortcut.id();

    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("register failed: {e:?}"))?;

    *slot.lock().unwrap() = Some(accel.to_string());

    HOTKEY_MAP.lock().unwrap().insert(shortcut_id, label.to_string());
    Ok(())
}

/// Called by the shortcut plugin handler in lib.rs. Turns a plugin
/// Shortcut into a direct window show/hide plus a state-sync event.
///
/// CRITICAL design note for global hotkeys:
///
/// The hotkey must work when ThreadTerm is NOT the frontmost app — the user
/// may be typing in Windsurf / Safari / whatever and wants the overlay
/// to appear ON TOP of their current app immediately, without having to
/// Cmd+Tab back to ThreadTerm first.
///
/// To achieve that we MUST manipulate the OS-level window directly from
/// Rust (`set_always_on_top`, `show`, `set_focus`). Simply emitting a
/// Tauri event to the main webview is not enough because:
///   1. The main webview's JS runs, but it only toggles an INLINE overlay
///      inside the main window — which is hidden behind the other app.
///   2. We need `NSApp.activate(ignoringOtherApps:YES)` (Tauri's
///      `set_focus` on macOS triggers this) to bring our overlay window
///      to the keyboard-focus frontmost spot.
///
/// The `overlay://hotkey-a` / `-b` events are still emitted, but purely
/// as *state-sync* notifications so the overlayStore in both webviews
/// stays consistent with what the OS window is actually doing.
///
/// IMPORTANT: the plugin fires the handler twice per physical key press
/// (Pressed + Released). The `lib.rs` handler filters to Pressed only.
pub fn dispatch_hotkey(app: &AppHandle, shortcut: &Shortcut) {
    let id = shortcut.id();
    let map = HOTKEY_MAP.lock().unwrap();
    let slot = map.get(&id).cloned();
    drop(map);
    match slot.as_deref() {
        Some("A") => {
            tracing::info!(id = id, "overlay hotkey A fired — toggling selector window");
            toggle_selector_window(app);
            let _ = app.emit("overlay://hotkey-a", ());
        }
        Some("B") => {
            tracing::info!(id = id, "overlay hotkey B fired — recycling to main");
            // B always recycles the current float back into the main window.
            if let Err(e) = overlay_show_main(app.clone()) {
                tracing::warn!(error = %e, "overlay_show_main failed on hotkey B");
            }
            let _ = app.emit("overlay://hotkey-b", ());
        }
        _ => {
            tracing::warn!(id = id, "overlay hotkey fired with no matching slot");
        }
    }
}

/// Toggle the selector webview window: if it's currently visible, hide
/// it; otherwise, foreground it above all other apps.
///
/// This is the synchronous Rust path used by the global hotkey, so the
/// overlay pops up regardless of which app currently has keyboard focus.
fn toggle_selector_window(app: &AppHandle) {
    let visible = app
        .get_webview_window(SELECTOR_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);

    if visible {
        if let Err(e) = overlay_hide_selector(app.clone()) {
            tracing::warn!(error = %e, "overlay_hide_selector failed on hotkey toggle");
        }
    } else if let Err(e) = overlay_show_selector(app.clone()) {
        tracing::warn!(error = %e, "overlay_show_selector failed on hotkey toggle");
    }
}
