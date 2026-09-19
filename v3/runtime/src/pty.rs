use crate::{db::Database, job::SessionJob, output::OutputStore};
use anyhow::{anyhow, Context, Result};
#[cfg(not(windows))]
use portable_pty::CommandBuilder;
use portable_pty::{MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Arc<LivePty>>>>,
    output: Arc<OutputStore>,
}
struct LivePty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
    exit_code: Mutex<Option<i32>>,
    // Taking this ownership boundary closes the Windows Job immediately,
    // terminating only this session's assigned descendant tree.
    job: Mutex<Option<SessionJob>>,
    _reader: thread::JoinHandle<()>,
}
impl PtyManager {
    pub fn new(output: Arc<OutputStore>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            output,
        }
    }
    pub fn launch(
        &self,
        db: Arc<Database>,
        session_id: &str,
        cwd: &str,
        executable: Option<&str>,
        args: &[String],
    ) -> Result<()> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("opening PTY")?;
        #[cfg(windows)]
        let gate = crate::bootstrap::BootstrapGate::new()?;
        #[cfg(windows)]
        let mut command = gate.command(executable.unwrap_or(default_shell()), args, cwd)?;
        #[cfg(not(windows))]
        let mut command = {
            let mut command = CommandBuilder::new(executable.unwrap_or(default_shell()));
            command.cwd(cwd);
            for arg in args {
                command.arg(arg);
            }
            command
        };
        if db
            .session_by_id(session_id)?
            .is_some_and(|session| session.provider == "grok")
        {
            for (name, value) in
                crate::providers::network::grok_env_for_settings(&db.settings_value()?)?
            {
                command.env(name, value);
            }
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .context("launching PTY child")?;
        let pid = child
            .process_id()
            .context("PTY child did not expose a process id")?;
        let job = match SessionJob::assign(pid) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        #[cfg(windows)]
        if let Err(error) = gate.release(pid) {
            let _ = child.kill();
            return Err(error);
        }
        let writer = pair.master.take_writer().context("opening PTY writer")?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("opening PTY reader")?;
        db.set_session_status(session_id, "running", None)?;
        let output = Arc::clone(&self.output);
        let id = session_id.to_owned();
        let reader_db = Arc::clone(&db);
        let handle = thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(len) => {
                            if output.append(&reader_db, &id, &buffer[..len]).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })?;
        let live = Arc::new(LivePty {
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            exit_code: Mutex::new(None),
            job: Mutex::new(Some(job)),
            _reader: handle,
        });
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("PTY registry lock poisoned"))?;
        if sessions.contains_key(session_id) {
            return Err(anyhow!("session already has a live PTY"));
        };
        sessions.insert(session_id.to_owned(), Arc::clone(&live));
        drop(sessions);
        let wait_sessions = Arc::clone(&self.sessions);
        let wait_id = session_id.to_owned();
        thread::spawn(move || {
            // Never hold the child mutex across a blocking wait: stop must be
            // able to issue its bounded force fallback while the child runs.
            let code = loop {
                let status = live
                    .child
                    .lock()
                    .map_err(|_| ())
                    .and_then(|mut child| child.try_wait().map_err(|_| ()));
                match status {
                    Ok(Some(status)) => break Some(status.exit_code() as i32),
                    Ok(None) => thread::sleep(std::time::Duration::from_millis(20)),
                    Err(()) => break None,
                }
            };
            if let Ok(mut exit) = live.exit_code.lock() {
                *exit = code;
            }
            if let Ok(mut registry) = wait_sessions.lock() {
                registry.remove(&wait_id);
            }
            let _ = db.set_session_status(&wait_id, "exited", code);
        });
        Ok(())
    }
    pub fn input(&self, session_id: &str, data: &[u8]) -> Result<()> {
        let live = self.live(session_id)?;
        let mut writer = live
            .writer
            .lock()
            .map_err(|_| anyhow!("PTY writer lock poisoned"))?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(anyhow!("invalid terminal size"));
        };
        let live = self.live(session_id)?;
        live.master
            .lock()
            .map_err(|_| anyhow!("PTY master lock poisoned"))?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(())
    }
    pub fn stop(&self, db: &Database, session_id: &str, force: bool) -> Result<()> {
        let live = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("PTY registry lock poisoned"))?
            .remove(session_id)
            .ok_or_else(|| anyhow!("session has no live PTY"))?;
        if force {
            // Drop the per-session Job before returning. On Windows this kills
            // the full process tree; elsewhere child.kill below is the native
            // immediate process boundary. Do not wait for the reader/waiter.
            let job = live
                .job
                .lock()
                .map_err(|_| anyhow!("PTY Job lock poisoned"))?
                .take();
            drop(job);
            if let Ok(mut child) = live.child.lock() {
                let _ = child.kill();
            }
            db.set_session_status(session_id, "exited", None)?;
            return Ok(());
        }
        // A cooperative interrupt gives shells and native agents a bounded
        // opportunity to flush; explicit stop falls back to the session Job.
        if let Ok(mut writer) = live.writer.lock() {
            let _ = writer.write_all(&[3]);
            let _ = writer.flush();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut exit = None;
        while std::time::Instant::now() < deadline {
            exit = *live
                .exit_code
                .lock()
                .map_err(|_| anyhow!("PTY exit lock poisoned"))?;
            if exit.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if exit.is_none() {
            let mut child = live
                .child
                .lock()
                .map_err(|_| anyhow!("PTY child lock poisoned"))?;
            child.kill()?;
            exit = Some(child.wait()?.exit_code() as i32);
        }
        db.set_session_status(session_id, "exited", exit)?;
        Ok(())
    }
    pub fn terminate_all(&self, db: &Database) {
        let ids: Vec<_> = self
            .sessions
            .lock()
            .ok()
            .map(|v| v.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            let _ = self.stop(db, &id, false);
        }
    }
    fn live(&self, id: &str) -> Result<Arc<LivePty>> {
        self.sessions
            .lock()
            .map_err(|_| anyhow!("PTY registry lock poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("session is not running"))
    }
}
fn default_shell() -> &'static str {
    if cfg!(windows) {
        "cmd.exe"
    } else {
        "/bin/sh"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateSession;
    use std::time::{Duration, Instant};

    #[test]
    fn captures_real_shell_output() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "pty-smoke",
            })
            .unwrap();
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        #[cfg(windows)]
        let (program, args) = (
            "cmd.exe",
            vec!["/C".to_owned(), "echo threadterm-pty-smoke".to_owned()],
        );
        #[cfg(not(windows))]
        let (program, args) = (
            "/bin/sh",
            vec!["-c".to_owned(), "printf threadterm-pty-smoke".to_owned()],
        );
        manager
            .launch(
                Arc::clone(&db),
                &session.id,
                dir.path().to_str().unwrap(),
                Some(program),
                &args,
            )
            .unwrap();
        let mut output = Vec::new();
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(50));
            for (_, bytes) in db.output_from(&session.id, 0, 64 * 1024).unwrap() {
                output.extend(bytes);
            }
            if String::from_utf8_lossy(&output).contains("threadterm-pty-smoke") {
                return;
            }
            output.clear();
        }
        panic!("PTY did not capture shell output");
    }

    #[test]
    fn force_stop_returns_immediately_and_leaves_other_sessions_live() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        let first = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "force-first",
            })
            .unwrap();
        let second = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "force-second",
            })
            .unwrap();
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        #[cfg(windows)]
        let (program, args) = (
            "cmd.exe",
            vec!["/C".to_owned(), "ping -n 20 127.0.0.1 > nul".to_owned()],
        );
        #[cfg(not(windows))]
        let (program, args) = ("/bin/sh", vec!["-c".to_owned(), "sleep 20".to_owned()]);
        for session in [&first, &second] {
            manager
                .launch(
                    Arc::clone(&db),
                    &session.id,
                    dir.path().to_str().unwrap(),
                    Some(program),
                    &args,
                )
                .unwrap();
        }
        let started = Instant::now();
        manager.stop(&db, &first.id, true).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            db.session_by_id(&first.id).unwrap().unwrap().status,
            "exited"
        );
        assert!(
            manager.live(&second.id).is_ok(),
            "force stop must not remove another session"
        );
        manager.stop(&db, &second.id, true).unwrap();
    }
}
