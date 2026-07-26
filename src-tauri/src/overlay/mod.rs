/*!
 * Global overlay window management.
 *
 * Owns the two ad-hoc webview windows that live outside the main app shell:
 *   • `selector` — full-screen transparent card picker, triggered by Hotkey A.
 *   • `float`    — always-on-top floating terminal window that hosts one
 *                  session at a time, triggered by Enter confirmation on the
 *                  selector.
 *
 * Both windows are created lazily on first use and then reused (show/hide)
 * to minimise resource churn. All state transitions the frontend can observe
 * are broadcast via Tauri events so both the main window and the overlay
 * windows stay in sync with the single source of truth (`overlayStore`).
 *
 * Shortcut handling is integrated in `lib.rs` via `tauri-plugin-global-shortcut`;
 * the plugin calls back into `dispatch_hotkey` which translates `A` / `B`
 * into `hotkey-a` / `hotkey-b` events. The frontend decides what happens
 * next depending on the current overlay state.
 *
 * Module layout:
 *   • `state`    — persisted overlay settings (hotkeys, float bounds).
 *   • `platform` — macOS NSPanel / activation-policy plumbing + non-macOS no-ops.
 *   • `window`   — webview window construction (selector + float) and prewarm.
 *   • `hotkey`   — global shortcut registration and dispatch.
 *   • `commands` — Tauri `#[command]` entry points exposed to the frontend.
 */

// `tauri_nspanel::tauri_panel!` expands to code that calls `WebviewWindow::app_handle()`,
// which is provided by the `tauri::Manager` trait. Bring it into scope here so the
// macro expansion compiles cleanly inside this module.
#[cfg(target_os = "macos")]
use tauri::Manager as _;

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(OverlaySelectorPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })

    panel!(OverlayFloatPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

mod commands;
mod hotkey;
mod platform;
mod state;
mod window;

// ── Public surface for `lib.rs` ─────────────────────────────────────────────

pub use hotkey::{dispatch_hotkey, register_default_shortcuts, PluginShortcutState};
pub use state::load_settings;
pub use window::prewarm_windows;

pub use commands::{
    overlay_get_settings, overlay_hide_float, overlay_hide_selector, overlay_save_float_bounds,
    overlay_set_float_launch_mode, overlay_set_lightweight_mode, overlay_show_float,
    overlay_show_main, overlay_show_selector, overlay_update_shortcut,
};

// `tauri::generate_handler!` resolves both the function AND a sibling
// `__cmd__<name>` macro at the path passed to it. Re-export the macros so
// the call site in `lib.rs` can keep using `overlay::overlay_show_selector`
// shorthand instead of the longer `overlay::commands::…` path.
pub use commands::{
    __cmd__overlay_get_settings, __cmd__overlay_hide_float, __cmd__overlay_hide_selector,
    __cmd__overlay_save_float_bounds, __cmd__overlay_set_float_launch_mode,
    __cmd__overlay_set_lightweight_mode, __cmd__overlay_show_float, __cmd__overlay_show_main,
    __cmd__overlay_show_selector, __cmd__overlay_update_shortcut,
};
