//! Each new terminal starts from a fresh copy of the user's Windows environment.
//!
//! The runtime is a long-lived daemon, so the environment it inherited goes stale: a tool installed
//! later (a new Path entry, JAVA_HOME, ...) would not reach new terminals. portable-pty overlays the
//! machine and user `Environment` registry keys on the inherited environment, but expands their
//! `%VARIABLES%` against that stale environment, never drops a deleted variable and skips the volatile
//! (logon) variables. Windows' own `CreateEnvironmentBlock` builds what a new logon gets — machine,
//! user and volatile variables, expanded in order, the user Path appended to the machine Path — and
//! [`merge`] combines it with the runtime's environment so variables its launcher set on purpose
//! (QA's isolated homes, ThreadTerm's own settings) survive. Chat providers' background processes
//! start from the same environment ([`apply_to_service`]).
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::{OsStr, OsString},
    sync::OnceLock,
};

pub type Vars = Vec<(OsString, OsString)>;

/// What Windows defines for this user at one moment.
pub struct Snapshot {
    /// `CreateEnvironmentBlock` for the runtime's own token, without inheritance.
    pub block: Vars,
    /// Names (see [`key`]) in the machine and user `Environment` registry keys.
    pub registry: HashSet<OsString>,
}

static START: OnceLock<Option<Vars>> = OnceLock::new();

/// Records what Windows defined when the runtime started; call once, before the first terminal.
pub fn initialize() {
    START.get_or_init(|| {
        block()
            .map_err(|error| eprintln!("child environment: keeping the inherited one: {error:#}"))
            .ok()
    });
}

/// The environment for a new terminal, or `None` to keep the inherited one (not initialized, or
/// Windows could not build it).
pub fn for_terminal() -> Option<Vars> {
    compose(START.get()?.as_ref()?, snapshot)
}

fn compose(start: &[(OsString, OsString)], now: impl FnOnce() -> anyhow::Result<Snapshot>) -> Option<Vars> {
    match now() {
        Ok(now) => Some(merge(&now, start, &std::env::vars_os().collect::<Vars>())),
        Err(error) => {
            eprintln!("child environment: keeping the inherited one: {error:#}");
            None
        }
    }
}

/// Starts `command` from [`for_terminal`] instead of the runtime's environment, keeping the
/// variables already set on it (the bootstrap gate). Per-session variables are set after this.
pub fn apply(command: &mut portable_pty::CommandBuilder) {
    if let Some(vars) = for_terminal() {
        replace(command, vars);
    }
}

fn replace(command: &mut portable_pty::CommandBuilder, vars: Vars) {
    let own: Vec<(String, String)> = command
        .iter_extra_env_as_str()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    command.env_clear();
    for (name, value) in vars {
        command.env(name, value);
    }
    for (name, value) in own {
        command.env(name, value);
    }
}

/// [`apply`] for a background process (a chat provider): it starts from the same environment as a
/// new terminal, keeping the variables already set or removed on it (the bootstrap gate).
/// The provider's own variables are set after this.
pub fn apply_to_service(command: &mut std::process::Command) {
    if let Some(vars) = for_terminal() {
        replace_service(command, vars);
    }
}

fn replace_service(command: &mut std::process::Command, vars: Vars) {
    let own: Vec<(OsString, Option<OsString>)> = command
        .get_envs()
        .map(|(name, value)| (name.to_owned(), value.map(OsStr::to_owned)))
        .collect();
    command.env_clear().envs(vars);
    for (name, value) in own {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

/// Chooses each variable of a new terminal:
/// - defined in the machine or user `Environment` key: Windows' value now (portable-pty's overlay
///   already let these win over the inherited value);
/// - otherwise the runtime's own value when Windows defined nothing or something else at runtime
///   start (its launcher set or changed it);
/// - otherwise Windows' value now: refreshed, new, or gone when Windows no longer defines it.
///
/// A variable the launcher removed stays removed.
pub fn merge(now: &Snapshot, start: &[(OsString, OsString)], current: &[(OsString, OsString)]) -> Vars {
    fn index(vars: &[(OsString, OsString)]) -> HashMap<OsString, (&OsString, &OsString)> {
        vars.iter().map(|(name, value)| (key(name), (name, value))).collect()
    }
    let (fresh, start, current) = (index(&now.block), index(start), index(current));
    let mut chosen = BTreeMap::new();
    for name in fresh.keys().chain(current.keys()) {
        let entry = if now.registry.contains(name) {
            fresh.get(name)
        } else {
            match (current.get(name), start.get(name)) {
                (Some(own), Some((_, at_start))) if own.1 == *at_start => fresh.get(name),
                (Some(own), _) => Some(own),
                (None, Some(_)) => None,
                (None, None) => fresh.get(name),
            }
        };
        if let Some((original, value)) = entry {
            chosen.insert(name.clone(), ((*original).clone(), (*value).clone()));
        }
    }
    chosen.into_values().collect()
}

/// Windows compares variable names without regard to case.
fn key(name: &OsStr) -> OsString {
    name.to_str().map_or_else(|| name.to_owned(), |name| name.to_lowercase().into())
}

/// `NAME=value` entries, each ending in NUL, up to an empty entry. A name may begin with `=`.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_block(wide: &[u16]) -> Vars {
    #[cfg(windows)]
    use std::os::windows::ffi::OsStringExt;
    #[cfg(not(windows))]
    let from_wide = |wide: &[u16]| OsString::from(String::from_utf16_lossy(wide));
    #[cfg(windows)]
    let from_wide = OsString::from_wide;
    wide.split(|&unit| unit == 0)
        .take_while(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let split = 1 + entry.iter().skip(1).position(|&unit| unit == u16::from(b'='))?;
            Some((from_wide(&entry[..split]), from_wide(&entry[split + 1..])))
        })
        .collect()
}

#[cfg(windows)]
fn snapshot() -> anyhow::Result<Snapshot> {
    Ok(Snapshot { block: block()?, registry: registry_names()? })
}

#[cfg(windows)]
fn block() -> anyhow::Result<Vars> {
    use anyhow::Context;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        Security::{TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY},
        System::{
            Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock},
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error()).context("opening the runtime's token");
    }
    let mut block = std::ptr::null_mut();
    let created = unsafe { CreateEnvironmentBlock(&mut block, token, 0) };
    let error = std::io::Error::last_os_error();
    unsafe { CloseHandle(token) };
    if created == 0 {
        return Err(error).context("CreateEnvironmentBlock");
    }
    let start = block as *const u16;
    let mut len = 0;
    // Entry by entry up to the empty one that ends the block.
    while unsafe { *start.add(len) } != 0 {
        while unsafe { *start.add(len) } != 0 {
            len += 1;
        }
        len += 1;
    }
    let vars = parse_block(unsafe { std::slice::from_raw_parts(start, len) });
    unsafe { DestroyEnvironmentBlock(block) };
    Ok(vars)
}

#[cfg(windows)]
fn registry_names() -> anyhow::Result<HashSet<OsString>> {
    use anyhow::bail;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
        System::Registry::{RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE},
    };
    let mut names = HashSet::new();
    for (root, path) in [
        (HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (HKEY_CURRENT_USER, "Environment"),
    ] {
        let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
        let mut handle = std::ptr::null_mut();
        match unsafe { RegOpenKeyExW(root, wide.as_ptr(), 0, KEY_QUERY_VALUE, &mut handle) } {
            ERROR_SUCCESS => {}
            ERROR_FILE_NOT_FOUND => continue,
            code => bail!("opening {path}: {}", std::io::Error::from_raw_os_error(code as i32)),
        }
        // Value names are at most 16,383 characters.
        let mut buffer = vec![0u16; 16_384];
        let mut failure = None;
        for index in 0u32.. {
            let mut len = buffer.len() as u32;
            let code = unsafe {
                RegEnumValueW(handle, index, buffer.as_mut_ptr(), &mut len, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
            };
            match code {
                ERROR_SUCCESS => {
                    names.insert(key(&OsString::from_wide(&buffer[..len as usize])));
                }
                ERROR_NO_MORE_ITEMS => break,
                code => {
                    failure = Some(code);
                    break;
                }
            }
        }
        unsafe { RegCloseKey(handle) };
        if let Some(code) = failure {
            bail!("reading {path}: {}", std::io::Error::from_raw_os_error(code as i32));
        }
    }
    Ok(names)
}

#[cfg(not(windows))]
fn snapshot() -> anyhow::Result<Snapshot> {
    anyhow::bail!("only Windows terminals are rebuilt from the registry")
}

#[cfg(not(windows))]
fn block() -> anyhow::Result<Vars> {
    anyhow::bail!("only Windows terminals are rebuilt from the registry")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        pairs.iter().map(|(name, value)| ((*name).into(), (*value).into())).collect()
    }
    fn lookup<'a>(vars: &'a Vars, name: &str) -> Option<&'a str> {
        vars.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.to_str().unwrap())
    }
    fn snapshot(block: &[(&str, &str)], registry: &[&str]) -> Snapshot {
        Snapshot { block: vars(block), registry: registry.iter().map(|name| key(OsStr::new(name))).collect() }
    }

    #[test]
    fn registry_variables_take_windows_current_values() {
        // At start JAVA_HOME did not exist; the user then added it and a Path entry that uses it, and
        // deleted OLD_TOOL. The runtime still carries its start-time copies.
        let start = vars(&[("Path", r"C:\Windows"), ("OLD_TOOL", "1")]);
        let now = snapshot(
            &[("Path", r"C:\Windows;D:\jdk\bin"), ("JAVA_HOME", r"D:\jdk")],
            &["Path", "JAVA_HOME"],
        );
        let merged = merge(&now, &start, &start);
        assert_eq!(lookup(&merged, "Path"), Some(r"C:\Windows;D:\jdk\bin"));
        assert_eq!(lookup(&merged, "JAVA_HOME"), Some(r"D:\jdk"));
        assert_eq!(lookup(&merged, "OLD_TOOL"), None);
    }

    #[test]
    fn variables_the_launcher_set_survive_and_the_rest_refresh() {
        let start = vars(&[("USERPROFILE", r"C:\Users\me"), ("APPDATA", r"C:\Users\me\AppData\Roaming"), ("LOGONSERVER", r"\\OLD")]);
        let current = vars(&[
            ("USERPROFILE", r"D:\scratch\home"),
            ("APPDATA", r"C:\Users\me\AppData\Roaming"),
            ("LOGONSERVER", r"\\OLD"),
            ("CODEX_HOME", r"D:\scratch\codex"),
            ("Path", r"D:\scratch\bin;C:\Windows"),
        ]);
        let now = snapshot(
            &[("USERPROFILE", r"C:\Users\me"), ("APPDATA", r"C:\Users\me\AppData\Roaming"), ("LOGONSERVER", r"\\NEW"), ("Path", r"C:\Windows")],
            &["Path"],
        );
        let merged = merge(&now, &start, &current);
        assert_eq!(lookup(&merged, "USERPROFILE"), Some(r"D:\scratch\home"));
        assert_eq!(lookup(&merged, "CODEX_HOME"), Some(r"D:\scratch\codex"));
        assert_eq!(lookup(&merged, "APPDATA"), Some(r"C:\Users\me\AppData\Roaming"));
        assert_eq!(lookup(&merged, "LOGONSERVER"), Some(r"\\NEW"));
        // As with portable-pty's overlay, the registry Path wins over a launcher's Path.
        assert_eq!(lookup(&merged, "Path"), Some(r"C:\Windows"));
    }

    #[test]
    fn removed_variables_stay_removed_and_new_ones_appear() {
        let start = vars(&[("SESSIONNAME", "Console")]);
        let now = snapshot(&[("SESSIONNAME", "Console"), ("CLIENTNAME", "laptop")], &[]);
        let merged = merge(&now, &start, &[]);
        assert_eq!(lookup(&merged, "SESSIONNAME"), None);
        assert_eq!(lookup(&merged, "CLIENTNAME"), Some("laptop"));
    }

    #[test]
    fn names_match_without_regard_to_case() {
        let start = vars(&[("PATH", r"C:\Windows")]);
        let now = snapshot(&[("Path", r"C:\Windows;D:\new")], &["path"]);
        let merged = merge(&now, &start, &start);
        assert_eq!(merged, vars(&[("Path", r"C:\Windows;D:\new")]));
    }

    #[test]
    fn the_block_keeps_names_that_begin_with_equals() {
        let wide: Vec<u16> = "=C:=C:\\x\0A=b=c\0\0ignored\0".encode_utf16().collect();
        assert_eq!(parse_block(&wide), vars(&[("=C:", r"C:\x"), ("A", "b=c")]));
        assert!(parse_block(&[0, 0]).is_empty());
    }

    #[test]
    fn a_failure_keeps_the_inherited_environment() {
        assert!(compose(&vars(&[]), || anyhow::bail!("registry unavailable")).is_none());
        // Unit tests never call `initialize`, like a runtime whose start-time snapshot failed.
        let mut command = portable_pty::CommandBuilder::new("cmd.exe");
        command.env("THREADTERM_V3_BOOTSTRAP_GATE", "gate");
        let before: Vec<(String, String)> = command.iter_full_env_as_str().map(|(name, value)| (name.to_owned(), value.to_owned())).collect();
        apply(&mut command);
        let after: Vec<(String, String)> = command.iter_full_env_as_str().map(|(name, value)| (name.to_owned(), value.to_owned())).collect();
        assert_eq!(after, before);
    }

    #[test]
    fn the_command_keeps_its_own_variables_and_drops_the_inherited_ones() {
        let mut command = portable_pty::CommandBuilder::new("cmd.exe");
        command.env("THREADTERM_V3_BOOTSTRAP_GATE", "gate");
        assert!(command.get_env("SystemRoot").is_some() || !cfg!(windows));
        replace(&mut command, vars(&[("Fresh", "1"), ("THREADTERM_V3_BOOTSTRAP_GATE", "stale")]));
        assert_eq!(command.get_env("Fresh"), Some(OsStr::new("1")));
        assert_eq!(command.get_env("THREADTERM_V3_BOOTSTRAP_GATE"), Some(OsStr::new("gate")));
        assert_eq!(command.get_env("SystemRoot"), None);
    }

    #[cfg(windows)]
    fn cmd_set(command: &mut std::process::Command) -> HashMap<String, String> {
        let output = command.output().unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(name, value)| (name.to_uppercase(), value.to_owned()))
            .collect()
    }

    #[cfg(windows)]
    fn cmd() -> std::process::Command {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
        let mut command = std::process::Command::new(format!(r"{root}\System32\cmd.exe"));
        command.args(["/d", "/c", "set"]);
        command
    }

    #[test]
    fn a_service_keeps_its_own_variables_and_removals() {
        let mut command = std::process::Command::new("node");
        command.env("THREADTERM_V3_BOOTSTRAP_GATE", "gate").env_remove("REMOVED");
        replace_service(&mut command, vars(&[("Fresh", "1"), ("THREADTERM_V3_BOOTSTRAP_GATE", "stale"), ("REMOVED", "1")]));
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(OsStr::new("Fresh"), Some(OsStr::new("1")))));
        assert!(envs.contains(&(OsStr::new("THREADTERM_V3_BOOTSTRAP_GATE"), Some(OsStr::new("gate")))));
        // After `env_clear` a removed variable is simply absent.
        assert!(!envs.iter().any(|(name, value)| *name == "REMOVED" && value.is_some()));
    }

    #[cfg(windows)]
    #[test]
    fn a_service_starts_with_only_the_given_environment() {
        let root = std::env::var("SystemRoot").unwrap();
        let mut command = cmd();
        command.env("THREADTERM_V3_BOOTSTRAP_GATE", "gate").env_remove("REMOVED");
        // A drive's current folder (`=C:`) is part of a runtime started from cmd.exe.
        replace_service(&mut command, vars(&[("SystemRoot", &root), ("Fresh", "1"), ("REMOVED", "1"), ("=C:", r"C:\")]));
        let child = cmd_set(&mut command);
        assert_eq!(child.get("FRESH").map(String::as_str), Some("1"));
        assert_eq!(child.get("THREADTERM_V3_BOOTSTRAP_GATE").map(String::as_str), Some("gate"));
        // cmd.exe adds these three itself when they are missing.
        let mut names: Vec<_> =
            child.keys().map(String::as_str).filter(|name| !["PROMPT", "COMSPEC", "PATHEXT"].contains(name)).collect();
        names.sort_unstable();
        assert_eq!(names, ["FRESH", "SYSTEMROOT", "THREADTERM_V3_BOOTSTRAP_GATE"], "inherited and removed variables are gone");
    }

    #[cfg(windows)]
    #[test]
    fn a_service_keeps_the_inherited_environment_on_failure() {
        // Unit tests never call `initialize`, like a runtime whose start-time snapshot failed.
        let mut command = cmd();
        command.env("THREADTERM_V3_BOOTSTRAP_GATE", "gate");
        apply_to_service(&mut command);
        let envs: Vec<_> = command.get_envs().collect();
        assert_eq!(envs, [(OsStr::new("THREADTERM_V3_BOOTSTRAP_GATE"), Some(OsStr::new("gate")))]);
        let child = cmd_set(&mut command);
        assert_eq!(child.get("SYSTEMROOT"), std::env::var("SystemRoot").ok().as_ref());
        assert_eq!(child.get("THREADTERM_V3_BOOTSTRAP_GATE").map(String::as_str), Some("gate"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_builds_the_users_environment_from_the_registry() {
        // Read-only: CreateEnvironmentBlock and the two Environment keys.
        let block = block().unwrap();
        for name in ["SystemRoot", "Path", "USERPROFILE", "APPDATA"] {
            assert!(lookup(&block, name).is_some_and(|value| !value.is_empty()), "{name} missing");
        }
        let registry = registry_names().unwrap();
        assert!(registry.contains(&key(OsStr::new("Path"))) && registry.contains(&key(OsStr::new("windir"))));
        assert!(!registry.contains(&key(OsStr::new("USERPROFILE"))));
    }
}
