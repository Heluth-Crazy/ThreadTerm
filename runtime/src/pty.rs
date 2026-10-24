use crate::{db::Database, job::SessionJob, output::OutputStore};
use anyhow::{anyhow, Context, Result};
#[cfg(not(windows))]
use portable_pty::CommandBuilder;
use portable_pty::{MasterPty, PtySize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Arc<LivePty>>>>,
    /// Sessions inside `launch`, not yet in `sessions`.
    starting: Arc<Mutex<HashSet<String>>>,
    output: Arc<OutputStore>,
}
/// Holds a session's place in `PtyManager::starting` for the duration of one launch.
struct Starting<'a> {
    starting: &'a Mutex<HashSet<String>>,
    id: String,
}
impl Drop for Starting<'_> {
    fn drop(&mut self) {
        if let Ok(mut starting) = self.starting.lock() {
            starting.remove(&self.id);
        }
    }
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
            starting: Arc::new(Mutex::new(HashSet::new())),
            output,
        }
    }
    /// Refuses a session that is live or already being launched. A second console for it would paint
    /// into the live session's output (clear screen, title) before the late check below refused it.
    fn reserve(&self, session_id: &str) -> Result<Starting<'_>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("PTY registry lock poisoned"))?;
        let mut starting = self
            .starting
            .lock()
            .map_err(|_| anyhow!("PTY registry lock poisoned"))?;
        if sessions.contains_key(session_id) || !starting.insert(session_id.to_owned()) {
            return Err(anyhow!("session already has a live PTY"));
        }
        Ok(Starting {
            starting: &self.starting,
            id: session_id.to_owned(),
        })
    }
    pub fn launch(
        &self,
        db: Arc<Database>,
        session_id: &str,
        cwd: &str,
        executable: Option<&str>,
        args: &[String],
    ) -> Result<()> {
        // Everything that can refuse the launch comes before the console is opened.
        let _starting = self.reserve(session_id)?;
        // Reject script launches whose arguments cannot survive cmd.exe quoting
        // here, before the bootstrap gate would hide the cause behind a timeout.
        #[cfg(windows)]
        if let Some(program) = executable {
            crate::providers::common::windows_script_invocation(program, args)?;
        }
        let pty_system = portable_pty::native_pty_system();
        // A resumed process must start in the geometry of the retained screen,
        // not draw its first frames at 80x24 into a differently-sized xterm.
        let session = db.session_by_id(session_id)?.context("session missing")?;
        let cols = session
            .cols
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n > 0)
            .unwrap_or(80);
        let rows = session
            .rows
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n > 0)
            .unwrap_or(24);
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("opening PTY")?;
        // The bundled console host waits ~3 s for an answer to its startup DA1 query: answer it before
        // the child starts, and keep that query from the clients (conpty.rs).
        let bundled_host = crate::conpty::active() == crate::conpty::Backend::Bundled;
        let mut writer = pair.master.take_writer().context("opening PTY writer")?;
        if bundled_host {
            writer.write_all(crate::conpty::DA1_REPLY).context("answering the console host")?;
            writer.flush().context("answering the console host")?;
        }
        db.set_session_terminal_size(session_id, i32::from(cols), i32::from(rows))?;
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
        // The user's current Windows environment rather than the long-lived runtime's
        // (environment.rs); the session's own variables below still win.
        crate::environment::apply(&mut command);
        if session.run.is_some() {
            crate::quick_launch::apply_environment(&db, session_id, &mut command)?;
        }
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
        #[cfg(all(test, windows))]
        crate::bootstrap::test_support::prepare_pty(&mut command);
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
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("opening PTY reader")?;
        db.set_session_status(session_id, "running", None)?;
        let output = Arc::clone(&self.output);
        let id = session_id.to_owned();
        let reader_db = Arc::clone(&db);
        let mut run_observer = session.run.as_ref().map(|_| crate::quick_launch::OutputObserver::default());
        let handle = thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                let mut startup = crate::conpty::StartupQueryFilter::new(bundled_host);
                // Storage failure policy (output.rs): a refused append keeps the
                // bytes pending and marks the terminal degraded, so the reader
                // keeps draining and the live view catches up once the database
                // accepts data again. Report the transition once, not per chunk.
                let mut storage_failure: Option<String> = None;
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(len) => {
                            let data = startup.feed(&buffer[..len]);
                            if let Some(observer) = run_observer.as_mut() {
                                if let Some(url) = observer.feed(&data) {
                                    let _ = crate::quick_launch::observe_output(&reader_db, &id, &url);
                                }
                                if observer.is_done() { run_observer = None; }
                            }
                            if !data.is_empty() {
                                match output.append(&reader_db, &id, &data) {
                                    Ok(_) => storage_failure = None,
                                    Err(error) => report_storage_failure(&mut storage_failure, &id, &error),
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                let rest = startup.finish();
                if let Some(observer) = run_observer.as_mut() {
                    if let Some(url) = observer.feed(&rest).or_else(|| observer.finish()) {
                        let _ = crate::quick_launch::observe_output(&reader_db, &id, &url);
                    }
                }
                if !rest.is_empty() {
                    if let Err(error) = output.append(&reader_db, &id, &rest) {
                        report_storage_failure(&mut storage_failure, &id, &error);
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
        // Unreachable while `reserve` holds the session; kept as the registry's own guard.
        if sessions.contains_key(session_id) {
            return Err(anyhow!("session already has a live PTY"));
        };
        sessions.insert(session_id.to_owned(), Arc::clone(&live));
        drop(sessions);
        let wait_sessions = Arc::clone(&self.sessions);
        let wait_id = session_id.to_owned();
        let setup_pty = self.clone();
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
            // A stop/relaunch can replace the registry entry before this
            // generation's waiter wakes up. Only the owning generation may
            // remove the entry or finalize the durable session state; an old
            // waiter must never mark a newly launched PTY exited.
            let mut finalized = false;
            if let Ok(mut registry) = wait_sessions.lock() {
                if registry
                    .get(&wait_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &live))
                {
                    // Keep ownership through the status write: stop must not
                    // release this id for relaunch between check and finalize.
                    match db.set_session_status(&wait_id, "exited", code) {
                        Ok(()) => finalized = true,
                        Err(error) => eprintln!("PTY exit for {wait_id} could not be finalized: {error}"),
                    }
                    registry.remove(&wait_id);
                }
            }
            if finalized {
                match crate::quick_launch::setup_terminal_exited(&db, &wait_id, code, false) {
                    Ok(Some(run_id)) => crate::quick_launch::start_next_setup_step(db, setup_pty, run_id),
                    Ok(None) => {},
                    Err(error) => eprintln!("Worktree setup exit for {wait_id} failed: {error}"),
                }
            }
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
            crate::quick_launch::setup_terminal_exited(db, session_id, None, true)?;
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
        crate::quick_launch::setup_terminal_exited(db, session_id, exit, true)?;
        Ok(())
    }
    pub fn terminate_all(&self, db: &Database) {
        if let Err(error) = crate::quick_launch::mark_setup_runs_interrupted(db) {
            eprintln!("Worktree setup shutdown recovery failed: {error}");
        }
        db.begin_shutdown();
        let mut sessions: Vec<_> = self
            .sessions
            .lock()
            .ok()
            .map(|mut registry| registry.drain().map(|(id, live)| (id, live, None)).collect())
            .unwrap_or_default();
        // Every terminal gets the interrupt before we wait on a single shared grace period.
        // Removing ownership first fences the normal exit waiters from finalizing these sessions.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        for (_, live, _) in &sessions {
            if let Ok(mut writer) = live.writer.lock() {
                let _ = writer.write_all(&[3]);
                let _ = writer.flush();
            }
        }
        loop {
            for (_, live, exit) in &mut sessions {
                if exit.is_none() {
                    if let Ok(mut child) = live.child.lock() {
                        if let Ok(Some(status)) = child.try_wait() {
                            *exit = Some(status.exit_code() as i32);
                        }
                    }
                }
            }
            if sessions.iter().all(|(_, _, exit)| exit.is_some()) || std::time::Instant::now() >= deadline {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        for (id, live, exit) in sessions {
            if exit.is_none() {
                if let Ok(mut job) = live.job.lock() {
                    drop(job.take());
                }
                if let Ok(mut child) = live.child.lock() {
                    let _ = child.kill();
                }
            }
            // Never wait on a reader or a killed child during runtime teardown.
            if let Err(error) = db.set_session_status(&id, "exited", exit) {
                eprintln!("PTY shutdown for {id} could not be finalized: {error}");
            }
            if let Err(error) = crate::quick_launch::setup_terminal_exited(db, &id, exit, true) {
                eprintln!("Worktree setup shutdown for {id} failed: {error}");
            }
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
/// Reports the first failed durable append of one stretch of storage failure.
fn report_storage_failure(seen: &mut Option<String>, session_id: &str, error: &anyhow::Error) {
    if seen.is_some() {
        return;
    }
    let message = error.to_string();
    eprintln!("Terminal output for {session_id} could not be saved: {message}");
    *seen = Some(message);
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

    #[cfg(windows)]
    #[test]
    fn windows_script_receives_args_verbatim_through_bootstrap_pty() {
        use crate::providers::common::windows_script_fixtures::{
            fixture_dir, parse_echo_output, strip_ansi,
        };
        let (_root, script) = fixture_dir();
        let cwd = script.parent().unwrap().to_string_lossy().into_owned();
        // ConPTY may transcode non-ASCII output depending on the host codepage,
        // so this path asserts the ASCII matrix; the plain-command and managed
        // service tests cover non-ASCII arguments with explicit OEM decoding.
        let args = vec![
            "with space".to_owned(),
            "a&b|c<d>e".to_owned(),
            "caret^bang!".to_owned(),
            "--session".to_owned(),
            "ses_0123456789".to_owned(),
        ];
        let db = Arc::new(Database::open(&script.with_file_name("pty.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "pty-script-args",
            })
            .unwrap();
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        manager
            .launch(
                Arc::clone(&db),
                &session.id,
                &cwd,
                Some(&script.to_string_lossy()),
                &args,
            )
            .unwrap();
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            output.clear();
            for (_, bytes) in db.output_from(&session.id, 0, 64 * 1024).unwrap() {
                output.extend(bytes);
            }
            if strip_ansi(&String::from_utf8_lossy(&output)).contains("DONE") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // ConPTY pads repainted rows with spaces; none of the matrix arguments
        // end in a space, so trim that rendering artifact before comparing.
        let parsed: Vec<String> = parse_echo_output(&strip_ansi(&String::from_utf8_lossy(&output)))
            .into_iter()
            .map(|value| value.trim_end().to_owned())
            .collect();
        assert_eq!(&parsed[..args.len()], args.as_slice());
        manager.stop(&db, &session.id, true).ok();
    }

    #[cfg(windows)]
    #[test]
    fn windows_script_launch_rejects_unsafe_args_before_the_gate() {
        use crate::providers::common::windows_script_fixtures::fixture_dir;
        let (_root, script) = fixture_dir();
        let cwd = script.parent().unwrap().to_string_lossy().into_owned();
        let db = Arc::new(Database::open(&script.with_file_name("pty-reject.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "pty-script-reject",
            })
            .unwrap();
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        let error = manager
            .launch(
                Arc::clone(&db),
                &session.id,
                &cwd,
                Some(&script.to_string_lossy()),
                &["%PATH%".to_owned()],
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("'%'"),
            "unexpected error: {error}"
        );
    }

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

    /// The desktop starts the runtime detached, i.e. in a new process group, which ignores Ctrl+C —
    /// and that is inherited by every process it starts. The PTY bootstrap must hand the terminal's
    /// program normal Ctrl+C handling back, or Ctrl+C cannot stop a running command.
    #[cfg(windows)]
    #[test]
    fn ctrl_c_interrupts_a_running_command_even_when_the_runtime_ignores_it() {
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe { SetConsoleCtrlHandler(None, 0) };
            }
        }
        unsafe { SetConsoleCtrlHandler(None, 1) }; // like the detached runtime
        let _restore = Restore;
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession { project_id: None, title: None, provider: "shell", mode: "terminal", native_id: None, operation_id: "pty-ctrl-c" })
            .unwrap();
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        let args = ["/d".to_owned(), "/k".to_owned(), "prompt READY$G".to_owned()];
        manager.launch(Arc::clone(&db), &session.id, dir.path().to_str().unwrap(), Some("cmd.exe"), &args).unwrap();
        let text = || {
            let mut output = Vec::new();
            for (_, bytes) in db.output_from(&session.id, 0, 1024 * 1024).unwrap() {
                output.extend(bytes);
            }
            String::from_utf8_lossy(&output).into_owned()
        };
        let wait = |check: &dyn Fn(&str) -> bool, what: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !check(&text()) {
                assert!(Instant::now() < deadline, "{what}; output: {}", text());
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        wait(&|output| output.contains("READY>"), "cmd prompt did not appear");
        manager.input(&session.id, b"ping -n 30 127.0.0.1\r").unwrap();
        wait(&|output| output.matches("127.0.0.1").count() >= 4, "ping did not start");
        manager.input(&session.id, b"\x03").unwrap();
        // The prompt comes back long before ping's 30 seconds are over.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let output = text();
            let after_ping = output.rfind("127.0.0.1").map(|at| &output[at..]).unwrap_or("");
            if after_ping.contains("READY>") {
                break;
            }
            assert!(Instant::now() < deadline, "Ctrl+C did not interrupt ping; output: {output}");
            std::thread::sleep(Duration::from_millis(50));
        }
        manager.stop(&db, &session.id, true).unwrap();
    }

    /// A refused second launch used to start its own console first, whose opening frame (clear
    /// screen, title) landed in the live session's output (tests/pty_lifecycle.rs found it).
    #[cfg(windows)]
    #[test]
    fn a_second_launch_for_a_live_session_is_refused_before_it_opens_a_console() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession { project_id: None, title: None, provider: "shell", mode: "terminal", native_id: None, operation_id: "pty-twice" })
            .unwrap();
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        let cwd = dir.path().to_str().unwrap();
        let args = ["/d".to_owned(), "/k".to_owned(), "prompt READY$G".to_owned()];
        manager.launch(Arc::clone(&db), &session.id, cwd, Some("cmd.exe"), &args).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let text = || {
            let output: Vec<u8> = db.output_from(&session.id, 0, 1 << 20).unwrap().into_iter().flat_map(|(_, bytes)| bytes).collect();
            String::from_utf8_lossy(&output).into_owned()
        };
        while !text().contains("READY>") {
            assert!(Instant::now() < deadline, "cmd prompt did not appear");
            std::thread::sleep(Duration::from_millis(50));
        }
        let before = db.output_end(&session.id).unwrap();
        let error = manager.launch(Arc::clone(&db), &session.id, cwd, Some("cmd.exe"), &args).unwrap_err();
        assert!(error.to_string().contains("already has a live PTY"), "{error:#}");
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(db.output_end(&session.id).unwrap(), before, "the refused launch wrote into the live session: {:?}", text());
        assert!(manager.live(&session.id).is_ok());
        manager.stop(&db, &session.id, true).unwrap();
    }

    /// F23: a refused durable append used to end the PTY reader silently. The
    /// reader now keeps draining, the session stays live, and recording resumes
    /// from the unchanged cursor once storage accepts data again.
    #[test]
    fn a_storage_failure_keeps_the_reader_draining_and_marks_the_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession { project_id: None, title: None, provider: "shell", mode: "terminal", native_id: None, operation_id: "pty-storage-degraded" })
            .unwrap();
        // Cursor 0 is occupied, so the reader's first durable append is refused.
        db.append_output(&session.id, 0, b"occupied").unwrap();
        let output = Arc::new(OutputStore::default());
        let manager = PtyManager::new(Arc::clone(&output));
        #[cfg(windows)]
        let (program, args) = (
            "cmd.exe",
            vec!["/Q".to_owned(), "/K".to_owned(), "prompt READY$G".to_owned()],
        );
        #[cfg(not(windows))]
        let (program, args) = (
            "/bin/sh",
            vec!["-c".to_owned(), "printf 'READY>'; read line; printf 'AFTER-MARKER'".to_owned()],
        );
        manager
            .launch(Arc::clone(&db), &session.id, dir.path().to_str().unwrap(), Some(program), &args)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while db.terminal_storage_degraded(&session.id).unwrap().is_none() {
            assert!(Instant::now() < deadline, "the refused append was not reported");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(db.session_by_id(&session.id).unwrap().unwrap().status, "running", "a storage failure must not end the session");
        assert!(manager.live(&session.id).is_ok());
        // Storage recovers, then the live process writes again.
        db.transaction(|tx| {
            tx.execute("DELETE FROM output_chunks WHERE session_id=?", [&session.id])?;
            Ok(())
        })
        .unwrap();
        #[cfg(windows)]
        let input = b"echo AFTER-MARKER\r".to_vec();
        #[cfg(not(windows))]
        let input = b"go\n".to_vec();
        manager.input(&session.id, &input).unwrap();
        let text = || {
            let bytes: Vec<u8> = db.output_from(&session.id, 0, 1 << 20).unwrap().into_iter().flat_map(|(_, data)| data).collect();
            String::from_utf8_lossy(&bytes).into_owned()
        };
        while !text().contains("AFTER-MARKER") {
            assert!(Instant::now() < deadline, "the reader stopped draining after a storage failure: {:?}", text());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(db.terminal_storage_degraded(&session.id).unwrap().is_none(), "recording must resume without keeping the degraded marker");
        manager.stop(&db, &session.id, true).unwrap();
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

    #[cfg(windows)]
    #[test]
    fn shutdown_stops_idle_terminals_with_one_grace_and_no_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        let mut ids = Vec::new();
        for index in 0..3 {
            let session = db.create_session(CreateSession {
                project_id: None, title: None, provider: "shell", mode: "terminal",
                native_id: None, operation_id: &format!("shutdown-{index}"),
            }).unwrap();
            manager.launch(Arc::clone(&db), &session.id, dir.path().to_str().unwrap(),
                Some("cmd.exe"), &["/Q".into(), "/K".into(), "prompt READY$G".into()]).unwrap();
            ids.push(session.id);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        for id in &ids {
            loop {
                let output: Vec<u8> = db.output_from(id, 0, 1 << 20).unwrap()
                    .into_iter().flat_map(|(_, bytes)| bytes).collect();
                if String::from_utf8_lossy(&output).contains("READY>") { break; }
                assert!(Instant::now() < deadline, "idle shell did not become ready");
                thread::sleep(Duration::from_millis(20));
            }
        }
        let started = Instant::now();
        manager.terminate_all(&db);
        assert!(started.elapsed() < Duration::from_secs(4), "shutdown took {:?}", started.elapsed());
        for id in &ids {
            assert_eq!(db.session_by_id(id).unwrap().unwrap().status, "exited");
            assert!(manager.live(id).is_err());
        }
        assert!(db.snapshot().unwrap().inbox.is_empty());
        // Shutdown quieting belongs to this database, never to other runtimes in the process.
        let other = Database::open(&dir.path().join("other.sqlite")).unwrap();
        let session = other.create_session(CreateSession {
            project_id: None, title: None, provider: "shell", mode: "terminal",
            native_id: None, operation_id: "ordinary-failure",
        }).unwrap();
        other.set_session_status(&session.id, "exited", Some(1)).unwrap();
        assert_eq!(other.snapshot().unwrap().inbox.len(), 1);
    }

    #[test]
    fn old_waiter_cannot_finalize_a_relaunched_session() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open(&dir.path().join("runtime.sqlite")).unwrap());
        let session = db
            .create_session(CreateSession {
                project_id: None,
                title: None,
                provider: "shell",
                mode: "terminal",
                native_id: None,
                operation_id: "relaunch-race",
            })
            .unwrap();
        let manager = PtyManager::new(Arc::new(OutputStore::default()));
        #[cfg(windows)]
        let (program, args) = ("cmd.exe", vec!["/Q".to_owned(), "/K".to_owned()]);
        #[cfg(not(windows))]
        let (program, args) = ("/bin/sh", vec![]);
        db.set_session_terminal_size(&session.id, 117, 37).unwrap();
        for _ in 0..4 {
            manager
                .launch(
                    Arc::clone(&db),
                    &session.id,
                    dir.path().to_str().unwrap(),
                    Some(program),
                    &args,
                )
                .unwrap();
            let size = manager
                .live(&session.id)
                .unwrap()
                .master
                .lock()
                .unwrap()
                .get_size()
                .unwrap();
            assert_eq!(
                (size.cols, size.rows),
                (117, 37),
                "relaunch changed the recorded geometry"
            );
            manager.stop(&db, &session.id, true).unwrap();
        }
        manager
            .launch(
                Arc::clone(&db),
                &session.id,
                dir.path().to_str().unwrap(),
                Some(program),
                &args,
            )
            .unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            db.session_by_id(&session.id).unwrap().unwrap().status,
            "running"
        );
        assert!(manager.live(&session.id).is_ok());
        manager
            .input(&session.id, b"echo RELAUNCHED_OK\r\n")
            .unwrap();
        manager.stop(&db, &session.id, true).unwrap();
    }
}
