use tauri::AppHandle;
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
