use std::{fs, path::PathBuf};

use crate::shell_integration::{
    build_installed_content, install_shell_integration_block, remove_shell_integration_block,
};

fn diff_for(before: &str, after: &str) -> String {
    use similar::{ChangeTag, TextDiff};
    let diff = TextDiff::from_lines(before, after);
    let mut out = String::new();
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            ChangeTag::Delete => "-",
            ChangeTag::Insert => "+",
            ChangeTag::Equal => " ",
        };
        out.push_str(sign);
        out.push_str(change.value());
        if !change.value().ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

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
fn shell_integration_preview_diff_shows_install_lines() {
    let before = "export PATH=$PATH:/usr/local/bin\n";
    let after = build_installed_content(before, "zsh", "/opt/threadterm/zsh.sh");
    let diff = diff_for(before, &after);

    assert_ne!(before, after, "preview must differ from original rc");
    assert!(
        diff.contains("+# >>> threadterm shell integration"),
        "diff must add the start sentinel: {diff}"
    );
    assert!(
        diff.contains("+# <<< threadterm shell integration"),
        "diff must add the end sentinel: {diff}"
    );
    assert!(
        diff.contains("+source \"/opt/threadterm/zsh.sh\""),
        "diff must add the source line: {diff}"
    );
    // The pre-existing line must remain in `after` and show as unchanged
    // context in the diff (whitespace prefix is the unified-diff " " marker
    // emitted by `diff_for`).
    assert!(after.contains("export PATH=$PATH:/usr/local/bin"));
}

#[test]
fn shell_integration_preview_diff_is_empty_when_already_installed() {
    let original = "alias ll='ls -lah'\n";
    let after_first = build_installed_content(original, "bash", "/opt/threadterm/bash.sh");
    // Re-run preview against the already-installed rc: should be a no-op.
    let after_second = build_installed_content(&after_first, "bash", "/opt/threadterm/bash.sh");

    assert_eq!(
        after_first, after_second,
        "preview must be a no-op once integration is already installed"
    );
    let diff = diff_for(&after_first, &after_second);
    for line in diff.lines() {
        assert!(
            !line.starts_with('+') && !line.starts_with('-'),
            "no-op preview must not produce +/- diff lines: {diff}"
        );
    }
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
