use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const SETTINGS_WINDOW_LABEL: &str = "settings";
const SETTINGS_OPEN_EVENT: &str = "settings://open";

#[derive(Clone, Serialize)]
struct SettingsOpenPayload {
    tab: &'static str,
}

fn normalize_settings_tab(value: &str) -> &'static str {
    match value {
        "appearance" => "appearance",
        "supervisor" => "supervisor",
        "data" => "data",
        _ => "shortcuts",
    }
}

fn focus_settings_window(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[tauri::command]
pub async fn settings_open(app: tauri::AppHandle, tab: String) -> Result<(), String> {
    let tab = normalize_settings_tab(&tab);
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        app.emit_to(
            SETTINGS_WINDOW_LABEL,
            SETTINGS_OPEN_EVENT,
            SettingsOpenPayload { tab },
        )
        .map_err(|error| format!("Could not route the settings tab: {error}"))?;
        focus_settings_window(&window);
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        &app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(format!("settings.html?tab={tab}").into()),
    )
    .title("ThreadTerm Settings")
    .inner_size(960.0, 720.0)
    .min_inner_size(760.0, 520.0)
    .resizable(true)
    .decorations(true)
    .transparent(false)
    .center()
    .visible(true)
    .focused(true)
    .skip_taskbar(false);
    let builder = crate::data_directory::apply_webview_data_directory(&app, builder);
    let window = builder
        .build()
        .map_err(|error| format!("Could not create the settings window: {error}"))?;
    focus_settings_window(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_settings_tab;

    #[test]
    fn only_accepts_known_settings_tabs() {
        assert_eq!(normalize_settings_tab("appearance"), "appearance");
        assert_eq!(normalize_settings_tab("supervisor"), "supervisor");
        assert_eq!(normalize_settings_tab("data"), "data");
        assert_eq!(normalize_settings_tab("missing?injected=true"), "shortcuts");
    }
}
