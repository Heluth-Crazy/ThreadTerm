use portable_pty::CommandBuilder;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use once_cell::sync::Lazy;
#[cfg(target_os = "macos")]
use std::process::Command;

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
/// `where` probes cost ~0.5-0.8s *each* on a cold PATH scan — and they used to
/// run inside PTY_SPAWN_LOCK on every pty_create, serializing multi-card
/// startup into multi-second delays before the first prompt appeared. Probe
/// once, reuse forever.
#[cfg(target_os = "windows")]
static WINDOWS_SHELL: Lazy<&'static str> =
    Lazy::new(|| select_windows_shell(which_exists("pwsh.exe"), which_exists("powershell.exe")));

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
    std::process::Command::new("where")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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
}
