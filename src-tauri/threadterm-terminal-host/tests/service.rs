use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use terminal_host_core::{
    Catalog, CatalogCommand, CreateClaim, PresentationTarget, RequestDigest, RuntimeIdentity,
    MAX_LIST_PAGE_SIZE,
};
use terminal_host_protocol::{
    ClientClass, EnvelopeKind, ExitBehavior, HelloRequest, Method, Presentation, ProtocolRange,
    RequestEnvelope, ResponseEnvelope, TransportErrorCode, PROTOCOL_VERSION,
};
use threadterm_terminal_host::{
    bootstrap::{RuntimeEndpoint, Secret, ENDPOINT_SCHEMA_VERSION},
    service::{HelloAck, ServiceLimits, TerminalHostService},
    HostError,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn endpoint() -> RuntimeEndpoint {
    RuntimeEndpoint {
        schema_version: ENDPOINT_SCHEMA_VERSION,
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        runtime_id: "runtime".into(),
        pid: 42,
        process_start_time: "123".into(),
        pipe_name: r"\\.\pipe\ThreadTerm.TerminalHost.test".into(),
        daemon_version: "0.1.0".into(),
        launch_nonce: "nonce".into(),
        owner_generation: 7,
    }
}

fn service(limits: ServiceLimits) -> TerminalHostService {
    let temp = tempdir().unwrap();
    let path = temp.keep().join("runtime.sqlite");
    let (catalog, _) = Catalog::open(
        &path,
        RuntimeIdentity {
            runtime_id: "runtime".into(),
            launch_nonce: "nonce".into(),
        },
    )
    .unwrap();
    TerminalHostService::new(endpoint(), Secret::from_bytes([9; 32]), catalog, limits).unwrap()
}

fn hello(secret: String, method: Method) -> RequestEnvelope {
    RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 1,
        method,
        params: serde_json::to_value(HelloRequest {
            protocol: ProtocolRange {
                min: PROTOCOL_VERSION,
                max: PROTOCOL_VERSION,
            },
            client: ClientClass::McpBridge,
            capabilities: vec![],
            secret,
        })
        .unwrap(),
    }
}

async fn send(stream: &mut tokio::io::DuplexStream, request: &RequestEnvelope) {
    let body = serde_json::to_vec(request).unwrap();
    stream.write_u32_le(body.len() as u32).await.unwrap();
    stream.write_all(&body).await.unwrap();
}

async fn receive(stream: &mut tokio::io::DuplexStream) -> ResponseEnvelope {
    let length = stream.read_u32_le().await.unwrap() as usize;
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[test]
fn hello_ack_echoes_tuple_and_redacts_connection() {
    let service = service(ServiceLimits::default());
    let request = hello(Secret::from_bytes([9; 32]).encoded(), Method::Hello);
    let (_, _, ack) = service
        .authenticate_frame(&serde_json::to_vec(&request).unwrap())
        .unwrap();
    assert_eq!(
        (
            ack.runtime_id.as_str(),
            ack.launch_nonce.as_str(),
            ack.owner_generation
        ),
        ("runtime", "nonce", 7)
    );
    let debug = format!("{ack:?}");
    assert!(debug.contains("[redacted]"));
    assert!(!debug.contains(&ack.connection_id));
}

#[test]
fn preauth_failures_are_uniform_and_hello_first() {
    let service = service(ServiceLimits::default());
    let wrong = hello(Secret::from_bytes([8; 32]).encoded(), Method::Hello);
    let prehello = hello(Secret::from_bytes([9; 32]).encoded(), Method::Health);
    assert_eq!(
        service.authenticate_frame(&serde_json::to_vec(&wrong).unwrap()),
        Err(HostError::Unauthorized)
    );
    assert_eq!(
        service.authenticate_frame(&serde_json::to_vec(&prehello).unwrap()),
        Err(HostError::Unauthorized)
    );
    let mut incompatible = hello(Secret::from_bytes([9; 32]).encoded(), Method::Hello);
    incompatible.version.major = 2;
    assert_eq!(
        service.authenticate_frame(&serde_json::to_vec(&incompatible).unwrap()),
        Err(HostError::Unauthorized)
    );
}

#[tokio::test]
async fn fake_transport_authenticates_then_health_list_and_typed_method_error() {
    let service = service(ServiceLimits::default());
    let (mut client, mut server) = tokio::io::duplex(128 * 1024);
    let task = tokio::spawn(async move { service.serve_stream(&mut server).await });
    send(
        &mut client,
        &hello(Secret::from_bytes([9; 32]).encoded(), Method::Hello),
    )
    .await;
    let hello_response = receive(&mut client).await;
    let ack: HelloAck = serde_json::from_value(hello_response.result.unwrap()).unwrap();
    send(
        &mut client,
        &RequestEnvelope {
            version: ack.selected_version,
            kind: EnvelopeKind::Request,
            id: 2,
            method: Method::SessionCreate,
            params: serde_json::json!({}),
        },
    )
    .await;
    assert_eq!(
        receive(&mut client).await.error.unwrap().code,
        TransportErrorCode::InvalidMethod
    );
    send(
        &mut client,
        &RequestEnvelope {
            version: ack.selected_version,
            kind: EnvelopeKind::Request,
            id: 3,
            method: Method::Health,
            params: serde_json::json!({}),
        },
    )
    .await;
    assert_eq!(receive(&mut client).await.result.unwrap()["status"], "ok");
    send(
        &mut client,
        &RequestEnvelope {
            version: ack.selected_version,
            kind: EnvelopeKind::Request,
            id: 4,
            method: Method::SessionList,
            params: serde_json::json!({}),
        },
    )
    .await;
    assert_eq!(
        receive(&mut client).await.result.unwrap(),
        serde_json::json!({"sessions": []})
    );
    drop(client);
    assert_eq!(task.await.unwrap(), Ok(()));
}

#[tokio::test]
async fn oversize_and_timeout_close_without_allocating_general_frame() {
    let limits = ServiceLimits {
        hello_timeout: Duration::from_millis(20),
        ..ServiceLimits::default()
    };
    let host = service(limits);
    let (mut client, mut server) = tokio::io::duplex(64);
    let task = tokio::spawn(async move { host.serve_stream(&mut server).await });
    client
        .write_u32_le((terminal_host_protocol::MAX_HELLO_FRAME_BYTES + 1) as u32)
        .await
        .unwrap();
    assert_eq!(task.await.unwrap(), Err(HostError::Unauthorized));

    let host = service(ServiceLimits {
        hello_timeout: Duration::from_millis(20),
        ..ServiceLimits::default()
    });
    let (_client, mut server) = tokio::io::duplex(64);
    assert_eq!(
        host.serve_stream(&mut server).await,
        Err(HostError::Timeout)
    );
}

async fn preauth_wire_response(request: RequestEnvelope) -> Vec<u8> {
    let host = service(ServiceLimits::default());
    let (mut client, mut server) = tokio::io::duplex(128 * 1024);
    let task = tokio::spawn(async move { host.serve_stream(&mut server).await });
    send(&mut client, &request).await;
    let length = client.read_u32_le().await.unwrap() as usize;
    let mut body = vec![0; length];
    client.read_exact(&mut body).await.unwrap();
    assert_eq!(task.await.unwrap(), Err(HostError::Unauthorized));
    body
}

#[tokio::test]
async fn wrong_secret_and_prehello_have_identical_wire_error_then_close() {
    let wrong =
        preauth_wire_response(hello(Secret::from_bytes([8; 32]).encoded(), Method::Hello)).await;
    let prehello =
        preauth_wire_response(hello(Secret::from_bytes([9; 32]).encoded(), Method::Health)).await;
    assert_eq!(wrong, prehello);
    let response: ResponseEnvelope = serde_json::from_slice(&wrong).unwrap();
    assert_eq!(response.error.unwrap().message, "unauthorized");
}

#[tokio::test]
async fn preauth_connection_limit_fails_closed() {
    let host = Arc::new(service(ServiceLimits {
        hello_timeout: Duration::from_secs(2),
        max_preauth_connections: 1,
        ..ServiceLimits::default()
    }));
    let (_first_client, mut first_server) = tokio::io::duplex(64);
    let first_host = Arc::clone(&host);
    let first = tokio::spawn(async move { first_host.serve_stream(&mut first_server).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let (_second_client, mut second_server) = tokio::io::duplex(64);
    assert_eq!(
        host.serve_stream(&mut second_server).await,
        Err(HostError::QueueFull)
    );
    first.abort();
}

#[tokio::test]
async fn authenticated_oversize_frame_closes_without_body_allocation() {
    let host = service(ServiceLimits::default());
    let (mut client, mut server) = tokio::io::duplex(128 * 1024);
    let task = tokio::spawn(async move { host.serve_stream(&mut server).await });
    send(
        &mut client,
        &hello(Secret::from_bytes([9; 32]).encoded(), Method::Hello),
    )
    .await;
    let _ = receive(&mut client).await;
    client
        .write_u32_le((terminal_host_protocol::MAX_FRAME_BYTES + 1) as u32)
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
}

#[test]
fn session_list_is_catalog_bounded_and_refuses_truncation() {
    let temp = tempdir().unwrap();
    let path = temp.keep().join("runtime.sqlite");
    let (catalog, _) = Catalog::open(
        &path,
        RuntimeIdentity {
            runtime_id: "runtime".into(),
            launch_nonce: "nonce".into(),
        },
    )
    .unwrap();
    for index in 0_u8..3 {
        catalog
            .execute(CatalogCommand::Claim(CreateClaim {
                request_id: format!("test:request:{index}"),
                digest: RequestDigest::new([index; 32]),
                stream_id: format!("stream-{index}"),
                title: None,
                target: PresentationTarget::Window,
                presentation: Presentation::Focused,
                exit_behavior: ExitBehavior::Keep,
                now_ms: i64::from(index) + 1,
            }))
            .unwrap();
    }
    let host = TerminalHostService::new(
        endpoint(),
        Secret::from_bytes([9; 32]),
        catalog,
        ServiceLimits {
            max_list_records: 2,
            ..ServiceLimits::default()
        },
    )
    .unwrap();
    let request = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id: 5,
        method: Method::SessionList,
        params: serde_json::json!({}),
    };
    let response =
        host.handle_authenticated_frame(PROTOCOL_VERSION, &serde_json::to_vec(&request).unwrap());
    assert_eq!(
        response.error.unwrap().code,
        TransportErrorCode::InternalError
    );

    let temp = tempdir().unwrap();
    let (catalog, _) = Catalog::open(
        temp.path().join("runtime.sqlite"),
        RuntimeIdentity {
            runtime_id: "runtime".into(),
            launch_nonce: "nonce".into(),
        },
    )
    .unwrap();
    assert_eq!(
        TerminalHostService::new(
            endpoint(),
            Secret::from_bytes([9; 32]),
            catalog,
            ServiceLimits {
                max_list_records: MAX_LIST_PAGE_SIZE as usize + 1,
                ..ServiceLimits::default()
            }
        )
        .err(),
        Some(HostError::InvalidArguments),
    );
}

#[test]
fn authenticated_wrong_kind_and_version_have_distinct_stable_codes() {
    let host = service(ServiceLimits::default());
    let mut request = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Response,
        id: 10,
        method: Method::Health,
        params: serde_json::json!({}),
    };
    let response =
        host.handle_authenticated_frame(PROTOCOL_VERSION, &serde_json::to_vec(&request).unwrap());
    assert_eq!(
        response.error.unwrap().code,
        TransportErrorCode::InvalidKind
    );
    request.kind = EnvelopeKind::Request;
    request.version.major += 1;
    let response =
        host.handle_authenticated_frame(PROTOCOL_VERSION, &serde_json::to_vec(&request).unwrap());
    assert_eq!(
        response.error.unwrap().code,
        TransportErrorCode::UnsupportedVersion
    );
}

#[test]
fn authenticated_health_and_list_require_strict_empty_params() {
    let host = service(ServiceLimits::default());
    for (id, method, params) in [
        (20, Method::Health, serde_json::json!({"extra": true})),
        (21, Method::Health, serde_json::json!([])),
        (22, Method::SessionList, serde_json::json!({"limit": 1})),
        (23, Method::SessionList, serde_json::json!(null)),
    ] {
        let request = RequestEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Request,
            id,
            method,
            params,
        };
        let response = host
            .handle_authenticated_frame(PROTOCOL_VERSION, &serde_json::to_vec(&request).unwrap());
        assert_eq!(
            response
                .error
                .unwrap_or_else(|| panic!("request {id} accepted non-empty params"))
                .code,
            TransportErrorCode::InvalidRequest
        );
    }
}
