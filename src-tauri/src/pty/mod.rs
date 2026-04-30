//! PTY session management.
//!
//! This module is split into:
//! - [`session`]: the `PtySession` struct, state-machine helpers and
//!   shared timing constants.
//! - [`registry`]: the global session map and lookup helpers.
//! - [`events`]: regex-based pattern matching, the background output
//!   reader and the idle-state watcher.
//! - [`shell`]: platform-specific shell selection and PATH plumbing.
//!
//! Only the items re-exported here form ThreadTerm's public PTY surface.

mod events;
mod registry;
mod session;
mod shell;

pub use registry::list_live_sessions;
pub use session::{LivePtySessionSnapshot, SessionState};

use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{Manager, Window};

use session::{
    OUTPUT_BUFFER_MAX_BYTES, PtySession, RESIZE_OUTPUT_ACTIVITY_SUPPRESS,
    clear_waiting_for_input, mark_killed, suppress_output_activity_for,
};

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Create a new PTY session and begin streaming output.
#[tauri::command]
pub async fn pty_create(
    id: String,
    working_dir: String,
    rows: u16,
    cols: u16,
    window: Window,
) -> Result<String, String> {
    if registry::contains(&id) {
        tracing::debug!(id = %id, "pty_create: id already bound, returning existing session");
        return Ok(id);
    }

    let pty_system = NativePtySystem::default();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let shell_path = shell::default_shell();
    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.cwd(&working_dir);
    shell::configure_shell_command(&mut cmd, &shell_path);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Drop the slave so reads on master detect EOF when the child exits.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        _working_dir: working_dir,
        state: RwLock::new(SessionState::Idle),
        app_handle: window.app_handle().clone(),
        output_buffer: RwLock::new(String::with_capacity(
            OUTPUT_BUFFER_MAX_BYTES.min(8192),
        )),
        last_output_at: Mutex::new(None),
        last_size: Mutex::new((rows, cols)),
        suppress_output_activity_until: Mutex::new(None),
        killed: AtomicBool::new(false),
    });

    if let Err(rejected) = registry::insert_if_absent(id.clone(), session.clone()) {
        // Idempotent: if a PTY with this id already exists (e.g. a
        // second webview — typically the floating-terminal overlay —
        // mounted xterm for the same card while the main window's
        // Shell was still alive), kill the redundant child we just
        // spawned (avoids a fork leak) and return Ok(id). The caller
        // attaches to the existing session's `pty-output` broadcast
        // via the listen API, so no state is lost.
        if let Ok(mut c) = rejected.child.lock() {
            let _ = c.kill();
        }
        tracing::debug!(id = %id, "pty_create: id already bound, returning existing session");
        return Ok(id);
    }

    // Spawn a background thread to read PTY output and emit events. The
    // session remains Idle until bytes actually flow from the PTY.
    events::spawn_output_idle_watcher(id.clone(), session.clone());
    let stream_id = id.clone();
    let stream_session = session.clone();
    let handle = window.app_handle().clone();
    std::thread::spawn(move || {
        events::stream_pty_output(stream_id, reader, stream_session, handle);
    });

    tracing::info!(id = %id, shell = %shell_path, "PTY session created");
    Ok(id)
}

/// Write data (keystrokes) to a PTY session.
#[tauri::command]
pub async fn pty_input(id: String, data: String) -> Result<(), String> {
    let session = registry::get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

    // User input clears the waiting state; the session becomes Running only
    // once the PTY emits output again.
    clear_waiting_for_input(&session, &id);

    let mut writer = session
        .writer
        .lock()
        .map_err(|e| format!("Failed to lock PTY writer: {e}"))?;

    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {e}"))?;

    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {e}"))?;

    Ok(())
}

/// Resize a PTY session.
#[tauri::command]
pub async fn pty_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let session = registry::get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

    {
        let mut last_size = session
            .last_size
            .lock()
            .map_err(|e| format!("Failed to lock PTY size: {e}"))?;
        if *last_size == (rows, cols) {
            return Ok(());
        }
        *last_size = (rows, cols);
    }

    suppress_output_activity_for(&session, RESIZE_OUTPUT_ACTIVITY_SUPPRESS);

    let master = session
        .master
        .lock()
        .map_err(|e| format!("Failed to lock PTY master: {e}"))?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {e}"))?;

    Ok(())
}

/// Kill a PTY session and clean up resources.
#[tauri::command]
pub async fn pty_kill(id: String) -> Result<(), String> {
    if let Some(session) = registry::remove(&id) {
        mark_killed(&session);
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
        // Drop the Arc<PtySession> — when the reader thread also drops its
        // clone the master fd is closed and the reader gets EOF.
        drop(session);
        tracing::info!(id = %id, "PTY session killed");
        Ok(())
    } else {
        Err(format!("PTY session '{}' not found", id))
    }
}

/// Get the current state of a PTY session.
#[tauri::command]
pub async fn pty_get_session_state(pty_id: String) -> Result<SessionState, String> {
    let session = registry::get(&pty_id)
        .ok_or_else(|| format!("PTY session '{}' not found", pty_id))?;

    session
        .state
        .read()
        .map(|s| s.clone())
        .map_err(|e| format!("Failed to read session state: {e}"))
}

/// Read recent output for a live PTY session so a second webview can render
/// context immediately after attaching instead of looking like a fresh shell.
#[tauri::command]
pub async fn pty_get_recent_output(pty_id: String) -> Result<Option<String>, String> {
    Ok(get_recent_output(&pty_id))
}

/// Read the recent output buffer for a PTY session.
pub fn get_recent_output(pty_id: &str) -> Option<String> {
    let session = registry::get(pty_id)?;
    let buf = session.output_buffer.read().ok()?;
    if buf.is_empty() {
        None
    } else {
        Some(buf.clone())
    }
}

// Tests preserved verbatim from the pre-split `pty.rs` live in
// `pty/tests.rs` so that `cargo test pty::tests` (ROADMAP baseline) keeps
// resolving to the same set of cases. Submodules carry their own
// additional tests.
#[cfg(test)]
mod tests;
