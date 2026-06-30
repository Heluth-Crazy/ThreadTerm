use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

/// How the floating terminal window opens after a card is picked from the
/// selector. Persisted as `overlay.float_launch_mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FloatLaunchMode {
    /// Borderless 900×560 (or last-saved bounds) picture-in-picture window.
    #[default]
    Floating,
    /// Fill the work area (keeps the OS window frame off — float is frameless).
    Maximized,
    /// True fullscreen (covers the taskbar).
    Fullscreen,
}

impl FloatLaunchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            FloatLaunchMode::Floating => "floating",
            FloatLaunchMode::Maximized => "maximized",
            FloatLaunchMode::Fullscreen => "fullscreen",
        }
    }

    pub fn from_value(s: &str) -> Option<Self> {
        match s {
            "floating" => Some(FloatLaunchMode::Floating),
            "maximized" => Some(FloatLaunchMode::Maximized),
            "fullscreen" => Some(FloatLaunchMode::Fullscreen),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlaySettings {
    pub hotkey_a: String,
    pub hotkey_b: String,
    pub float_bounds: Option<FloatBounds>,
    #[serde(default)]
    pub float_launch_mode: FloatLaunchMode,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            hotkey_a: "CmdOrCtrl+Shift+Space".to_string(),
            hotkey_b: "CmdOrCtrl+Shift+O".to_string(),
            float_bounds: None,
            float_launch_mode: FloatLaunchMode::Floating,
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
pub(super) static OVERLAY_SETTINGS: Lazy<Mutex<OverlaySettings>> =
    Lazy::new(|| Mutex::new(OverlaySettings::default()));

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
    if let Ok(Some(v)) = crate::db::get_setting("overlay.float_launch_mode") {
        if let Some(mode) = FloatLaunchMode::from_value(&v) {
            out.float_launch_mode = mode;
        }
    }
    // Poison-tolerant: a panic in another short critical section must not
    // permanently disable overlay settings. Recover the inner data instead.
    *OVERLAY_SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = out.clone();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_use_documented_accelerators() {
        let s = OverlaySettings::default();
        assert_eq!(s.hotkey_a, "CmdOrCtrl+Shift+Space");
        assert_eq!(s.hotkey_b, "CmdOrCtrl+Shift+O");
        assert!(s.float_bounds.is_none());
    }

    #[test]
    fn poisoned_settings_mutex_is_still_recoverable() {
        // D2: a panic inside a critical section poisons std::sync::Mutex.
        // The hardened `.lock().unwrap_or_else(|e| e.into_inner())` pattern
        // must still hand back the inner data so overlay settings keep
        // working instead of cascading panics forever.
        let lock = std::sync::Mutex::new(OverlaySettings::default());

        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock().unwrap();
            panic!("simulated panic inside the critical section");
        }));
        assert!(poisoned.is_err());
        assert!(lock.is_poisoned());

        // Plain `.lock().unwrap()` would propagate the poison and panic.
        // The poison-tolerant pattern recovers the inner data unchanged.
        let recovered = lock.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(recovered.hotkey_a, "CmdOrCtrl+Shift+Space");
        assert_eq!(recovered.hotkey_b, "CmdOrCtrl+Shift+O");
    }

    #[test]
    fn float_bounds_round_trip_through_json() {
        let bounds = FloatBounds {
            x: 100.0,
            y: 200.0,
            w: 800.0,
            h: 600.0,
        };
        let json = serde_json::to_string(&bounds).unwrap();
        let parsed: FloatBounds = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.x, 100.0);
        assert_eq!(parsed.y, 200.0);
        assert_eq!(parsed.w, 800.0);
        assert_eq!(parsed.h, 600.0);
    }
}
