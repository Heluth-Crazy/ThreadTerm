use super::*;
use crate::environment::{Snapshot, Vars};

fn reproduction(case: &str) {
    let marker = "THREADTERM_ENV_REPRO_CHILD";
    if env::var(marker).ok().as_deref() != Some(case) {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        let script = "@echo off\r\necho EXE=%~f0\r\necho PATH=%PATH%\r\n";
        if case != "added" { std::fs::write(old.join("tt-env-stub.cmd"), script).unwrap(); }
        if case != "removed" { std::fs::write(new.join("tt-env-stub.cmd"), script).unwrap(); }
        if case == "moved" { std::fs::remove_file(old.join("tt-env-stub.cmd")).unwrap(); }
        let output = std::process::Command::new(env::current_exe().unwrap())
            .args(["--exact", &format!("providers::common::provider_environment_tests::discovery_{case}"), "--nocapture"])
            .env(marker, case).env("THREADTERM_ENV_REPRO_ROOT", root.path())
            .env("PATH", &old).output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        return;
    }
    let root = PathBuf::from(env::var_os("THREADTERM_ENV_REPRO_ROOT").unwrap());
    let new = root.join("new");
    let fresh_path = if case == "removed" { root.join("empty") } else { new.clone() };
    let start: Vars = env::vars_os().collect();
    let mut block = start.clone();
    block.retain(|(name, _)| !name.eq_ignore_ascii_case("PATH"));
    block.push(("Path".into(), fresh_path.as_os_str().to_owned()));
    let now = Snapshot { block, registry: ["PATH".into()].into_iter().collect() };
    crate::environment::with_test_snapshot(&start, now, || {
        let discovered = find_executable("tt-env-stub");
        let expected = (case != "removed").then(|| new.join("tt-env-stub.cmd"));
        // Observe both actual child environments and the program that ran before comparing discovery.
        if let Some(path) = discovered.as_ref().or(expected.as_ref()) {
            let spec = CommandSpec::from_path(path.clone(), vec!["--version".into()]).unwrap();
            let version = command_output(&spec, Duration::from_secs(5)).unwrap();
            let spec = CommandSpec::from_path(path.clone(), vec![]).unwrap();
            let launch = command_output(&spec, Duration::from_secs(5)).unwrap();
            for output in [&version, &launch] {
                assert!(output.contains(&format!("PATH={}", fresh_path.display())), "{output}");
                assert!(output.contains(&format!("EXE={}", path.display())), "{output}");
            }
            eprintln!("{case}: discovery={discovered:?}; version={version:?}; launch={launch:?}");
        }
        assert_eq!(discovered, expected, "discovery must agree with the refreshed child PATH");
        if expected.is_none() {
            let error = CommandSpec::provider("tt-env-stub", &[]).unwrap_err();
            assert_eq!(error.code, "provider_unavailable");
            assert!(error.message.contains("executable was not found on PATH"));
        }
    });
}

#[test]
fn discovery_added() { reproduction("added"); }
#[test]
fn discovery_removed() { reproduction("removed"); }
#[test]
fn discovery_moved() { reproduction("moved"); }

#[test]
fn snapshot_path_and_pathext_win_and_launcher_fallback_remains_absolute() {
    let root = tempfile::tempdir().unwrap();
    let fresh = root.path().join("fresh");
    let launcher = root.path().join("launcher");
    for directory in [&fresh, &launcher] {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("tt-order.custom"), "stub").unwrap();
    }
    let vars = vec![("pAtHeXt".into(), ".CUSTOM".into())];
    assert_eq!(find_executable_in("tt-order", &vars, &[fresh.clone(), launcher.clone()]), Some(fresh.join("tt-order.custom")));
    std::fs::remove_file(fresh.join("tt-order.custom")).unwrap();
    assert_eq!(find_executable_in("tt-order", &vars, &[fresh, launcher.clone()]), Some(launcher.join("tt-order.custom")));
    let relative = PathBuf::from(".").join("Cargo.toml");
    if relative.is_file() { assert!(find_executable_in(relative.to_str().unwrap(), &vars, &[]).unwrap().is_absolute()); }
}

#[test]
fn opencode_path_wrapper_is_not_replaced_by_a_coinstalled_legacy_native_binary() {
    let root = tempfile::tempdir().unwrap();
    let launcher = root.path().join("launcher");
    let legacy_native = launcher
        .join("node_modules")
        .join("opencode-ai")
        .join("bin")
        .join("opencode.exe");
    std::fs::create_dir_all(legacy_native.parent().unwrap()).unwrap();
    let wrapper = launcher.join("opencode.cmd");
    std::fs::write(&wrapper, "@echo off\r\n").unwrap();
    std::fs::write(&legacy_native, "legacy native binary").unwrap();

    let resolved = find_executable_in("opencode", &Vec::new(), &[launcher]);
    assert_eq!(resolved, Some(wrapper));
}

#[test]
fn captured_probe_environment_survives_decision_and_removed_executable_is_explicit() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("captured.cmd");
    std::fs::write(&script, "@echo off\r\necho PATH=%PATH%\r\necho EXE=%~f0\r\n").unwrap();
    let start = env::vars_os().collect::<Vars>();
    let mut block = start.clone();
    block.retain(|(name, _)| !name.eq_ignore_ascii_case("PATH"));
    block.push(("Path".into(), root.path().as_os_str().to_owned()));
    let spec = crate::environment::with_test_snapshot(&start, Snapshot { block, registry: ["PATH".into()].into_iter().collect() }, || {
        let _decision = crate::environment::provider_decision();
        let environment = crate::environment::provider_environment();
        let path = find_executable("captured").unwrap();
        let spec = CommandSpec::from_path(path, vec!["--version".into()]).unwrap();
        assert!(Arc::ptr_eq(&environment, &spec.environment));
        spec
    });
    let output = command_output(&spec, Duration::from_secs(5)).unwrap();
    assert!(output.contains(&format!("PATH={}", root.path().display())), "{output}");
    assert!(output.contains(&format!("EXE={}", script.display())), "{output}");
    std::fs::remove_file(script).unwrap();
    let error = command_output(&spec, Duration::from_secs(5)).unwrap_err();
    assert_eq!(error.code, "provider_unavailable");
    assert!(error.message.contains("executable was not found on PATH"));
    let error = spawn_managed_service(&spec, None, &[]).err().expect("removed launch must fail");
    assert_eq!(error.code, "provider_unavailable");
}
