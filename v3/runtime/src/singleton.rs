use anyhow::{anyhow, Result};
#[cfg(windows)]
pub struct RuntimeLock(*mut core::ffi::c_void);
#[cfg(windows)]
impl RuntimeLock {
    pub fn acquire(name: &str) -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_ALREADY_EXISTS},
            System::Threading::CreateMutexW,
        };
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let handle = CreateMutexW(core::ptr::null(), 0, wide.as_ptr());
            if handle.is_null() {
                return Err(anyhow!(
                    "creating runtime singleton: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32) {
                CloseHandle(handle);
                return Err(anyhow!("runtime already running"));
            }
            Ok(Self(handle))
        }
    }
}
#[cfg(windows)]
impl Drop for RuntimeLock {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(not(windows))]
pub struct RuntimeLock;
#[cfg(not(windows))]
impl RuntimeLock {
    pub fn acquire(_name: &str) -> Result<Self> {
        Ok(Self)
    }
}
