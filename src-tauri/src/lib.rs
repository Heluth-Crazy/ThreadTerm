mod ai;
mod auth;
mod db;
mod fs_commands;
mod git;
mod handoff;
mod health;
mod http_server;
mod projects;
mod pty;
mod session_history;
mod skills;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Structured logging via tracing
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            db::init_database().map_err(|e| {
                tracing::error!(error = %e, "Database initialisation failed");
                e.to_string()
            })?;

            // Start the HTTP/WS server in the background (non-blocking).
            let handle = app.handle().clone();
            tokio::spawn(http_server::start_http_server(handle));

            tracing::info!("OpenWork Tauri backend ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // PTY
            pty::pty_create,
            pty::pty_input,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_get_session_state,
            // Auth
            auth::auth_login,
            auth::auth_register,
            auth::auth_verify,
            auth::auth_logout,
            // Projects
            projects::projects_list,
            projects::projects_get,
            projects::projects_add,
            projects::projects_remove,
            projects::projects_update_session_name,
            // AI
            ai::ai_start_session,
            ai::ai_send_message,
            ai::ai_abort_session,
            ai::ai_approve_tool,
            ai::ai_list_sessions,
            ai::settings_get_ai_config,
            // Git
            git::git_status,
            git::git_diff,
            git::git_log,
            git::git_branches,
            git::git_stage,
            git::git_commit,
            git::git_checkout_branch,
            git::git_create_branch,
            git::git_pull,
            git::git_push,
            git::git_worktree_list,
            git::git_worktree_add,
            git::git_worktree_remove,
            // File system & settings
            fs_commands::fs_list_dir,
            fs_commands::fs_read_file,
            fs_commands::fs_write_file,
            fs_commands::fs_delete_file,
            fs_commands::settings_get_all,
            fs_commands::settings_set,
            // Session history
            session_history::session_list,
            session_history::session_messages,
            // File system extras
            fs_commands::fs_read_file_base64,
            fs_commands::get_app_version,
            // Health
            health::health_check,
            // Skills
            skills::skills_list,
            skills::skills_read,
            skills::skills_create,
            skills::skills_update,
            skills::skills_delete,
            // Handoff
            handoff::handoff_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
