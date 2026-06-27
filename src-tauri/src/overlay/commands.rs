use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

use super::hotkey::register_hotkey;
use super::platform::{
    activate_float_window_for_keyboard, configure_float_window_for_current_space,
    configure_pet_window_for_current_space, configure_selector_window_for_current_space,
    order_overlay_window_front, restore_regular_activation_policy,
    restore_regular_activation_policy_if_no_overlay_visible, set_overlay_activation_policy,
};
use super::state::{FloatBounds, FloatLaunchMode, OverlaySettings, OVERLAY_SETTINGS};
use super::window::{
    ensure_float, ensure_pet, ensure_selector, pet_window_size, primary_monitor_bounds,
    resolve_pet_geometry, PetGeometry, FLOAT_LABEL, MAIN_LABEL, PET_LABEL, SELECTOR_LABEL,
};
use std::sync::Mutex;

#[tauri::command]
pub fn overlay_show_selector(app: AppHandle) -> Result<(), String> {
    ensure_selector(&app)?;
    set_overlay_activation_policy(&app);
    // Hide float while selector is open (mutual exclusion). Restored on close.
    if let Some(f) = app.get_webview_window(FLOAT_LABEL) {
        let _ = f.hide();
    }
    if let Some(w) = app.get_webview_window(SELECTOR_LABEL) {
        // Re-align to the current primary monitor's physical bounds.
        // This handles three real-world cases that would otherwise leave
        // the window mis-sized or off-screen:
        //   • the prewarmed window was built before any monitor was
        //     reported by the window server (logical_w fallback used)
        //   • the user unplugged or switched displays since prewarm
        //   • the resolution changed (e.g. external 4K → laptop retina)
        let (mx, my, mw, mh) = primary_monitor_bounds(&app);
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
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(SELECTOR_LABEL) {
            panel.hide();
        }
    }

    if let Some(w) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = w.hide();
    }
    restore_regular_activation_policy_if_no_overlay_visible(&app);
    let _ = app.emit("overlay://selector-hidden", ());
    Ok(())
}

#[tauri::command]
pub fn overlay_show_float(app: AppHandle, card_id: String) -> Result<(), String> {
    ensure_float(&app)?;
    set_overlay_activation_policy(&app);
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
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(FLOAT_LABEL) {
            panel.hide();
        }
    }

    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        let _ = w.hide();
    }
    restore_regular_activation_policy_if_no_overlay_visible(&app);
    let _ = app.emit("overlay://float-hidden", ());
    Ok(())
}

#[tauri::command]
pub fn overlay_show_main(app: AppHandle) -> Result<(), String> {
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
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(FLOAT_LABEL) {
            panel.hide();
        }
    }
    if let Some(f) = app.get_webview_window(FLOAT_LABEL) {
        let _ = f.hide();
    }
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
    let _ = crate::db::set_setting("overlay.float_bounds", &json);
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
pub fn overlay_set_prewarm(app: AppHandle, enabled: bool) -> Result<(), String> {
    OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .overlay_prewarm = enabled;
    let _ = crate::db::set_setting("overlay.prewarm", if enabled { "true" } else { "false" });
    // Enabling warms the overlay webviews now (effective this session). Disabling
    // only affects the next startup; already-created webviews persist until exit.
    if enabled {
        super::window::prewarm_windows(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_update_shortcut(
    app: AppHandle,
    label: String,
    accelerator: String,
) -> Result<(), String> {
    register_hotkey(&app, &label, &accelerator)?;
    // Persist
    let key = match label.as_str() {
        "A" => "overlay.hotkey_a",
        "B" => "overlay.hotkey_b",
        _ => return Err(format!("unknown slot {label}")),
    };
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

#[tauri::command]
pub fn overlay_move_float(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        let _ = w.set_position(LogicalPosition::new(x, y));
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_resize_float(app: AppHandle, w: f64, h: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(FLOAT_LABEL) {
        let _ = win.set_size(LogicalSize::new(w, h));
    }
    Ok(())
}

#[tauri::command]
pub fn pet_show(app: AppHandle) -> Result<(), String> {
    ensure_pet(&app)?;

    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.set_visible_on_all_workspaces(true);
        configure_pet_window_for_current_space(&window);
        let _ = window.set_always_on_top(true);
        let _ = window.unminimize();

        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;

            if let Ok(panel) = app.get_webview_panel(PET_LABEL) {
                panel.show_and_make_key();
                panel.order_front_regardless();
            } else {
                let _ = window.show();
                order_overlay_window_front(&window);
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.show();
            order_overlay_window_front(&window);
        }
    }

    let _ = app.emit("pet://shown", ());
    Ok(())
}

#[tauri::command]
pub fn pet_hide(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Ok(panel) = app.get_webview_panel(PET_LABEL) {
            panel.hide();
        }
    }

    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.hide();
    }

    let _ = app.emit("pet://hidden", ());
    Ok(())
}

#[tauri::command]
pub fn pet_set_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
    Ok(())
}

/// Sprite anchor in logical px, monitor-global (same口径 as `lastPosition`).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PetAnchor {
    pub x: f64,
    pub y: f64,
}

/// Intent sent by the pet webview. `visual` is one of
/// "collapsed" | "bubble" | "expanded". `anchor` is `None` on first show
/// (backend picks the default bottom-right slot).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PetGeometryIntent {
    pub visual: String,
    pub size: f64,
    pub anchor: Option<PetAnchor>,
    /// Default-corner hint used only when `anchor` is `None`:
    /// "leftBottom" pins bottom-left, anything else → bottom-right.
    pub corner: Option<String>,
}

/// Serializes all pet window resize+move so two concurrent geometry passes
/// (e.g. a bubble arriving while an expand is in flight) can never interleave
/// and produce a half-applied/flickering window.
static PET_GEOMETRY_LOCK: Mutex<()> = Mutex::new(());

/// The single authority for the pet window's size + position. Computes the
/// union geometry (sprite + bubble/panel) clamped into the hosting monitor's
/// work area, applies size then position atomically, and broadcasts the
/// resolved geometry on `pet://geometry` so the webview can lay out the
/// sprite/content with the returned local offsets. Replaces the old split
/// `pet_set_expanded` + `pet_set_position` pet-sync path (race fix).
#[tauri::command]
pub fn pet_apply_geometry(
    app: AppHandle,
    intent: PetGeometryIntent,
) -> Result<PetGeometry, String> {
    let _guard = PET_GEOMETRY_LOCK
        .lock()
        .map_err(|e| format!("pet geometry lock poisoned: {e}"))?;

    let anchor = intent.anchor.as_ref().map(|a| (a.x, a.y));
    let geom = resolve_pet_geometry(
        &app,
        &intent.visual,
        intent.size,
        anchor,
        intent.corner.as_deref(),
    );

    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.set_size(LogicalSize::new(geom.window_w, geom.window_h));
        let _ = window.set_position(LogicalPosition::new(geom.window_x, geom.window_y));

        // Physical-size/position fallback. On macOS some NSPanel-backed
        // windows don't reliably honour `set_size(LogicalSize)` for the pet
        // panel — the selector window already works around the same class of
        // bug with PhysicalSize + physical coordinates (see
        // `overlay_show_selector` / `ensure_selector`). Re-assert the rect in
        // physical px using this window's own scale factor so the resize
        // actually takes effect. Logical-only environments (scale 1.0) are a
        // no-op repeat, so this is safe everywhere.
        let scale = window.scale_factor().unwrap_or(1.0);
        if scale > 0.0 {
            let _ = window.set_size(tauri::PhysicalSize::new(
                (geom.window_w * scale).round() as u32,
                (geom.window_h * scale).round() as u32,
            ));
            let _ = window.set_position(tauri::PhysicalPosition::new(
                (geom.window_x * scale).round() as i32,
                (geom.window_y * scale).round() as i32,
            ));
        }
    }

    tracing::info!(
        visual = %intent.visual,
        w = geom.window_w,
        h = geom.window_h,
        x = geom.window_x,
        y = geom.window_y,
        "pet_apply_geometry applied"
    );

    let _ = app.emit("pet://geometry", &geom);
    Ok(geom)
}

#[tauri::command]
pub fn pet_set_expanded(app: AppHandle, expanded: bool, size: Option<f64>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let (w, h) = pet_window_size(expanded, size);
        let _ = window.set_size(LogicalSize::new(w, h));
    }
    let _ = app.emit("pet://expanded", expanded);
    Ok(())
}

#[tauri::command]
pub fn pet_focus_main_to_card(app: AppHandle, card_id: String) -> Result<(), String> {
    overlay_show_main(app.clone())?;
    let _ = app.emit("pet://focus-card", card_id);
    Ok(())
}

#[tauri::command]
pub fn pet_open_notification_center(app: AppHandle) -> Result<(), String> {
    overlay_show_main(app.clone())?;
    let _ = app.emit("pet://open-notification-center", ());
    Ok(())
}
