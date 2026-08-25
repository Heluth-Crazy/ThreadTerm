use base64::{engine::general_purpose::STANDARD, Engine as _};
use once_cell::sync::Lazy;
use portable_pty::CommandBuilder;

pub(crate) const POWERSHELL_UTF8_ENV: &str = "THREADTERM_POWERSHELL_UTF8";

/// The environment is read once for the process, while the parser remains
/// pure so tests never need to mutate process-global state.
pub(crate) static POWERSHELL_UTF8_ENABLED: Lazy<bool> =
    Lazy::new(|| parse_powershell_utf8_flag(std::env::var(POWERSHELL_UTF8_ENV).ok().as_deref()));

pub(crate) fn parse_powershell_utf8_flag(value: Option<&str>) -> bool {
    super::super::startup::parse_readiness_flag(value)
}

pub(crate) fn powershell_utf8_enabled() -> bool {
    *POWERSHELL_UTF8_ENABLED
}

pub(super) fn is_powershell_shell(shell: &str) -> bool {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let stem = match name.len().checked_sub(4) {
        Some(index)
            if name
                .get(index..)
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".exe")) =>
        {
            name.get(..index).unwrap_or(name)
        }
        _ => name,
    };
    stem.eq_ignore_ascii_case("pwsh") || stem.eq_ignore_ascii_case("powershell")
}

fn validate_nonce(nonce: &str) -> Result<(), String> {
    if nonce.len() != 32
        || nonce
            .bytes()
            .any(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("startup_marker_invalid".to_string());
    }
    Ok(())
}

fn bootstrap_script(nonce: &str, utf8_enabled: bool) -> String {
    let mut script = String::from("try {\r\n");
    if utf8_enabled {
        script.push_str(
            "    try {\r\n\
        $utf8 = [System.Text.UTF8Encoding]::new($false)\r\n\
        [Console]::InputEncoding = $utf8\r\n\
        [Console]::OutputEncoding = $utf8\r\n\
        $OutputEncoding = $utf8\r\n\
    } catch {\r\n\
    }\r\n",
        );
    }
    script.push_str(
        "} catch {\r\n\
} finally {\r\n\
    [Console]::Write(([char]27 + ']777;threadterm;ready;",
    );
    script.push_str(nonce);
    script.push_str("' + [char]7))\r\n}\r\n");
    script
}

fn encode_utf16le(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

/// Additive interactive PowerShell startup. The existing shell environment
/// setup runs first; this function only adds a private encoded bootstrap.
pub(crate) fn configure_powershell_ready_command(
    cmd: &mut CommandBuilder,
    shell: &str,
    nonce: &str,
    utf8_enabled: bool,
) -> Result<(), String> {
    #[cfg(feature = "terminal-startup-harness")]
    let offline = crate::terminal_startup_harness::offline_attestation().is_enabled();
    #[cfg(not(feature = "terminal-startup-harness"))]
    let offline = false;
    configure_powershell_ready_command_with_offline(cmd, shell, nonce, utf8_enabled, offline)
}

pub(crate) fn configure_powershell_ready_command_with_offline(
    cmd: &mut CommandBuilder,
    shell: &str,
    nonce: &str,
    utf8_enabled: bool,
    offline: bool,
) -> Result<(), String> {
    super::configure_shell_command(cmd, shell);
    validate_nonce(nonce)?;
    if !is_powershell_shell(shell) {
        return Err("powershell_shell_invalid".to_string());
    }

    let encoded = encode_utf16le(&bootstrap_script(nonce, utf8_enabled));
    cmd.arg("-NoLogo");
    if offline {
        // The runner's offline attestation permits profile isolation for its
        // synthetic shell only. Production and ordinary feature builds retain
        // profile loading exactly as before.
        cmd.arg("-NoProfile");
    }
    cmd.args(["-NoExit", "-EncodedCommand"]);
    cmd.arg(encoded);
    Ok(())
}
