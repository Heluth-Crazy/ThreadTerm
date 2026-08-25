use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::CommandBuilder;

#[cfg(feature = "terminal-startup-harness")]
use super::bootstrap::configure_powershell_ready_command_with_offline;
use super::bootstrap::{
    configure_powershell_ready_command, parse_powershell_utf8_flag, POWERSHELL_UTF8_ENV,
};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const INVALID_UPPERCASE_NONCE: &str = "0123456789ABCDEF0123456789abcdef";

fn configured_args(utf8_enabled: bool) -> Vec<String> {
    let mut command = CommandBuilder::new("pwsh.exe");
    configure_powershell_ready_command(&mut command, "pwsh.exe", NONCE, utf8_enabled)
        .expect("configure PowerShell bootstrap");
    command
        .get_argv()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

#[cfg(feature = "terminal-startup-harness")]
fn configured_offline_args(utf8_enabled: bool) -> Vec<String> {
    let mut command = CommandBuilder::new("pwsh.exe");
    configure_powershell_ready_command_with_offline(
        &mut command,
        "pwsh.exe",
        NONCE,
        utf8_enabled,
        true,
    )
    .expect("configure offline PowerShell bootstrap");
    command
        .get_argv()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

fn decode_script(args: &[String]) -> String {
    let encoded = args
        .windows(2)
        .find(|pair| pair[0] == "-EncodedCommand")
        .map(|pair| pair[1].as_str())
        .expect("encoded command argument");
    let bytes = STANDARD.decode(encoded).expect("base64 payload");
    assert_eq!(bytes.len() % 2, 0);
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).expect("UTF-16LE PowerShell script")
}

#[test]
fn encoded_interactive_args_preserve_profile_loading() {
    let args = configured_args(false);
    assert_eq!(&args[1..4], ["-NoLogo", "-NoExit", "-EncodedCommand"]);
    assert!(!args.iter().any(|arg| arg == "-NoProfile"));
    assert!(!args.iter().any(|arg| arg == "-NonInteractive"));
    assert_eq!(POWERSHELL_UTF8_ENV, "THREADTERM_POWERSHELL_UTF8");

    let mut command = CommandBuilder::new("pwsh.exe");
    configure_powershell_ready_command(&mut command, "pwsh.exe", NONCE, false)
        .expect("configure environment");
    assert_eq!(
        command.get_env("SHELL").and_then(|value| value.to_str()),
        Some("pwsh.exe")
    );
    assert_eq!(
        command.get_env("TERM").and_then(|value| value.to_str()),
        Some("xterm-256color")
    );
}

#[cfg(feature = "terminal-startup-harness")]
#[test]
fn offline_interactive_args_disable_profile_loading_exactly_once() {
    let args = configured_offline_args(false);
    assert_eq!(
        &args[1..5],
        ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand"]
    );
    assert_eq!(args.iter().filter(|arg| *arg == "-NoProfile").count(), 1);
}

#[test]
fn marker_is_constructed_in_finally_with_exact_nonce() {
    let script = decode_script(&configured_args(false));
    let finally = script.find("} finally {").expect("finally block");
    let marker = script.find("[Console]::Write").expect("marker write");
    assert!(marker > finally);
    assert!(script.contains("[char]27"));
    assert!(script.contains("[char]7"));
    assert!(script.contains("']777;threadterm;ready;0123456789abcdef0123456789abcdef'"));
    assert_eq!(script.matches(NONCE).count(), 1);
}

#[test]
fn utf8_fragment_is_independent_and_does_not_change_file_defaults() {
    let on = decode_script(&configured_args(true));
    assert!(on.contains("[System.Text.UTF8Encoding]::new($false)"));
    assert!(on.contains("[Console]::InputEncoding = $utf8"));
    assert!(on.contains("[Console]::OutputEncoding = $utf8"));
    assert!(on.contains("$OutputEncoding = $utf8"));
    assert!(!on.contains("$PSDefaultParameterValues"));
    assert!(!on.contains("Out-File"));
    assert!(!on.contains("Set-Content"));

    let off = decode_script(&configured_args(false));
    for setting in [
        "UTF8Encoding",
        "InputEncoding",
        "OutputEncoding",
        "$OutputEncoding",
    ] {
        assert!(
            !off.contains(setting),
            "UTF-8 setting leaked into OFF script"
        );
    }
    assert!(off.contains("finally"));
}

#[test]
fn invalid_nonce_is_redacted_and_cmd_never_gets_a_powershell_probe() {
    for nonce in [
        "short",
        "0123456789abcdef0123456789ABCDE",
        INVALID_UPPERCASE_NONCE,
    ] {
        let mut command = CommandBuilder::new("pwsh.exe");
        let error = configure_powershell_ready_command(&mut command, "pwsh.exe", nonce, false)
            .expect_err("invalid nonce");
        assert_eq!(error, "startup_marker_invalid");
        assert!(!error.contains(nonce));
        assert_eq!(command.get_argv().len(), 1);
    }

    for shell in ["cmd.exe", r"C:\\é\\cmd.ExE"] {
        let mut command = CommandBuilder::new(shell);
        let error = configure_powershell_ready_command(&mut command, shell, NONCE, false)
            .expect_err("non-PowerShell shell");
        assert_eq!(error, "powershell_shell_invalid");
        assert_eq!(command.get_argv().len(), 1);
    }
}

#[test]
fn powershell_executable_suffix_is_case_insensitive_and_utf8_safe() {
    for shell in ["PWSH.EXE", "PowerShell.ExE", r"C:\\é\\PwSh.ExE"] {
        let args = {
            let mut command = CommandBuilder::new(shell);
            configure_powershell_ready_command(&mut command, shell, NONCE, false)
                .expect("mixed-case PowerShell executable");
            command.get_argv().clone()
        };
        assert!(args.iter().any(|arg| arg == "-EncodedCommand"));
    }
}

#[test]
fn utf8_flag_uses_the_existing_conservative_tokens_without_env_mutation() {
    for value in ["1", "true", "ON", "enabled"] {
        assert!(parse_powershell_utf8_flag(Some(value)));
    }
    for value in [None, Some(""), Some("yes"), Some(" true "), Some("0")] {
        assert!(!parse_powershell_utf8_flag(value));
    }
}

#[test]
fn one_shot_powershell_arguments_remain_noninteractive_and_unchanged() {
    assert_eq!(
        super::one_shot_command_args("C:\\PowerShell\\pwsh.exe", "Write-Output ok"),
        vec![
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output ok"
        ]
    );
}
