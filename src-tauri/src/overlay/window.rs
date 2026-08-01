use tauri::{AppHandle, Manager, WebviewUrl};

#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindowBuilder;

#[cfg(target_os = "macos")]
use super::platform::set_overlay_activation_policy;
use super::platform::{
    configure_float_window_for_current_space, configure_selector_window_for_current_space,
    restore_regular_activation_policy_if_no_overlay_visible,
};
use super::state::OVERLAY_SETTINGS;

// ── Labels ───────────────────────────────────────────────────────────────────

pub const SELECTOR_LABEL: &str = "selector";
pub const FLOAT_LABEL: &str = "float";
pub const MAIN_LABEL: &str = "main";

// ── Public API (called from lib.rs setup) ────────────────────────────────────

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
/// Platform default: prewarm is ON everywhere except Windows, where the two
/// hidden WebView2 renderer processes cost ~230MB of standing memory even
/// for users who never touch the overlay hotkeys. Windows users who want
/// instant first summon can opt back in with THREADTERM_OVERLAY_PREWARM=1;
/// THREADTERM_SKIP_OVERLAY_PREWARM=1 forces prewarm off on any platform.
///
/// Failures are logged but not fatal — the lazy ensure_selector /
/// ensure_float path still works as a fallback.
pub fn prewarm_windows(app: &AppHandle) {
    if OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .lightweight_mode
    {
        tracing::info!("overlay prewarm disabled by lightweight mode");
        return;
    }

    if !prewarm_enabled(
        std::env::var("THREADTERM_SKIP_OVERLAY_PREWARM")
            .ok()
            .as_deref(),
        std::env::var("THREADTERM_OVERLAY_PREWARM").ok().as_deref(),
        default_prewarm_enabled(),
    ) {
        tracing::info!(
            "overlay prewarm disabled; selector/float will be created lazily on first use"
        );
        return;
    }

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

fn env_truthy(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Windows defaults prewarm OFF (lazy overlay creation); other platforms ON.
#[cfg(target_os = "windows")]
fn default_prewarm_enabled() -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
fn default_prewarm_enabled() -> bool {
    true
}

/// Skip wins over opt-in; otherwise an explicit opt-in wins over the
/// platform default.
fn prewarm_enabled(skip_env: Option<&str>, optin_env: Option<&str>, default_enabled: bool) -> bool {
    if env_truthy(skip_env) {
        return false;
    }
    if env_truthy(optin_env) {
        return true;
    }
    default_enabled
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Resolve the primary monitor's physical bounds. Used both at window
/// build and on each `overlay_show_selector` call.
///
/// Falls back to a generous 1920x1080 at origin when the monitor query
/// fails — happens in headless CI and very early during app boot before
/// any display has been registered with the window server.
pub(super) fn primary_monitor_bounds(app: &AppHandle) -> (i32, i32, u32, u32) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let p = m.position();
        let s = m.size();
        return (p.x, p.y, s.width, s.height);
    }
    (0, 0, 1920, 1080)
}

pub(super) fn ensure_selector(app: &AppHandle) -> Result<(), String> {
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
        use super::OverlaySelectorPanel;
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
        let builder =
            WebviewWindowBuilder::new(app, SELECTOR_LABEL, WebviewUrl::App("selector.html".into()))
                .title("ThreadTerm · Selector")
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .visible(false)
                .inner_size(logical_w, logical_h);
        let builder = crate::data_directory::apply_webview_data_directory(app, builder);

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

pub(super) fn ensure_float(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(FLOAT_LABEL).is_some() {
        return Ok(());
    }
    let settings = OVERLAY_SETTINGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    #[cfg(target_os = "macos")]
    {
        use super::OverlayFloatPanel;
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
        let mut builder =
            WebviewWindowBuilder::new(app, FLOAT_LABEL, WebviewUrl::App("float.html".into()))
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
        let builder = crate::data_directory::apply_webview_data_directory(app, builder);

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

#[cfg(test)]
mod tests {
    use super::prewarm_enabled;

    #[test]
    fn follows_platform_default_when_no_env_set() {
        assert!(prewarm_enabled(None, None, true));
        assert!(!prewarm_enabled(None, None, false));
    }

    #[test]
    fn optin_overrides_default_off() {
        for value in ["1", "true", "yes", "on", " TRUE "] {
            assert!(prewarm_enabled(None, Some(value), false));
        }
    }

    #[test]
    fn non_truthy_optin_falls_through_to_default() {
        for value in ["0", "false", "", "maybe"] {
            assert!(!prewarm_enabled(None, Some(value), false));
            assert!(prewarm_enabled(None, Some(value), true));
        }
    }

    #[test]
    fn skip_wins_over_optin_and_default() {
        assert!(!prewarm_enabled(Some("1"), Some("1"), true));
        assert!(!prewarm_enabled(Some("yes"), None, true));
    }
}
