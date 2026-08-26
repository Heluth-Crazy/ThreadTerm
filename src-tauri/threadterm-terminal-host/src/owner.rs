use std::{
    fmt,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use sha2::{Digest, Sha256};

use crate::{
    bootstrap::{EndpointIdentity, OwnerCleanupProof},
    HostError,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientRole {
    ConnectOnly,
    EnsureRunning,
    BecomeOwner,
}

impl ClientRole {
    pub fn parse(value: &str) -> Result<Self, HostError> {
        match value {
            "connect-only" => Ok(Self::ConnectOnly),
            "ensure-running" => Ok(Self::EnsureRunning),
            "become-owner" => Ok(Self::BecomeOwner),
            _ => Err(HostError::InvalidArguments),
        }
    }

    pub const fn may_claim_owner(self) -> bool {
        matches!(self, Self::BecomeOwner)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ElectionDecision {
    ConnectExisting,
    ProbeExisting,
    OwnerStartRequired,
    AttemptOwnerClaim,
}

pub fn decide(role: ClientRole, endpoint_available: bool) -> ElectionDecision {
    match (role, endpoint_available) {
        (ClientRole::BecomeOwner, true) => ElectionDecision::ProbeExisting,
        (ClientRole::BecomeOwner, false) => ElectionDecision::AttemptOwnerClaim,
        (ClientRole::EnsureRunning, false) => ElectionDecision::OwnerStartRequired,
        _ => ElectionDecision::ConnectExisting,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimState {
    Acquired,
    Abandoned,
    Busy,
}

pub struct FakeElection {
    claimed: AtomicBool,
}

pub enum ClaimAttempt {
    Owned(OwnerClaimProof),
    Busy,
}

pub struct OwnerClaimProof {
    state: ClaimState,
    _private: (),
}

impl Default for FakeElection {
    fn default() -> Self {
        Self {
            claimed: AtomicBool::new(false),
        }
    }
}

impl FakeElection {
    pub fn try_claim(&self, role: ClientRole) -> Result<ClaimAttempt, HostError> {
        if !role.may_claim_owner() {
            return Err(HostError::OwnershipUnavailable);
        }
        Ok(
            if self
                .claimed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                ClaimAttempt::Owned(OwnerClaimProof {
                    state: ClaimState::Acquired,
                    _private: (),
                })
            } else {
                ClaimAttempt::Busy
            },
        )
    }
}

pub(crate) struct FailedHello {
    _private: (),
}

pub(crate) enum OwnerProbe<T> {
    Live(T),
    Failed(FailedHello),
}

pub(crate) async fn probe_owner<F, Future, T>(probe: F) -> OwnerProbe<T>
where
    F: FnOnce() -> Future,
    Future: std::future::Future<Output = Result<T, HostError>>,
{
    match probe().await {
        Ok(value) => OwnerProbe::Live(value),
        Err(_) => OwnerProbe::Failed(FailedHello { _private: () }),
    }
}

#[cfg(test)]
fn failed_real_hello_for_test() -> FailedHello {
    FailedHello { _private: () }
}

pub(crate) fn authorize_cleanup(
    role: ClientRole,
    claim: &OwnerClaimProof,
    _: FailedHello,
    target: EndpointIdentity,
) -> Result<OwnerCleanupProof, HostError> {
    if !role.may_claim_owner()
        || !matches!(claim.state, ClaimState::Acquired | ClaimState::Abandoned)
    {
        return Err(HostError::OwnershipUnavailable);
    }
    Ok(OwnerCleanupProof::from_owner_claim(target))
}

pub(crate) fn authorize_current_cleanup(
    claim: &OwnerClaimProof,
    target: EndpointIdentity,
) -> Result<OwnerCleanupProof, HostError> {
    if !matches!(claim.state, ClaimState::Acquired | ClaimState::Abandoned) {
        return Err(HostError::OwnershipUnavailable);
    }
    Ok(OwnerCleanupProof::from_owner_claim(target))
}

pub fn profile_mutex_name(sid: &str, profile_dir: &Path) -> Result<String, HostError> {
    if sid.trim().is_empty() || profile_dir.as_os_str().is_empty() {
        return Err(HostError::InvalidArguments);
    }
    let sid_hash = digest(sid.as_bytes());
    let canonical = std::fs::canonicalize(profile_dir).map_err(|_| HostError::InvalidArguments)?;
    let profile_hash = digest(&path_identity_bytes(&canonical));
    Ok(format!(
        "Global\\ThreadTerm.TerminalHost.{}.{}",
        &sid_hash[..24],
        &profile_hash[..24]
    ))
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(windows)]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(windows))]
fn path_identity_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
pub struct WindowsMutexClaim {
    release: Option<std::sync::mpsc::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
    state: ClaimState,
}

#[cfg(windows)]
impl WindowsMutexClaim {
    pub fn acquire(
        role: ClientRole,
        name: String,
        security: &crate::windows_security::ProtectedSecurityAttributes,
    ) -> Result<Self, HostError> {
        use std::{sync::mpsc, thread};
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
            },
        };

        if !role.may_claim_owner() {
            return Err(HostError::OwnershipUnavailable);
        }
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let owner_sid = security.sid().to_owned();
        let join = thread::Builder::new()
            .name("terminal-host-owner-mutex".into())
            .spawn(move || {
                let thread_security =
                    match crate::windows_security::ProtectedSecurityAttributes::for_sid(&owner_sid)
                    {
                        Ok(value) => value,
                        Err(error) => {
                            let _ = result_tx.send(Err(error));
                            return;
                        }
                    };
                let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                let handle = unsafe {
                    CreateMutexW(
                        Some(thread_security.as_mut_ptr()),
                        false,
                        PCWSTR(wide.as_ptr()),
                    )
                };
                let Ok(handle) = handle else {
                    let _ = result_tx.send(Err(HostError::Security));
                    return;
                };
                if crate::windows_security::validate_kernel_handle_acl(handle, &owner_sid).is_err()
                {
                    let _ = result_tx.send(Err(HostError::Security));
                    let _ = unsafe { CloseHandle(handle) };
                    return;
                }
                let wait = unsafe { WaitForSingleObject(handle, 0) };
                let state = if wait == WAIT_OBJECT_0 {
                    Ok(ClaimState::Acquired)
                } else if wait == WAIT_ABANDONED {
                    Ok(ClaimState::Abandoned)
                } else if wait == WAIT_TIMEOUT {
                    Ok(ClaimState::Busy)
                } else {
                    Err(HostError::OwnershipUnavailable)
                };
                let Ok(state) = state else {
                    let _ = result_tx.send(state);
                    let _ = unsafe { CloseHandle(handle) };
                    return;
                };
                let owns = state != ClaimState::Busy;
                if result_tx.send(Ok(state)).is_ok() && owns {
                    let _ = release_rx.recv();
                    let _ = unsafe { ReleaseMutex(handle) };
                }
                let _ = unsafe { CloseHandle(handle) };
            })
            .map_err(|_| HostError::OwnershipUnavailable)?;
        let state = result_rx
            .recv()
            .map_err(|_| HostError::OwnershipUnavailable)??;
        Ok(Self {
            release: (state != ClaimState::Busy).then_some(release_tx),
            join: Some(join),
            state,
        })
    }

    pub const fn state(&self) -> ClaimState {
        self.state
    }

    pub fn owner_proof(&self) -> Result<OwnerClaimProof, HostError> {
        matches!(self.state, ClaimState::Acquired | ClaimState::Abandoned)
            .then_some(OwnerClaimProof {
                state: self.state,
                _private: (),
            })
            .ok_or(HostError::OwnershipUnavailable)
    }
}

#[cfg(windows)]
impl Drop for WindowsMutexClaim {
    fn drop(&mut self) {
        self.release.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl fmt::Display for ClientRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ConnectOnly => "connect-only",
            Self::EnsureRunning => "ensure-running",
            Self::BecomeOwner => "become-owner",
        })
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;
    use terminal_host_protocol::PROTOCOL_VERSION;

    use super::*;
    use crate::bootstrap::{
        cleanup_endpoint_if_owned, publish_endpoint_atomic, read_endpoint, NoopPublishObserver,
        RuntimeEndpoint, ENDPOINT_SCHEMA_VERSION,
    };

    fn endpoint(runtime: &str, nonce: &str, generation: u64, pid: u32) -> RuntimeEndpoint {
        RuntimeEndpoint {
            schema_version: ENDPOINT_SCHEMA_VERSION,
            protocol_min: PROTOCOL_VERSION,
            protocol_max: PROTOCOL_VERSION,
            runtime_id: runtime.into(),
            pid,
            process_start_time: "123".into(),
            pipe_name: r"\\.\pipe\ThreadTerm.TerminalHost.cleanup-test".into(),
            daemon_version: "0.1.0".into(),
            launch_nonce: nonce.into(),
            owner_generation: generation,
        }
    }

    #[test]
    fn cleanup_requires_sealed_claim_failed_hello_and_exact_tuple() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("runtime.endpoint.json");
        let current = endpoint("runtime", "nonce", 9, 555);
        publish_endpoint_atomic(&path, &current, &NoopPublishObserver).unwrap();
        let election = FakeElection::default();
        let ClaimAttempt::Owned(claim) = election.try_claim(ClientRole::BecomeOwner).unwrap()
        else {
            panic!("owner")
        };

        for mismatch in [
            endpoint("other", "nonce", 9, 555).identity(),
            endpoint("runtime", "other", 9, 555).identity(),
            endpoint("runtime", "nonce", 10, 555).identity(),
        ] {
            let proof = authorize_cleanup(
                ClientRole::BecomeOwner,
                &claim,
                failed_real_hello_for_test(),
                mismatch.clone(),
            )
            .unwrap();
            assert!(!cleanup_endpoint_if_owned(&path, &mismatch, &proof).unwrap());
            assert_eq!(read_endpoint(&path).unwrap(), current);
        }

        // Reusing a PID does not help a different tuple. PID is absent from the
        // authorization type; only the three-part endpoint identity can match.
        let target = current.identity();
        let proof = authorize_cleanup(
            ClientRole::BecomeOwner,
            &claim,
            failed_real_hello_for_test(),
            target.clone(),
        )
        .unwrap();
        assert!(cleanup_endpoint_if_owned(&path, &target, &proof).unwrap());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn live_probe_is_reused_while_failed_probe_issues_cleanup_evidence() {
        match probe_owner(|| async { Ok::<_, HostError>("live") }).await {
            OwnerProbe::Live(value) => assert_eq!(value, "live"),
            OwnerProbe::Failed(_) => panic!("live owner must be reused"),
        }
        let evidence = match probe_owner(|| async { Err::<(), _>(HostError::Timeout) }).await {
            OwnerProbe::Failed(evidence) => evidence,
            OwnerProbe::Live(_) => panic!("failed hello must permit reconciliation"),
        };
        let election = FakeElection::default();
        let ClaimAttempt::Owned(claim) = election.try_claim(ClientRole::BecomeOwner).unwrap()
        else {
            panic!("owner")
        };
        assert!(authorize_cleanup(
            ClientRole::BecomeOwner,
            &claim,
            evidence,
            endpoint("stale", "nonce", 1, 1).identity(),
        )
        .is_ok());
    }
}
