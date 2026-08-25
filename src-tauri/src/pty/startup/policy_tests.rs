use super::{
    clamp_powershell_timeout_ms, classify_shell_family, parse_readiness_flag,
    startup_readiness_policy, PtyShellFamily, StartupReadinessPolicy,
};

#[test]
fn shell_family_uses_case_insensitive_basename_and_exe_stem() {
    assert_eq!(
        classify_shell_family(r"C:\Program Files\PowerShell\PWSh.EXE"),
        PtyShellFamily::Pwsh
    );
    assert_eq!(
        classify_shell_family("C:/Windows/System32/POWERSHELL.exe"),
        PtyShellFamily::WindowsPowerShell
    );
    assert_eq!(classify_shell_family("cmd.EXE"), PtyShellFamily::Cmd);
    assert_eq!(
        classify_shell_family("/usr/bin/bash"),
        PtyShellFamily::Posix
    );
    assert_eq!(classify_shell_family(r"C:\工具"), PtyShellFamily::Posix);
    assert_eq!(
        classify_shell_family("C:\\tools\\custom.exe"),
        PtyShellFamily::Posix
    );
}

#[test]
fn readiness_parser_has_a_closed_true_set() {
    for token in ["1", "true", "TRUE", "on", "Enabled"] {
        assert!(parse_readiness_flag(Some(token)));
    }
    for token in [
        None,
        Some(""),
        Some("0"),
        Some("false"),
        Some("off"),
        Some("disabled"),
        Some("yes"),
        Some(" true "),
    ] {
        assert!(!parse_readiness_flag(token));
    }
}

#[test]
fn policy_is_immediate_when_off_and_shell_specific_when_on() {
    for shell in [
        PtyShellFamily::Pwsh,
        PtyShellFamily::WindowsPowerShell,
        PtyShellFamily::Cmd,
        PtyShellFamily::Posix,
    ] {
        assert_eq!(
            startup_readiness_policy(shell, false),
            StartupReadinessPolicy::Immediate
        );
    }
    assert_eq!(
        startup_readiness_policy(PtyShellFamily::Pwsh, true),
        StartupReadinessPolicy::Marker { timeout_ms: 3_000 }
    );
    assert_eq!(
        StartupReadinessPolicy::for_shell(PtyShellFamily::WindowsPowerShell, true),
        StartupReadinessPolicy::Marker { timeout_ms: 3_000 }
    );
    assert_eq!(
        StartupReadinessPolicy::for_shell(PtyShellFamily::Cmd, true),
        StartupReadinessPolicy::FirstOutput { timeout_ms: 750 }
    );
    assert_eq!(
        StartupReadinessPolicy::for_shell(PtyShellFamily::Posix, true),
        StartupReadinessPolicy::Immediate
    );
}

#[test]
fn powershell_timeout_defaults_and_clamps_at_both_boundaries() {
    for value in [None, Some(""), Some("invalid"), Some("-1")] {
        assert_eq!(clamp_powershell_timeout_ms(value), 3_000);
    }
    assert_eq!(clamp_powershell_timeout_ms(Some("499")), 500);
    assert_eq!(clamp_powershell_timeout_ms(Some("500")), 500);
    assert_eq!(clamp_powershell_timeout_ms(Some("1250")), 1250);
    assert_eq!(clamp_powershell_timeout_ms(Some("5000")), 5000);
    assert_eq!(clamp_powershell_timeout_ms(Some("5001")), 5000);
    assert_eq!(
        StartupReadinessPolicy::for_shell_with_timeout(PtyShellFamily::Pwsh, true, Some("499")),
        StartupReadinessPolicy::Marker { timeout_ms: 500 }
    );
}
