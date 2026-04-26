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
 */
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindowBuilder;

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
            can_become_main_window: true,
            is_floating_panel: true
        }
    })
}

// ── Labels ───────────────────────────────────────────────────────────────────

pub const SELECTOR_LABEL: &str = "selector";
pub const FLOAT_LABEL: &str = "float";
pub const MAIN_LABEL: &str = "main";

// ── Persistent settings ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlaySettings {
    pub hotkey_a: String,
    pub hotkey_b: String,
    pub float_bounds: Option<FloatBounds>,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            hotkey_a: "CmdOrCtrl+Shift+Space".to_string(),
            hotkey_b: "CmdOrCtrl+Shift+O".to_string(),
            float_bounds: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FloatBounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// In-memory cache of overlay settings. Persisted via the `settings` table in
/// `db.rs` (keys: `overlay.hotkey_a`, `overlay.hotkey_b`, `overlay.float_bounds`).
static OVERLAY_SETTINGS: Lazy<Mutex<OverlaySettings>> =
    Lazy::new(|| Mutex::new(OverlaySettings::default()));

/// Label of the currently active hotkey binding, so we can unregister
/// before swapping in a new accelerator.
static REGISTERED_A: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static REGISTERED_B: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

// ── Public API (called from lib.rs setup) ────────────────────────────────────

/// Load any persisted overlay settings from the SQLite settings table.
pub fn load_settings() -> OverlaySettings {
    let mut out = OverlaySettings::default();
    if let Ok(Some(v)) = crate::db::get_setting("overlay.hotkey_a") {
        if !v.is_empty() {
            out.hotkey_a = v;
        }
    }
    if let Ok(Some(v)) = crate::db::get_setting("overlay.hotkey_b") {
        if !v.is_empty() {
            out.hotkey_b = v;
        }
    }
    if let Ok(Some(v)) = crate::db::get_setting("overlay.float_bounds") {
        if let Ok(bounds) = serde_json::from_str::<FloatBounds>(&v) {
            out.float_bounds = Some(bounds);
        }
    }
    *OVERLAY_SETTINGS.lock().unwrap() = out.clone();
    out
}

/// Pre-create the selector + float webviews so the first hotkey press is
/// instant. Both windows are built hidden (`visible(false)`) and simply
/// sit in memory until the user summons them.
///
/// Why this matters: if we wait until the first hotkey to create the
/// selector window, the user experiences a ~300-800ms delay while Tauri
/// boots a new webview, Vite serves the HTML, React hydrates, and zustand
/// stores rehydrate from localStorage. For a "press hotkey → overlay
/// appears over Windsurf NOW" UX that's unacceptable.
///
/// Failures are logged but not fatal — the lazy ensure_selector /
/// ensure_float path still works as a fallback.
pub fn prewarm_windows(app: &AppHandle) {
    if let Err(e) = ensure_selector(app) {
        tracing::warn!(error = %e, "prewarm: ensure_selector failed");
    }
    if let Err(e) = ensure_float(app) {
        tracing::warn!(error = %e, "prewarm: ensure_float failed");
    }
    // Prewarming hidden overlay panels temporarily switches macOS to
    // Accessory activation policy; restore the normal app policy before the
    // main window becomes the user's focus target.
    restore_regular_activation_policy_if_no_overlay_visible(app);
}

/// Register the two global shortcuts. Safe to call from `setup`; logs but
/// does not panic on failure (a user may have a conflicting binding).
pub fn register_default_shortcuts(app: &AppHandle) {
    let settings = OVERLAY_SETTINGS.lock().unwrap().clone();
    let _ = register_hotkey(app, "A", &settings.hotkey_a);
    let _ = register_hotkey(app, "B", &settings.hotkey_b);
}

fn register_hotkey(app: &AppHandle, label: &str, accel: &str) -> Result<(), String> {
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

/// Shortcut id → slot label ("A"/"B") map used by the central handler.
/// Keyed on `Shortcut::id()` rather than the accelerator string because
/// the latter doesn't round-trip (see `register_hotkey` for details).
pub static HOTKEY_MAP: Lazy<Mutex<std::collections::HashMap<u32, String>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

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

/// Public re-export so `lib.rs` can filter press vs release without
/// importing the plugin crate directly in more places than necessary.
pub use tauri_plugin_global_shortcut::ShortcutState as PluginShortcutState;

// ── Window helpers ───────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn configure_selector_window_for_current_space(window: &WebviewWindow) {
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
fn configure_float_window_for_current_space(window: &WebviewWindow) {
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

    // Critical difference from the selector: the terminal must NOT be a
    // NonactivatingPanel. If it is, macOS keeps keyboard focus on the app
    // underneath the floating terminal, so typing affects the lower window.
    let mut style = ns_window.styleMask() | NSWindowStyleMask::UtilityWindow;
    style.remove(NSWindowStyleMask::NonactivatingPanel);
    ns_window.setStyleMask(style);
}

#[cfg(target_os = "macos")]
fn activate_float_window_for_keyboard(window: &WebviewWindow) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let Some(ns_window) = (unsafe { (ns_window_ptr as *mut NSWindow).as_ref() }) else {
        return;
    };

    if let Some(mtm) = MainThreadMarker::new() {
        let ns_app = objc2_app_kit::NSApp(mtm);
        #[allow(deprecated)]
        ns_app.activateIgnoringOtherApps(true);
    }

    ns_window.makeKeyAndOrderFront(None);
    ns_window.makeMainWindow();
    ns_window.orderFrontRegardless();
}

#[cfg(target_os = "macos")]
fn set_overlay_activation_policy(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        tracing::warn!(error = %e, "failed to set accessory activation policy for overlay");
    }
}

#[cfg(target_os = "macos")]
fn restore_regular_activation_policy(app: &AppHandle) {
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        tracing::warn!(error = %e, "failed to restore regular activation policy after overlay");
    }
}

#[cfg(target_os = "macos")]
fn restore_regular_activation_policy_if_no_overlay_visible(app: &AppHandle) {
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
fn order_overlay_window_front(window: &WebviewWindow) {
    use objc2::MainThreadMarker;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let Some(ns_window) = (unsafe { (ns_window_ptr as *mut objc2_app_kit::NSWindow).as_ref() }) else {
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

#[cfg(not(target_os = "macos"))]
fn configure_selector_window_for_current_space(_window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
fn configure_float_window_for_current_space(_window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
fn activate_float_window_for_keyboard(_window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
fn set_overlay_activation_policy(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
fn restore_regular_activation_policy(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
fn restore_regular_activation_policy_if_no_overlay_visible(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
fn order_overlay_window_front(_window: &WebviewWindow) {}

/// Resolve the primary monitor's physical bounds. Used both at window
/// build and on each `overlay_show_selector` call.
///
/// Falls back to a generous 1920x1080 at origin when the monitor query
/// fails — happens in headless CI and very early during app boot before
/// any display has been registered with the window server.
fn primary_monitor_bounds(app: &AppHandle) -> (i32, i32, u32, u32) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let p = m.position();
        let s = m.size();
        return (p.x, p.y, s.width, s.height);
    }
    (0, 0, 1920, 1080)
}

fn ensure_selector(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(SELECTOR_LABEL).is_some() {
        return Ok(());
    }
    // NB: we intentionally do **not** call `.transparent(true)` here. In
    // Tauri 2.x that method is gated behind the `unstable` cargo feature and
    // additionally requires the macOS `macOSPrivateApi` opt-in, which is
    // incompatible with Mac App Store distribution. The `ExpandFromCornerShell`
    // React component already paints a full-viewport backdrop inside the
    // webview, so window-level transparency is purely cosmetic.

    // CRITICAL: we have to give the builder an explicit inner_size and
    // position. If we don't, tao falls back to a default 800x600 window
    // somewhere in the top-left and the user perceives the global hotkey
    // as "the screen flashed but no window appeared" — they're literally
    // not looking at the right corner of their screen.
    //
    // We use logical pixel size = physical / scale_factor. macOS's window
    // server will treat that as the natural full-screen size on retina.
    let (mx, my, mw, mh) = primary_monitor_bounds(app);
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let logical_w = (mw as f64 / scale).max(640.0);
    let logical_h = (mh as f64 / scale).max(480.0);

    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

        set_overlay_activation_policy(app);
        PanelBuilder::<_, OverlaySelectorPanel>::new(app, SELECTOR_LABEL)
            .url(WebviewUrl::App("selector.html".into()))
            .title("ThreadTerm · Selector")
            .level(PanelLevel::ScreenSaver)
            .floating(true)
            .hides_on_deactivate(false)
            .works_when_modal(true)
            .style_mask(StyleMask::empty().resizable())
            .collection_behavior(
                CollectionBehavior::new()
                    .full_screen_auxiliary()
                    .can_join_all_spaces()
                    .ignores_cycle(),
            )
            .with_window(move |builder| {
                builder
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .visible(false)
                    .inner_size(logical_w, logical_h)
            })
            .build()
            .map_err(|e| format!("failed to build selector panel: {e:?}"))?;

        tracing::info!("overlay selector NSPanel created");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let builder = WebviewWindowBuilder::new(
            app,
            SELECTOR_LABEL,
            WebviewUrl::App("selector.html".into()),
        )
        .title("ThreadTerm · Selector")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .inner_size(logical_w, logical_h);

        builder
            .build()
            .map_err(|e| format!("failed to build selector window: {e:?}"))?;
    }

    // Position via physical coords so multi-monitor / retina lines up.
    if let Some(w) = app.get_webview_window(SELECTOR_LABEL) {
        let _ = w.set_position(tauri::PhysicalPosition::new(mx, my));
        let _ = w.set_size(tauri::PhysicalSize::new(mw, mh));

        // CRITICAL on macOS — without `CanJoinAllSpaces` the selector
        // will only appear on the Space that hosts ThreadTerm's main
        // window. If the user is in Windsurf on a different Space and
        // presses the global hotkey, macOS either:
        //   • flashes a Space-switch animation and moves the user away,
        //   • or (more commonly with activateIgnoringOtherApps) leaves
        //     the user on the current Space while the selector quietly
        //     opens on the OTHER Space, invisible.
        //
        // Setting `visible_on_all_workspaces(true)` flips on
        // `NSWindowCollectionBehavior::CanJoinAllSpaces` so the
        // selector always renders on the user's current Space. This is
        // the real "the hotkey pops the overlay over whatever I'm
        // doing" fix.
        let _ = w.set_visible_on_all_workspaces(true);
        configure_selector_window_for_current_space(&w);
    }
    Ok(())
}

fn ensure_float(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(FLOAT_LABEL).is_some() {
        return Ok(());
    }
    let settings = OVERLAY_SETTINGS.lock().unwrap().clone();

    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

        let bounds = settings.float_bounds.clone();
        set_overlay_activation_policy(app);
        PanelBuilder::<_, OverlayFloatPanel>::new(app, FLOAT_LABEL)
            .url(WebviewUrl::App("float.html".into()))
            .title("ThreadTerm · Floating Terminal")
            .level(PanelLevel::ScreenSaver)
            .floating(true)
            .hides_on_deactivate(false)
            .works_when_modal(true)
            .style_mask(StyleMask::empty().nonactivating_panel())
            .collection_behavior(
                CollectionBehavior::new()
                    .full_screen_auxiliary()
                    .can_join_all_spaces()
                    .ignores_cycle(),
            )
            .with_window(move |builder| {
                let builder = builder
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(false)
                    .resizable(true)
                    .visible(false)
                    .inner_size(900.0, 560.0)
                    .min_inner_size(480.0, 320.0);

                if let Some(b) = bounds {
                    builder
                        .inner_size(b.w.max(480.0), b.h.max(320.0))
                        .position(b.x, b.y)
                } else {
                    builder
                }
            })
            .build()
            .map_err(|e| format!("failed to build float panel: {e:?}"))?;

        tracing::info!("overlay float NSPanel created");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut builder = WebviewWindowBuilder::new(
            app,
            FLOAT_LABEL,
            WebviewUrl::App("float.html".into()),
        )
        .title("ThreadTerm · Floating Terminal")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .resizable(true)
        .visible(false)
        .inner_size(900.0, 560.0)
        .min_inner_size(480.0, 320.0);

        if let Some(b) = settings.float_bounds.clone() {
            builder = builder
                .inner_size(b.w.max(480.0), b.h.max(320.0))
                .position(b.x, b.y);
        }

        builder
            .build()
            .map_err(|e| format!("failed to build float window: {e:?}"))?;
    }

    // Same CanJoinAllSpaces treatment as the selector — the float
    // terminal should follow the user across macOS Spaces so it stays
    // useful while they context-switch between apps.
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        let _ = w.set_visible_on_all_workspaces(true);
        configure_float_window_for_current_space(&w);
    }
    Ok(())
}

// ── Commands ────────────────────────────────────────────────────────────────

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
                tracing::warn!("overlay selector panel missing; falling back to WebviewWindow show");
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
                panel.make_main_window();
                panel.order_front_regardless();
                activate_float_window_for_keyboard(&w);
                let _ = w.set_focus();
            } else {
                tracing::warn!("overlay float panel missing; falling back to WebviewWindow show");
                let _ = w.show();
                order_overlay_window_front(&w);
                activate_float_window_for_keyboard(&w);
                let _ = w.set_focus();
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
