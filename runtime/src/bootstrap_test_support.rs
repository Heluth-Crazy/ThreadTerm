//! Libtest initializes a TERM-dependent formatter before entering the helper.
//! Isolate that test-only startup, then restore the application's environment.
use portable_pty::CommandBuilder;
use std::ffi::OsString;

const ORIGINAL_TERM: &str = "THREADTERM_V3_TEST_ORIGINAL_TERM";

pub(super) fn prepare_initial_pty(command: &mut CommandBuilder) {
    command.env_remove(ORIGINAL_TERM);
    prepare_pty(command);
}

pub(crate) fn prepare_pty(command: &mut CommandBuilder) {
    // This can run again after environment::apply. Preserve the first carrier
    // when TERM is already absent, or refresh it if composition restored TERM.
    if let Some(term) = command.get_env("TERM").map(OsString::from) {
        command.env(ORIGINAL_TERM, term);
    }
    command.env_remove("TERM");
}

pub(super) fn prepare_service(command: &mut std::process::Command) {
    let own = command
        .get_envs()
        .find(|(name, _)| {
            name.to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("TERM"))
        })
        .map(|(_, value)| value.map(OsString::from));
    let term = own.unwrap_or_else(|| std::env::var_os("TERM"));
    command.env_remove("TERM").env_remove(ORIGINAL_TERM);
    if let Some(term) = term {
        command.env(ORIGINAL_TERM, term);
    }
}

pub(super) fn restore_term() {
    // Only the dedicated child process executes this: no parent test changes
    // its process-wide environment. The formatter has already initialized.
    if let Some(term) = std::env::var_os(ORIGINAL_TERM) {
        std::env::set_var("TERM", term);
    }
    std::env::remove_var(ORIGINAL_TERM);
}

#[test]
fn quick_launch_helper_term_isolation_is_idempotent_and_child_scoped() {
    let parent = std::env::var_os("TERM");
    let mut command = CommandBuilder::new("cmd.exe");
    command.env_remove(ORIGINAL_TERM);
    command.env("TERM", "xterm-256color");
    prepare_pty(&mut command);
    assert!(command.get_env("TERM").is_none());
    assert_eq!(
        command.get_env(ORIGINAL_TERM),
        Some(std::ffi::OsStr::new("xterm-256color"))
    );
    prepare_pty(&mut command);
    assert_eq!(
        command.get_env(ORIGINAL_TERM),
        Some(std::ffi::OsStr::new("xterm-256color"))
    );
    command.env("TERM", "fresh-term");
    prepare_pty(&mut command);
    assert!(command.get_env("TERM").is_none());
    assert_eq!(
        command.get_env(ORIGINAL_TERM),
        Some(std::ffi::OsStr::new("fresh-term"))
    );
    assert_eq!(std::env::var_os("TERM"), parent);
    for term in [None, Some(""), Some("终端")] {
        let mut command = CommandBuilder::new("cmd.exe");
        command.env_remove("TERM");
        if let Some(term) = term {
            command.env("TERM", term);
        }
        prepare_initial_pty(&mut command);
        assert!(command.get_env("TERM").is_none());
        assert_eq!(
            command.get_env(ORIGINAL_TERM),
            term.map(std::ffi::OsStr::new)
        );
    }
    let mut service = std::process::Command::new("cmd.exe");
    service.env("TERM", "service-term");
    prepare_service(&mut service);
    assert_eq!(
        service
            .get_envs()
            .find(|(name, _)| *name == "TERM")
            .unwrap()
            .1,
        None
    );
    assert_eq!(
        service
            .get_envs()
            .find(|(name, _)| *name == ORIGINAL_TERM)
            .unwrap()
            .1,
        Some(std::ffi::OsStr::new("service-term"))
    );
    assert_eq!(std::env::var_os("TERM"), parent);
}
