//! Shared lifecycle plumbing for hidden service-style child processes
//! (Codex app-server, Claude chat sidecar).
//!
//! Windows contract (see .trellis/spec/backend/windows-background-processes.md):
//! spawn hidden (`CREATE_NO_WINDOW`), start suspended, assign the process to a
//! kill-on-close Job Object before resuming so no descendant can escape the
//! tree, and terminate the whole job on drop.

use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

#[cfg(windows)]
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
        },
    },
};

pub(crate) struct ManagedServiceChild {
    child: Child,
    #[cfg(windows)]
    job: WindowsJob,
}

impl ManagedServiceChild {
    pub(crate) fn stdin(&mut self) -> &mut Option<ChildStdin> {
        &mut self.child.stdin
    }

    pub(crate) fn stdout(&mut self) -> &mut Option<ChildStdout> {
        &mut self.child.stdout
    }

    pub(crate) fn stderr(&mut self) -> &mut Option<ChildStderr> {
        &mut self.child.stderr
    }

    #[cfg(test)]
    pub(crate) fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub(crate) async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    pub(crate) fn terminate(&mut self) {
        #[cfg(windows)]
        let _ = self.job.terminate();
        let _ = self.child.start_kill();
    }
}

impl Drop for ManagedServiceChild {
    fn drop(&mut self) {
        #[cfg(windows)]
        let _ = self.job.terminate();
        let _ = self.child.start_kill();
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsOwnedHandle(HANDLE);

// Windows kernel handles are process-wide. This wrapper owns exactly one
// handle and only closes it during Drop, so moving it between runtime threads
// does not change its validity or ownership.
#[cfg(windows)]
unsafe impl Send for WindowsOwnedHandle {}
#[cfg(windows)]
unsafe impl Sync for WindowsOwnedHandle {}

#[cfg(windows)]
impl Drop for WindowsOwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsJob {
    handle: WindowsOwnedHandle,
}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> std::io::Result<Self> {
        let job = Self {
            handle: WindowsOwnedHandle(
                unsafe { CreateJobObjectW(None, None) }.map_err(std::io::Error::other)?,
            ),
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.handle.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            )
        }
        .map_err(std::io::Error::other)?;
        Ok(job)
    }

    fn assign(&self, child: &Child) -> std::io::Result<()> {
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| std::io::Error::other("managed child has no process handle"))?;
        unsafe { AssignProcessToJobObject(self.handle.0, HANDLE(process_handle as _)) }
            .map_err(std::io::Error::other)
    }

    fn terminate(&self) -> std::io::Result<()> {
        unsafe { TerminateJobObject(self.handle.0, 1) }.map_err(std::io::Error::other)
    }
}

#[cfg(windows)]
fn resume_windows_process_threads(process_id: u32) -> std::io::Result<()> {
    let snapshot = WindowsOwnedHandle(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(std::io::Error::other)?,
    );
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };

    let mut next = unsafe { Thread32First(snapshot.0, &mut entry) };
    while next.is_ok() {
        if entry.th32OwnerProcessID == process_id {
            let thread = WindowsOwnedHandle(
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                    .map_err(std::io::Error::other)?,
            );
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
        }
        next = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    Ok(())
}

pub(crate) fn spawn_managed_service_child(
    mut command: Command,
) -> std::io::Result<ManagedServiceChild> {
    command.kill_on_drop(true);

    #[cfg(windows)]
    {
        // Start suspended so the service cannot create an untracked descendant
        // between CreateProcess and AssignProcessToJobObject.
        let job = WindowsJob::new()?;
        command.creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0);
        let mut child = command.spawn()?;
        let prepare_result = job.assign(&child).and_then(|_| {
            let process_id = child
                .id()
                .ok_or_else(|| std::io::Error::other("managed child has no process id"))?;
            resume_windows_process_threads(process_id)
        });
        if let Err(error) = prepare_result {
            let _ = job.terminate();
            let _ = child.start_kill();
            return Err(error);
        }
        Ok(ManagedServiceChild { child, job })
    }

    #[cfg(not(windows))]
    {
        Ok(ManagedServiceChild {
            child: command.spawn()?,
        })
    }
}
