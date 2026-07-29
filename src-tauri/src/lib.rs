mod agent_sessions;
#[cfg(feature = "mobile-bridge")]
mod bridge;
#[cfg(not(feature = "mobile-bridge"))]
#[path = "bridge_disabled.rs"]
mod bridge;
mod claude_chat;
mod codex_app;
mod db;
mod files;
mod git;
mod local_directory;
mod notification;
mod overlay;
mod platform_material;
mod provider_sessions;
pub mod pty;
mod service_child;
mod stats;
mod supervisor;

use tauri::Manager;

pub fn run() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&["selector", "float"])
                .with_filter(|label| label == "main" || label == "settings")
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    let run_result = builder
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
            overlay::register_default_shortcuts(app.handle());
            overlay::prewarm_windows(app.handle());
            supervisor::init(app.handle().clone());
            bridge::set_app_handle(app.handle().clone());
            bridge::restore_bridge_on_startup();
            if let Some(window) = app.get_webview_window("main") {
                platform_material::apply_to_main_window(&window);
            }

            tracing::info!("ThreadTerm Tauri backend ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            supervisor::supervisor_enable,
            git::git_branch_overview,
            git::git_file_diff,
            git::git_file_text_diff,
            git::git_status,
            git::git_worktree_add,
            git::git_worktree_list,
            files::read_directory,
            files::workspace_read_file,
            files::workspace_write_file,
            local_directory::open_local_directory,
            pty::pty_create,
            pty::pty_input,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_get_session_state,
            pty::pty_get_all_session_states,
            pty::pty_get_recent_output,
            pty::pty_attach_snapshot,
            pty::pty_register_output_consumer,
            pty::pty_unregister_output_consumer,
            pty::pty_ack,
            notification::notification_send_os,
            notification::window_focus_main,
            provider_sessions::provider_find_recent_session,
            provider_sessions::provider_list_recent_sessions,
            provider_sessions::provider_resolve_resume_session,
            agent_sessions::provider_list_agent_sessions,
            stats::stats_compute,
            stats::stats_cancel,
            stats::stats_rebuild,
            platform_material::native_platform_material_state,
            bridge::bridge_start,
            bridge::bridge_stop,
            bridge::bridge_status,
            bridge::bridge_has_subscribers,
            bridge::bridge_pair_qr,
            bridge::bridge_devices,
            bridge::bridge_revoke_device,
            bridge::bridge_sync_cards,
            bridge::bridge_sync_state,
            bridge::bridge_resolve_mobile_spawn,
            bridge::bridge_resolve_mobile_activate,
            bridge::bridge_resolve_mobile_close,
            bridge::bridge_resolve_mobile_rename_card,
            bridge::bridge_broadcast_theme,
            claude_chat::claude_chat_probe,
            claude_chat::claude_chat_start,
            claude_chat::claude_chat_send,
            claude_chat::claude_chat_interrupt,
            claude_chat::claude_chat_set_model,
            claude_chat::claude_chat_set_permission_mode,
            claude_chat::claude_chat_decision,
            claude_chat::claude_chat_stop,
            claude_chat::claude_chat_history,
            codex_app::codex_app_status,
            codex_app::codex_app_open_card,
            codex_app::codex_app_send_message,
            codex_app::codex_app_respond_request,
            codex_app::codex_app_interrupt,
            codex_app::codex_app_compact,
            codex_app::codex_app_set_goal,
            codex_app::codex_app_list_skills,
            overlay::overlay_show_selector,
            overlay::overlay_hide_selector,
            overlay::overlay_show_float,
            overlay::overlay_hide_float,
            overlay::overlay_show_main,
            overlay::overlay_save_float_bounds,
            overlay::overlay_set_float_launch_mode,
            overlay::overlay_set_lightweight_mode,
            overlay::overlay_get_settings,
            overlay::overlay_update_shortcut,
        ])
        .run(tauri::generate_context!());
    let audit = db::shutdown_audit_writer(std::time::Duration::from_secs(2));
    if audit.failed > 0 || audit.dropped > 0 || audit.pending > 0 || audit.shutdown_timeouts > 0 {
        tracing::warn!(
            written = audit.written,
            failed = audit.failed,
            dropped = audit.dropped,
            pending = audit.pending,
            shutdown_timeouts = audit.shutdown_timeouts,
            "Audit writer exited with incomplete metadata"
        );
    }
    run_result.expect("error while running tauri application");
}
