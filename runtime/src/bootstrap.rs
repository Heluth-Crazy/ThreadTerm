//! A trusted ConPTY bootstrap waits for its parent to assign the session Job.
//! No external program can execute before the parent releases the private gate.
use anyhow::{bail, Context, Result};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Read,
    os::windows::ffi::OsStrExt,
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{WriteFile, PIPE_ACCESS_OUTBOUND},
    System::{
        Console::{SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT},
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_NOWAIT,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        },
    },
};
const GATE_ENV: &str = "THREADTERM_V3_BOOTSTRAP_GATE";
const COMMAND_ENV: &str = "THREADTERM_V3_BOOTSTRAP_COMMAND";
const ENV_REF_PREFIX: &str = "THREADTERM_V3_BOOTSTRAP_ENV_";
#[cfg(test)]
#[path = "bootstrap_test_support.rs"]
pub(crate) mod test_support;
#[derive(Serialize, Deserialize)]
struct Launch {
    program: String,
    args: Vec<String>,
    cwd: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    env_refs: Vec<(String, String)>,
    #[serde(default)]
    payload_ref: Option<String>,
}

pub struct BootstrapGate {
    handle: HANDLE,
    name: String,
}
// The gate is owned by the launch thread; Win32 handles are transferable.
unsafe impl Send for BootstrapGate {}
impl BootstrapGate {
    pub fn new() -> Result<Self> {
        let name = format!(r"\\.\pipe\threadterm-v3-bootstrap-{}", uuid::Uuid::new_v4());
        let wide: Vec<u16> = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut acl = crate::windows_security::SecurityAttributes::current_user_only()?;
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_OUTBOUND,
                PIPE_TYPE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                16,
                16,
                10_000,
                acl.raw(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self { handle, name })
    }
    pub fn command(&self, program: &str, args: &[String], cwd: &str) -> Result<CommandBuilder> {
        let mut command = CommandBuilder::new(std::env::current_exe()?);
        #[cfg(not(test))]
        command.arg("--pty-bootstrap");
        #[cfg(test)]
        command.args([
            "--exact",
            "bootstrap::tests::bootstrap_helper",
            "--nocapture",
        ]);
        command.cwd(cwd);
        command.env(GATE_ENV, &self.name);
        command.env(
            COMMAND_ENV,
            serde_json::to_string(&Launch {
                program: program.to_owned(),
                args: args.to_vec(),
                cwd: cwd.to_owned(),
                hidden: false,
                env_refs: Vec::new(),
                payload_ref: None,
            })?,
        );
        #[cfg(test)]
        test_support::prepare_initial_pty(&mut command);
        Ok(command)
    }
    pub fn service_command(
        &self,
        program: &str,
        args: &[String],
        cwd: &str,
    ) -> Result<std::process::Command> {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(std::env::current_exe()?);
        #[cfg(not(test))]
        command.arg("--pty-bootstrap");
        #[cfg(test)]
        command.args([
            "--exact",
            "bootstrap::tests::bootstrap_helper",
            "--nocapture",
        ]);
        command.current_dir(cwd).env(GATE_ENV, &self.name).env(
            COMMAND_ENV,
            serde_json::to_string(&Launch {
                program: program.to_owned(),
                args: args.to_vec(),
                cwd: cwd.to_owned(),
                hidden: true,
                env_refs: Vec::new(),
                payload_ref: None,
            })?,
        );
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        #[cfg(test)]
        test_support::prepare_service(&mut command);
        Ok(command)
    }
    /// Only the exact trusted child PID may receive the release byte.
    pub fn release(&self, expected_pid: u32) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let connected = unsafe { ConnectNamedPipe(self.handle, ptr::null_mut()) };
            let error = std::io::Error::last_os_error();
            if connected != 0 || error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
                break;
            }
            if Instant::now() >= deadline {
                bail!("PTY bootstrap connection timed out: {error}")
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut pid = 0;
        if unsafe { GetNamedPipeClientProcessId(self.handle, &mut pid) } == 0 || pid != expected_pid
        {
            bail!("PTY bootstrap gate client identity mismatch")
        }
        let byte = [1u8];
        let mut written = 0;
        if unsafe { WriteFile(self.handle, byte.as_ptr(), 1, &mut written, ptr::null_mut()) } == 0
            || written != 1
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}
impl Drop for BootstrapGate {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

unsafe extern "system" fn keep_bootstrap_alive(signal: u32) -> i32 {
    i32::from(signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT)
}

fn direct_cmd_payload<'a>(program: &str, args: &'a [String]) -> Option<(&'a [String], &'a str)> {
    let is_cmd = program
        .rsplit(['\\', '/'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"));
    let command_index = args
        .iter()
        .position(|arg| arg.eq_ignore_ascii_case("/c"))?;
    if !is_cmd
        || !args[..command_index]
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("/s"))
        || command_index + 2 != args.len()
    {
        return None;
    }
    Some((&args[..=command_index], &args[command_index + 1]))
}

pub(crate) fn application_environment(
    command: &mut CommandBuilder,
    overrides: &[(String, String)],
) -> Result<()> {
    let config = command
        .get_env(COMMAND_ENV)
        .and_then(|value| value.to_str())
        .context("missing PTY bootstrap command")?;
    let mut launch: Launch = serde_json::from_str(config)?;
    launch.env_refs.clear();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    if launch.payload_ref.is_none() && direct_cmd_payload(&launch.program, &launch.args).is_some() {
        let reference = format!("{ENV_REF_PREFIX}{nonce}_payload");
        if let Some(payload) = launch.args.last_mut() {
            command.env(&reference, &*payload);
            payload.clear();
            launch.payload_ref = Some(reference);
        }
    }
    for (index, (name, value)) in overrides.iter().enumerate() {
        let reference = format!("{ENV_REF_PREFIX}{nonce}_{index}");
        command.env(&reference, value);
        launch.env_refs.push((name.clone(), reference));
    }
    command.env(COMMAND_ENV, serde_json::to_string(&launch)?);
    Ok(())
}

pub(crate) fn is_control_environment_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(GATE_ENV) || name.eq_ignore_ascii_case(COMMAND_ENV)
}

pub fn run() -> Result<i32> {
    let gate = std::env::var(GATE_ENV).context("missing PTY bootstrap gate")?;
    if !gate.starts_with(r"\\.\pipe\threadterm-v3-bootstrap-") {
        bail!("invalid PTY bootstrap gate")
    }
    let config = std::env::var(COMMAND_ENV).context("missing PTY bootstrap command")?;
    if config.len() > 128 * 1024 {
        bail!("PTY bootstrap command is too large")
    }
    let mut config: Launch = serde_json::from_str(&config)?;
    if let Some(reference) = &config.payload_ref {
        if !reference.starts_with(ENV_REF_PREFIX) { bail!("invalid PTY bootstrap payload reference"); }
        let payload = std::env::var(reference).context("missing PTY bootstrap payload carrier")?;
        *config.args.last_mut().context("missing PTY bootstrap payload argument")? = payload;
    }
    let environment: Vec<_> = config
        .env_refs
        .iter()
        .map(|(name, reference)| {
            if !reference.starts_with(ENV_REF_PREFIX) {
                bail!("invalid PTY bootstrap environment reference")
            }
            let value = std::env::var(reference)
                .with_context(|| format!("missing PTY bootstrap environment value for {name}"))?;
            Ok((name.clone(), reference.clone(), value))
        })
        .collect::<Result<_>>()?;
    let mut pipe = OpenOptions::new()
        .read(true)
        .open(&gate)
        .context("opening PTY bootstrap gate")?;
    let mut release = [0u8];
    pipe.read_exact(&mut release)
        .context("parent did not release PTY bootstrap")?;
    if release != [1] {
        bail!("invalid PTY bootstrap release")
    }
    drop(pipe);
    // The desktop starts the runtime detached, i.e. in a new process group, which ignores Ctrl-C,
    // and that setting is inherited by every process started after it. Restore normal Ctrl-C
    // processing so the terminal's application (and what it starts) can be interrupted again; the
    // helper itself survives Ctrl-C long enough to wait for its child and forward its exit code.
    if !config.hidden
        && (unsafe { SetConsoleCtrlHandler(None, 0) } == 0
            || unsafe { SetConsoleCtrlHandler(Some(keep_bootstrap_alive), 1) } == 0)
    {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut command =
        match crate::providers::common::windows_script_invocation(&config.program, &config.args)? {
            Some(invocation) => {
                use std::os::windows::process::CommandExt;
                let mut command = std::process::Command::new(&invocation.program);
                command.args(&invocation.args);
                // Fully prepared cmd.exe command line; must reach CreateProcess
                // verbatim because cmd.exe applies its own quote rules.
                command.raw_arg(&invocation.raw_payload);
                command
            }
            None => {
                use std::os::windows::process::CommandExt;
                let mut command = std::process::Command::new(&config.program);
                if let Some((flags, payload)) = direct_cmd_payload(&config.program, &config.args) {
                    command.args(flags);
                    // `/S` strips these outer quotes before cmd.exe parses the
                    // command, leaving the payload's own quotes unchanged.
                    command.raw_arg(format!(" \"{payload}\""));
                } else {
                    command.args(&config.args);
                }
                command
            }
        };
    command
        .current_dir(&config.cwd)
        .env_remove(GATE_ENV)
        .env_remove(COMMAND_ENV);
    if let Some(reference) = &config.payload_ref { command.env_remove(reference); }
    for (_, reference, _) in &environment {
        command.env_remove(reference);
    }
    for (name, _) in std::env::vars_os() {
        if name
            .to_str()
            .is_some_and(|name| environment.iter().any(|(key, _, _)| key.eq_ignore_ascii_case(name)))
        {
            command.env_remove(name);
        }
    }
    for (name, _, value) in environment {
        command.env(name, value);
    }
    if config.hidden {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let status = command
        .status()
        .context("launching supervised application")?;
    Ok(status.code().unwrap_or(1))
}
#[cfg(test)]
mod tests {
    #[test]
    fn bootstrap_helper() {
        if std::env::var_os(super::GATE_ENV).is_some() {
            super::test_support::restore_term();
            match super::run() {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("{error:#}");
                    std::process::exit(1)
                }
            }
        }
    }
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;
    use crate::job::SessionJob;
    use std::io::Read;
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenProcess, WaitForSingleObject},
    };
    fn running(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(0x0010_0000, 0, pid);
            if h.is_null() {
                return false;
            }
            let active = WaitForSingleObject(h, 0) != WAIT_OBJECT_0;
            CloseHandle(h);
            active
        }
    }
    #[test]
    fn bootstrap_gate_prevents_early_children_and_job_ends_immediate_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pids.txt");
        let literal = pidfile.to_string_lossy().replace('\'', "''");
        let script=format!("$c=Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru; [System.IO.File]::WriteAllText('{}',\"$PID,$($c.Id)\"); Start-Sleep -Seconds 30",literal);
        let gate = BootstrapGate::new().unwrap();
        let args = vec!["-NoProfile".to_owned(), "-Command".to_owned(), script];
        let command = gate
            .command("powershell.exe", &args, dir.path().to_str().unwrap())
            .unwrap();
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        let bootstrap_pid = child.process_id().unwrap();
        // The trusted child may run arbitrary bootstrap initialization here, but no
        // external application may start until our per-session Job exists.
        std::thread::sleep(Duration::from_millis(150));
        assert!(!pidfile.exists());
        let job = SessionJob::assign(bootstrap_pid).unwrap();
        gate.release(bootstrap_pid).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        while !pidfile.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            pidfile.exists(),
            "external application did not start after release"
        );
        let ids: Vec<u32> = std::fs::read_to_string(&pidfile)
            .unwrap()
            .split(',')
            .map(|s| s.parse().unwrap())
            .collect();
        assert!(running(bootstrap_pid) && running(ids[0]) && running(ids[1]));
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(5);
        while [bootstrap_pid, ids[0], ids[1]].into_iter().any(running) && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !running(bootstrap_pid) && !running(ids[0]) && !running(ids[1]),
            "Job close left bootstrap or immediate descendants alive"
        );
        let _ = child.wait();
    }

    #[test]
    fn direct_cmd_payload_survives_the_real_bootstrap_gate() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("快速 启动");
        std::fs::create_dir(&cwd).unwrap();
        let payload = "set PERCENT=VALUE& echo __QT_CWD__%CD% & echo __QT_QUOTED__\"a b\" & echo __QT_PERCENT__100%PERCENT%|findstr __QT_PERCENT__";
        let args = vec![
            "/D".to_owned(),
            "/S".to_owned(),
            "/C".to_owned(),
            payload.to_owned(),
        ];
        let gate = BootstrapGate::new().unwrap();
        let command = gate.command("cmd.exe", &args, cwd.to_str().unwrap()).unwrap();
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        gate.release(pid).unwrap();
        assert_eq!(child.wait().unwrap().exit_code(), 0);
        drop(pair.slave);
        drop(pair.master);
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        let output = String::from_utf8_lossy(&output);
        assert!(
            output.contains(&format!("__QT_CWD__{}", cwd.display())),
            "CJK cwd was changed: {output:?}"
        );
        assert!(
            output.contains("__QT_QUOTED__\"a b\""),
            "quotes reached cmd with extra escaping: {output:?}"
        );
        assert!(
            output.contains("__QT_PERCENT__100VALUE"),
            "&, |, or %VAR% did not survive: {output:?}"
        );
    }
}
