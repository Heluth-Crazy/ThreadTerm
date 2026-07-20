use std::path::PathBuf;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) fn background_cli_command(name: &str) -> Command {
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

pub(super) fn is_safe_session_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(windows)]
fn resolve_windows_cli_program(name: &str) -> Option<PathBuf> {
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
                resolve_windows_cli_program_from_roots("agent", &[root.clone()]),
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
            let resolved = resolve_windows_cli_program_from_roots("agent", &[root.clone()])
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
