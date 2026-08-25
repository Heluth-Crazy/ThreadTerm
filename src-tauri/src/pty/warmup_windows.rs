use portable_pty::{Child, CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::path::PathBuf;
use std::time::Instant;

#[cfg(not(feature = "terminal-startup-harness"))]
use super::warmup::reap_with_deadlines;
#[cfg(feature = "terminal-startup-harness")]
use super::warmup::reap_with_deadlines_observed;
use super::warmup::{ChildPoll, ChildProbe, Coordinator, WarmupStatus};

struct PortableChild<'a>(&'a mut dyn Child);

fn is_disk_or_verbatim_disk_path(text: &str) -> bool {
    let disk = text.strip_prefix("\\\\?\\").unwrap_or(text);
    disk.len() >= 3
        && disk.as_bytes()[0].is_ascii_alphabetic()
        && disk.as_bytes()[1] == b':'
        && disk.as_bytes()[2] == b'\\'
        && (!text.starts_with("\\\\") || text.starts_with("\\\\?\\"))
        && !text.starts_with("\\\\?\\UNC\\")
        && !text.starts_with("\\\\?\\unc\\")
        && !text.starts_with("\\\\.\\")
        && !text.contains('/')
}

fn canonical_system_cmd_path() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR"))?;
    let candidate = PathBuf::from(root).join("System32").join("cmd.exe");
    let canonical = std::fs::canonicalize(candidate).ok()?;
    let text = canonical.to_str()?;
    let basename = canonical.file_name()?.to_str()?;
    (canonical.is_file()
        && is_disk_or_verbatim_disk_path(text)
        && basename.eq_ignore_ascii_case("cmd.exe"))
    .then_some(canonical)
}

impl ChildProbe for PortableChild<'_> {
    fn try_wait(&mut self) -> ChildPoll {
        match self.0.try_wait() {
            Ok(Some(_)) => ChildPoll::Exited,
            Ok(None) => ChildPoll::Running,
            Err(_) => ChildPoll::Error,
        }
    }

    fn kill(&mut self) -> bool {
        self.0.kill().is_ok()
    }
}

pub(super) fn run(coordinator: &Coordinator) {
    #[cfg(feature = "terminal-startup-harness")]
    {
        crate::terminal_startup_warmup_harness::record_native_spawn_attempt();
        if crate::terminal_startup_warmup_harness::should_fail_spawn() {
            crate::terminal_startup_warmup_harness::record_native_spawn_failure();
            coordinator.set_status(WarmupStatus::Failed);
            tracing::debug!("ConPTY warmup failed");
            return;
        }
    }
    let pty_system = NativePtySystem::default();
    let size = PtySize {
        rows: 1,
        cols: 1,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = match pty_system.openpty(size) {
        Ok(pair) => pair,
        Err(_) => {
            coordinator.set_status(WarmupStatus::Failed);
            #[cfg(feature = "terminal-startup-harness")]
            crate::terminal_startup_warmup_harness::record_native_spawn_failure();
            tracing::debug!("ConPTY warmup failed");
            return;
        }
    };
    // Warmup is a fixed system primitive, not an interactive shell choice.
    // Pin it to a canonical System32 executable so a poisoned PATH cannot
    // redirect this background create. Production behavior otherwise remains
    // unchanged.
    let Some(cmd_path) = canonical_system_cmd_path() else {
        coordinator.set_status(WarmupStatus::Failed);
        tracing::debug!("ConPTY warmup failed");
        return;
    };
    let mut command = CommandBuilder::new(cmd_path);
    #[cfg(feature = "terminal-startup-harness")]
    if crate::terminal_startup_warmup_harness::should_never_exit() {
        // `pause` is a fixed, local cmd primitive.  The PTY remains alive
        // until the bounded lifecycle asks it to terminate and then confirms
        // exit through `try_wait`.
        command.args(["/d", "/q", "/c", "pause >nul"]);
    } else {
        command.args(["/d", "/q", "/c", "exit"]);
    }
    #[cfg(not(feature = "terminal-startup-harness"))]
    command.args(["/d", "/q", "/c", "exit"]);
    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(_) => {
            drop(pair);
            coordinator.set_status(WarmupStatus::Failed);
            #[cfg(feature = "terminal-startup-harness")]
            crate::terminal_startup_warmup_harness::record_native_spawn_failure();
            tracing::debug!("ConPTY warmup failed");
            return;
        }
    };
    drop(pair.slave);
    coordinator.set_status(WarmupStatus::Waiting);
    #[cfg(feature = "terminal-startup-harness")]
    crate::terminal_startup_warmup_harness::record_child_spawned();
    #[cfg(feature = "terminal-startup-harness")]
    let observation = {
        let mut probe = PortableChild(child.as_mut());
        reap_with_deadlines_observed(&mut probe, Instant::now, std::thread::sleep)
    };
    #[cfg(not(feature = "terminal-startup-harness"))]
    let status = {
        let mut probe = PortableChild(child.as_mut());
        reap_with_deadlines(&mut probe, Instant::now, std::thread::sleep)
    };
    drop(pair.master);
    drop(child);
    #[cfg(feature = "terminal-startup-harness")]
    let status = observation.status;
    #[cfg(feature = "terminal-startup-harness")]
    crate::terminal_startup_warmup_harness::record_reap(
        match status {
            WarmupStatus::Completed => {
                crate::terminal_startup_warmup_harness::WarmupHarnessStatus::Completed
            }
            WarmupStatus::TimedOut => {
                crate::terminal_startup_warmup_harness::WarmupHarnessStatus::TimedOut
            }
            _ => crate::terminal_startup_warmup_harness::WarmupHarnessStatus::Failed,
        },
        observation.kill_attempted,
        observation.reap_confirmed,
        observation.reap_timed_out,
    );
    coordinator.set_status(status);
    let status_name = match status {
        WarmupStatus::Skipped => "skipped",
        WarmupStatus::Spawning => "spawning",
        WarmupStatus::Waiting => "waiting",
        WarmupStatus::Completed => "completed",
        WarmupStatus::Failed => "failed",
        WarmupStatus::TimedOut => "timedOut",
    };
    tracing::debug!(status = status_name, "ConPTY warmup");
}
