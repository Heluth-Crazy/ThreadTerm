#![cfg(all(windows, feature = "terminal-daemon-owner"))]

use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use serde_json::Value;
use terminal_host_protocol::{
    ClientClass, CloseMode, CreateDisposition, DesktopRegisterRequest, EnvelopeKind, EventEnvelope,
    EventName, EventPayload, HelloRequest, Method, Placement, Presentation, ProtocolRange,
    RequestEnvelope, ResponseEnvelope, SessionAttachRequest, SessionAttachResponse,
    SessionCloseRequest, SessionCreateRequest, SessionCreateResponse, SessionInputRequest,
    SurfacePresentRequestedEvent, SurfaceReadyRequest, TransportErrorCode, PROTOCOL_VERSION,
    SURFACE_PRESENTATION_V1,
};
use threadterm_terminal_host::{
    bootstrap::{read_endpoint, BootstrapPaths, Secret},
    service::HelloAck,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    time::timeout,
};

const IO_TIMEOUT: Duration = Duration::from_secs(10);

struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

async fn write_request<T: Serialize>(
    client: &mut NamedPipeClient,
    id: u64,
    method: Method,
    params: T,
) {
    let envelope = RequestEnvelope {
        version: PROTOCOL_VERSION,
        kind: EnvelopeKind::Request,
        id,
        method,
        params: serde_json::to_value(params).unwrap(),
    };
    let body = serde_json::to_vec(&envelope).unwrap();
    timeout(IO_TIMEOUT, client.write_u32_le(body.len() as u32))
        .await
        .unwrap()
        .unwrap();
    timeout(IO_TIMEOUT, client.write_all(&body))
        .await
        .unwrap()
        .unwrap();
}

async fn read_value(client: &mut NamedPipeClient) -> Value {
    let length = timeout(IO_TIMEOUT, client.read_u32_le())
        .await
        .unwrap()
        .unwrap() as usize;
    assert!(length > 0 && length <= terminal_host_protocol::MAX_FRAME_BYTES);
    let mut body = vec![0; length];
    timeout(IO_TIMEOUT, client.read_exact(&mut body))
        .await
        .unwrap()
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn read_response(client: &mut NamedPipeClient, id: u64) -> ResponseEnvelope {
    loop {
        let value = read_value(client).await;
        if value.get("kind") == Some(&Value::String("response".into()))
            && value.get("id") == Some(&Value::Number(id.into()))
        {
            return serde_json::from_value(value).unwrap();
        }
    }
}

async fn wait_for_endpoint(
    paths: &BootstrapPaths,
) -> threadterm_terminal_host::bootstrap::RuntimeEndpoint {
    timeout(IO_TIMEOUT, async {
        loop {
            if let Ok(endpoint) = read_endpoint(paths.endpoint()) {
                break endpoint;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("daemon must publish its endpoint")
}

async fn connect(pipe_name: &str) -> NamedPipeClient {
    timeout(IO_TIMEOUT, async {
        loop {
            match ClientOptions::new().open(pipe_name) {
                Ok(client) => break client,
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => panic!("named-pipe connect failed: {error}"),
            }
        }
    })
    .await
    .expect("daemon pipe must become connectable")
}

async fn read_surface_request(client: &mut NamedPipeClient) -> SurfacePresentRequestedEvent {
    loop {
        let value = read_value(client).await;
        if value.get("event")
            == Some(&serde_json::to_value(EventName::SurfacePresentRequested).unwrap())
        {
            let event: EventEnvelope = serde_json::from_value(value).unwrap();
            return match event.decode_payload().unwrap() {
                EventPayload::SurfacePresentRequested(request) => request,
                _ => unreachable!("event token and payload type must agree"),
            };
        }
    }
}

async fn attach_and_ready(
    desktop: &mut NamedPipeClient,
    request_id: u64,
    request: &SurfacePresentRequestedEvent,
) -> SessionAttachResponse {
    write_request(
        desktop,
        request_id,
        Method::SessionAttach,
        SessionAttachRequest {
            handle: request.handle.clone(),
        },
    )
    .await;
    let attached: SessionAttachResponse =
        serde_json::from_value(read_response(desktop, request_id).await.result.unwrap()).unwrap();
    write_request(
        desktop,
        request_id + 1,
        Method::SurfaceReady,
        SurfaceReadyRequest {
            handle: request.handle.clone(),
            revision: request.revision,
            attach_id: attached.attach_id.clone(),
            stream_id: attached.stream_id.clone(),
        },
    )
    .await;
    assert!(read_response(desktop, request_id + 1).await.error.is_none());
    attached
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_daemon_named_pipe_owns_real_conpty_end_to_end() {
    use std::os::windows::process::CommandExt;

    let profile = tempfile::tempdir().unwrap();
    let paths = BootstrapPaths::from_profile_dir(profile.path().to_path_buf()).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_threadterm-terminal-host"));
    command
        .args([
            "--profile-dir",
            profile.path().to_str().unwrap(),
            "--role",
            "become-owner",
        ])
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command.spawn().unwrap();
    let mut child = ChildGuard(Some(child));

    let endpoint = wait_for_endpoint(&paths).await;
    assert_eq!(endpoint.pid, child.0.as_ref().unwrap().id());
    let secret = Secret::read(paths.secret()).unwrap();
    let mut desktop = connect(&endpoint.pipe_name).await;

    write_request(
        &mut desktop,
        1,
        Method::Hello,
        HelloRequest {
            protocol: ProtocolRange {
                min: PROTOCOL_VERSION,
                max: PROTOCOL_VERSION,
            },
            client: ClientClass::Desktop,
            capabilities: vec![],
            secret: secret.encoded(),
        },
    )
    .await;
    let hello = read_response(&mut desktop, 1).await;
    let ack: HelloAck = serde_json::from_value(hello.result.unwrap()).unwrap();
    assert_eq!(ack.runtime_id, endpoint.runtime_id);
    assert!(ack.capabilities.contains(&"session.create".into()));
    assert!(ack.capabilities.contains(&"surface.ready".into()));

    write_request(
        &mut desktop,
        2,
        Method::DesktopRegister,
        DesktopRegisterRequest {
            surface_protocol_version: SURFACE_PRESENTATION_V1.into(),
            placements: vec![Placement::Workspace, Placement::Window],
            background_presentation: true,
        },
    )
    .await;
    assert!(read_response(&mut desktop, 2).await.error.is_none());

    let mut control = connect(&endpoint.pipe_name).await;
    write_request(
        &mut control,
        1,
        Method::Hello,
        HelloRequest {
            protocol: ProtocolRange {
                min: PROTOCOL_VERSION,
                max: PROTOCOL_VERSION,
            },
            client: ClientClass::McpBridge,
            capabilities: vec![],
            secret: secret.encoded(),
        },
    )
    .await;
    let control_ack: HelloAck =
        serde_json::from_value(read_response(&mut control, 1).await.result.unwrap()).unwrap();
    assert!(!control_ack
        .capabilities
        .contains(&"desktop.register".into()));

    write_request(
        &mut control,
        3,
        Method::SessionCreate,
        SessionCreateRequest {
            request_id: "daemon-e2e:create".into(),
            executable: "cmd.exe".into(),
            args: vec!["/D".into(), "/Q".into(), "/K".into()],
            cwd: profile.path().to_string_lossy().into_owned(),
            title: Some("daemon-e2e".into()),
            placement: Placement::Workspace,
            presentation: Presentation::Background,
            exit_behavior: terminal_host_protocol::ExitBehavior::Keep,
            rows: 24,
            cols: 80,
        },
    )
    .await;
    let first_present = read_surface_request(&mut desktop).await;
    let attached = attach_and_ready(&mut desktop, 4, &first_present).await;
    let created: SessionCreateResponse =
        serde_json::from_value(read_response(&mut control, 3).await.result.unwrap()).unwrap();
    assert_eq!(created.disposition, CreateDisposition::Created);
    assert_eq!(created.session.handle, first_present.handle);
    assert!(created.session.child_pid.is_some());
    write_request(
        &mut desktop,
        6,
        Method::SessionInput,
        SessionInputRequest {
            attach_id: attached.attach_id.clone(),
            stream_id: attached.stream_id.clone(),
            data_base64: BASE64.encode(b"echo EXTERNAL_DAEMON_E2E_SENTINEL\r\n"),
        },
    )
    .await;

    let mut input_response = false;
    let mut observed_output = false;
    let deadline = Instant::now() + IO_TIMEOUT;
    while Instant::now() < deadline && !(input_response && observed_output) {
        let value = read_value(&mut desktop).await;
        if value.get("kind") == Some(&Value::String("response".into()))
            && value.get("id") == Some(&Value::Number(6.into()))
        {
            let response: ResponseEnvelope = serde_json::from_value(value).unwrap();
            assert!(response.error.is_none());
            input_response = true;
        } else if value.get("event")
            == Some(&serde_json::to_value(EventName::SessionOutput).unwrap())
        {
            let encoded = value["payload"]["data_base64"].as_str().unwrap();
            let output = BASE64.decode(encoded).unwrap();
            observed_output |=
                String::from_utf8_lossy(&output).contains("EXTERNAL_DAEMON_E2E_SENTINEL");
        }
    }
    assert!(input_response && observed_output);

    write_request(
        &mut control,
        7,
        Method::SessionClose,
        SessionCloseRequest {
            handle: created.session.handle,
            mode: CloseMode::Force,
        },
    )
    .await;
    assert!(read_response(&mut control, 7).await.error.is_none());

    write_request(
        &mut control,
        8,
        Method::SessionCreate,
        SessionCreateRequest {
            request_id: "daemon-e2e:stop".into(),
            executable: "cmd.exe".into(),
            args: vec!["/D".into(), "/Q".into(), "/K".into()],
            cwd: profile.path().to_string_lossy().into_owned(),
            title: None,
            placement: Placement::Window,
            presentation: Presentation::Background,
            exit_behavior: terminal_host_protocol::ExitBehavior::Keep,
            rows: 24,
            cols: 80,
        },
    )
    .await;
    let second_present = read_surface_request(&mut desktop).await;
    let _second_attach = attach_and_ready(&mut desktop, 9, &second_present).await;
    let second: SessionCreateResponse =
        serde_json::from_value(read_response(&mut control, 8).await.result.unwrap()).unwrap();
    assert_eq!(second.disposition, CreateDisposition::Created);

    write_request(
        &mut control,
        10,
        Method::RuntimeStop,
        terminal_host_protocol::RuntimeStopRequest {
            terminate_live_sessions: false,
        },
    )
    .await;
    assert_eq!(
        read_response(&mut control, 10).await.error.unwrap().code,
        TransportErrorCode::RuntimeBusy
    );
    assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none());

    write_request(
        &mut control,
        11,
        Method::RuntimeStop,
        terminal_host_protocol::RuntimeStopRequest {
            terminate_live_sessions: true,
        },
    )
    .await;
    assert!(read_response(&mut control, 11).await.error.is_none());
    drop(control);
    drop(desktop);

    let deadline = Instant::now() + IO_TIMEOUT;
    loop {
        if let Some(status) = child.0.as_mut().unwrap().try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "daemon did not stop after flushed response"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    child.0.take();
    timeout(IO_TIMEOUT, async {
        while paths.endpoint().exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owner must clean its exact endpoint tuple");
}
