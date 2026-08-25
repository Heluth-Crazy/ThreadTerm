use once_cell::sync::Lazy;

use super::types::PtyShellFamily;

pub const PROVIDER_SHELL_READY_ENV: &str = "THREADTERM_PROVIDER_SHELL_READY";
pub const DEFAULT_POWERSHELL_TIMEOUT_MS: u64 = 3_000;
pub const MIN_POWERSHELL_TIMEOUT_MS: u64 = 500;
pub const MAX_POWERSHELL_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupReadinessPolicy {
    Immediate,
    Marker { timeout_ms: u64 },
    FirstOutput { timeout_ms: u64 },
}

/// Parse only the explicitly supported process flag tokens; whitespace is not
/// normalized so an accidental value remains safely disabled.
pub fn parse_readiness_flag(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value.eq_ignore_ascii_case("1")
            || value.eq_ignore_ascii_case("true")
            || value.eq_ignore_ascii_case("on")
            || value.eq_ignore_ascii_case("enabled")
    })
}

/// Process-scoped production view of `THREADTERM_PROVIDER_SHELL_READY`.
pub static PROVIDER_SHELL_READY_ENABLED: Lazy<bool> =
    Lazy::new(|| parse_readiness_flag(std::env::var(PROVIDER_SHELL_READY_ENV).ok().as_deref()));

pub fn provider_shell_ready_enabled() -> bool {
    *PROVIDER_SHELL_READY_ENABLED
}

/// Classify only the final path component; this intentionally does not perform
/// shell discovery or normalize the path used to spawn the process.
pub fn classify_shell_family(path: &str) -> PtyShellFamily {
    let basename = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = match basename.len().checked_sub(4) {
        Some(index)
            if basename
                .get(index..)
                .is_some_and(|s| s.eq_ignore_ascii_case(".exe")) =>
        {
            basename.get(..index).unwrap_or(basename)
        }
        _ => basename,
    };
    if stem.eq_ignore_ascii_case("pwsh") {
        PtyShellFamily::Pwsh
    } else if stem.eq_ignore_ascii_case("powershell") {
        PtyShellFamily::WindowsPowerShell
    } else if stem.eq_ignore_ascii_case("cmd") {
        PtyShellFamily::Cmd
    } else {
        PtyShellFamily::Posix
    }
}

pub fn clamp_powershell_timeout_ms(value: Option<&str>) -> u64 {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_POWERSHELL_TIMEOUT_MS)
        .clamp(MIN_POWERSHELL_TIMEOUT_MS, MAX_POWERSHELL_TIMEOUT_MS)
}

impl StartupReadinessPolicy {
    pub fn for_shell(shell: PtyShellFamily, readiness_enabled: bool) -> Self {
        Self::for_shell_with_timeout(shell, readiness_enabled, None)
    }

    pub fn for_shell_with_timeout(
        shell: PtyShellFamily,
        readiness_enabled: bool,
        timeout: Option<&str>,
    ) -> Self {
        if !readiness_enabled {
            return Self::Immediate;
        }
        match shell {
            PtyShellFamily::Pwsh | PtyShellFamily::WindowsPowerShell => Self::Marker {
                timeout_ms: clamp_powershell_timeout_ms(timeout),
            },
            PtyShellFamily::Cmd => Self::FirstOutput { timeout_ms: 750 },
            PtyShellFamily::Posix => Self::Immediate,
        }
    }
}

pub fn startup_readiness_policy(
    shell: PtyShellFamily,
    readiness_enabled: bool,
) -> StartupReadinessPolicy {
    StartupReadinessPolicy::for_shell(shell, readiness_enabled)
}
