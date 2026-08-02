//! ThreadTerm iOS shell library.
//!
//! Registers only mobile-safe plugins. Desktop PTY / file / bridge-server
//! commands must never be linked into this crate.
//!
//! The secure WebSocket + Keychain + certificate fingerprint plugin is
//! implemented in Swift under `gen/apple` after `tauri ios init` on macOS.
//! See README.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

/// Placeholder command surface for the iOS shell.
/// Real secure transport commands are provided by the native plugin once
/// initialized on macOS/Xcode (`secure_pair`, `secure_connect`, `secure_send`,
/// `secure_forget`).
#[tauri::command]
fn mobile_shell_info() -> serde_json::Value {
    serde_json::json!({
        "kind": "ios_workspace_client",
        "desktopBackend": false,
        "securePlugin": cfg!(feature = "ios-secure-plugin"),
        "capabilities": ["terminal", "workspace_tabs", "files", "diff", "drafts", "leases"],
        "persistence": "keychain_token_and_ui_prefs_only",
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![mobile_shell_info])
        .setup(|app| {
            // Do not start desktop bridge server, PTY host, or filesystem watchers.
            log::info!(
                "ThreadTerm iOS shell starting (label={:?})",
                app.config().identifier
            );
            let _ = app.handle();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ThreadTerm iOS shell");
}
