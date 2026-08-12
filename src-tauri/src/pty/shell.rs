use portable_pty::CommandBuilder;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use once_cell::sync::Lazy;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "windows")]
use std::{
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
const WINDOWS_SHELL_PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Pick the Windows shell by preference: pwsh (PowerShell 7+) > Windows
/// PowerShell > cmd. Pure (no platform calls) so the ordering is unit-tested on
/// any host; the real `cfg(windows)` path feeds it `which_exists` results.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn select_windows_shell(has_pwsh: bool, has_powershell: bool) -> &'static str {
    if has_pwsh {
        "pwsh.exe"
    } else if has_powershell {
        "powershell.exe"
    } else {
        "cmd.exe"
    }
}

/// Which shells are installed can't change while the app is running, but the
/// `where` probes cost ~0.5-0.8s on a cold PATH scan and can block indefinitely
/// on an unhealthy network PATH entry. Probe once with a strict deadline, then
/// reuse the result forever. A timed-out preferred shell safely falls back to
/// the next candidate (and ultimately cmd.exe), so first PTY creation remains
/// bounded.
#[cfg(target_os = "windows")]
static WINDOWS_SHELL: Lazy<&'static str> = Lazy::new(|| {
    let has_pwsh = which_exists("pwsh.exe");
    let has_powershell = !has_pwsh && which_exists("powershell.exe");
    select_windows_shell(has_pwsh, has_powershell)
});

/// Returns the default shell for the current platform.
pub(super) fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        (*WINDOWS_SHELL).to_string()
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

#[cfg(target_os = "macos")]
static LOGIN_SHELL_PATH: Lazy<Option<String>> = Lazy::new(resolve_macos_login_shell_path);

#[cfg(target_os = "macos")]
const MACOS_FALLBACK_PATH: &str =
    "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

#[cfg(target_os = "macos")]
fn resolve_macos_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let output = Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg("printf '__THREADTERM_PATH_BEGIN__%s__THREADTERM_PATH_END__\\n' \"$PATH\"")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = stdout
        .split("__THREADTERM_PATH_BEGIN__")
        .nth(1)?
        .split("__THREADTERM_PATH_END__")
        .next()?
        .trim();

    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(target_os = "macos")]
fn merge_path_values(values: &[&str]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts = Vec::new();

    for value in values {
        for part in value.split(':') {
            let trimmed = part.trim();
            if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
                continue;
            }
            parts.push(trimmed.to_string());
        }
    }

    parts.join(":")
}

pub(super) fn configure_shell_command(cmd: &mut CommandBuilder, shell: &str) {
    #[cfg(target_os = "macos")]
    {
        if shell.ends_with("/zsh") || shell == "zsh" || shell.ends_with("/bash") || shell == "bash"
        {
            cmd.arg("-l");
        }

        let process_path = std::env::var("PATH").unwrap_or_default();
        let login_path = LOGIN_SHELL_PATH.as_deref().unwrap_or("");
        let home = std::env::var("HOME").unwrap_or_default();
        let user_bin_path = format!("{home}/.local/bin:{home}/.cargo/bin:{home}/.bun/bin");
        let path = merge_path_values(&[
            login_path,
            &process_path,
            MACOS_FALLBACK_PATH,
            &user_bin_path,
        ]);
        cmd.env("PATH", path);
    }

    cmd.env("SHELL", shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "3");
}

#[cfg(target_os = "windows")]
fn which_exists(name: &str) -> bool {
    let where_executable = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .map(|root| root.join("System32").join("where.exe"))
        .unwrap_or_else(|| std::path::PathBuf::from("where.exe"));
    let mut command = Command::new(where_executable);
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .args(["/Q", name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let Ok(mut child) = command.spawn() else {
        return false;
    };
    matches!(
        wait_for_child_with_timeout(&mut child, WINDOWS_SHELL_PROBE_TIMEOUT),
        Ok(Some(status)) if status.success()
    )
}

#[cfg(target_os = "windows")]
fn wait_for_child_with_timeout(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Normalize a working directory for Windows `CommandBuilder::cwd`: ConPTY
/// wants native backslash separators, and a cwd carrying forward slashes
/// (common from JS path joins) can fail to resolve. Pure — only invoked on the
/// Windows spawn path. `/` is never a valid Windows path char, so a blanket
/// replace is safe.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn normalize_windows_cwd(dir: &str) -> String {
    dir.replace('/', "\\")
}

#[cfg(test)]
mod tests {
    use super::{normalize_windows_cwd, select_windows_shell};
    #[cfg(target_os = "windows")]
    use super::{wait_for_child_with_timeout, which_exists, CREATE_NO_WINDOW};
    #[cfg(target_os = "windows")]
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    #[test]
    fn windows_shell_prefers_pwsh_then_powershell_then_cmd() {
        assert_eq!(select_windows_shell(true, true), "pwsh.exe");
        assert_eq!(select_windows_shell(true, false), "pwsh.exe");
        assert_eq!(select_windows_shell(false, true), "powershell.exe");
        assert_eq!(select_windows_shell(false, false), "cmd.exe");
    }

    #[test]
    fn windows_cwd_uses_backslash_separators() {
        assert_eq!(
            normalize_windows_cwd("C:/Users/foo/my project"),
            "C:\\Users\\foo\\my project"
        );
        assert_eq!(
            normalize_windows_cwd("C:\\already\\native"),
            "C:\\already\\native"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_probe_finds_cmd() {
        assert!(which_exists("cmd.exe"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_probe_timeout_kills_a_slow_probe() {
        let mut command = Command::new("ping.exe");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-n", "5", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("start slow probe");
        let started = Instant::now();

        let status = wait_for_child_with_timeout(&mut child, Duration::from_millis(30))
            .expect("wait for slow probe");

        assert!(status.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
