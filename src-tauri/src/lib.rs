mod ai_explain;
mod bridge;
mod db;
mod notification;
mod overlay;
mod provider_sessions;
pub mod pty;
mod shell_integration;

#[cfg(test)]
mod shell_integration_tests;

pub fn run() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == overlay::PluginShortcutState::Pressed {
                        overlay::dispatch_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .setup(|app| {
            db::init_database().map_err(|e| {
                tracing::error!(error = %e, "Database initialisation failed");
                e.to_string()
            })?;

            overlay::load_settings();
            overlay::register_default_shortcuts(&app.handle());
            overlay::prewarm_windows(&app.handle());

            tracing::info!("ThreadTerm Tauri backend ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_explain::ai_explain,
            pty::pty_create,
            pty::pty_input,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_get_session_state,
            pty::pty_get_recent_output,
            pty::pty_attach_snapshot,
            pty::pty_ack,
            pty::set_command_blocks_enabled,
            pty::get_command_blocks_enabled,
            notification::notification_send_os,
            provider_sessions::provider_find_recent_session,
            shell_integration::detect_shell,
            shell_integration::preview_shell_integration,
            shell_integration::install_shell_integration,
            shell_integration::uninstall_shell_integration,
            bridge::bridge_start,
            bridge::bridge_stop,
            bridge::bridge_status,
            bridge::bridge_pair_qr,
            bridge::bridge_devices,
            bridge::bridge_revoke_device,
            overlay::overlay_show_selector,
            overlay::overlay_hide_selector,
            overlay::overlay_show_float,
            overlay::overlay_hide_float,
            overlay::overlay_show_main,
            overlay::overlay_save_float_bounds,
            overlay::overlay_get_settings,
            overlay::overlay_update_shortcut,
            overlay::overlay_move_float,
            overlay::overlay_resize_float,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
