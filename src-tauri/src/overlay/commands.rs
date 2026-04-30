use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

use super::hotkey::register_hotkey;
use super::platform::{
    activate_float_window_for_keyboard, configure_float_window_for_current_space,
    configure_selector_window_for_current_space, order_overlay_window_front,
    restore_regular_activation_policy, restore_regular_activation_policy_if_no_overlay_visible,
    set_overlay_activation_policy,
};
use super::state::{FloatBounds, OVERLAY_SETTINGS, OverlaySettings};
use super::window::{
    FLOAT_LABEL, MAIN_LABEL, SELECTOR_LABEL, ensure_float, ensure_selector, primary_monitor_bounds,
};

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
    OVERLAY_SETTINGS.lock().unwrap().float_bounds = Some(bounds.clone());
    let json = serde_json::to_string(&bounds).unwrap_or_default();
    let _ = crate::db::set_setting("overlay.float_bounds", &json);
    Ok(())
}

#[tauri::command]
pub fn overlay_get_settings() -> OverlaySettings {
    OVERLAY_SETTINGS.lock().unwrap().clone()
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
    let mut settings = OVERLAY_SETTINGS.lock().unwrap();
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
