use std::{io, path::Path, time::Duration};

use terminal_host_protocol::{
    encode_json_frame, ClientClass, EnvelopeKind, HelloRequest, Method, ProtocolRange,
    ProtocolVersion, RequestEnvelope, ResponseEnvelope, MAX_FRAME_BYTES, MAX_HELLO_FRAME_BYTES,
    PROTOCOL_VERSION,
};
use threadterm_terminal_host::{
    bootstrap::{read_endpoint, BootstrapPaths, RuntimeEndpoint, Secret},
    windows_security::{current_process_sid, validate_path_acl},
    HostError,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::reconnect::DaemonClientError;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct HelloAck {
    selected_version: ProtocolVersion,
    runtime_id: String,
    launch_nonce: String,
    owner_generation: u64,
    connection_id: String,
    capabilities: Vec<String>,
}

pub(crate) struct Connected<S> {
    pub stream: S,
    pub selected: ProtocolVersion,
    pub runtime_id: String,
}

pub(crate) fn read_bootstrap(
    profile_dir: &Path,
) -> Result<(RuntimeEndpoint, String), DaemonClientError> {
    if !profile_dir.is_absolute() {
        return Err(DaemonClientError::InvalidConfiguration);
    }
    let paths =
        BootstrapPaths::from_profile_dir(profile_dir.to_path_buf()).map_err(map_bootstrap_error)?;
    let sid = current_process_sid().map_err(map_bootstrap_error)?;
    validate_path_acl(paths.endpoint(), &sid).map_err(map_bootstrap_error)?;
    validate_path_acl(paths.secret(), &sid).map_err(map_bootstrap_error)?;
    let endpoint = read_endpoint(paths.endpoint()).map_err(map_bootstrap_error)?;
    let secret = Secret::read(paths.secret()).map_err(map_bootstrap_error)?;
    Ok((endpoint, secret.encoded()))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) async fn authenticate<S>(
    mut stream: S,
    endpoint: &RuntimeEndpoint,
    secret: String,
    timeout: Duration,
) -> Result<Connected<S>, DaemonClientError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let daemon_range = ProtocolRange {
        min: endpoint.protocol_min,
        max: endpoint.protocol_max,
    };
    let client_range = ProtocolRange {
        min: PROTOCOL_VERSION,
        max: PROTOCOL_VERSION,
    };
    if daemon_range.negotiate(&client_range) != Some(PROTOCOL_VERSION) {
        return Err(DaemonClientError::Protocol);
    }
    let hello = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 1,
        method: Method::Hello,
        params: serde_json::to_value(HelloRequest {
            protocol: ProtocolRange {
                min: PROTOCOL_VERSION,
                max: PROTOCOL_VERSION,
            },
            client: ClientClass::Desktop,
            capabilities: Vec::new(),
            secret,
        })
        .map_err(|_| DaemonClientError::Protocol)?,
    };
    write_request(&mut stream, &hello).await?;
    let response = tokio::time::timeout(timeout, read_response(&mut stream, MAX_HELLO_FRAME_BYTES))
        .await
        .map_err(|_| DaemonClientError::Timeout)??;
    response
        .validate_for(&PROTOCOL_VERSION)
        .map_err(|_| DaemonClientError::Protocol)?;
    let ack: HelloAck =
        serde_json::from_value(response.result.ok_or(DaemonClientError::Authentication)?)
            .map_err(|_| DaemonClientError::Authentication)?;
    let required = [
        "runtime.health",
        "session.list",
        "session.attach",
        "session.detach",
        "session.input",
        "session.resize",
        "session.ack",
        "session.resync",
        "session.present",
        "desktop.register",
        "surface.ready",
        "surface.hidden",
    ];
    let tuple_matches = ack.selected_version == PROTOCOL_VERSION
        && ack.runtime_id == endpoint.runtime_id
        && ack.launch_nonce == endpoint.launch_nonce
        && ack.owner_generation == endpoint.owner_generation
        && valid_identifier(&ack.connection_id)
        && ack.capabilities.len() <= terminal_host_protocol::MAX_HELLO_CAPABILITIES
        && ack.capabilities.iter().all(|capability| {
            !capability.is_empty()
                && capability.len() <= terminal_host_protocol::MAX_CAPABILITY_BYTES
        })
        && required
            .iter()
            .all(|required| ack.capabilities.iter().any(|actual| actual == required));
    if !tuple_matches {
        return Err(DaemonClientError::Authentication);
    }
    Ok(Connected {
        stream,
        selected: ack.selected_version,
        runtime_id: ack.runtime_id,
    })
}

fn map_bootstrap_error(error: HostError) -> DaemonClientError {
    match error {
        HostError::InvalidArguments => DaemonClientError::InvalidConfiguration,
        HostError::InvalidEndpoint | HostError::EndpointTooLarge | HostError::Security => {
            DaemonClientError::InvalidEndpoint
        }
        HostError::SecretUnavailable | HostError::OwnershipUnavailable | HostError::Io => {
            DaemonClientError::Unavailable
        }
        HostError::UnsupportedPlatform => DaemonClientError::UnsupportedPlatform,
        HostError::Unauthorized => DaemonClientError::Authentication,
        HostError::Timeout => DaemonClientError::Timeout,
        HostError::QueueFull => DaemonClientError::Busy,
        HostError::Catalog => DaemonClientError::Protocol,
    }
}

pub(crate) async fn write_request<W>(
    writer: &mut W,
    request: &RequestEnvelope,
) -> Result<(), DaemonClientError>
where
    W: AsyncWrite + Unpin,
{
    let frame = encode_json_frame(request).map_err(|_| DaemonClientError::Protocol)?;
    writer
        .write_all(&frame)
        .await
        .map_err(|_| DaemonClientError::Disconnected)?;
    writer
        .flush()
        .await
        .map_err(|_| DaemonClientError::Disconnected)
}

pub(crate) async fn read_json_frame<R>(reader: &mut R) -> Result<Vec<u8>, DaemonClientError>
where
    R: AsyncRead + Unpin,
{
    let length = reader.read_u32_le().await.map_err(map_read_error)? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(DaemonClientError::Protocol);
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.map_err(map_read_error)?;
    Ok(body)
}

async fn read_response<R>(
    reader: &mut R,
    maximum: usize,
) -> Result<ResponseEnvelope, DaemonClientError>
where
    R: AsyncRead + Unpin,
{
    let length = reader.read_u32_le().await.map_err(map_read_error)? as usize;
    if length == 0 || length > maximum {
        return Err(DaemonClientError::Protocol);
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.map_err(map_read_error)?;
    serde_json::from_slice(&body).map_err(|_| DaemonClientError::Protocol)
}

fn map_read_error(error: io::Error) -> DaemonClientError {
    if matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof | io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
    ) {
        DaemonClientError::Disconnected
    } else {
        DaemonClientError::Unavailable
    }
}

#[cfg(windows)]
pub(crate) async fn connect_pipe(
    pipe_name: &str,
    timeout: Duration,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, DaemonClientError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    tokio::time::timeout(timeout, async {
        loop {
            match ClientOptions::new().open(pipe_name) {
                Ok(client) => return Ok(client),
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(_) => return Err(DaemonClientError::Unavailable),
            }
        }
    })
    .await
    .map_err(|_| DaemonClientError::Timeout)?
}
