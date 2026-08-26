use std::{
    fs,
    sync::{Arc, Barrier},
    thread,
};

use tempfile::tempdir;
use terminal_host_protocol::PROTOCOL_VERSION;
use threadterm_terminal_host::{
    bootstrap::{
        publish_endpoint_atomic, read_endpoint, valid_local_pipe_name, BootstrapPaths,
        NoopPublishObserver, PublishCheckpoint, PublishObserver, RuntimeEndpoint, Secret,
        SecretPublishCheckpoint, SecretPublishObserver, ENDPOINT_SCHEMA_VERSION,
        MAX_ENDPOINT_BYTES,
    },
    owner::{decide, ClaimAttempt, ClientRole, ElectionDecision, FakeElection},
    HostError,
};

fn endpoint(runtime: &str, nonce: &str, generation: u64) -> RuntimeEndpoint {
    RuntimeEndpoint {
        schema_version: ENDPOINT_SCHEMA_VERSION,
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        runtime_id: runtime.into(),
        pid: 42,
        process_start_time: "123456789".into(),
        pipe_name: r"\\.\pipe\ThreadTerm.TerminalHost.abc_123".into(),
        daemon_version: "0.1.0".into(),
        launch_nonce: nonce.into(),
        owner_generation: generation,
    }
}

struct FailSecretAt(SecretPublishCheckpoint);
impl SecretPublishObserver for FailSecretAt {
    fn checkpoint(&self, checkpoint: SecretPublishCheckpoint) -> Result<(), HostError> {
        if checkpoint == self.0 {
            Err(HostError::Io)
        } else {
            Ok(())
        }
    }
}

#[test]
fn secret_is_atomically_installed_and_never_overwrites_partial_final() {
    let temp = absolute_temp();
    let path = temp.path().join("runtime.secret");
    let secret = Secret::from_bytes([5; 32]);
    for checkpoint in [
        SecretPublishCheckpoint::TempCreated,
        SecretPublishCheckpoint::BodyWritten,
        SecretPublishCheckpoint::TempSynced,
        SecretPublishCheckpoint::BeforeInstall,
    ] {
        assert_eq!(
            secret.persist_create_new_observed(&path, &FailSecretAt(checkpoint)),
            Err(HostError::Io)
        );
        assert!(!path.exists());
    }
    secret.persist_create_new(&path).unwrap();
    assert_eq!(Secret::read(&path).unwrap(), secret);
    fs::write(&path, b"partial").unwrap();
    assert_eq!(
        secret.persist_create_new(&path),
        Err(HostError::SecretUnavailable)
    );
    assert_eq!(fs::read(&path).unwrap(), b"partial");
}

fn absolute_temp() -> tempfile::TempDir {
    tempdir().expect("temp dir")
}

#[test]
fn profile_paths_require_absolute_input_and_stay_contained() {
    assert_eq!(
        BootstrapPaths::from_profile_dir("relative".into()),
        Err(HostError::InvalidArguments)
    );
    let temp = absolute_temp();
    let paths = BootstrapPaths::from_profile_dir(temp.path().to_path_buf()).unwrap();
    let aliased = BootstrapPaths::from_profile_dir(temp.path().join(".")).unwrap();
    assert_eq!(paths, aliased);
    for path in [paths.endpoint(), paths.secret(), paths.catalog()] {
        assert!(path.starts_with(paths.root()));
    }
    let canonical = fs::canonicalize(temp.path()).unwrap();
    assert_eq!(paths.root().parent(), Some(canonical.as_path()));
}

#[test]
fn endpoint_schema_is_strict_bounded_and_pipe_is_local() {
    let temp = absolute_temp();
    let path = temp.path().join("endpoint.json");
    let mut value = serde_json::to_value(endpoint("r", "n", 1)).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("secret".into(), serde_json::json!("leak"));
    publish_endpoint_atomic(&path, &endpoint("r", "n", 1), &NoopPublishObserver).unwrap();
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(read_endpoint(&path), Err(HostError::InvalidEndpoint));
    fs::write(&path, vec![b'x'; MAX_ENDPOINT_BYTES as usize + 1]).unwrap();
    assert_eq!(read_endpoint(&path), Err(HostError::EndpointTooLarge));
    assert!(valid_local_pipe_name(
        r"\\.\pipe\ThreadTerm.TerminalHost.good-1"
    ));
    assert!(!valid_local_pipe_name(
        r"\\server\pipe\ThreadTerm.TerminalHost.bad"
    ));
    assert!(!valid_local_pipe_name(
        r"\\.\pipe\ThreadTerm.TerminalHost.bad\child"
    ));
}

#[test]
fn secret_is_exact_constant_work_and_redacted() {
    let secret = Secret::from_bytes([7; 32]);
    assert!(secret.verify_bytes(&[7; 32]));
    assert!(!secret.verify_bytes(&[7; 31]));
    assert!(!secret.verify_bytes(&[7; 33]));
    assert!(!secret.verify_encoded("not-base64***"));
    assert!(!secret.verify_encoded(&(secret.encoded() + "=")));
    assert!(secret.verify_encoded(&secret.encoded()));
    assert_eq!(format!("{secret:?}"), "Secret([redacted])");
    assert!(!format!("{:?}", endpoint("runtime", "nonce", 1)).contains("abc_123"));
}

struct FailAt(PublishCheckpoint);
impl PublishObserver for FailAt {
    fn checkpoint(&self, checkpoint: PublishCheckpoint) -> Result<(), HostError> {
        if checkpoint == self.0 {
            Err(HostError::Io)
        } else {
            Ok(())
        }
    }
}

#[test]
fn interrupted_publish_preserves_old_endpoint_and_cleans_normal_temp() {
    let temp = absolute_temp();
    let path = temp.path().join("runtime.endpoint.json");
    let old = endpoint("old", "old-nonce", 1);
    publish_endpoint_atomic(&path, &old, &NoopPublishObserver).unwrap();
    for checkpoint in [
        PublishCheckpoint::TempCreated,
        PublishCheckpoint::BodyWritten,
        PublishCheckpoint::TempSynced,
        PublishCheckpoint::BeforeReplace,
    ] {
        assert_eq!(
            publish_endpoint_atomic(&path, &endpoint("new", "new-nonce", 2), &FailAt(checkpoint)),
            Err(HostError::Io)
        );
        assert_eq!(read_endpoint(&path).unwrap(), old);
        assert_eq!(
            fs::read_dir(temp.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
    }
    fs::write(
        temp.path().join(".runtime.endpoint.json.crash.tmp"),
        b"partial",
    )
    .unwrap();
    assert_eq!(read_endpoint(&path).unwrap(), old);
}

#[test]
fn post_replace_fault_reports_error_but_leaves_complete_new_endpoint() {
    let temp = absolute_temp();
    let path = temp.path().join("runtime.endpoint.json");
    let old = endpoint("old", "old-nonce", 1);
    let new = endpoint("new", "new-nonce", 2);
    publish_endpoint_atomic(&path, &old, &NoopPublishObserver).unwrap();
    assert_eq!(
        publish_endpoint_atomic(&path, &new, &FailAt(PublishCheckpoint::Replaced)),
        Err(HostError::Io)
    );
    assert_eq!(read_endpoint(&path).unwrap(), new);
}

#[test]
fn atomic_readers_never_observe_partial_json() {
    let temp = absolute_temp();
    let path = temp.path().join("runtime.endpoint.json");
    publish_endpoint_atomic(&path, &endpoint("r0", "n0", 1), &NoopPublishObserver).unwrap();
    let barrier = Arc::new(Barrier::new(5));
    let mut readers = Vec::new();
    for _ in 0..4 {
        let path = path.clone();
        let barrier = Arc::clone(&barrier);
        readers.push(thread::spawn(move || {
            barrier.wait();
            for _ in 0..100 {
                read_endpoint(&path).unwrap().validate().unwrap();
            }
        }));
    }
    barrier.wait();
    for index in 1..=50 {
        publish_endpoint_atomic(
            &path,
            &endpoint(&format!("r{index}"), &format!("n{index}"), index + 1),
            &NoopPublishObserver,
        )
        .unwrap();
    }
    for reader in readers {
        reader.join().unwrap();
    }
}

#[test]
fn roles_and_hundred_starters_elect_exactly_one_candidate() {
    assert_eq!(
        decide(ClientRole::ConnectOnly, false),
        ElectionDecision::ConnectExisting
    );
    assert_eq!(
        decide(ClientRole::EnsureRunning, false),
        ElectionDecision::OwnerStartRequired
    );
    assert_eq!(
        decide(ClientRole::BecomeOwner, true),
        ElectionDecision::ProbeExisting
    );
    let election = Arc::new(FakeElection::default());
    let barrier = Arc::new(Barrier::new(100));
    let starters = (0..100)
        .map(|_| {
            let election = Arc::clone(&election);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                matches!(
                    election.try_claim(ClientRole::BecomeOwner).unwrap(),
                    ClaimAttempt::Owned(_)
                )
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        starters
            .into_iter()
            .map(|starter| starter.join().unwrap())
            .filter(|owned| *owned)
            .count(),
        1
    );
    assert_eq!(
        election.try_claim(ClientRole::ConnectOnly).err(),
        Some(HostError::OwnershipUnavailable)
    );
}
