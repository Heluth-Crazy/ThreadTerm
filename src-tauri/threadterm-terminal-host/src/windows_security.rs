use std::{
    ffi::c_void,
    fs::File,
    mem::size_of,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::Path,
    ptr,
};

use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, LocalFree, GENERIC_ALL, HANDLE, HLOCAL},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                ConvertStringSidToSidW, GetNamedSecurityInfoW, GetSecurityInfo,
                SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
            },
            EqualSid, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
            GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL, CONTAINER_INHERIT_ACE,
            DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, INHERITED_ACE,
            OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::{
            SystemServices::ACCESS_ALLOWED_ACE_TYPE,
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    },
};

use crate::HostError;

const SYSTEM_SID: &str = "S-1-5-18";

pub struct ProtectedSecurityAttributes {
    descriptor: PSECURITY_DESCRIPTOR,
    attributes: SECURITY_ATTRIBUTES,
    sddl: String,
    sid: String,
}

impl ProtectedSecurityAttributes {
    pub fn for_sid(sid: &str) -> Result<Self, HostError> {
        Self::from_sddl(sid, format!("O:{sid}G:{sid}D:P(A;;GA;;;SY)(A;;GA;;;{sid})"))
    }

    pub fn for_directory_sid(sid: &str) -> Result<Self, HostError> {
        Self::from_sddl(
            sid,
            format!("O:{sid}G:{sid}D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;{sid})"),
        )
    }

    fn from_sddl(sid: &str, sddl: String) -> Result<Self, HostError> {
        if sid.trim().is_empty() {
            return Err(HostError::Security);
        }
        let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|_| HostError::Security)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        Ok(Self {
            descriptor,
            attributes,
            sddl,
            sid: sid.to_owned(),
        })
    }

    pub fn as_mut_ptr(&self) -> *mut SECURITY_ATTRIBUTES {
        (&self.attributes as *const SECURITY_ATTRIBUTES).cast_mut()
    }

    pub fn sddl(&self) -> &str {
        &self.sddl
    }
    pub fn sid(&self) -> &str {
        &self.sid
    }
}

impl Drop for ProtectedSecurityAttributes {
    fn drop(&mut self) {
        unsafe { LocalFree(Some(HLOCAL(self.descriptor.0))) };
    }
}

pub fn current_process_sid() -> Result<String, HostError> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(|_| HostError::Security)?;
    let result = (|| {
        let mut required = 0_u32;
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut required) };
        if required < size_of::<TOKEN_USER>() as u32 {
            return Err(HostError::Security);
        }
        let mut buffer = vec![0_u8; required as usize];
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                required,
                &mut required,
            )
        }
        .map_err(|_| HostError::Security)?;
        let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
        let mut string = PWSTR::null();
        unsafe { ConvertSidToStringSidW(user.User.Sid, &mut string) }
            .map_err(|_| HostError::Security)?;
        let value = unsafe { string.to_string() }.map_err(|_| HostError::Security)?;
        unsafe { LocalFree(Some(HLOCAL(string.0.cast()))) };
        Ok(value)
    })();
    let _ = unsafe { CloseHandle(token) };
    result
}

pub fn protect_and_validate_path(path: &Path, sid: &str) -> Result<(), HostError> {
    let metadata = std::fs::metadata(path).map_err(|_| HostError::Security)?;
    let descriptor = if metadata.is_dir() {
        ProtectedSecurityAttributes::for_directory_sid(sid)?
    } else {
        ProtectedSecurityAttributes::for_sid(sid)?
    };
    let mut present = windows::core::BOOL::default();
    let mut defaulted = windows::core::BOOL::default();
    let mut dacl: *mut ACL = ptr::null_mut();
    unsafe {
        GetSecurityDescriptorDacl(
            descriptor.descriptor,
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    }
    .map_err(|_| HostError::Security)?;
    if !present.as_bool() || dacl.is_null() {
        return Err(HostError::Security);
    }
    let owner = allocated_sid(sid)?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        SetNamedSecurityInfoW(
            PWSTR(wide.as_ptr().cast_mut()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | GROUP_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            Some(owner),
            Some(owner),
            Some(dacl),
            None,
        )
    };
    unsafe { LocalFree(Some(HLOCAL(owner.0))) };
    if result.0 != 0 {
        return Err(HostError::Security);
    }
    validate_path_acl(path, sid)
}

pub fn validate_path_acl(path: &Path, sid: &str) -> Result<(), HostError> {
    validate_path_acl_internal(path, sid, true)
}

pub fn validate_inherited_safe_path(path: &Path, sid: &str) -> Result<(), HostError> {
    validate_path_acl_internal(path, sid, false)
}

fn validate_path_acl_internal(
    path: &Path,
    sid: &str,
    require_protected: bool,
) -> Result<(), HostError> {
    let metadata = std::fs::metadata(path).map_err(|_| HostError::Security)?;
    let (required_ace_flags, allowed_extra_ace_flags) = if metadata.is_dir() {
        ((OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE).0 as u8, 0)
    } else if require_protected {
        (0, 0)
    } else {
        (0, INHERITED_ACE.0 as u8)
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut owner = PSID::default();
    let mut group = PSID::default();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let result = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            Some(&mut group),
            Some(&mut dacl),
            None,
            &mut descriptor,
        )
    };
    if result.0 != 0 || dacl.is_null() {
        return Err(HostError::Security);
    }
    let expected = allocated_sid(sid)?;
    let ownership_matches = unsafe { EqualSid(owner, expected) }.is_ok()
        && unsafe { EqualSid(group, expected) }.is_ok();
    unsafe { LocalFree(Some(HLOCAL(expected.0))) };
    let mut control = 0_u16;
    let mut revision = 0_u32;
    let protected =
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }.is_ok()
            && (control & SE_DACL_PROTECTED.0) != 0;
    let validation = if ownership_matches && (!require_protected || protected) {
        validate_exact_dacl(
            dacl,
            sid,
            windows::Win32::Storage::FileSystem::FILE_ALL_ACCESS.0,
            required_ace_flags,
            allowed_extra_ace_flags,
        )
    } else {
        Err(HostError::Security)
    };
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    validation
}

pub fn create_private_file_new(path: &Path, sid: &str) -> Result<File, HostError> {
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_MODE,
    };
    let security = ProtectedSecurityAttributes::for_sid(sid)?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_MODE(0),
            Some(security.as_mut_ptr()),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    }
    .map_err(|_| HostError::Io)?;
    let file = unsafe { File::from_raw_handle(handle.0) };
    validate_path_acl(path, sid)?;
    Ok(file)
}

pub fn open_private_file_read(path: &Path, sid: &str) -> Result<File, HostError> {
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
        FILE_SHARE_DELETE, FILE_SHARE_READ, OPEN_EXISTING,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    }
    .map_err(|_| HostError::Io)?;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut information) }.is_err()
        || information.dwFileAttributes
            & (FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0)
            != 0
        || validate_handle_acl(handle, sid, true).is_err()
    {
        let _ = unsafe { CloseHandle(handle) };
        return Err(HostError::Security);
    }
    Ok(unsafe { File::from_raw_handle(handle.0) })
}

fn validate_handle_acl(
    handle: HANDLE,
    sid: &str,
    require_protected: bool,
) -> Result<(), HostError> {
    validate_handle_security(
        handle,
        SE_FILE_OBJECT,
        sid,
        require_protected,
        windows::Win32::Storage::FileSystem::FILE_ALL_ACCESS.0,
    )
}

pub fn validate_kernel_handle_acl(handle: HANDLE, sid: &str) -> Result<(), HostError> {
    validate_handle_security(
        handle,
        SE_KERNEL_OBJECT,
        sid,
        true,
        windows::Win32::System::Threading::MUTEX_ALL_ACCESS.0,
    )
}

fn validate_handle_security(
    handle: HANDLE,
    object_type: windows::Win32::Security::Authorization::SE_OBJECT_TYPE,
    sid: &str,
    require_protected: bool,
    full_access_mask: u32,
) -> Result<(), HostError> {
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut owner = PSID::default();
    let mut group = PSID::default();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let result = unsafe {
        GetSecurityInfo(
            handle,
            object_type,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            Some(&mut group),
            Some(&mut dacl),
            None,
            Some(&mut descriptor),
        )
    };
    if result.0 != 0 || dacl.is_null() {
        return Err(HostError::Security);
    }
    let expected = allocated_sid(sid)?;
    let ownership_matches = unsafe { EqualSid(owner, expected) }.is_ok()
        && unsafe { EqualSid(group, expected) }.is_ok();
    unsafe { LocalFree(Some(HLOCAL(expected.0))) };
    let mut control = 0_u16;
    let mut revision = 0_u32;
    let protected =
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }.is_ok()
            && (control & SE_DACL_PROTECTED.0) != 0;
    let validation = if ownership_matches && (!require_protected || protected) {
        validate_exact_dacl(dacl, sid, full_access_mask, 0, 0)
    } else {
        Err(HostError::Security)
    };
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    validation
}

pub fn create_or_validate_private_directory(path: &Path, sid: &str) -> Result<(), HostError> {
    use windows::Win32::Storage::FileSystem::CreateDirectoryW;
    if path.exists() {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| HostError::Security)?;
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Err(HostError::Security);
        }
        return validate_path_acl(path, sid);
    }
    let security = ProtectedSecurityAttributes::for_directory_sid(sid)?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { CreateDirectoryW(PCWSTR(wide.as_ptr()), Some(security.as_mut_ptr())) }
        .map_err(|_| HostError::Security)?;
    validate_path_acl(path, sid)
}

fn validate_exact_dacl(
    dacl: *const ACL,
    sid: &str,
    full_access_mask: u32,
    required_ace_flags: u8,
    allowed_extra_ace_flags: u8,
) -> Result<(), HostError> {
    let user = allocated_sid(sid)?;
    let system = allocated_sid(SYSTEM_SID)?;
    let result = (|| {
        let acl = unsafe { &*dacl };
        if acl.AceCount != 2 {
            return Err(HostError::Security);
        }
        let mut user_seen = false;
        let mut system_seen = false;
        for index in 0..2 {
            let mut raw: *mut c_void = ptr::null_mut();
            unsafe { GetAce(dacl, index, &mut raw) }.map_err(|_| HostError::Security)?;
            if raw.is_null() {
                return Err(HostError::Security);
            }
            let ace = unsafe { &*(raw.cast::<ACCESS_ALLOWED_ACE>()) };
            if u32::from(ace.Header.AceType) != ACCESS_ALLOWED_ACE_TYPE
                || (ace.Mask != GENERIC_ALL.0 && ace.Mask != full_access_mask)
                || ace.Header.AceFlags & !allowed_extra_ace_flags != required_ace_flags
            {
                return Err(HostError::Security);
            }
            let ace_sid = PSID((&ace.SidStart as *const u32).cast_mut().cast());
            if unsafe { EqualSid(ace_sid, user) }.is_ok() {
                user_seen = true;
            } else if unsafe { EqualSid(ace_sid, system) }.is_ok() {
                system_seen = true;
            } else {
                return Err(HostError::Security);
            }
        }
        (user_seen && system_seen)
            .then_some(())
            .ok_or(HostError::Security)
    })();
    unsafe {
        LocalFree(Some(HLOCAL(user.0)));
        LocalFree(Some(HLOCAL(system.0)));
    }
    result
}

fn allocated_sid(value: &str) -> Result<PSID, HostError> {
    let wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut sid = PSID::default();
    unsafe { ConvertStringSidToSidW(PCWSTR(wide.as_ptr()), &mut sid) }
        .map_err(|_| HostError::Security)?;
    Ok(sid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;
    use terminal_host_protocol::PROTOCOL_VERSION;

    #[test]
    fn strict_directory_and_direct_or_safely_inherited_files_validate() {
        let temp = tempdir().unwrap();
        let sid = current_process_sid().unwrap();
        let root = temp.path().join("terminal-host");
        create_or_validate_private_directory(&root, &sid).unwrap();
        validate_path_acl(&root, &sid).unwrap();

        let direct = root.join("runtime.secret");
        drop(create_private_file_new(&direct, &sid).unwrap());
        validate_path_acl(&direct, &sid).unwrap();

        let inherited = root.join("runtime.sqlite-wal");
        drop(std::fs::File::create(&inherited).unwrap());
        validate_inherited_safe_path(&inherited, &sid).unwrap();
        protect_and_validate_path(&inherited, &sid).unwrap();
        validate_path_acl(&inherited, &sid).unwrap();
    }

    #[test]
    fn broad_everyone_ace_is_rejected() {
        use windows::Win32::Storage::FileSystem::CreateDirectoryW;
        let temp = tempdir().unwrap();
        let sid = current_process_sid().unwrap();
        let root = temp.path().join("terminal-host");
        let broad = ProtectedSecurityAttributes::from_sddl(
            &sid,
            format!("O:{sid}G:{sid}D:P(A;OICI;GA;;;WD)"),
        )
        .unwrap();
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { CreateDirectoryW(PCWSTR(wide.as_ptr()), Some(broad.as_mut_ptr())) }.unwrap();
        assert_eq!(validate_path_acl(&root, &sid), Err(HostError::Security));
        assert_eq!(
            create_or_validate_private_directory(&root, &sid),
            Err(HostError::Security)
        );
    }

    #[test]
    fn private_directory_without_child_inheritance_is_rejected() {
        use windows::Win32::Storage::FileSystem::CreateDirectoryW;
        let temp = tempdir().unwrap();
        let sid = current_process_sid().unwrap();
        let root = temp.path().join("terminal-host");
        let non_inheriting = ProtectedSecurityAttributes::from_sddl(
            &sid,
            format!("O:{sid}G:{sid}D:P(A;;GA;;;SY)(A;;GA;;;{sid})"),
        )
        .unwrap();
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { CreateDirectoryW(PCWSTR(wide.as_ptr()), Some(non_inheriting.as_mut_ptr())) }
            .unwrap();
        assert_eq!(validate_path_acl(&root, &sid), Err(HostError::Security));
        assert_eq!(
            create_or_validate_private_directory(&root, &sid),
            Err(HostError::Security)
        );
    }

    #[test]
    fn endpoint_publish_replaces_broad_destination_with_exact_acl() {
        use crate::bootstrap::{
            publish_endpoint_atomic, read_endpoint, NoopPublishObserver, RuntimeEndpoint,
            ENDPOINT_SCHEMA_VERSION,
        };
        use windows::Win32::Storage::FileSystem::CreateFileW;
        use windows::Win32::Storage::FileSystem::{
            CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE, FILE_SHARE_MODE,
        };
        let temp = tempdir().unwrap();
        let sid = current_process_sid().unwrap();
        let path = temp.path().join("runtime.endpoint.json");
        let broad =
            ProtectedSecurityAttributes::from_sddl(&sid, format!("O:{sid}G:{sid}D:P(A;;GA;;;WD)"))
                .unwrap();
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                Some(broad.as_mut_ptr()),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .unwrap();
        let mut file = unsafe { File::from_raw_handle(handle.0) };
        file.write_all(b"stale").unwrap();
        drop(file);
        assert_eq!(validate_path_acl(&path, &sid), Err(HostError::Security));
        let endpoint = RuntimeEndpoint {
            schema_version: ENDPOINT_SCHEMA_VERSION,
            protocol_min: PROTOCOL_VERSION,
            protocol_max: PROTOCOL_VERSION,
            runtime_id: "runtime".into(),
            pid: 1,
            process_start_time: "1".into(),
            pipe_name: r"\\.\pipe\ThreadTerm.TerminalHost.secure-replace".into(),
            daemon_version: "test".into(),
            launch_nonce: "nonce".into(),
            owner_generation: 1,
        };
        publish_endpoint_atomic(&path, &endpoint, &NoopPublishObserver).unwrap();
        validate_path_acl(&path, &sid).unwrap();
        assert_eq!(read_endpoint(&path).unwrap(), endpoint);
    }
}
