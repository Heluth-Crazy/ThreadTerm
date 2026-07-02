use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{window::Color, WebviewWindow};

const MATERIAL_ENV: &str = "THREADTERM_PLATFORM_MATERIAL";
const VITE_MATERIAL_ENV: &str = "VITE_THREADTERM_PLATFORM_MATERIAL";
static MATERIAL_APPLIED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum NativePlatform {
    Macos,
    Windows,
    Linux,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PlatformMaterialState {
    enabled: bool,
    platform: NativePlatform,
}

#[tauri::command]
pub fn native_platform_material_state() -> PlatformMaterialState {
    PlatformMaterialState {
        enabled: platform_material_enabled()
            && platform_supports_material()
            && MATERIAL_APPLIED.load(Ordering::Relaxed),
        platform: current_platform(),
    }
}

pub fn apply_to_main_window(window: &WebviewWindow) {
    if window.label() != "main" {
        return;
    }

    if !platform_material_enabled() {
        MATERIAL_APPLIED.store(false, Ordering::Relaxed);
        tracing::info!("Platform material gate disabled; keeping default main-window visuals");
        return;
    }

    if !platform_supports_material() {
        MATERIAL_APPLIED.store(false, Ordering::Relaxed);
        let _ = apply_platform_material(window);
        return;
    }

    make_webview_transparent(window);

    if let Err(error) = window.set_background_color(Some(Color(0, 0, 0, 0))) {
        tracing::warn!(error = %error, "Failed to make main webview background transparent");
    }

    match apply_platform_material(window) {
        Ok(()) => {
            MATERIAL_APPLIED.store(true, Ordering::Relaxed);
            tracing::info!(platform = ?current_platform(), "Platform material applied to main window")
        }
        Err(error) => {
            MATERIAL_APPLIED.store(false, Ordering::Relaxed);
            tracing::warn!(error = %error, "Platform material unavailable; keeping CSS fallback")
        }
    }
}

fn platform_material_enabled() -> bool {
    let values: Vec<Option<String>> = [MATERIAL_ENV, VITE_MATERIAL_ENV]
        .iter()
        .map(|key| std::env::var(key).ok())
        .collect();
    material_enabled_from_env(&values, default_material_enabled())
}

/// Windows defaults material OFF: transparent windows force WebView2 into the
/// slower visuals-based composition path, which measurably degrades terminal
/// and diff scrolling and inflates the GPU process. macOS vibrancy is
/// window-server native and effectively free, so it stays default ON.
#[cfg(target_os = "windows")]
fn default_material_enabled() -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
fn default_material_enabled() -> bool {
    true
}

/// Resolves the material gate from env values against the platform default.
/// Disable wins over enable; an explicit enable token overrides a default-off
/// platform; unset/unknown values fall through to the default.
fn material_enabled_from_env(values: &[Option<String>], default_enabled: bool) -> bool {
    let tokens: Vec<&str> = values.iter().filter_map(|value| value.as_deref()).collect();
    if tokens.iter().any(|value| env_value_disables(value)) {
        return false;
    }
    if tokens.iter().any(|value| env_value_enables(value)) {
        return true;
    }
    default_enabled
}

fn env_value_disables(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "no"
    )
}

fn env_value_enables(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "yes"
    )
}

#[cfg(target_os = "macos")]
fn current_platform() -> NativePlatform {
    NativePlatform::Macos
}

#[cfg(target_os = "windows")]
fn current_platform() -> NativePlatform {
    NativePlatform::Windows
}

#[cfg(target_os = "linux")]
fn current_platform() -> NativePlatform {
    NativePlatform::Linux
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn current_platform() -> NativePlatform {
    NativePlatform::Unknown
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_supports_material() -> bool {
    true
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_supports_material() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn apply_platform_material(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    apply_vibrancy(
        window,
        NSVisualEffectMaterial::WindowBackground,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        None,
    )
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn make_webview_transparent(window: &WebviewWindow) {
    if let Err(error) = window.with_webview(|webview| unsafe {
        use objc2_foundation::{ns_string, NSNumber, NSObjectNSKeyValueCoding};
        use objc2_web_kit::WKWebView;

        let view: &WKWebView = &*webview.inner().cast();
        let no = NSNumber::numberWithBool(false);
        view.setValue_forKey(Some(&no), ns_string!("drawsBackground"));
    }) {
        tracing::warn!(error = %error, "Failed to disable WKWebView drawsBackground");
    }
}

#[cfg(not(target_os = "macos"))]
fn make_webview_transparent(_window: &WebviewWindow) {}

#[cfg(target_os = "windows")]
fn apply_platform_material(window: &WebviewWindow) -> Result<(), String> {
    use window_vibrancy::{apply_acrylic, apply_mica};

    match apply_mica(window, None) {
        Ok(()) => Ok(()),
        Err(mica_error) => {
            tracing::warn!(error = %mica_error, "Mica unavailable; trying acrylic fallback");
            apply_acrylic(window, Some((24, 24, 24, 180))).map_err(|acrylic_error| {
                format!("mica failed: {mica_error}; acrylic fallback failed: {acrylic_error}")
            })
        }
    }
}

#[cfg(target_os = "linux")]
fn apply_platform_material(_window: &WebviewWindow) -> Result<(), String> {
    tracing::info!("Platform material is a Linux no-op; compositor support varies by desktop");
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn apply_platform_material(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{env_value_disables, env_value_enables, material_enabled_from_env};

    #[test]
    fn recognizes_disable_tokens() {
        for value in ["0", "false", "FALSE", "off", "no", " no "] {
            assert!(env_value_disables(value));
        }
    }

    #[test]
    fn does_not_treat_enable_or_unknown_tokens_as_disable() {
        for value in ["", "1", "true", "on", "yes", "material"] {
            assert!(!env_value_disables(value));
        }
    }

    #[test]
    fn recognizes_enable_tokens() {
        for value in ["1", "true", "TRUE", "on", "yes", " yes "] {
            assert!(env_value_enables(value));
        }
    }

    #[test]
    fn follows_platform_default_when_no_env_set() {
        assert!(material_enabled_from_env(&[None, None], true));
        assert!(!material_enabled_from_env(&[None, None], false));
    }

    #[test]
    fn explicit_enable_overrides_default_off() {
        for value in ["1", "true", "on", "yes"] {
            assert!(material_enabled_from_env(
                &[Some(value.to_string()), None],
                false
            ));
        }
    }

    #[test]
    fn unknown_values_fall_through_to_default() {
        assert!(material_enabled_from_env(
            &[Some("material".to_string()), None],
            true
        ));
        assert!(!material_enabled_from_env(
            &[Some("material".to_string()), None],
            false
        ));
    }

    #[test]
    fn disabled_when_any_env_explicitly_off() {
        for value in ["0", "false", "off", "no"] {
            assert!(!material_enabled_from_env(
                &[Some(value.to_string()), None],
                true
            ));
        }
    }

    #[test]
    fn disable_wins_when_one_key_off_and_other_unset() {
        assert!(!material_enabled_from_env(
            &[Some("0".to_string()), None],
            true
        ));
        assert!(!material_enabled_from_env(
            &[None, Some("false".to_string())],
            true
        ));
    }

    #[test]
    fn disable_wins_over_enable() {
        assert!(!material_enabled_from_env(
            &[Some("1".to_string()), Some("off".to_string())],
            true
        ));
    }
}
