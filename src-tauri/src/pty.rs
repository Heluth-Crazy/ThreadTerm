use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use once_cell::sync::Lazy;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Window};

/// Global map of active PTY sessions.
static PTY_SESSIONS: Lazy<DashMap<String, Arc<PtySession>>> = Lazy::new(DashMap::new);

/// Represents a live PTY session.
/// All interior-mutable fields are protected by Mutex so the struct is Sync.
struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    _working_dir: String,
}

// Safety: every non-Sync field is behind a Mutex.
unsafe impl Sync for PtySession {}

/// Payload emitted on `pty-output` events.
#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

/// Payload emitted on `pty-exit` events.
#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
    code: Option<u32>,
}

/// Returns the default shell for the current platform.
fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        if which_exists("powershell.exe") {
            "powershell.exe".to_string()
        } else {
            "cmd.exe".to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    }
}

#[cfg(target_os = "windows")]
fn which_exists(name: &str) -> bool {
    std::process::Command::new("where")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create a new PTY session and begin streaming output.
#[tauri::command]
pub async fn pty_create(
    id: String,
    working_dir: String,
    rows: u16,
    cols: u16,
    window: Window,
) -> Result<String, String> {
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

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&working_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("FORCE_COLOR", "3");

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
    });

    let session_for_stream = session.clone();
    match PTY_SESSIONS.entry(id.clone()) {
        Entry::Occupied(_) => {
            if let Ok(mut c) = session.child.lock() {
                let _ = c.kill();
            }
            return Err(format!("PTY session '{}' already exists", id));
        }
        Entry::Vacant(e) => {
            e.insert(session);
        }
    }

    // Spawn a background thread to read PTY output and emit events.
    let stream_id = id.clone();
    std::thread::spawn(move || {
        stream_pty_output(stream_id, reader, session_for_stream, window);
    });

    tracing::info!(id = %id, shell = %shell, "PTY session created");
    Ok(id)
}

/// Background reader: reads chunks from the PTY and emits Tauri events.
fn stream_pty_output(
    id: String,
    mut reader: Box<dyn Read + Send>,
    session: Arc<PtySession>,
    window: Window,
) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF – child exited
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = window.emit(
                    "pty-output",
                    PtyOutputPayload {
                        id: id.clone(),
                        data,
                    },
                );
            }
            Err(e) => {
                tracing::warn!(id = %id, error = %e, "PTY read error");
                break;
            }
        }
    }

    // Determine exit code.
    let code = session
        .child
        .lock()
        .ok()
        .and_then(|mut child| {
            child.wait().ok().map(|status| {
                if status.success() { 0u32 } else { 1u32 }
            })
        });

    let _ = window.emit(
        "pty-exit",
        PtyExitPayload {
            id: id.clone(),
            code,
        },
    );

    // Remove session from map.
    PTY_SESSIONS.remove(&id);
    tracing::info!(id = %id, "PTY session ended");
}

/// Write data (keystrokes) to a PTY session.
#[tauri::command]
pub async fn pty_input(id: String, data: String) -> Result<(), String> {
    let session = PTY_SESSIONS
        .get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

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

/// Write to a PTY session whose key matches the given prefix (for session lookup).
pub fn write_to_session_by_prefix(prefix: &str, data: &str) -> Result<(), String> {
    // Collect key first, drop DashMap read reference before acquiring Mutex
    let key = PTY_SESSIONS
        .iter()
        .find(|e| e.key() == prefix || e.key().starts_with(prefix))
        .map(|e| e.key().clone());

    let key = key.ok_or_else(|| format!("No PTY session found for: {prefix}"))?;

    let session = PTY_SESSIONS.get(&key)
        .ok_or_else(|| format!("PTY session disappeared: {key}"))?;

    let mut writer = session.writer.lock()
        .map_err(|e| format!("lock error: {e}"))?;
    writer.write_all(data.as_bytes())
        .map_err(|e| format!("write error: {e}"))?;
    writer.flush()
        .map_err(|e| format!("flush error: {e}"))?;
    Ok(())
}

/// Resize a PTY session.
#[tauri::command]
pub async fn pty_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let session = PTY_SESSIONS
        .get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

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
    if let Some((_, session)) = PTY_SESSIONS.remove(&id) {
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

/// Create a PTY session running a specific command (used by ai.rs).
pub fn create_command_pty(
    id: String,
    working_dir: String,
    program: &str,
    args: &[&str],
    rows: u16,
    cols: u16,
    window: Window,
) -> Result<String, String> {
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

    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.cwd(&working_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("FORCE_COLOR", "3");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

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
    });

    let session_for_stream = session.clone();
    match PTY_SESSIONS.entry(id.clone()) {
        Entry::Occupied(_) => {
            if let Ok(mut c) = session.child.lock() {
                let _ = c.kill();
            }
            return Err(format!("PTY session '{}' already exists", id));
        }
        Entry::Vacant(e) => {
            e.insert(session);
        }
    }

    let stream_id = id.clone();
    std::thread::spawn(move || {
        stream_pty_output(stream_id, reader, session_for_stream, window);
    });

    tracing::info!(id = %id, program = %program, "Command PTY session created");
    Ok(id)
}
