use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub async fn notification_send_os(
    app: AppHandle,
    title: String,
    body: String,
    card_id: Option<String>,
) -> Result<(), String> {
    tracing::info!(
        title = %title,
        card_id = card_id.as_deref().unwrap_or(""),
        "dispatching OS notification"
    );

    let mut builder = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .sound("default")
        .auto_cancel();

    if let Some(card_id) = card_id {
        builder = builder.extra("cardId", card_id);
    }

    builder.show().map_err(|error| {
        tracing::warn!(error = %error, "failed to dispatch OS notification");
        error.to_string()
    })
}

/// Bring the main window to the foreground. Invoked after a system-notification
/// click (and in-app "recent notifications" jumps) so the card the user asked
/// for is actually visible, not buried behind other apps.
#[tauri::command]
pub async fn window_focus_main(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;

    // Windows restricts SetForegroundWindow for background processes — a plain
    // set_focus often only flashes the taskbar icon. Briefly toggling
    // always-on-top forces the window above the z-order before focusing, then
    // releases it so we don't pin over other apps. Best-effort: a failed
    // toggle must not abort the focus call.
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = window.set_always_on_top(true) {
            tracing::warn!(error = %error, "focus workaround: set_always_on_top(true) failed");
        }
    }

    let focus_result = window.set_focus().map_err(|e| e.to_string());

    #[cfg(target_os = "windows")]
    {
        if let Err(error) = window.set_always_on_top(false) {
            tracing::warn!(error = %error, "focus workaround: set_always_on_top(false) failed");
        }
    }

    focus_result
}
