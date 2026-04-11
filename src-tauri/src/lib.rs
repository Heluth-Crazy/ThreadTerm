mod auth;
mod db;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Structured logging via tracing
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|_app| {
            db::init_database().map_err(|e| {
                tracing::error!(error = %e, "Database initialisation failed");
                e.to_string()
            })?;
            tracing::info!("OpenWork Tauri backend ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // PTY
            pty::pty_create,
            pty::pty_input,
            pty::pty_resize,
            pty::pty_kill,
            // Auth
            auth::auth_login,
            auth::auth_register,
            auth::auth_verify,
            auth::auth_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
