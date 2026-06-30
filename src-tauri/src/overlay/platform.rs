//! Platform-specific window plumbing.
//!
//! macOS needs heavy AppKit / NSPanel manipulation to make the selector and
//! float windows behave like a global overlay (`CanJoinAllSpaces`,
//! `Accessory` activation policy, NSScreenSaver level, etc.). The non-macOS
//! variants keep the same call sites while applying the subset of native
//! focus / foreground behaviour that Tauri exposes cross-platform.

use tauri::AppHandle;
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
use super::window::{FLOAT_LABEL, SELECTOR_LABEL};
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
pub(super) fn configure_selector_window_for_current_space(window: &WebviewWindow) {
    use objc2_app_kit::{
        NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let Some(ns_window) = (unsafe { (ns_window_ptr as *mut NSWindow).as_ref() }) else {
        return;
    };

    let behavior = ns_window.collectionBehavior()
        | NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::CanJoinAllApplications
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Transient
        | NSWindowCollectionBehavior::IgnoresCycle;

    ns_window.setCollectionBehavior(behavior);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setCanBecomeVisibleWithoutLogin(true);
    ns_window.setLevel(NSScreenSaverWindowLevel);

    let style = ns_window.styleMask()
        | NSWindowStyleMask::UtilityWindow
        | NSWindowStyleMask::NonactivatingPanel;
    ns_window.setStyleMask(style);
}

#[cfg(target_os = "macos")]
pub(super) fn configure_float_window_for_current_space(window: &WebviewWindow) {
    use objc2_app_kit::{
        NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let Some(ns_window) = (unsafe { (ns_window_ptr as *mut NSWindow).as_ref() }) else {
        return;
    };

    let behavior = ns_window.collectionBehavior()
        | NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::CanJoinAllApplications
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Transient
        | NSWindowCollectionBehavior::IgnoresCycle;

    ns_window.setCollectionBehavior(behavior);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setCanBecomeVisibleWithoutLogin(true);
    ns_window.setLevel(NSScreenSaverWindowLevel);

    // Keep the float as a non-activating panel so selecting a card from the
    // global overlay does not switch Spaces or pull the main ThreadTerm
    // window/desktop to the foreground. The custom panel subclass above can
    // still become key, so the webview can receive terminal input.
    let style = ns_window.styleMask()
        | NSWindowStyleMask::UtilityWindow
        | NSWindowStyleMask::NonactivatingPanel;
    ns_window.setStyleMask(style);
}

#[cfg(target_os = "macos")]
pub(super) fn activate_float_window_for_keyboard(window: &WebviewWindow) {
    use objc2_app_kit::NSWindow;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let Some(ns_window) = (unsafe { (ns_window_ptr as *mut NSWindow).as_ref() }) else {
        return;
    };

    // Do not call NSApp.activateIgnoringOtherApps(true) here: that was the
    // regression that made Cmd+Shift+Space selections jump back to the Space
    // hosting ThreadTerm. Ordering the non-activating panel front is enough.
    ns_window.makeKeyAndOrderFront(None);
    ns_window.orderFrontRegardless();
}

#[cfg(target_os = "macos")]
pub(super) fn set_overlay_activation_policy(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        tracing::warn!(error = %e, "failed to set accessory activation policy for overlay");
    }
}

#[cfg(target_os = "macos")]
pub(super) fn restore_regular_activation_policy(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        tracing::warn!(error = %e, "failed to restore regular activation policy after overlay");
    }
}

#[cfg(target_os = "macos")]
pub(super) fn restore_regular_activation_policy_if_no_overlay_visible(app: &AppHandle) {
    let selector_visible = app
        .get_webview_window(SELECTOR_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let float_visible = app
        .get_webview_window(FLOAT_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !selector_visible && !float_visible {
        restore_regular_activation_policy(app);
    }
}

#[cfg(target_os = "macos")]
pub(super) fn order_overlay_window_front(window: &WebviewWindow) {
    use objc2::MainThreadMarker;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let Some(ns_window) = (unsafe { (ns_window_ptr as *mut objc2_app_kit::NSWindow).as_ref() })
    else {
        return;
    };

    if let Some(mtm) = MainThreadMarker::new() {
        let ns_app = objc2_app_kit::NSApp(mtm);
        #[allow(deprecated)]
        ns_app.activateIgnoringOtherApps(true);
    }
    ns_window.makeKeyAndOrderFront(None);
    ns_window.orderFrontRegardless();
}

// ── Non-macOS no-ops ─────────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub(super) fn configure_selector_window_for_current_space(_window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
pub(super) fn configure_float_window_for_current_space(_window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
pub(super) fn activate_float_window_for_keyboard(window: &WebviewWindow) {
    let _ = window.set_focus();
}

#[cfg(not(target_os = "macos"))]
pub(super) fn set_overlay_activation_policy(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub(super) fn restore_regular_activation_policy(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub(super) fn restore_regular_activation_policy_if_no_overlay_visible(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub(super) fn order_overlay_window_front(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
}
