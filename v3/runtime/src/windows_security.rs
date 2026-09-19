//! Small, isolated Windows ACL helpers.  Both pipes and the bootstrap secret
//! use a protected DACL containing only the current logon SID and LocalSystem.
use anyhow::{anyhow, Result};
use std::{ffi::c_void, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        },
        GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

pub struct SecurityAttributes {
    descriptor: *mut c_void,
    attributes: SECURITY_ATTRIBUTES,
}
impl SecurityAttributes {
    pub fn current_user_only() -> Result<Self> {
        let sddl = format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", current_sid()?);
        let wide = wide(&sddl);
        let mut descriptor = ptr::null_mut();
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            ) == 0
            {
                return Err(last_error("creating security descriptor"));
            }
        };
        Ok(Self {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            },
        })
    }
    pub fn raw(&mut self) -> *mut SECURITY_ATTRIBUTES {
        &mut self.attributes
    }
}
impl Drop for SecurityAttributes {
    fn drop(&mut self) {
        unsafe {
            if !self.descriptor.is_null() {
                LocalFree(self.descriptor as _);
            }
        }
    }
}
pub fn restrict_file_to_current_user(path: &Path) -> Result<()> {
    let acl = SecurityAttributes::current_user_only()?;
    let wide = wide(&path.as_os_str().to_string_lossy());
    unsafe {
        if SetFileSecurityW(
            wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            acl.descriptor,
        ) == 0
        {
            return Err(last_error("restricting credential ACL"));
        }
    }
    Ok(())
}
pub fn current_sid() -> Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("opening process token"));
        }
        let result = (|| {
            let mut length = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
            if length == 0 {
                return Err(last_error("sizing token information"));
            }
            let mut buffer = vec![0u8; length as usize];
            if GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                length,
                &mut length,
            ) == 0
            {
                return Err(last_error("reading token user"));
            }
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let mut raw = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut raw) == 0 {
                return Err(last_error("converting token SID"));
            }
            let sid = from_wide(raw);
            LocalFree(raw as _);
            Ok(sid)
        })();
        CloseHandle(token);
        result
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
unsafe fn from_wide(mut value: *mut u16) -> String {
    let start = value;
    while *value != 0 {
        value = value.add(1)
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(
        start,
        value.offset_from(start) as usize,
    ))
}
fn last_error(context: &str) -> anyhow::Error {
    anyhow!("{context}: {}", std::io::Error::last_os_error())
}
