use super::*;

#[test]
fn auth_probe_uses_native_help_capabilities_without_a_version_threshold() {
    assert_eq!(
        auth_probe_args("\x1b[36m--standalone\x1b[0m  private server"),
        Some(vec!["--standalone", "auth", "list"])
    );
    assert_eq!(
        auth_probe_args("opencode auth\n--standalone  use private server\n"),
        Some(vec!["--standalone", "auth", "list"])
    );
    assert_eq!(auth_probe_args("opencode auth\nCommands:\n  opencode auth login [url]\n  opencode auth logout\n  opencode auth list\n"), Some(vec!["auth", "list"]));
    for unknown in [
        "",
        "[]",
        "<html>frontend</html>",
        "unknown option",
        "opencode auth\n--not-standalone\n",
        "opencode auth list",
    ] {
        assert!(
            auth_probe_args(unknown).is_none(),
            "unknown help cannot authorize a potentially persistent service: {unknown}"
        );
    }
}

#[test]
fn captured_help_selects_the_confirmed_private_or_legacy_command() {
    for row in crate::providers::conformance::fixture("opencode-auth-help.jsonl") {
        let args = auth_probe_args(row["stdout"].as_str().unwrap()).unwrap();
        let expected = row["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(args, expected);
    }
}
