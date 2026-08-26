use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use terminal_host_protocol::{
    encode_json_frame, ClientClass, DesktopRegisterRequest, EmptyResponse, EnvelopeKind,
    EventEnvelope, EventName, Method, Placement, Presentation, ProtocolVersion, RequestEnvelope,
    ResponseEnvelope, SessionListResponse, SurfacePresentRequestedEvent, PROTOCOL_VERSION,
    SURFACE_PRESENTATION_V1,
};
use threadterm_terminal_host::bootstrap::{RuntimeEndpoint, ENDPOINT_SCHEMA_VERSION};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::mpsc,
};

use super::{
    connection::{authenticate, Connected},
    reconnect::{
        initialize_desktop, run_test_connection, DaemonClientConfig, DaemonClientError,
        DaemonClientHandle,
    },
    DaemonEvent,
};

fn endpoint() -> RuntimeEndpoint {
    RuntimeEndpoint {
        schema_version: ENDPOINT_SCHEMA_VERSION,
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        runtime_id: "runtime0123456789".into(),
        pid: 42,
        process_start_time: "123456".into(),
        pipe_name: r"\\.\pipe\ThreadTerm.TerminalHost.test".into(),
        daemon_version: "0.1.0".into(),
        launch_nonce: "nonce0123456789".into(),
        owner_generation: 7,
    }
}

fn capabilities() -> Vec<String> {
    [
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
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

async fn read_request<R: AsyncRead + Unpin>(reader: &mut R) -> RequestEnvelope {
    let length = reader.read_u32_le().await.unwrap() as usize;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn write_json<W: AsyncWrite + Unpin, T: serde::Serialize>(writer: &mut W, value: &T) {
    writer
        .write_all(&encode_json_frame(value).unwrap())
        .await
        .unwrap();
    writer.flush().await.unwrap();
}

fn success(id: u64, result: serde_json::Value) -> ResponseEnvelope {
    ResponseEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Response,
        id,
        result: Some(result),
        error: None,
    }
}

#[tokio::test]
async fn hello_register_and_reconcile_are_strict_and_window_only() {
    let expected = endpoint();
    let server_endpoint = expected.clone();
    let (client, mut server) = tokio::io::duplex(64 * 1024);
    let callback_events = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&callback_events);
    let sink: Arc<dyn super::DaemonEventSink> = Arc::new(move |event| {
        captured.lock().unwrap().push(event);
    });

    let server_task = tokio::spawn(async move {
        let hello = read_request(&mut server).await;
        assert_eq!(hello.method, Method::Hello);
        let params: terminal_host_protocol::HelloRequest =
            serde_json::from_value(hello.params).unwrap();
        assert_eq!(params.client, ClientClass::Desktop);
        write_json(
            &mut server,
            &success(
                hello.id,
                serde_json::json!({
                    "selected_version": PROTOCOL_VERSION,
                    "runtime_id": server_endpoint.runtime_id,
                    "launch_nonce": server_endpoint.launch_nonce,
                    "owner_generation": server_endpoint.owner_generation,
                    "connection_id": "connection0123456789",
                    "capabilities": capabilities(),
                }),
            ),
        )
        .await;

        let register = read_request(&mut server).await;
        assert_eq!(register.method, Method::DesktopRegister);
        let registration: DesktopRegisterRequest = serde_json::from_value(register.params).unwrap();
        assert_eq!(
            registration.surface_protocol_version,
            SURFACE_PRESENTATION_V1
        );
        assert_eq!(
            registration.placements,
            vec![Placement::Window, Placement::Workspace]
        );
        assert!(registration.background_presentation);

        let event = EventEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Event,
            event: EventName::SurfacePresentRequested,
            payload: serde_json::to_value(SurfacePresentRequestedEvent {
                handle: "handle0123456789".into(),
                revision: 1,
                placement: Placement::Window,
                workspace_target: None,
                presentation: Presentation::Background,
            })
            .unwrap(),
        };
        write_json(&mut server, &event).await;
        write_json(
            &mut server,
            &success(register.id, serde_json::to_value(EmptyResponse {}).unwrap()),
        )
        .await;

        let list = read_request(&mut server).await;
        assert_eq!(list.method, Method::SessionList);
        write_json(
            &mut server,
            &success(
                list.id,
                serde_json::to_value(SessionListResponse { sessions: vec![] }).unwrap(),
            ),
        )
        .await;
    });

    let mut connected = authenticate(
        client,
        &expected,
        "not-a-real-secret".into(),
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    let catalog = initialize_desktop(&mut connected, Duration::from_secs(1), &sink)
        .await
        .unwrap();
    assert!(catalog.sessions.is_empty());
    server_task.await.unwrap();
    assert!(matches!(
        callback_events.lock().unwrap().as_slice(),
        [DaemonEvent::SurfacePresentRequested(_)]
    ));
}

#[tokio::test]
async fn hello_rejects_a_mismatched_runtime_tuple() {
    let expected = endpoint();
    let (client, mut server) = tokio::io::duplex(16 * 1024);
    tokio::spawn(async move {
        let hello = read_request(&mut server).await;
        write_json(
            &mut server,
            &success(
                hello.id,
                serde_json::json!({
                    "selected_version": ProtocolVersion { major: 1, minor: 0 },
                    "runtime_id": "different-runtime",
                    "launch_nonce": "nonce0123456789",
                    "owner_generation": 7,
                    "connection_id": "connection0123456789",
                    "capabilities": capabilities(),
                }),
            ),
        )
        .await;
    });
    let error = authenticate(client, &expected, "secret".into(), Duration::from_secs(1))
        .await
        .err()
        .unwrap();
    assert_eq!(error, DaemonClientError::Authentication);
}

#[tokio::test]
async fn request_mux_projects_events_and_disconnect_does_not_replay() {
    let (client, mut server) = tokio::io::duplex(64 * 1024);
    let connected = Connected {
        stream: client,
        selected: PROTOCOL_VERSION,
        runtime_id: "runtime0123456789".into(),
    };
    let mut config = DaemonClientConfig::new(std::env::temp_dir());
    config.request_timeout = Duration::from_millis(250);
    let (commands, receiver) = mpsc::channel(8);
    let handle = DaemonClientHandle {
        commands,
        request_timeout: config.request_timeout,
    };
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    let sink: Arc<dyn super::DaemonEventSink> = Arc::new(move |event| {
        captured.lock().unwrap().push(event);
    });
    let actor = tokio::spawn(run_test_connection(
        connected,
        config,
        Arc::clone(&sink),
        receiver,
    ));

    let server_task = tokio::spawn(async move {
        let first = read_request(&mut server).await;
        let second = read_request(&mut server).await;
        let event = EventEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Event,
            event: EventName::SurfacePresentRequested,
            payload: serde_json::to_value(SurfacePresentRequestedEvent {
                handle: "handle0123456789".into(),
                revision: 2,
                placement: Placement::Window,
                workspace_target: None,
                presentation: Presentation::Focused,
            })
            .unwrap(),
        };
        write_json(&mut server, &event).await;
        for request in [second, first] {
            let result = match request.method {
                Method::Health => serde_json::json!({
                    "status": "ok",
                    "runtime_id": "runtime0123456789",
                    "owner_generation": 7,
                    "desktop_available": true,
                }),
                Method::SessionList => {
                    serde_json::to_value(SessionListResponse { sessions: vec![] }).unwrap()
                }
                _ => panic!("unexpected method"),
            };
            write_json(&mut server, &success(request.id, result)).await;
        }
    });

    let (health, list) = tokio::join!(handle.health(), handle.list());
    assert_eq!(health.unwrap().runtime_id, "runtime0123456789");
    assert!(list.unwrap().sessions.is_empty());
    server_task.await.unwrap();
    assert!(matches!(
        events.lock().unwrap().as_slice(),
        [DaemonEvent::SurfacePresentRequested(_)]
    ));

    let after_disconnect = handle.health().await.unwrap_err();
    assert!(matches!(
        after_disconnect,
        DaemonClientError::Disconnected | DaemonClientError::Timeout
    ));
    actor.await.unwrap();
}
