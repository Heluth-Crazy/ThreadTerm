use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::service_child::{spawn_managed_service_child, ManagedServiceChild};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy)]
pub(crate) struct BackgroundCommandLimits {
    pub(crate) timeout: Duration,
    pub(crate) stdout_bytes: usize,
    pub(crate) stderr_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackgroundCommandError {
    MissingCli,
    TimedOut,
    OutputTooLarge(&'static str),
    Io(std::io::ErrorKind),
    ReaderFailed,
}

pub(crate) struct BackgroundCommandOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
}

pub(crate) fn background_cli_command(name: &str) -> Command {
    #[cfg(windows)]
    let program = resolve_windows_cli_program(name).unwrap_or_else(|| PathBuf::from(name));
    #[cfg(not(windows))]
    let program = PathBuf::from(name);

    background_cli_command_for_program(program)
}

fn background_cli_command_for_program(program: PathBuf) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub(crate) async fn run_background_cli(
    name: &str,
    args: &[&str],
    limits: BackgroundCommandLimits,
) -> Result<BackgroundCommandOutput, BackgroundCommandError> {
    let mut command = background_cli_command(name);
    command.args(args);
    run_background_command(command, limits).await
}

async fn run_background_command(
    mut command: Command,
    limits: BackgroundCommandLimits,
) -> Result<BackgroundCommandOutput, BackgroundCommandError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_managed_service_child(command).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            BackgroundCommandError::MissingCli
        } else {
            BackgroundCommandError::Io(error.kind())
        }
    })?;
    let stdout = child
        .stdout()
        .take()
        .ok_or(BackgroundCommandError::ReaderFailed)?;
    let stderr = child
        .stderr()
        .take()
        .ok_or(BackgroundCommandError::ReaderFailed)?;
    let (overflow_tx, mut overflow_rx) = mpsc::unbounded_channel();
    let stdout_task = tokio::spawn(drain_capped(
        stdout,
        limits.stdout_bytes,
        "stdout",
        overflow_tx.clone(),
    ));
    let stderr_task = tokio::spawn(drain_capped(
        stderr,
        limits.stderr_bytes,
        "stderr",
        overflow_tx,
    ));

    enum Completion {
        Finished(Result<ExitStatus, std::io::Error>),
        Overflow(&'static str),
        TimedOut,
    }

    let completion = tokio::select! {
        status = child.wait() => Completion::Finished(status),
        stream = overflow_rx.recv() => Completion::Overflow(stream.unwrap_or("output")),
        _ = tokio::time::sleep(limits.timeout) => Completion::TimedOut,
    };

    let status = match completion {
        Completion::Finished(status) => {
            status.map_err(|error| BackgroundCommandError::Io(error.kind()))?
        }
        Completion::Overflow(stream) => {
            terminate_background_child(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(BackgroundCommandError::OutputTooLarge(stream));
        }
        Completion::TimedOut => {
            terminate_background_child(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(BackgroundCommandError::TimedOut);
        }
    };

    let (stdout, stdout_overflow) = stdout_task
        .await
        .map_err(|_| BackgroundCommandError::ReaderFailed)?
        .map_err(|error| BackgroundCommandError::Io(error.kind()))?;
    let (_stderr, stderr_overflow) = stderr_task
        .await
        .map_err(|_| BackgroundCommandError::ReaderFailed)?
        .map_err(|error| BackgroundCommandError::Io(error.kind()))?;
    if stdout_overflow {
        return Err(BackgroundCommandError::OutputTooLarge("stdout"));
    }
    if stderr_overflow {
        return Err(BackgroundCommandError::OutputTooLarge("stderr"));
    }

    Ok(BackgroundCommandOutput { status, stdout })
}

async fn drain_capped<R>(
    mut reader: R,
    limit: usize,
    stream: &'static str,
    overflow_tx: mpsc::UnboundedSender<&'static str>,
) -> Result<(Vec<u8>, bool), std::io::Error>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut chunk = [0u8; 8 * 1024];
    let mut overflow = false;
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..read.min(remaining)]);
        if read > remaining && !overflow {
            overflow = true;
            let _ = overflow_tx.send(stream);
        }
    }
    Ok((bytes, overflow))
}

async fn terminate_background_child(child: &mut ManagedServiceChild) {
    child.terminate();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

pub(crate) fn is_safe_session_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(windows)]
pub(crate) fn resolve_windows_cli_program(name: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        roots.extend(std::env::split_paths(&path));
    }
    resolve_windows_cli_program_from_roots(name, &roots)
}

#[cfg(windows)]
fn resolve_windows_cli_program_from_roots(name: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    const WINDOWS_EXECUTABLE_SUFFIXES: &[&str] = &["exe", "com", "cmd", "bat", ""];

    for suffix in WINDOWS_EXECUTABLE_SUFFIXES {
        for root in roots {
            let candidate = if suffix.is_empty() {
                root.join(name)
            } else {
                root.join(format!("{name}.{suffix}"))
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_reject_shell_metacharacters() {
        assert!(is_safe_session_id("ses_abc-123.4:5"));
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("session & whoami"));
        assert!(!is_safe_session_id("%COMSPEC%"));
    }

    #[test]
    #[ignore]
    fn background_command_test_child() {
        match std::env::var("THREADTERM_BACKGROUND_COMMAND_TEST").as_deref() {
            Ok("output") => {
                use std::io::Write as _;
                let bytes = vec![b'x'; 256 * 1024];
                std::io::stdout().write_all(&bytes).expect("write output");
            }
            Ok("sleep") => {
                std::thread::sleep(Duration::from_millis(600));
                if let Some(marker) = std::env::var_os("THREADTERM_BACKGROUND_COMMAND_MARKER") {
                    std::fs::write(marker, b"survived").expect("write marker");
                }
            }
            _ => {}
        }
    }

    fn test_child_command(mode: &str) -> Command {
        let mut command = background_cli_command_for_program(
            std::env::current_exe().expect("current test executable"),
        );
        command.args([
            "--ignored",
            "--exact",
            "agent_sessions::process::tests::background_command_test_child",
            "--nocapture",
        ]);
        command.env("THREADTERM_BACKGROUND_COMMAND_TEST", mode);
        command
    }

    #[tokio::test]
    async fn bounded_command_kills_a_timed_out_child() {
        let marker = std::env::temp_dir().join(format!(
            "threadterm-background-timeout-marker-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&marker);
        let mut command = test_child_command("sleep");
        command.env("THREADTERM_BACKGROUND_COMMAND_MARKER", &marker);
        let result = run_background_command(
            command,
            BackgroundCommandLimits {
                timeout: Duration::from_millis(100),
                stdout_bytes: 64 * 1024,
                stderr_bytes: 64 * 1024,
            },
        )
        .await;
        assert!(matches!(result, Err(BackgroundCommandError::TimedOut)));
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(!marker.exists(), "timed-out child was still able to write");
        let _ = std::fs::remove_file(marker);
    }

    #[tokio::test]
    async fn bounded_command_stops_on_oversized_stdout() {
        let result = run_background_command(
            test_child_command("output"),
            BackgroundCommandLimits {
                timeout: Duration::from_secs(5),
                stdout_bytes: 1024,
                stderr_bytes: 64 * 1024,
            },
        )
        .await;
        assert!(matches!(
            result,
            Err(BackgroundCommandError::OutputTooLarge("stdout"))
        ));
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        use std::fs;
        use std::sync::atomic::{AtomicU64, Ordering};

        static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

        fn temp_root() -> PathBuf {
            let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            std::env::temp_dir().join(format!(
                "threadterm-background-cli-{}-{id}",
                std::process::id()
            ))
        }

        #[test]
        fn resolver_prefers_native_executable_over_npm_shim() {
            let root = temp_root();
            fs::create_dir_all(&root).expect("mkdir");
            let exe = root.join("agent.exe");
            let cmd = root.join("agent.cmd");
            fs::write(&exe, []).expect("exe");
            fs::write(&cmd, "@echo off\r\n").expect("cmd");

            assert_eq!(
                resolve_windows_cli_program_from_roots("agent", std::slice::from_ref(&root)),
                Some(exe)
            );
            let _ = fs::remove_dir_all(root);
        }

        #[tokio::test]
        async fn resolved_cmd_shim_runs_with_hidden_piped_process() {
            let root = temp_root();
            fs::create_dir_all(&root).expect("mkdir");
            let shim = root.join("agent.cmd");
            fs::write(&shim, "@echo off\r\necho shim-ok\r\n").expect("cmd");
            let resolved =
                resolve_windows_cli_program_from_roots("agent", std::slice::from_ref(&root))
                    .expect("resolve cmd shim");

            let output = background_cli_command_for_program(resolved)
                .output()
                .await
                .expect("run cmd shim");
            assert!(output.status.success());
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "shim-ok");
            let _ = fs::remove_dir_all(root);
        }
    }
}
