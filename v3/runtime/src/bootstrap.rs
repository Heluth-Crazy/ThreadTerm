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
#[derive(Serialize, Deserialize)]
struct Launch {
    program: String,
    args: Vec<String>,
    cwd: String,
    #[serde(default)]
    hidden: bool,
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
            })?,
        );
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
            })?,
        );
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
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
pub fn run() -> Result<i32> {
    let gate = std::env::var(GATE_ENV).context("missing PTY bootstrap gate")?;
    if !gate.starts_with(r"\\.\pipe\threadterm-v3-bootstrap-") {
        bail!("invalid PTY bootstrap gate")
    }
    let config = std::env::var(COMMAND_ENV).context("missing PTY bootstrap command")?;
    if config.len() > 128 * 1024 {
        bail!("PTY bootstrap command is too large")
    }
    let config: Launch = serde_json::from_str(&config)?;
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
    // The actual application still receives console control events. The helper
    // survives Ctrl-C long enough to wait for its child and forward its exit code.
    if !config.hidden && unsafe { SetConsoleCtrlHandler(Some(keep_bootstrap_alive), 1) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut command = std::process::Command::new(&config.program);
    command
        .args(&config.args)
        .current_dir(&config.cwd)
        .env_remove(GATE_ENV)
        .env_remove(COMMAND_ENV);
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
}
