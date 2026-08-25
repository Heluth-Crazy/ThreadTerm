use super::{harness_shell_path, HarnessShell};

#[test]
fn harness_shell_mapping_accepts_only_fixed_executables() {
    assert_eq!(harness_shell_path(HarnessShell::Auto), None);
    assert_eq!(harness_shell_path(HarnessShell::Pwsh), Some("pwsh.exe"));
    assert_eq!(
        harness_shell_path(HarnessShell::WindowsPowerShell),
        Some("powershell.exe")
    );
    assert_eq!(harness_shell_path(HarnessShell::Cmd), Some("cmd.exe"));
}
