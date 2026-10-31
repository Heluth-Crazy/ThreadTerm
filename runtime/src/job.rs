#[cfg(windows)]
use anyhow::{anyhow, Result};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
            JobObjectExtendedLimitInformation, QueryInformationJobObject,
            SetInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

/// Bound on the assigned-process list: a run whose tree explodes is not worth
/// another query, and readiness only needs the listeners it can see.
#[cfg(windows)]
const MAX_PROCESS_IDS: usize = 4096;

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

    /// Pids currently assigned to this job: the run's whole process tree, which
    /// is what port readiness scans for listeners. An unavailable list is an
    /// empty one, never an error the caller has to handle while polling.
    pub fn process_ids(&self) -> Vec<u32> {
        let header = core::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        let word = core::mem::size_of::<usize>();
        // The ids start after the two counters, not after the struct: its trailing
        // [usize; 1] makes the struct longer than that offset.
        let first = core::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) / word;
        let ids = |buffer: &[usize], fits: usize| -> Vec<u32> {
            buffer[first..first + fits]
                .iter()
                .map(|pid| *pid as u32)
                .collect()
        };
        let mut capacity = 64usize;
        loop {
            capacity = capacity.min(MAX_PROCESS_IDS);
            // Room for the header and `capacity` ids, word-aligned for the FFI write.
            let mut buffer = vec![0usize; first + capacity];
            let bytes = (header + (capacity - 1) * word) as u32;
            let mut returned = 0u32;
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    bytes,
                    &raw mut returned,
                )
            };
            let list = buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            let (assigned, listed) = unsafe {
                (
                    (*list).NumberOfAssignedProcesses as usize,
                    (*list).NumberOfProcessIdsInList as usize,
                )
            };
            let fits = listed.min(capacity);
            // A list that fits is the answer. A longer one is asked for again with
            // more room; at the cap the ids that fit are still the best answer.
            let more = ok == 0 && std::io::Error::last_os_error().raw_os_error() == Some(234);
            if ok != 0 && assigned <= capacity {
                return ids(&buffer, fits);
            }
            if capacity == MAX_PROCESS_IDS {
                return if ok != 0 || more {
                    ids(&buffer, fits)
                } else {
                    Vec::new()
                };
            }
            if ok == 0 && !more {
                return Vec::new();
            }
            capacity = capacity.saturating_mul(2);
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
    fn process_ids_lists_the_root_process_and_its_descendant() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("tree.txt");
        let escaped = pids.to_string_lossy().replace("'", "''");
        // The descendant is created after the assignment, so it belongs to the job.
        let script = format!("Start-Sleep -Milliseconds 500; $c=Start-Process powershell -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 30' -PassThru; Set-Content -LiteralPath '{}' -Encoding ascii -Value \"$PID,$($c.Id)\"; Start-Sleep -Seconds 30", escaped);
        let mut parent = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .spawn()
            .unwrap();
        let job = SessionJob::assign(parent.id()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        // The list must hold the tree's first process too, not only its descendants.
        let ids = loop {
            let ids = job.process_ids();
            if ids.contains(&parent.id()) && ids.len() >= 2 {
                break ids;
            }
            assert!(
                Instant::now() < deadline,
                "the job list never showed the tree: {ids:?}"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        assert!(ids.contains(&parent.id()), "the root pid is listed: {ids:?}");
        assert!(
            ids.iter().filter(|pid| **pid != 0).count() >= 2,
            "no zero padding in the list: {ids:?}"
        );
        drop(job);
        let _ = parent.wait();
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
        // PowerShell may still hold the file open (OS error 32) right after it appears: retry the read.
        let ids: Vec<u32> = loop {
            let parsed = fs::read_to_string(&pids).ok().and_then(|text| {
                text.trim().split(',').map(|value| value.parse().ok()).collect::<Option<Vec<u32>>>().filter(|ids| ids.len() == 2)
            });
            if let Some(ids) = parsed {
                break ids;
            }
            assert!(Instant::now() < deadline, "the pid file never became readable");
            std::thread::sleep(Duration::from_millis(25));
        };
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
    /// No job objects here, so readiness falls back to the output scanner.
    pub fn process_ids(&self) -> Vec<u32> {
        Vec::new()
    }
}
