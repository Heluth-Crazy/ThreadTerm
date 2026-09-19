#[cfg(windows)]
use anyhow::{anyhow, Result};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

/// Per-session Windows process-tree boundary. Dropping this handle kills only
/// descendants explicitly assigned to this session, including daemon-crash paths.
#[cfg(windows)]
pub struct SessionJob(*mut core::ffi::c_void);
#[cfg(windows)]
unsafe impl Send for SessionJob {}
#[cfg(windows)]
unsafe impl Sync for SessionJob {}
#[cfg(windows)]
impl SessionJob {
    pub fn assign(pid: u32) -> Result<Self> {
        unsafe {
            let job = CreateJobObjectW(core::ptr::null(), core::ptr::null());
            if job.is_null() {
                return Err(anyhow!(
                    "CreateJobObjectW: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = core::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &raw const info as *const _,
                core::mem::size_of_val(&info) as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err(anyhow!(
                    "SetInformationJobObject: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() || AssignProcessToJobObject(job, process) == 0 {
                if !process.is_null() {
                    CloseHandle(process);
                }
                CloseHandle(job);
                return Err(anyhow!(
                    "AssignProcessToJobObject: {}",
                    std::io::Error::last_os_error()
                ));
            }
            CloseHandle(process);
            Ok(Self(job))
        }
    }
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        fs,
        process::Command,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject},
    };

    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    fn running(pid: u32) -> bool {
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE_ACCESS, 0, pid);
            if handle.is_null() {
                return false;
            }
            let active = WaitForSingleObject(handle, 0) != WAIT_OBJECT_0;
            CloseHandle(handle);
            active
        }
    }

    #[test]
    fn dropping_session_job_ends_parent_and_descendant_tree() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids.txt");
        let escaped = pids.to_string_lossy().replace("'", "''");
        // Delay descendant creation until after AssignProcessToJobObject. This
        // proves close-on-owner-loss recursively terminates descendants.
        let script=format!("Start-Sleep -Milliseconds 500; $c=Start-Process powershell -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 30' -PassThru; Set-Content -LiteralPath '{}' -Value \"$PID,$($c.Id)\"; Start-Sleep -Seconds 30",escaped);
        let mut parent = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .spawn()
            .unwrap();
        let parent_pid = parent.id();
        let job = SessionJob::assign(parent_pid).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pids.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(pids.exists(), "parent did not create descendant");
        let text = fs::read_to_string(&pids).unwrap();
        let ids: Vec<u32> = text.trim().split(',').map(|v| v.parse().unwrap()).collect();
        assert_eq!(ids[0], parent_pid);
        assert!(running(ids[1]));
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(5);
        while (running(ids[0]) || running(ids[1])) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            !running(ids[0]) && !running(ids[1]),
            "Job close left a process alive"
        );
        let _ = parent.wait();
    }
}
#[cfg(windows)]
impl Drop for SessionJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
#[cfg(not(windows))]
pub struct SessionJob;
#[cfg(not(windows))]
impl SessionJob {
    pub fn assign(_pid: u32) -> anyhow::Result<Self> {
        Ok(Self)
    }
}
