use std::{fs, path::PathBuf};

use crate::shell_integration::{install_shell_integration_block, remove_shell_integration_block};

fn temp_rc(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "threadterm-{name}-{}-{}.rc",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    let _ = fs::remove_file(&path);
    path
}

#[test]
fn shell_integration_install_is_idempotent() {
    let rc = temp_rc("install");
    fs::write(&rc, "existing\n").expect("write rc");

    install_shell_integration_block(&rc, "zsh", "/opt/threadterm/zsh.sh")
        .expect("install first time");
    install_shell_integration_block(&rc, "zsh", "/opt/threadterm/zsh.sh")
        .expect("install second time");

    let content = fs::read_to_string(&rc).expect("read rc");
    assert_eq!(
        content
            .matches("# >>> threadterm shell integration")
            .count(),
        1
    );
    assert!(content.contains("source \"/opt/threadterm/zsh.sh\""));

    let _ = fs::remove_file(rc);
}

#[test]
fn shell_integration_uninstall_is_idempotent() {
    let rc = temp_rc("uninstall");
    fs::write(&rc, "before\n").expect("write rc");
    install_shell_integration_block(&rc, "bash", "/opt/threadterm/bash.sh").expect("install");

    remove_shell_integration_block(&rc).expect("remove first time");
    remove_shell_integration_block(&rc).expect("remove second time");

    let content = fs::read_to_string(&rc).expect("read rc");
    assert_eq!(content, "before\n");

    let _ = fs::remove_file(rc);
}

#[test]
fn shell_integration_scripts_emit_duration_metadata() {
    let scripts = [
        ("zsh", include_str!("../resources/shell-integration/zsh.sh")),
        (
            "bash",
            include_str!("../resources/shell-integration/bash.sh"),
        ),
        (
            "fish",
            include_str!("../resources/shell-integration/fish.sh"),
        ),
        (
            "pwsh",
            include_str!("../resources/shell-integration/pwsh.ps1"),
        ),
    ];

    for (shell, script) in scripts {
        assert!(
            script.contains("133;D"),
            "{shell} script must emit OSC 133 command-finished markers"
        );
        assert!(
            script.contains("6973;duration="),
            "{shell} script must emit ThreadTerm duration metadata"
        );
    }
}
