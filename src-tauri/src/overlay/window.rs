use tauri::{AppHandle, Manager, WebviewUrl};

#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindowBuilder;

use super::platform::{
    configure_float_window_for_current_space, configure_pet_window_for_current_space,
    configure_selector_window_for_current_space,
    restore_regular_activation_policy_if_no_overlay_visible, set_overlay_activation_policy,
};
use super::state::OVERLAY_SETTINGS;

// ── Labels ───────────────────────────────────────────────────────────────────

pub const SELECTOR_LABEL: &str = "selector";
pub const FLOAT_LABEL: &str = "float";
pub const PET_LABEL: &str = "pet";
pub const MAIN_LABEL: &str = "main";

pub const PET_DEFAULT_SIZE: f64 = 96.0;
pub const PET_MIN_SIZE: f64 = 80.0;
pub const PET_MAX_SIZE: f64 = 120.0;
pub const PET_EXPANDED_WIDTH: f64 = 296.0;
pub const PET_EXPANDED_HEIGHT: f64 = 380.0;
const PET_DEFAULT_MARGIN: f64 = 24.0;

// Bubble (transient toast) box, logical px. Kept in sync with the CSS
// `.pet-toast` max box in `src/pet/petAnimations.css`.
const PET_BUBBLE_W: f64 = 280.0;
const PET_BUBBLE_H: f64 = 88.0;
const PET_BUBBLE_GAP: f64 = 12.0;

// ── Geometry: single authority for the pet OS window ─────────────────────────
//
// The pet window is one of three finite visual states:
//   • collapsed — just the sprite (size × size)
//   • bubble    — sprite + a transient notification toast beside it
//   • expanded  — sprite + the full notification panel
//
// For `bubble`/`expanded` the OS window must grow to the *union* bounding box
// of sprite + content so the content is never clipped by the webview's
// `overflow:hidden` or pushed off-screen. The whole composition is then
// clamped back inside the work area of the monitor that hosts the sprite, so
// it can never overflow any screen edge (fixes the "通知框被挡" / "靠右展开
// 出屏" bugs). All math is in logical px, monitor-global coordinates — the
// single口径 shared with `pet_set_position` (LogicalPosition) and the
// frontend's `lastPosition` (already divided by scaleFactor).

/// Result of geometry resolution. `*_local_*` are the sprite/content offsets
/// inside the final window so the webview can absolutely-position them and
/// stay glued to the window after clamping.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetGeometry {
    pub window_x: f64,
    pub window_y: f64,
    pub window_w: f64,
    pub window_h: f64,
    /// "left" | "right" | "top" | "bottom" — which side the content sits on.
    pub side: String,
    pub pet_local_x: f64,
    pub pet_local_y: f64,
    pub content_local_x: f64,
    pub content_local_y: f64,
}

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
/// Failures are logged but not fatal — the lazy ensure_selector /
/// ensure_float path still works as a fallback.
pub fn prewarm_windows(app: &AppHandle) {
    let skip_prewarm = std::env::var("THREADTERM_SKIP_OVERLAY_PREWARM")
        .ok()
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false);
    if skip_prewarm {
        tracing::info!("overlay prewarm skipped by THREADTERM_SKIP_OVERLAY_PREWARM");
        return;
    }

    if let Err(e) = ensure_selector(app) {
        tracing::warn!(error = %e, "prewarm: ensure_selector failed");
    }
    if let Err(e) = ensure_float(app) {
        tracing::warn!(error = %e, "prewarm: ensure_float failed");
    }
    if let Err(e) = ensure_pet(app) {
        tracing::warn!(error = %e, "prewarm: ensure_pet failed");
    }
    // Prewarming hidden overlay panels temporarily switches macOS to
    // Accessory activation policy; restore the normal app policy before the
    // main window becomes the user's focus target.
    restore_regular_activation_policy_if_no_overlay_visible(app);
}

pub(super) fn pet_window_size(expanded: bool, size: Option<f64>) -> (f64, f64) {
    if expanded {
        return (PET_EXPANDED_WIDTH, PET_EXPANDED_HEIGHT);
    }
    let clamped = size
        .unwrap_or(PET_DEFAULT_SIZE)
        .clamp(PET_MIN_SIZE, PET_MAX_SIZE);
    (clamped, clamped)
}

/// Primary monitor rect in logical px (origin + size). The uniform
/// `PET_DEFAULT_MARGIN` inset is applied later by `compute_pet_geometry`'s
/// clamp, so this returns the full monitor rect (a precise
/// `NSScreen.visibleFrame` read is a future refinement — see plan TODO).
fn primary_work_area_logical(app: &AppHandle) -> (f64, f64, f64, f64) {
    let (mx, my, mw, mh) = primary_monitor_bounds(app);
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    (
        mx as f64 / scale,
        my as f64 / scale,
        mw as f64 / scale,
        mh as f64 / scale,
    )
}

/// Work area (logical px) of the monitor that contains the given anchor
/// point. Falls back to the primary monitor when no monitor contains the
/// anchor — happens after a display is unplugged while the pet was on it, so
/// the pet is never lost off-screen (multi-screen safety).
fn monitor_work_area_logical(app: &AppHandle, ax: f64, ay: f64) -> (f64, f64, f64, f64) {
    if let Ok(monitors) = app.available_monitors() {
        for m in &monitors {
            let s = m.scale_factor();
            let p = m.position();
            let sz = m.size();
            let lx = p.x as f64 / s;
            let ly = p.y as f64 / s;
            let lw = sz.width as f64 / s;
            let lh = sz.height as f64 / s;
            if ax >= lx && ax < lx + lw && ay >= ly && ay < ly + lh {
                return (lx, ly, lw, lh);
            }
        }
    }
    primary_work_area_logical(app)
}

/// Pure geometry: given the visual state, sprite size, optional sprite anchor
/// (logical, monitor-global; `None` → bottom-right default within `work`) and
/// the hosting monitor's work area, produce the final window rect, the chosen
/// content side, and sprite/content local offsets.
///
/// Pure (no `AppHandle`) so it is unit-testable — see `#[cfg(test)]` below.
pub(super) fn compute_pet_geometry(
    visual: &str,
    size: f64,
    anchor: Option<(f64, f64)>,
    work: (f64, f64, f64, f64),
) -> PetGeometry {
    let (wx, wy, ww, wh) = work;
    let m = PET_DEFAULT_MARGIN;
    let s = size.clamp(PET_MIN_SIZE, PET_MAX_SIZE);

    // Sprite top-left (global logical). Default = bottom-right within work.
    let (ax, ay) = anchor.unwrap_or((wx + ww - s - m, wy + wh - s - m));

    // Collapsed: window is just the sprite, clamped into the work area.
    if visual != "bubble" && visual != "expanded" {
        let mut win_w = s;
        let mut win_h = s;
        if win_w > ww - 2.0 * m {
            win_w = ww - 2.0 * m;
        }
        if win_h > wh - 2.0 * m {
            win_h = wh - 2.0 * m;
        }
        let win_x = ax.clamp(wx + m, (wx + ww - m - win_w).max(wx + m));
        let win_y = ay.clamp(wy + m, (wy + wh - m - win_h).max(wy + m));
        return PetGeometry {
            window_x: win_x,
            window_y: win_y,
            window_w: win_w,
            window_h: win_h,
            side: "right".to_string(),
            pet_local_x: ax - win_x,
            pet_local_y: ay - win_y,
            content_local_x: 0.0,
            content_local_y: 0.0,
        };
    }

    // Content box beside the sprite.
    let (bw, bh) = if visual == "expanded" {
        (PET_EXPANDED_WIDTH, PET_EXPANDED_HEIGHT)
    } else {
        (PET_BUBBLE_W, PET_BUBBLE_H)
    };
    let g = PET_BUBBLE_GAP;
    let cx = ax + s / 2.0;
    let cy = ay + s / 2.0;

    let space_left = ax - wx;
    let space_right = (wx + ww) - (ax + s);
    let space_top = ay - wy;
    let space_bottom = (wy + wh) - (ay + s);

    let side = if space_left >= bw + g && space_left >= space_right {
        "left"
    } else if space_right >= bw + g {
        "right"
    } else if space_top >= bh + g && space_top >= space_bottom {
        "top"
    } else {
        "bottom"
    };

    let (bx, by) = match side {
        "left" => (ax - g - bw, cy - bh / 2.0),
        "right" => (ax + s + g, cy - bh / 2.0),
        "top" => (cx - bw / 2.0, ay - g - bh),
        _ => (cx - bw / 2.0, ay + s + g),
    };

    // Union bounding box of sprite + content (unclamped origin).
    let ux = ax.min(bx);
    let uy = ay.min(by);
    let ur = (ax + s).max(bx + bw);
    let ub = (ay + s).max(by + bh);
    let mut win_w = ur - ux;
    let mut win_h = ub - uy;

    // Local offsets are relative to the *unclamped* union origin. The whole
    // composition rides with the window when it gets clamped, so these stay
    // valid and nothing ever sticks out of the window.
    let pet_local_x = ax - ux;
    let pet_local_y = ay - uy;
    let content_local_x = bx - ux;
    let content_local_y = by - uy;

    // Degenerate: union larger than the work area → shrink (content may clip,
    // documented fallback) so the window still fully fits on screen.
    if win_w > ww - 2.0 * m {
        win_w = ww - 2.0 * m;
    }
    if win_h > wh - 2.0 * m {
        win_h = wh - 2.0 * m;
    }
    let win_x = ux.clamp(wx + m, (wx + ww - m - win_w).max(wx + m));
    let win_y = uy.clamp(wy + m, (wy + wh - m - win_h).max(wy + m));

    PetGeometry {
        window_x: win_x,
        window_y: win_y,
        window_w: win_w,
        window_h: win_h,
        side: side.to_string(),
        pet_local_x,
        pet_local_y,
        content_local_x,
        content_local_y,
    }
}

/// Resolve geometry for the live app: picks the work area of the monitor that
/// hosts the anchor (or primary when no anchor yet), derives the default
/// corner anchor when none was supplied (`corner` = "leftBottom" pins to the
/// bottom-left; anything else → bottom-right), then delegates to the pure
/// [`compute_pet_geometry`].
pub(super) fn resolve_pet_geometry(
    app: &AppHandle,
    visual: &str,
    size: f64,
    anchor: Option<(f64, f64)>,
    corner: Option<&str>,
) -> PetGeometry {
    let work = match anchor {
        Some((x, y)) => monitor_work_area_logical(app, x, y),
        None => primary_work_area_logical(app),
    };
    let effective = anchor.or_else(|| {
        let (wx, wy, ww, wh) = work;
        let m = PET_DEFAULT_MARGIN;
        let s = size.clamp(PET_MIN_SIZE, PET_MAX_SIZE);
        if corner == Some("leftBottom") {
            Some((wx + m, wy + wh - s - m))
        } else {
            Some((wx + ww - s - m, wy + wh - s - m))
        }
    });
    compute_pet_geometry(visual, size, effective, work)
}

/// Default bottom-right pet position (logical px) on the primary monitor.
/// Signature preserved for `ensure_pet` / `prewarm_windows` — internally
/// delegates to the shared work-area helper.
fn pet_default_position(app: &AppHandle, width: f64, height: f64) -> (f64, f64) {
    let (wx, wy, ww, wh) = primary_work_area_logical(app);
    (
        wx + ww - width - PET_DEFAULT_MARGIN,
        wy + wh - height - PET_DEFAULT_MARGIN,
    )
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

pub(super) fn ensure_pet(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(PET_LABEL).is_some() {
        return Ok(());
    }

    let (w, h) = pet_window_size(false, None);
    let (x, y) = pet_default_position(app, w, h);

    #[cfg(target_os = "macos")]
    {
        use super::OverlayPetPanel;
        use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

        PanelBuilder::<_, OverlayPetPanel>::new(app, PET_LABEL)
            .url(WebviewUrl::App("pet.html".into()))
            .title("ThreadTerm · Desktop Pet")
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
                builder
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .visible(false)
                    .shadow(false)
                    .inner_size(w, h)
                    .position(x, y)
            })
            .build()
            .map_err(|e| format!("failed to build pet panel: {e:?}"))?;

        tracing::info!("overlay pet NSPanel created");
    }

    #[cfg(not(target_os = "macos"))]
    {
        WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("pet.html".into()))
            .title("ThreadTerm · Desktop Pet")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            // Windows draws a drop shadow / 1px frame around borderless
            // transparent windows. The macOS panel branch already disables
            // it; mirror that here so the pet has no extra border (issue #6).
            .shadow(false)
            .inner_size(w, h)
            .position(x, y)
            .build()
            .map_err(|e| format!("failed to build pet window: {e:?}"))?;
    }

    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.set_visible_on_all_workspaces(true);
        configure_pet_window_for_current_space(&window);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1920x1080 logical work area at origin.
    const WORK: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    fn contains(g: &PetGeometry, work: (f64, f64, f64, f64)) -> bool {
        let (wx, wy, ww, wh) = work;
        g.window_x >= wx
            && g.window_y >= wy
            && g.window_x + g.window_w <= wx + ww + 0.001
            && g.window_y + g.window_h <= wy + wh + 0.001
    }

    #[test]
    fn collapsed_is_just_the_sprite_clamped_inside() {
        let g = compute_pet_geometry("collapsed", 96.0, None, WORK);
        assert_eq!(g.window_w, 96.0);
        assert_eq!(g.window_h, 96.0);
        assert!(contains(&g, WORK));
    }

    #[test]
    fn bubble_at_bottom_right_flips_to_left() {
        // Default anchor (None) = bottom-right corner.
        let g = compute_pet_geometry("bubble", 96.0, None, WORK);
        assert_eq!(g.side, "left");
        // Window union must contain sprite + bubble and stay on screen.
        assert!(g.window_w >= PET_BUBBLE_W);
        assert!(contains(&g, WORK));
    }

    #[test]
    fn bubble_at_left_edge_flips_to_right() {
        let g = compute_pet_geometry("bubble", 96.0, Some((24.0, 900.0)), WORK);
        assert_eq!(g.side, "right");
        assert!(contains(&g, WORK));
    }

    #[test]
    fn bubble_near_top_with_no_horizontal_room_flips_vertical() {
        // Narrow work area so neither left nor right fits the bubble width.
        let narrow = (0.0, 0.0, 320.0, 1080.0);
        let g = compute_pet_geometry("bubble", 96.0, Some((112.0, 24.0)), narrow);
        assert!(g.side == "top" || g.side == "bottom");
        assert!(contains(&g, narrow));
    }

    #[test]
    fn expanded_panel_near_right_edge_stays_on_screen() {
        // Sprite hugging the right edge; expanded panel must not overflow.
        let g = compute_pet_geometry("expanded", 96.0, Some((1800.0, 900.0)), WORK);
        assert!(contains(&g, WORK));
        assert!(g.window_w >= PET_EXPANDED_WIDTH - 0.001);
    }

    #[test]
    fn union_larger_than_screen_degrades_but_stays_inside() {
        // Tiny screen smaller than the expanded panel.
        let tiny = (0.0, 0.0, 200.0, 200.0);
        let g = compute_pet_geometry("expanded", 96.0, Some((10.0, 10.0)), tiny);
        assert!(contains(&g, tiny));
        assert!(g.window_w <= 200.0 - 2.0 * PET_DEFAULT_MARGIN + 0.001);
    }
}
