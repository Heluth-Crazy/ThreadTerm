use std::{path::PathBuf, sync::Arc};

use serde_json::Value;
#[cfg(any(not(feature = "terminal-daemon-owner"), test))]
use terminal_host_core::Catalog;
use terminal_host_core::RuntimeIdentity;
#[cfg(feature = "terminal-daemon-owner")]
use terminal_host_core::{DaemonPtyEngine, PtyRuntimeConfig};
use terminal_host_protocol::{
    encode_json_frame, ClientClass, EnvelopeKind, HelloRequest, Method, ProtocolRange,
    RequestEnvelope, ResponseEnvelope, MAX_HELLO_FRAME_BYTES, PROTOCOL_VERSION,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
    time::{sleep, timeout, Duration},
};
use uuid::Uuid;

use crate::{
    bootstrap::{
        cleanup_endpoint_if_owned, prepare_bootstrap_root, publish_endpoint_atomic, read_endpoint,
        BootstrapPaths, NoopPublishObserver, RuntimeEndpoint, Secret, ENDPOINT_SCHEMA_VERSION,
    },
    owner::{
        authorize_cleanup, authorize_current_cleanup, decide, probe_owner, profile_mutex_name,
        ClaimState, ClientRole, ElectionDecision, FailedHello, OwnerProbe, WindowsMutexClaim,
    },
    service::{HelloAck, ServiceLimits, TerminalHostService},
    windows_security::{
        create_private_file_new, current_process_sid, protect_and_validate_path,
        validate_inherited_safe_path, validate_path_acl, ProtectedSecurityAttributes,
    },
    HostError,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub struct CliOptions {
    pub profile_dir: PathBuf,
    pub role: ClientRole,
}

pub fn parse_cli(arguments: impl IntoIterator<Item = String>) -> Result<CliOptions, HostError> {
    let mut arguments = arguments.into_iter();
    let _program = arguments.next();
    let mut profile_dir = None;
    let mut role = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--profile-dir" if profile_dir.is_none() => {
                profile_dir = arguments.next().map(PathBuf::from)
            }
            "--role" if role.is_none() => {
                role = arguments
                    .next()
                    .map(|value| ClientRole::parse(&value))
                    .transpose()?
            }
            _ => return Err(HostError::InvalidArguments),
        }
    }
    let profile_dir = profile_dir.ok_or(HostError::InvalidArguments)?;
    if !profile_dir.is_absolute() {
        return Err(HostError::InvalidArguments);
    }
    Ok(CliOptions {
        profile_dir,
        role: role.ok_or(HostError::InvalidArguments)?,
    })
}

pub async fn run(options: CliOptions) -> Result<Value, HostError> {
    let paths = BootstrapPaths::from_profile_dir(options.profile_dir)?;
    let endpoint = read_endpoint(paths.endpoint()).ok();
    match decide(options.role, endpoint.is_some()) {
        ElectionDecision::ConnectExisting => {
            let endpoint = endpoint.ok_or(HostError::OwnershipUnavailable)?;
            let secret = read_validated_secret(&paths)?;
            connect_and_health(&endpoint, &secret, client_class(options.role)).await
        }
        ElectionDecision::OwnerStartRequired => Err(HostError::OwnershipUnavailable),
        ElectionDecision::AttemptOwnerClaim => run_owner(paths, None).await,
        ElectionDecision::ProbeExisting => {
            let endpoint = endpoint.ok_or(HostError::InvalidEndpoint)?;
            let secret = read_validated_secret(&paths)?;
            match probe_owner(|| connect_and_health(&endpoint, &secret, ClientClass::Desktop)).await
            {
                OwnerProbe::Live(health) => Ok(health),
                OwnerProbe::Failed(evidence) => run_owner(paths, Some((endpoint, evidence))).await,
            }
        }
    }
}

async fn run_owner(
    paths: BootstrapPaths,
    previous: Option<(RuntimeEndpoint, FailedHello)>,
) -> Result<Value, HostError> {
    prepare_bootstrap_root(&paths)?;
    let sid = current_process_sid()?;
    let security = ProtectedSecurityAttributes::for_sid(&sid)?;
    let mutex_name = profile_mutex_name(
        &sid,
        paths.root().parent().ok_or(HostError::InvalidArguments)?,
    )?;
    let claim = WindowsMutexClaim::acquire(ClientRole::BecomeOwner, mutex_name, &security)?;
    if claim.state() == ClaimState::Busy {
        return wait_for_owner(&paths, ClientClass::Desktop).await;
    }
    let owner_proof = claim.owner_proof()?;
    if let Some((previous, failed_hello)) = previous {
        let cleanup = authorize_cleanup(
            ClientRole::BecomeOwner,
            &owner_proof,
            failed_hello,
            previous.identity(),
        )?;
        let _ = cleanup_endpoint_if_owned(paths.endpoint(), &previous.identity(), &cleanup)?;
    }
    let secret = match Secret::read(paths.secret()) {
        Ok(value) => {
            validate_path_acl(paths.secret(), &sid)?;
            value
        }
        Err(_) if !paths.secret().exists() => {
            let value = Secret::generate()?;
            value.persist_create_new(paths.secret())?;
            value
        }
        Err(error) => return Err(error),
    };
    let runtime_id = Uuid::new_v4().simple().to_string();
    let launch_nonce = Uuid::new_v4().simple().to_string();
    let pipe_name = pipe_name(&sid, paths.root(), &launch_nonce)?;
    let first_server = create_pipe(&pipe_name, true, &security)?;
    let identity = RuntimeIdentity {
        runtime_id: runtime_id.clone(),
        launch_nonce: launch_nonce.clone(),
    };
    if !paths.catalog().exists() {
        drop(create_private_file_new(paths.catalog(), &sid)?);
    } else {
        validate_inherited_safe_path(paths.catalog(), &sid)?;
    }
    #[cfg(not(feature = "terminal-daemon-owner"))]
    let (catalog, reconciliation) =
        Catalog::open(paths.catalog(), identity).map_err(|_| HostError::Catalog)?;
    #[cfg(feature = "terminal-daemon-owner")]
    let (engine, reconciliation) =
        DaemonPtyEngine::open(paths.catalog(), identity, PtyRuntimeConfig::default())
            .map_err(|_| HostError::Catalog)?;
    protect_and_validate_path(paths.catalog(), &sid)?;
    for sidecar in paths.catalog_sidecars() {
        if sidecar.exists() {
            protect_and_validate_path(&sidecar, &sid)?;
        }
    }
    let endpoint = RuntimeEndpoint {
        schema_version: ENDPOINT_SCHEMA_VERSION,
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        runtime_id,
        pid: std::process::id(),
        process_start_time: process_start_time()?,
        pipe_name,
        daemon_version: env!("CARGO_PKG_VERSION").into(),
        launch_nonce,
        owner_generation: reconciliation.generation,
    };
    publish_endpoint_atomic(paths.endpoint(), &endpoint, &NoopPublishObserver)?;
    #[cfg(not(feature = "terminal-daemon-owner"))]
    let service = Arc::new(TerminalHostService::new(
        endpoint.clone(),
        secret,
        catalog,
        ServiceLimits::default(),
    )?);
    #[cfg(feature = "terminal-daemon-owner")]
    let service = Arc::new(TerminalHostService::new_with_engine(
        endpoint.clone(),
        secret,
        engine,
        ServiceLimits::default(),
    )?);
    let accept_result = accept_loop(first_server, security, Arc::clone(&service)).await;
    drop(service);
    let cleanup_result =
        authorize_current_cleanup(&owner_proof, endpoint.identity()).and_then(|cleanup| {
            cleanup_endpoint_if_owned(paths.endpoint(), &endpoint.identity(), &cleanup).map(|_| ())
        });
    accept_result?;
    cleanup_result?;
    Ok(serde_json::json!({"status": "stopped"}))
}

fn create_pipe(
    name: &str,
    first: bool,
    security: &ProtectedSecurityAttributes,
) -> Result<NamedPipeServer, HostError> {
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true);
    unsafe { options.create_with_security_attributes_raw(name, security.as_mut_ptr().cast()) }
        .map_err(|_| HostError::Security)
}

#[cfg(not(feature = "terminal-daemon-owner"))]
async fn accept_loop(
    mut server: NamedPipeServer,
    security: ProtectedSecurityAttributes,
    service: Arc<TerminalHostService>,
) -> Result<(), HostError> {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            result = server.connect() => result.map_err(|_| HostError::Io)?,
            _ = tokio::signal::ctrl_c() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => continue,
        }
        let accepted = server;
        server = create_pipe(&service_endpoint_pipe(&service)?, false, &security)?;
        let service = Arc::clone(&service);
        connections.spawn(async move {
            let mut accepted = accepted;
            let _ = service.serve_stream(&mut accepted).await;
        });
    }
    let drained = timeout(Duration::from_secs(5), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_ok();
    if !drained {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    Ok(())
}

#[cfg(feature = "terminal-daemon-owner")]
async fn accept_loop(
    mut server: NamedPipeServer,
    security: ProtectedSecurityAttributes,
    service: Arc<TerminalHostService>,
) -> Result<(), HostError> {
    let mut connections = tokio::task::JoinSet::new();
    let mut shutdown = service.shutdown_receiver();
    let mut idle_tick = tokio::time::interval(Duration::from_millis(250));
    idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut idle_since = None;
    loop {
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            _ = tokio::signal::ctrl_c() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            result = server.connect() => {
                result.map_err(|_| HostError::Io)?;
                let accepted = server;
                server = create_pipe(&service_endpoint_pipe(&service)?, false, &security)?;
                idle_since = None;
                let service = Arc::clone(&service);
                connections.spawn(async move {
                    let mut accepted = accepted;
                    let _ = service.serve_stream(&mut accepted).await;
                });
            }
            _ = idle_tick.tick() => {
                if service.live_session_count() == 0 && service.connected_client_count() == 0 {
                    let since = idle_since.get_or_insert_with(tokio::time::Instant::now);
                    if since.elapsed() >= service.idle_shutdown_duration() {
                        break;
                    }
                } else {
                    idle_since = None;
                }
            }
        }
    }
    let drained = timeout(Duration::from_secs(5), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_ok();
    if !drained {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    Ok(())
}

fn service_endpoint_pipe(service: &TerminalHostService) -> Result<String, HostError> {
    service.pipe_name().map(str::to_owned)
}

fn pipe_name(
    sid: &str,
    profile_root: &std::path::Path,
    launch_nonce: &str,
) -> Result<String, HostError> {
    use sha2::{Digest, Sha256};
    use std::os::windows::ffi::OsStrExt;
    let canonical = std::fs::canonicalize(profile_root).map_err(|_| HostError::Security)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(sid.as_bytes());
    bytes.extend(
        canonical
            .as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes),
    );
    bytes.extend_from_slice(launch_nonce.as_bytes());
    let hash = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(r"\\.\pipe\ThreadTerm.TerminalHost.{}", &hash[..40]))
}

fn read_validated_secret(paths: &BootstrapPaths) -> Result<Secret, HostError> {
    let sid = current_process_sid()?;
    validate_path_acl(paths.secret(), &sid)?;
    Secret::read(paths.secret())
}

async fn connect_and_health(
    endpoint: &RuntimeEndpoint,
    secret: &Secret,
    client_class: ClientClass,
) -> Result<Value, HostError> {
    endpoint.validate()?;
    let mut client = timeout(CONNECT_TIMEOUT, async {
        loop {
            match ClientOptions::new().open(&endpoint.pipe_name) {
                Ok(client) => return Ok(client),
                Err(error) if error.raw_os_error() == Some(231) => {
                    sleep(Duration::from_millis(20)).await
                }
                Err(_) => return Err(HostError::Io),
            }
        }
    })
    .await
    .map_err(|_| HostError::Timeout)??;
    let hello = RequestEnvelope {
        version: endpoint.protocol_max,
        kind: EnvelopeKind::Request,
        id: 1,
        method: Method::Hello,
        params: serde_json::to_value(HelloRequest {
            protocol: ProtocolRange {
                min: endpoint.protocol_min,
                max: endpoint.protocol_max,
            },
            client: client_class,
            capabilities: Vec::new(),
            secret: secret.encoded(),
        })
        .map_err(|_| HostError::Io)?,
    };
    write_envelope(&mut client, &hello).await?;
    let response = read_response(&mut client, MAX_HELLO_FRAME_BYTES).await?;
    response
        .validate_for(&endpoint.protocol_max)
        .map_err(|_| HostError::Unauthorized)?;
    let ack: HelloAck = serde_json::from_value(response.result.ok_or(HostError::Unauthorized)?)
        .map_err(|_| HostError::Unauthorized)?;
    if ack.runtime_id != endpoint.runtime_id
        || ack.launch_nonce != endpoint.launch_nonce
        || ack.owner_generation != endpoint.owner_generation
        || ack.selected_version != endpoint.protocol_max
    {
        return Err(HostError::Unauthorized);
    }
    let health = RequestEnvelope {
        version: ack.selected_version,
        kind: EnvelopeKind::Request,
        id: 2,
        method: Method::Health,
        params: serde_json::json!({}),
    };
    write_envelope(&mut client, &health).await?;
    let response = read_response(&mut client, terminal_host_protocol::MAX_FRAME_BYTES).await?;
    response
        .validate_for(&ack.selected_version)
        .map_err(|_| HostError::Io)?;
    response.result.ok_or(HostError::Io)
}

async fn wait_for_owner(paths: &BootstrapPaths, client: ClientClass) -> Result<Value, HostError> {
    timeout(CONNECT_TIMEOUT, async {
        loop {
            if let Ok(endpoint) = read_endpoint(paths.endpoint()) {
                if let Ok(secret) = read_validated_secret(paths) {
                    if let Ok(health) = connect_and_health(&endpoint, &secret, client.clone()).await
                    {
                        return Ok(health);
                    }
                }
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| HostError::Timeout)?
}

fn client_class(role: ClientRole) -> ClientClass {
    match role {
        ClientRole::ConnectOnly => ClientClass::McpBridge,
        ClientRole::EnsureRunning | ClientRole::BecomeOwner => ClientClass::Desktop,
    }
}

fn process_start_time() -> Result<String, HostError> {
    use windows::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    }
    .map_err(|_| HostError::Io)?;
    Ok(
        ((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
            .to_string(),
    )
}

async fn write_envelope(
    client: &mut NamedPipeClient,
    envelope: &RequestEnvelope,
) -> Result<(), HostError> {
    let frame = encode_json_frame(envelope).map_err(|_| HostError::Io)?;
    client.write_all(&frame).await.map_err(|_| HostError::Io)
}

async fn read_response(
    client: &mut NamedPipeClient,
    maximum: usize,
) -> Result<ResponseEnvelope, HostError> {
    let length = timeout(CONNECT_TIMEOUT, client.read_u32_le())
        .await
        .map_err(|_| HostError::Timeout)?
        .map_err(|_| HostError::Io)? as usize;
    if length == 0 || length > maximum {
        return Err(HostError::Unauthorized);
    }
    let mut body = vec![0_u8; length];
    timeout(CONNECT_TIMEOUT, client.read_exact(&mut body))
        .await
        .map_err(|_| HostError::Timeout)?
        .map_err(|_| HostError::Io)?;
    serde_json::from_slice(&body).map_err(|_| HostError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_host_protocol::{HelloRequest, ProtocolRange};

    #[test]
    fn second_real_mutex_claimant_is_busy_and_name_is_profile_stable() {
        let temp = tempfile::tempdir().unwrap();
        let sid = current_process_sid().unwrap();
        let security = ProtectedSecurityAttributes::for_sid(&sid).unwrap();
        let name = profile_mutex_name(&sid, temp.path()).unwrap();
        assert!(name.starts_with("Global\\ThreadTerm.TerminalHost."));
        assert_eq!(name, profile_mutex_name(&sid, temp.path()).unwrap());
        let first =
            WindowsMutexClaim::acquire(ClientRole::BecomeOwner, name.clone(), &security).unwrap();
        assert!(matches!(
            first.state(),
            ClaimState::Acquired | ClaimState::Abandoned
        ));
        let second = WindowsMutexClaim::acquire(ClientRole::BecomeOwner, name, &security).unwrap();
        assert_eq!(second.state(), ClaimState::Busy);
        drop(second);
        drop(first);
    }

    #[tokio::test]
    async fn local_named_pipe_rejects_wrong_token_with_generic_error() {
        let sid = current_process_sid().unwrap();
        let security = ProtectedSecurityAttributes::for_sid(&sid).unwrap();
        let pipe = format!(
            r"\\.\pipe\ThreadTerm.TerminalHost.test-{}",
            Uuid::new_v4().simple()
        );
        let mut server = create_pipe(&pipe, true, &security).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let identity = RuntimeIdentity {
            runtime_id: "runtime".into(),
            launch_nonce: "nonce".into(),
        };
        let (catalog, reconciliation) =
            Catalog::open(temp.path().join("runtime.sqlite"), identity).unwrap();
        let endpoint = RuntimeEndpoint {
            schema_version: ENDPOINT_SCHEMA_VERSION,
            protocol_min: PROTOCOL_VERSION,
            protocol_max: PROTOCOL_VERSION,
            runtime_id: "runtime".into(),
            pid: std::process::id(),
            process_start_time: process_start_time().unwrap(),
            pipe_name: pipe.clone(),
            daemon_version: "test".into(),
            launch_nonce: "nonce".into(),
            owner_generation: reconciliation.generation,
        };
        let host = TerminalHostService::new(
            endpoint,
            Secret::from_bytes([7; 32]),
            catalog,
            ServiceLimits::default(),
        )
        .unwrap();
        let server_task = tokio::spawn(async move {
            server.connect().await.unwrap();
            host.serve_stream(&mut server).await
        });
        let mut client = ClientOptions::new().open(&pipe).unwrap();
        let request = RequestEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Request,
            id: 99,
            method: Method::Hello,
            params: serde_json::to_value(HelloRequest {
                protocol: ProtocolRange {
                    min: PROTOCOL_VERSION,
                    max: PROTOCOL_VERSION,
                },
                client: ClientClass::McpBridge,
                capabilities: vec![],
                secret: Secret::from_bytes([8; 32]).encoded(),
            })
            .unwrap(),
        };
        write_envelope(&mut client, &request).await.unwrap();
        let response = read_response(&mut client, MAX_HELLO_FRAME_BYTES)
            .await
            .unwrap();
        assert_eq!(response.error.unwrap().message, "unauthorized");
        assert_eq!(server_task.await.unwrap(), Err(HostError::Unauthorized));
    }

    #[test]
    fn pipe_names_are_nonce_qualified_and_local() {
        let temp = tempfile::tempdir().unwrap();
        let sid = current_process_sid().unwrap();
        let first = pipe_name(&sid, temp.path(), "launch-one").unwrap();
        let second = pipe_name(&sid, temp.path(), "launch-two").unwrap();
        assert_ne!(first, second);
        assert!(crate::bootstrap::valid_local_pipe_name(&first));
        assert!(crate::bootstrap::valid_local_pipe_name(&second));
    }
}
