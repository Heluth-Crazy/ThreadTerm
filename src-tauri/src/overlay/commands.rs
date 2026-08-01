#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager};

use super::hotkey::{register_default_shortcuts, register_hotkey, unregister_all_hotkeys};
#[cfg(target_os = "macos")]
use super::platform::activate_float_window_for_keyboard;
use super::platform::{
    configure_float_window_for_current_space, configure_selector_window_for_current_space,
    order_overlay_window_front, restore_regular_activation_policy,
    restore_regular_activation_policy_if_no_overlay_visible, set_overlay_activation_policy,
};
use super::state::{FloatBounds, FloatLaunchMode, OverlaySettings, OVERLAY_SETTINGS};
use super::window::{
    ensure_float, ensure_selector, primary_monitor_bounds, FLOAT_LABEL, MAIN_LABEL, SELECTOR_LABEL,
};

#[cfg(target_os = "windows")]
const FLOAT_IDLE_DESTROY_AFTER: Duration = Duration::from_secs(60);

/// Selector follows the same idle-destroy budget as float so closed overlays
/// do not retain a permanent WebView after the user stops using them.
#[cfg(target_os = "windows")]
const SELECTOR_IDLE_DESTROY_AFTER: Duration = Duration::from_secs(60);

#[cfg(target_os = "windows")]
static FLOAT_HIDE_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
static SELECTOR_HIDE_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
static FLOAT_VISIBILITY_TRANSITION: Mutex<()> = Mutex::new(());

/// Async because `ensure_selector` may create a webview window: on Windows,
/// creating a WebView2 window from a *synchronous* IPC command deadlocks the
/// event loop (wry#583 / tauri#4121) — the controller creation needs the
/// message loop to keep pumping. Async moves the command off that loop.
/// The sync body lives in `show_selector_impl` so the global-hotkey path
/// (which runs on the event loop, where creation is safe) can share it.
#[tauri::command]
pub async fn overlay_show_selector(app: AppHandle) -> Result<(), String> {
    show_selector_impl(&app)
}

fn lightweight_mode_enabled() -> bool {
    OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .lightweight_mode
}

pub(super) fn show_selector_impl(app: &AppHandle) -> Result<(), String> {
    if lightweight_mode_enabled() {
        tracing::info!("overlay selector suppressed by lightweight mode");
        return Ok(());
    }

    invalidate_selector_idle_destroy();
    ensure_selector(app)?;
    set_overlay_activation_policy(app);
    // Hide float while selector is open (mutual exclusion). Restored on close.
    let float_was_hidden = {
        let _transition = lock_float_visibility_transition();
        hide_float_window_for_idle(app)
    };
    if float_was_hidden {
        // Selector activation is also a native float-hide path. Keep both
        // webviews' surface state in sync and ensure an abandoned selection
        // cannot leave the hidden float WebView2 alive indefinitely.
        let _ = app.emit("overlay://float-hidden", ());
    }
    if let Some(w) = app.get_webview_window(SELECTOR_LABEL) {
        // Re-align to the current primary monitor's physical bounds.
        // This handles three real-world cases that would otherwise leave
        // the window mis-sized or off-screen:
        //   • the prewarmed window was built before any monitor was
        //     reported by the window server (logical_w fallback used)
        //   • the user unplugged or switched displays since prewarm
        //   • the resolution changed (e.g. external 4K → laptop retina)
        let (mx, my, mw, mh) = primary_monitor_bounds(app);
        let _ = w.set_position(tauri::PhysicalPosition::new(mx, my));
        let _ = w.set_size(tauri::PhysicalSize::new(mw, mh));

        // Re-assert CanJoinAllSpaces on every show. On some macOS
        // versions the collection behavior resets to default after
        // `orderOut:` so we have to re-apply it before the next
        // `makeKeyAndOrderFront:`, otherwise the window opens on the
        // Space where ThreadTerm's main window lives instead of the
        // user's current Space.
        let _ = w.set_visible_on_all_workspaces(true);
        configure_selector_window_for_current_space(&w);

        // Order matters to actually foreground the window when the global
        // hotkey is pressed while another app is active:
        //   1. mark always-on-top FIRST so the OS places it above peers
        //      the moment it becomes visible
        //   2. unminimize in case the user previously Cmd+M'd it
        //   3. show() to make the webview visible
        //   4. orderFrontRegardless() foregrounds the overlay without
        //      activating the main app or switching back to the desktop Space
        let _ = w.set_always_on_top(true);
        let _ = w.unminimize();
        set_overlay_memory_usage_normal(&w);

        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;

            if let Ok(panel) = app.get_webview_panel(SELECTOR_LABEL) {
                tracing::info!("overlay selector panel show_and_make_key");
                panel.show_and_make_key();
                panel.order_front_regardless();
            } else {
                tracing::warn!(
                    "overlay selector panel missing; falling back to WebviewWindow show"
                );
                let _ = w.show();
                order_overlay_window_front(&w);
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = w.show();
            order_overlay_window_front(&w);
        }

        tracing::info!(
            monitor = format!("{}x{}@{},{}", mw, mh, mx, my),
            "overlay selector shown"
        );
    } else {
        tracing::warn!("overlay_show_selector: selector window not found after ensure");
    }
    let _ = app.emit("overlay://selector-shown", ());
    Ok(())
}

#[tauri::command]
pub fn overlay_hide_selector(app: AppHandle) -> Result<(), String> {
    hide_selector_window_for_idle(&app);
    restore_regular_activation_policy_if_no_overlay_visible(&app);
    let _ = app.emit("overlay://selector-hidden", ());
    Ok(())
}

/// Hide selector, lower WebView2 memory target on Windows, and schedule idle
/// destroy. Shared by hide IPC and other paths that dismiss the selector.
fn hide_selector_window_for_idle(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(SELECTOR_LABEL) {
            panel.hide();
        }
    }

    if let Some(w) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = w.hide();
        set_overlay_memory_usage_low(&w);
        schedule_selector_idle_destroy(app);
    }
}

/// Async for the same Windows sync-command deadlock reason as
/// `overlay_show_selector` — `ensure_float` may create the float window.
#[tauri::command]
pub async fn overlay_show_float(app: AppHandle, card_id: String) -> Result<(), String> {
    show_float_impl(&app, card_id)
}

pub(super) fn show_float_impl(app: &AppHandle, card_id: String) -> Result<(), String> {
    if lightweight_mode_enabled() {
        tracing::info!(card_id = %card_id, "overlay float suppressed by lightweight mode");
        return Ok(());
    }

    let _transition = lock_float_visibility_transition();
    invalidate_float_idle_destroy();
    crate::pty::resume_float_output_consumers();

    ensure_float(app)?;
    set_overlay_activation_policy(app);
    // Hide selector if visible.
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(SELECTOR_LABEL) {
            panel.hide();
        }
    }
    if let Some(s) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = s.hide();
    }
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        set_float_memory_usage_normal(&w);
        // Same foregrounding ordering as selector — see overlay_show_selector.
        // Re-assert CanJoinAllSpaces so the float follows the user to
        // whichever Space they switched to while it was hidden.
        let _ = w.set_visible_on_all_workspaces(true);
        configure_float_window_for_current_space(&w);
        let _ = w.set_always_on_top(true);
        let _ = w.unminimize();

        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;

            if let Ok(panel) = app.get_webview_panel(FLOAT_LABEL) {
                tracing::info!(card_id = %card_id, "overlay float panel show_and_make_key");
                panel.show_and_make_key();
                panel.order_front_regardless();
                activate_float_window_for_keyboard(&w);
            } else {
                tracing::warn!("overlay float panel missing; falling back to WebviewWindow show");
                let _ = w.show();
                order_overlay_window_front(&w);
                activate_float_window_for_keyboard(&w);
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            apply_float_launch_mode(&w);
            let _ = w.show();
            order_overlay_window_front(&w);
        }
        tracing::info!(card_id = %card_id, "overlay float shown");
    } else {
        tracing::warn!("overlay_show_float: float window not found after ensure");
    }
    let _ = app.emit("overlay://float-shown", &card_id);
    Ok(())
}

#[tauri::command]
pub fn overlay_hide_float(app: AppHandle) -> Result<(), String> {
    let _transition = lock_float_visibility_transition();
    hide_float_window_for_idle(&app);
    restore_regular_activation_policy_if_no_overlay_visible(&app);
    let _ = app.emit("overlay://float-hidden", ());
    Ok(())
}

/// Single funnel for every native transition that hides the float surface.
/// On Windows this also starts the idle WebView2 release deadline; on other
/// platforms the memory and timer helpers are intentional no-ops.
fn hide_float_window_for_idle(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(FLOAT_LABEL) {
            panel.hide();
        }
    }

    let Some(window) = app.get_webview_window(FLOAT_LABEL) else {
        return false;
    };
    let _ = window.hide();
    set_float_memory_usage_low(&window);
    schedule_float_idle_destroy(app);
    true
}

#[cfg(target_os = "windows")]
fn set_float_memory_usage_low(window: &tauri::WebviewWindow) {
    set_overlay_memory_usage_low(window);
}

#[cfg(not(target_os = "windows"))]
fn set_float_memory_usage_low(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn set_float_memory_usage_normal(window: &tauri::WebviewWindow) {
    set_overlay_memory_usage_normal(window);
}

#[cfg(not(target_os = "windows"))]
fn set_float_memory_usage_normal(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn set_overlay_memory_usage_low(window: &tauri::WebviewWindow) {
    set_overlay_memory_usage_level(
        window,
        webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    );
}

#[cfg(not(target_os = "windows"))]
fn set_overlay_memory_usage_low(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn set_overlay_memory_usage_normal(window: &tauri::WebviewWindow) {
    set_overlay_memory_usage_level(
        window,
        webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    );
}

#[cfg(not(target_os = "windows"))]
fn set_overlay_memory_usage_normal(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "windows")]
fn set_overlay_memory_usage_level(
    window: &tauri::WebviewWindow,
    level: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_19;
    use windows_core::Interface as _;

    let label = window.label().to_string();
    if let Err(error) = window.with_webview(move |webview| {
        let result = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|webview| webview.cast::<ICoreWebView2_19>())
                .and_then(|webview| webview.SetMemoryUsageTargetLevel(level))
        };
        if let Err(error) = result {
            tracing::debug!(
                window = %label,
                error = %error,
                "Failed to set WebView2 memory usage target level"
            );
        }
    }) {
        tracing::debug!(
            window = %window.label(),
            error = %error,
            "Failed to access platform webview for memory usage target level"
        );
    }
}

#[cfg(target_os = "windows")]
fn schedule_float_idle_destroy(app: &AppHandle) {
    let generation = next_float_hide_generation(&FLOAT_HIDE_GENERATION);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FLOAT_IDLE_DESTROY_AFTER).await;
        let _transition = lock_float_visibility_transition();
        if !float_hide_generation_is_current(&FLOAT_HIDE_GENERATION, generation) {
            return;
        }
        let window = app.get_webview_window(FLOAT_LABEL);
        if window
            .as_ref()
            .is_some_and(|window| window.is_visible().unwrap_or(true))
        {
            return;
        }
        let removed = crate::pty::suspend_float_output_consumers();
        tracing::debug!(
            removed,
            "Detached float renderer consumers before idle close"
        );
        let Some(window) = window else { return };
        match window.close() {
            Ok(()) => tracing::info!("Closed idle float window to release WebView2 memory"),
            Err(error) => tracing::debug!(error = %error, "Failed to close idle float window"),
        }
    });
}

#[cfg(target_os = "windows")]
fn invalidate_float_idle_destroy() {
    next_float_hide_generation(&FLOAT_HIDE_GENERATION);
}

#[cfg(not(target_os = "windows"))]
fn invalidate_float_idle_destroy() {}

#[cfg(target_os = "windows")]
fn schedule_selector_idle_destroy(app: &AppHandle) {
    let generation = next_float_hide_generation(&SELECTOR_HIDE_GENERATION);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SELECTOR_IDLE_DESTROY_AFTER).await;
        if !float_hide_generation_is_current(&SELECTOR_HIDE_GENERATION, generation) {
            return;
        }
        let window = app.get_webview_window(SELECTOR_LABEL);
        if window
            .as_ref()
            .is_some_and(|window| window.is_visible().unwrap_or(true))
        {
            return;
        }
        let Some(window) = window else { return };
        match window.close() {
            Ok(()) => tracing::info!("Closed idle selector window to release WebView2 memory"),
            Err(error) => tracing::debug!(error = %error, "Failed to close idle selector window"),
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn schedule_selector_idle_destroy(_app: &AppHandle) {}

#[cfg(target_os = "windows")]
fn invalidate_selector_idle_destroy() {
    next_float_hide_generation(&SELECTOR_HIDE_GENERATION);
}

#[cfg(not(target_os = "windows"))]
fn invalidate_selector_idle_destroy() {}

#[cfg(target_os = "windows")]
fn next_float_hide_generation(counter: &AtomicU64) -> u64 {
    counter.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

#[cfg(target_os = "windows")]
fn float_hide_generation_is_current(counter: &AtomicU64, generation: u64) -> bool {
    counter.load(Ordering::SeqCst) == generation
}

#[cfg(target_os = "windows")]
fn lock_float_visibility_transition() -> MutexGuard<'static, ()> {
    FLOAT_VISIBILITY_TRANSITION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(not(target_os = "windows"))]
fn lock_float_visibility_transition() {}

#[cfg(not(target_os = "windows"))]
fn schedule_float_idle_destroy(_app: &AppHandle) {}

#[tauri::command]
pub fn overlay_show_main(app: AppHandle) -> Result<(), String> {
    let _transition = lock_float_visibility_transition();
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(SELECTOR_LABEL) {
            panel.hide();
        }
    }
    hide_selector_window_for_idle(&app);
    hide_float_window_for_idle(&app);
    // `overlay_show_main` also runs from the global B hotkey and selector
    // window, so the float renderer cannot rely on its local recycle handler
    // to learn that the native surface is now hidden.
    let _ = app.emit("overlay://float-hidden", ());
    restore_regular_activation_policy(&app);
    if let Some(m) = app.get_webview_window(MAIN_LABEL) {
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
    let _ = app.emit("overlay://main-shown", ());
    Ok(())
}

#[tauri::command]
pub fn overlay_save_float_bounds(bounds: FloatBounds) -> Result<(), String> {
    OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .float_bounds = Some(bounds.clone());
    let json = serde_json::to_string(&bounds).unwrap_or_default();
    if let Err(error) = crate::db::set_setting("overlay.float_bounds", &json) {
        tracing::warn!(%error, "failed to persist overlay float bounds");
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_get_settings() -> OverlaySettings {
    OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Apply the persisted float launch mode to the live float window
/// (fullscreen / maximized / restore-to-floating). No-op on macOS where the
/// float surface is an NSPanel with its own fullscreen semantics.
#[cfg(not(target_os = "macos"))]
fn apply_float_launch_mode(w: &tauri::WebviewWindow) {
    let mode = OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .float_launch_mode;
    match mode {
        FloatLaunchMode::Fullscreen => {
            let _ = w.set_fullscreen(true);
        }
        FloatLaunchMode::Maximized => {
            let _ = w.set_fullscreen(false);
            let _ = w.maximize();
        }
        FloatLaunchMode::Floating => {
            let _ = w.set_fullscreen(false);
            let _ = w.unmaximize();
        }
    }
}

#[tauri::command]
pub fn overlay_set_float_launch_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let parsed = FloatLaunchMode::from_value(&mode)
        .ok_or_else(|| format!("unknown float launch mode: {mode}"))?;
    OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .float_launch_mode = parsed;
    let _ = crate::db::set_setting("overlay.float_launch_mode", parsed.as_str());

    // Reflow a currently-visible float window so the change takes effect now.
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        if w.is_visible().unwrap_or(false) {
            apply_float_launch_mode(&w);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_set_lightweight_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .lightweight_mode = enabled;
    let _ = crate::db::set_setting(
        "overlay.lightweight_mode",
        if enabled { "true" } else { "false" },
    );

    if enabled {
        unregister_all_hotkeys(&app);
        let _ = overlay_hide_selector(app.clone());
        let _ = overlay_hide_float(app);
    } else {
        register_default_shortcuts(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_update_shortcut(
    app: AppHandle,
    label: String,
    accelerator: String,
) -> Result<(), String> {
    let key = match label.as_str() {
        "A" => "overlay.hotkey_a",
        "B" => "overlay.hotkey_b",
        _ => return Err(format!("unknown slot {label}")),
    };
    if !lightweight_mode_enabled() {
        register_hotkey(&app, &label, &accelerator)?;
    }
    // Persist
    let _ = crate::db::set_setting(key, &accelerator);
    // Update in-memory settings.
    let mut settings = OVERLAY_SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    match label.as_str() {
        "A" => settings.hotkey_a = accelerator,
        "B" => settings.hotkey_b = accelerator,
        _ => {}
    }
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn a_new_float_visibility_epoch_invalidates_the_previous_destroy_timer() {
        let generation = AtomicU64::new(0);
        let first_hide = next_float_hide_generation(&generation);
        assert!(float_hide_generation_is_current(&generation, first_hide));

        // Showing the window invalidates the first hide, and a later hide
        // receives its own deadline generation.
        next_float_hide_generation(&generation);
        assert!(!float_hide_generation_is_current(&generation, first_hide));

        let second_hide = next_float_hide_generation(&generation);
        assert!(float_hide_generation_is_current(&generation, second_hide));
        assert!(!float_hide_generation_is_current(&generation, first_hide));
    }
}
