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

mod emulator;
mod events;
mod registry;
mod session;
mod shell;
mod utf8;

pub use registry::list_live_sessions;
pub use session::{LivePtySessionSnapshot, PtyAttachSnapshot, SessionState};

/// Snapshot a single live PTY session by id (used by the bridge to build a
/// `CardMeta` for incremental card-added broadcasts). Returns `None` when no
/// session is registered for `id`.
pub fn live_session_snapshot(id: &str) -> Option<LivePtySessionSnapshot> {
    registry::live_session_snapshot(id)
}

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{Manager, Window};

use session::{
    clear_waiting_for_input, mark_killed, suppress_output_activity_for, PtySession,
    OUTPUT_BUFFER_MAX_BYTES, RESIZE_OUTPUT_ACTIVITY_SUPPRESS, SESSION_SCROLLBACK_LINES,
};

/// Serializes PTY open+spawn so concurrent terminal creation can't race ConPTY
/// initialization — a known source of Windows blank/stall on rapid open/close
/// or multi-card spawn. Cheap and harmless elsewhere (spawns are infrequent).
static PTY_SPAWN_LOCK: Mutex<()> = Mutex::new(());

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

    // Resolve the shell before taking the spawn lock: the first Windows call
    // probes PATH via `where` (~1.3s total) and must not serialize concurrent
    // card creation behind it. Subsequent calls hit the cached Lazy value.
    let shell_path = shell::default_shell();

    // Serialize ConPTY/PTY open+spawn across concurrent terminal creations
    // (Windows blank/stall mitigation; harmless on other platforms). The lock
    // is held only around open+spawn, then released before the rest of setup.
    let (pair, child) = {
        let _spawn_guard = PTY_SPAWN_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());

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

        let mut cmd = CommandBuilder::new(&shell_path);
        // Windows: normalize forward slashes so ConPTY resolves the cwd reliably.
        #[cfg(target_os = "windows")]
        cmd.cwd(shell::normalize_windows_cwd(&working_dir));
        #[cfg(not(target_os = "windows"))]
        cmd.cwd(&working_dir);
        shell::configure_shell_command(&mut cmd, &shell_path);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {e}"))?;
        (pair, child)
    };

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
        output_buffer: RwLock::new(String::with_capacity(OUTPUT_BUFFER_MAX_BYTES.min(8192))),
        output_seq: Mutex::new(0),
        unacked_bytes: Mutex::new(0),
        snapshot: Mutex::new(emulator::TerminalSnapshot::new(
            rows,
            cols,
            SESSION_SCROLLBACK_LINES,
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

    // The session is now in the registry. Tell connected mobile clients
    // about the new card so the desktop/mobile session lists stay in sync
    // without waiting for a reconnect snapshot. Pure addition: desktop
    // behaviour is unchanged.
    crate::bridge::broadcast_card_added(&id);

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
    let session = registry::get(&id).ok_or_else(|| format!("PTY session '{}' not found", id))?;

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

    session::mark_input_activity(&session, &id);

    Ok(())
}

/// Resize a PTY session.
#[tauri::command]
pub async fn pty_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let session = registry::get(&id).ok_or_else(|| format!("PTY session '{}' not found", id))?;

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

    if let Ok(mut snapshot) = session.snapshot.lock() {
        snapshot.resize(rows, cols);
    }

    Ok(())
}

/// Kill a PTY session and clean up resources.
#[tauri::command]
pub async fn pty_kill(id: String) -> Result<(), String> {
    if let Some(session) = registry::remove(&id) {
        mark_killed(&session);
        // Snapshot the session *before* dropping it so the bridge can build
        // a full CardMeta for the removal broadcast (the session has already
        // left the registry, so a fresh lookup would fail). This explicit
        // close path also covers the mobile close entry
        // (bridge::server.rs -> pty_kill). Natural process exit
        // (events.rs) is intentionally NOT touched: exited cards stay
        // visible as completed/failed, matching desktop behaviour.
        let removed_snapshot = registry::live_session_snapshot_from(&id, &session);
        if let Ok(mut child) = session.child.lock() {
            // Windows: kill the whole process tree first so grandchildren
            // (sub-shells, node, git, …) don't orphan after close. `child.kill()`
            // alone only terminates the direct ConPTY child.
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                if let Some(pid) = child.process_id() {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                        .output();
                }
            }
            let _ = child.kill();
        }
        // Drop the Arc<PtySession> — when the reader thread also drops its
        // clone the master fd is closed and the reader gets EOF.
        drop(session);
        if let Some(snapshot) = removed_snapshot {
            crate::bridge::broadcast_card_removed(snapshot);
        }
        tracing::info!(id = %id, "PTY session killed");
        Ok(())
    } else {
        Err(format!("PTY session '{}' not found", id))
    }
}

/// Get the current state of a PTY session.
#[tauri::command]
pub async fn pty_get_session_state(pty_id: String) -> Result<SessionState, String> {
    let session =
        registry::get(&pty_id).ok_or_else(|| format!("PTY session '{}' not found", pty_id))?;

    session
        .state
        .read()
        .map(|s| s.clone())
        .map_err(|e| format!("Failed to read session state: {e}"))
}

/// Get the states of all live PTY sessions in a single call.
///
/// Audit P2-5: the frontend's cross-webview reconciliation poll used to call
/// `pty_get_session_state` once per card every cycle (N cards = N IPC
/// round-trips). This batch command returns `{ id → SessionState }` so the
/// poll costs one IPC regardless of card count; ids missing from the map
/// mean the PTY is no longer registered.
#[tauri::command]
pub async fn pty_get_all_session_states() -> Result<HashMap<String, SessionState>, String> {
    Ok(registry::all_session_states())
}

/// Read recent output for a live PTY session so a second webview can render
/// context immediately after attaching instead of looking like a fresh shell.
#[tauri::command]
pub async fn pty_get_recent_output(pty_id: String) -> Result<Option<String>, String> {
    Ok(get_recent_output(&pty_id))
}

#[tauri::command]
pub async fn pty_attach_snapshot(pty_id: String) -> Result<Option<PtyAttachSnapshot>, String> {
    Ok(attach_snapshot_for_bridge(&pty_id))
}

pub fn attach_snapshot_for_bridge(pty_id: &str) -> Option<PtyAttachSnapshot> {
    let session = registry::get(pty_id)?;
    Some(session::attach_snapshot(pty_id, &session))
}

#[tauri::command]
pub async fn pty_ack(id: String, count: usize) -> Result<(), String> {
    let Some(session) = registry::get(&id) else {
        return Ok(());
    };
    session::subtract_unacked(&session, count);
    Ok(())
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
