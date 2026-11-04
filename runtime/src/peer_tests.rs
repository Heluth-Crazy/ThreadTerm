//! Loopback coverage for the desktop peer TLS transport.  These tests use the
//! generated certificate as an explicit rustls trust anchor; accepting the
//! self-signed certificate without that pin would not exercise the pairing
//! contract.
use crate::{
    db::Database,
    domain::RpcRequest,
    providers::{
        ChatSession, ProviderAdapter, ProviderCapability, ProviderError, ScopedProviderEvents,
        TerminalCommand,
    },
    remote_access::REMOTE_CERTIFICATE_FILE,
    service::RuntimeService,
    PROTOCOL_CONTRACT, PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_rustls::{
    rustls::{pki_types::ServerName, ClientConfig, RootCertStore},
    TlsConnector,
};

struct EmittingAdapter {
    events: Arc<Mutex<Option<crate::provider_events::Sender>>>,
    sends: Arc<AtomicUsize>,
    send_block: Arc<Mutex<Option<SendBlock>>>,
}
struct SendBlock {
    entered: std::sync::mpsc::SyncSender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
impl ProviderAdapter for EmittingAdapter {
    fn id(&self) -> &str {
        "peer-fixture"
    }
    fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            source: "builtin",
            plugin_id: None,
            icon: None,
            sign_in: None,
            homepage: None,
            id: self.id().into(),
            name: "Peer fixture".into(),
            installed: true,
            version: None,
            terminal: false,
            chat: true,
            history: false,
            resume: false,
            terminal_resume_capture: "none",
            reason: None,
            auth: "authenticated".into(),
        }
    }
    fn terminal_command(
        &self,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<TerminalCommand, ProviderError> {
        Err(ProviderError::new("unsupported", "fixture has no terminal"))
    }
    fn history_list(
        &self,
        _: Option<&str>,
        _: u32,
        _: Option<&str>,
    ) -> Result<Value, ProviderError> {
        Ok(json!({"items":[]}))
    }
    fn history_read(&self, _: &str) -> Result<Value, ProviderError> {
        Ok(json!([]))
    }
    fn scopes_chat_events(&self) -> bool {
        true
    }
    fn open_chat(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        Err(ProviderError::new(
            "fixture",
            "scoped peer fixture required",
        ))
    }
    fn open_chat_scoped(
        &self,
        session: &str,
        _: &str,
        _: Option<&str>,
        worker_token: &str,
    ) -> Result<Box<dyn ChatSession>, ProviderError> {
        let sender = self
            .events
            .lock()
            .unwrap()
            .clone()
            .expect("fixture event sender installed");
        Ok(Box::new(EmittingChat {
            events: ScopedProviderEvents::new(sender, worker_token),
            session: session.into(),
            sends: Arc::clone(&self.sends),
            send_block: Arc::clone(&self.send_block),
        }))
    }
}
struct EmittingChat {
    events: ScopedProviderEvents,
    session: String,
    sends: Arc<AtomicUsize>,
    send_block: Arc<Mutex<Option<SendBlock>>>,
}
impl ChatSession for EmittingChat {
    fn native_id(&self) -> Option<String> {
        Some("peer-fixture-native".into())
    }
    fn is_alive(&self) -> bool {
        true
    }
    fn send(&mut self, _: &str, _: &str) -> Result<Value, ProviderError> {
        self.sends.fetch_add(1, Ordering::SeqCst);
        let block = self.send_block.lock().unwrap().take();
        if let Some(block) = block {
            let _ = block.entered.send(());
            let _ = block.release.recv();
        }
        // A real adapter emits these through its reader. This deterministic
        // provider uses the real ingress and projection worker.
        for (kind, data) in [
            ("chat.turn.started", json!({"model":"peer-model"})),
            (
                "chat.delta",
                json!({"item":{"id":"peer-turn"},"part":{"type":"text","text":"peer delta"}}),
            ),
            ("chat.turn.completed", json!({})),
        ] {
            crate::providers::emit_bound(
                &self.events,
                "peer-fixture",
                &self.session,
                Some("peer-fixture-native"),
                Some("peer-turn"),
                kind,
                data,
            );
        }
        Ok(json!({"turnId":"peer-turn"}))
    }
    fn cancel(&mut self, _: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn approve(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ProviderError> {
        Ok(())
    }
    fn stop(&mut self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct Fixture {
    root: tempfile::TempDir,
    service: Arc<RuntimeService>,
    sends: Arc<AtomicUsize>,
    send_block: Arc<Mutex<Option<SendBlock>>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.service.shutdown();
    }
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let config = crate::config::RuntimeConfig {
            data_dir: root.path().into(),
            database_path: root.path().join("runtime.sqlite"),
            credential_path: root.path().join("credential"),
            pipe_base: r"\\.\pipe\threadterm-peer-tests".into(),
        };
        let db = Arc::new(Database::open(&config.database_path).unwrap());
        crate::workspace_services::initialize(&db).unwrap();
        crate::settings_services::initialize(&db).unwrap();
        crate::session_configs::initialize(&db).unwrap();
        crate::retry_scheduler::initialize(&db).unwrap();
        let events = Arc::new(Mutex::new(None));
        let sends = Arc::new(AtomicUsize::new(0));
        let send_block = Arc::new(Mutex::new(None));
        let service = Arc::new(RuntimeService::with_test_providers(
            config,
            Arc::clone(&db),
            vec![Arc::new(EmittingAdapter {
                events: Arc::clone(&events),
                sends: Arc::clone(&sends),
                send_block: Arc::clone(&send_block),
            })],
        ));
        *events.lock().unwrap() = Some(service.test_provider_events());
        service.initialize_remote().unwrap();
        Self {
            root,
            service,
            sends,
            send_block,
        }
    }
    fn rpc(&self, method: &str, params: Value) -> Value {
        self.service
            .dispatch(
                "desktop",
                RpcRequest {
                    v: PROTOCOL_VERSION,
                    id: uuid::Uuid::new_v4().to_string(),
                    method: method.into(),
                    params,
                },
            )
            .unwrap()
    }
    fn enable(&self) -> Value {
        self.rpc("settings.update", json!({"patch":{"remoteMachines":{"enabled":true}},"expectedRevision":0,"operationId":"peer-enable-setting"}));
        self.rpc(
            "device.enable",
            json!({"operationId":"peer-enable-listener"}),
        )
    }
    async fn desktop(&self) -> (Value, Value) {
        let status = self.enable();
        let offer = self.rpc("device.pairing.create", json!({"permission":"fullcontrol","profile":"desktop","operationId":"peer-desktop-pair"}));
        let paired = pair(
            self.root.path(),
            status["port"].as_u64().unwrap() as u16,
            &offer,
            "Peer computer",
        )
        .await;
        (status, paired)
    }
}

type PeerStream = tokio_rustls::client::TlsStream<TcpStream>;
async fn tls(root: &std::path::Path, port: u16, alpn: &[u8]) -> PeerStream {
    let mut roots = RootCertStore::empty();
    let mut pem = Cursor::new(std::fs::read(root.join(REMOTE_CERTIFICATE_FILE)).unwrap());
    for certificate in rustls_pemfile::certs(&mut pem) {
        roots.add(certificate.unwrap()).unwrap();
    }
    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![alpn.to_vec()];
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let connected = TlsConnector::from(Arc::new(config))
        .connect(
            ServerName::try_from("localhost").unwrap().to_owned(),
            stream,
        )
        .await
        .unwrap();
    assert_eq!(connected.get_ref().1.alpn_protocol(), Some(alpn));
    connected
}

async fn untrusted_tls(port: u16) -> bool {
    let mut config = ClientConfig::builder()
        .with_root_certificates(RootCertStore::empty())
        .with_no_client_auth();
    config.alpn_protocols = vec![crate::peer::ALPN.to_vec()];
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    TlsConnector::from(Arc::new(config))
        .connect(
            ServerName::try_from("localhost").unwrap().to_owned(),
            stream,
        )
        .await
        .is_err()
}
async fn read_frame(stream: &mut PeerStream) -> Value {
    let size = stream.read_u32_le().await.unwrap() as usize;
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
async fn write_frame(stream: &mut PeerStream, value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    stream.write_u32_le(bytes.len() as u32).await.unwrap();
    stream.write_all(&bytes).await.unwrap();
    stream.flush().await.unwrap();
}
async fn pair(root: &std::path::Path, port: u16, offer: &Value, name: &str) -> Value {
    let (status, value) = pair_response(root, port, offer, name).await;
    assert_eq!(status, 200, "{value}");
    value
}
async fn pair_response(
    root: &std::path::Path,
    port: u16,
    offer: &Value,
    name: &str,
) -> (u16, Value) {
    let mut stream = tls(root, port, b"http/1.1").await;
    let body = serde_json::to_vec(
        &json!({"pairingId":offer["id"],"code":offer["code"],"deviceName":name}),
    )
    .unwrap();
    stream.write_all(format!("POST /v1/pair HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
    stream.write_all(&body).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let end = response.iter().position(|byte| *byte == b'\r').unwrap();
    let status = std::str::from_utf8(&response[..end])
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let body = response.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    (
        status,
        serde_json::from_slice(&response[body + 4..]).unwrap(),
    )
}
async fn peer(
    root: &std::path::Path,
    port: u16,
    credential: &str,
    channel: &str,
    client: &str,
    epoch: Value,
) -> (PeerStream, Value) {
    let mut stream = tls(root, port, crate::peer::ALPN).await;
    let challenge = read_frame(&mut stream).await;
    write_frame(&mut stream, &json!({"kind":"auth","protocol":PROTOCOL_VERSION,"contract":PROTOCOL_CONTRACT,"nonce":challenge["nonce"],"channel":channel,"clientId":client,"credential":credential,"epoch":epoch})).await;
    let authenticated = read_frame(&mut stream).await;
    (stream, authenticated)
}

async fn control_rpc(stream: &mut PeerStream, id: &str, method: &str, params: Value) -> Value {
    write_frame(
        stream,
        &json!({"v":PROTOCOL_VERSION,"id":id,"method":method,"params":params}),
    )
    .await;
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), read_frame(stream))
            .await
            .unwrap();
        if frame["id"] == id {
            return frame;
        }
    }
}

async fn assert_closed(stream: &mut PeerStream) {
    let mut discarded = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut discarded))
        .await
        .expect("peer channel did not close within two seconds")
        .ok();
}

async fn reject_channel(
    fixture: &Fixture,
    port: u16,
    token: &str,
    channel: &str,
    client: &str,
    epoch: Value,
) {
    let mut stream = tls(fixture.root.path(), port, crate::peer::ALPN).await;
    let challenge = read_frame(&mut stream).await;
    write_frame(&mut stream, &json!({"kind":"auth","protocol":1,"contract":PROTOCOL_CONTRACT,
        "nonce":challenge["nonce"],"channel":channel,"clientId":client,"credential":token,"epoch":epoch})).await;
    // No authenticated frame may precede the close.
    let read = tokio::time::timeout(Duration::from_secs(2), stream.read_u8())
        .await
        .unwrap();
    assert!(read.is_err(), "rejected channel received application bytes");
}

async fn binary_frame(stream: &mut PeerStream, kind: u8, header: Value) {
    let header = serde_json::to_vec(&header).unwrap();
    let mut frame = vec![kind];
    frame.extend_from_slice(&(header.len() as u32).to_le_bytes());
    frame.extend(header);
    stream.write_u32_le(frame.len() as u32).await.unwrap();
    stream.write_all(&frame).await.unwrap();
    stream.flush().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn headless_remote_chat_projects_started_delta_completed_on_control() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let client = uuid::Uuid::new_v4().to_string();
    let (mut control, hello) = peer(
        fixture.root.path(),
        port,
        paired["token"].as_str().unwrap(),
        "control",
        &client,
        Value::Null,
    )
    .await;
    assert_eq!(
        hello["principal"],
        format!("peer:{}:{client}", paired["device"]["id"].as_str().unwrap())
    );
    let (_output, output_hello) = peer(
        fixture.root.path(),
        port,
        paired["token"].as_str().unwrap(),
        "output",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    assert_eq!(output_hello["kind"], "authenticated");
    let created = control_rpc(&mut control,"create","session.create",json!({"cwd":fixture.root.path(),"provider":"peer-fixture","mode":"chat","operationId":"peer-create"})).await;
    assert!(created.get("error").is_none(), "{created}");
    let id = created["result"]["id"].as_str().unwrap();
    let claimed = control_rpc(
        &mut control,
        "claim",
        "session.claim",
        json!({"sessionId":id}),
    )
    .await;
    let lease = claimed["result"]["leaseEpoch"].as_i64().unwrap();
    let connected = control_rpc(
        &mut control,
        "connect",
        "chat.connect",
        json!({"sessionId":id,"leaseEpoch":lease,"operationId":"peer-connect"}),
    )
    .await;
    assert!(connected.get("error").is_none(), "{connected}");
    for _ in 0..100 {
        let state = control_rpc(
            &mut control,
            "connection",
            "chat.connection",
            json!({"sessionId":id}),
        )
        .await;
        if state["result"]["phase"] == "ready" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    write_frame(&mut control,&json!({"v":1,"id":"send","method":"chat.send","params":{"sessionId":id,"leaseEpoch":lease,"text":"hello","operationId":"peer-send"}})).await;
    let (mut reply, mut started, mut delta, mut completed) = (false, false, false, false);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !(reply && started && delta && completed) {
            let frame = read_frame(&mut control).await;
            if frame["id"] == "send" {
                assert!(frame.get("error").is_none(), "{frame}");
                reply = true;
            }
            if frame["event"] == "chat.item" && frame["data"]["sessionId"] == id {
                let item = &frame["data"]["item"];
                started |= item["turnModel"] == "peer-model" && item["turnStatus"].is_null();
                delta |= item["parts"].as_array().is_some_and(|parts| {
                    parts
                        .iter()
                        .any(|part| part["text"] == "peer delta" && part["status"] == "streaming")
                });
                completed |= item["turnStatus"] == "completed";
            }
        }
    })
    .await
    .expect("started, streaming delta and completed projections must reach control");
    // A lost response is not replayed by transport. An explicit operation replay
    // still produces the original receipt and only one user item.
    let replay = control_rpc(
        &mut control,
        "send-again",
        "chat.send",
        json!({"sessionId":id,"leaseEpoch":lease,"text":"hello","operationId":"peer-send"}),
    )
    .await;
    assert_eq!(replay["result"]["turnId"], "peer-turn");
    let users: i64 = fixture
        .service
        .db
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM chat_items WHERE session_id=? AND json_extract(data,'$.role')='user'",
                [id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(users, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn output_subscription_receives_real_shell_terminal_bytes() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let client = uuid::Uuid::new_v4().to_string();
    let (mut control, hello) = peer(
        fixture.root.path(),
        port,
        paired["token"].as_str().unwrap(),
        "control",
        &client,
        Value::Null,
    )
    .await;
    let (mut output, _) = peer(
        fixture.root.path(),
        port,
        paired["token"].as_str().unwrap(),
        "output",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    let shell=control_rpc(&mut control,"create","session.create",json!({"cwd":fixture.root.path(),"provider":"shell","mode":"terminal","operationId":"peer-shell-create"})).await;
    assert!(shell.get("error").is_none(), "{shell}");
    let id = shell["result"]["id"].as_str().unwrap();
    let claim = control_rpc(
        &mut control,
        "claim",
        "session.claim",
        json!({"sessionId":id}),
    )
    .await;
    let lease = claim["result"]["leaseEpoch"].as_i64().unwrap();
    binary_frame(&mut output, 3, json!({"sessionId":id,"cursor":0})).await;
    binary_frame(&mut output, 2, json!({"sessionId":id,"credit":65536})).await;
    let input = control_rpc(
        &mut control,
        "input",
        "terminal.input",
        json!({"sessionId":id,"leaseEpoch":lease,"data":"echo peer-shell-marker\r\n"}),
    )
    .await;
    assert!(input.get("error").is_none(), "{input}");
    let mut observed = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&observed).contains("peer-shell-marker") {
            let size = output.read_u32_le().await.unwrap() as usize;
            assert!(size <= crate::transport::MAX_FRAME);
            let mut frame = vec![0; size];
            output.read_exact(&mut frame).await.unwrap();
            if frame[0] == 1 {
                let len = u32::from_le_bytes(frame[1..5].try_into().unwrap()) as usize;
                observed.extend_from_slice(&frame[5 + len..]);
            }
        }
    })
    .await
    .unwrap();
    let stopped = control_rpc(
        &mut control,
        "exit",
        "terminal.input",
        json!({"sessionId":id,"leaseEpoch":lease,"data":"exit\r\n"}),
    )
    .await;
    assert!(stopped.get("error").is_none(), "{stopped}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn incompatible_frames_name_both_contracts_before_admitting_work() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let mut stream = tls(fixture.root.path(), port, crate::peer::ALPN).await;
    let challenge = read_frame(&mut stream).await;
    assert_eq!(challenge["version"], crate::RUNTIME_VERSION);
    write_frame(&mut stream,&json!({"kind":"auth","protocol":1,"contract":18,"version":"old-client","nonce":challenge["nonce"],"channel":"control","clientId":uuid::Uuid::new_v4(),"credential":paired["token"],"epoch":null})).await;
    let incompatible = read_frame(&mut stream).await;
    assert_eq!(incompatible["kind"], "incompatible");
    assert_eq!(incompatible["contract"], 19);
    assert_eq!(incompatible["receivedContract"], 18);
    assert_eq!(incompatible["receivedVersion"], "old-client");
    assert_closed(&mut stream).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn channels_require_same_device_client_epoch_and_live_control() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let client = uuid::Uuid::new_v4().to_string();
    for channel in ["output", "browser", "tunnel"] {
        reject_channel(&fixture, port, token, channel, &client, json!("absent")).await;
    }
    let (control, hello) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &client,
        Value::Null,
    )
    .await;
    for channel in ["output", "browser"] {
        reject_channel(
            &fixture,
            port,
            token,
            channel,
            &client,
            json!("wrong-epoch"),
        )
        .await;
        reject_channel(
            &fixture,
            port,
            token,
            channel,
            &uuid::Uuid::new_v4().to_string(),
            hello["epoch"].clone(),
        )
        .await;
    }
    let offer = fixture.rpc(
        "device.pairing.create",
        json!({"permission":"fullcontrol","profile":"desktop","operationId":"second-computer"}),
    );
    let other = pair(fixture.root.path(), port, &offer, "Other PC").await;
    for channel in ["output", "browser"] {
        reject_channel(
            &fixture,
            port,
            other["token"].as_str().unwrap(),
            channel,
            &client,
            hello["epoch"].clone(),
        )
        .await;
    }
    let (mut output, _) = peer(
        fixture.root.path(),
        port,
        token,
        "output",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    let (mut browser, _) = peer(
        fixture.root.path(),
        port,
        token,
        "browser",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    drop(control);
    assert_closed(&mut output).await;
    assert_closed(&mut browser).await;
    reject_channel(
        &fixture,
        port,
        token,
        "output",
        &client,
        hello["epoch"].clone(),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn profiles_replay_expired_and_unconfirmed_credentials_are_rejected() {
    let fixture = Fixture::new();
    let (status, desktop) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let offer = fixture.rpc(
        "device.pairing.create",
        json!({"permission":"readonly","operationId":"phone"}),
    );
    let phone = pair(fixture.root.path(), port, &offer, "Phone").await;
    assert_eq!(
        pair_response(fixture.root.path(), port, &offer, "Replay")
            .await
            .0,
        401
    );
    reject_channel(
        &fixture,
        port,
        phone["token"].as_str().unwrap(),
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
    // A desktop credential cannot use the phone RPC route.
    let mut http = tls(fixture.root.path(), port, b"http/1.1").await;
    let body = r#"{"method":"remote.sessions","params":{}}"#;
    http.write_all(format!("POST /v1/rpc HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",desktop["token"].as_str().unwrap(),body.len()).as_bytes()).await.unwrap();
    let mut response = Vec::new();
    http.read_to_end(&mut response).await.unwrap();
    assert!(response.starts_with(b"HTTP/1.1 401"));
    for (operation, unconfirmed) in [("expired", false), ("unconfirmed", true)] {
        let offer = fixture.rpc(
            "device.pairing.create",
            json!({"permission":"fullcontrol","profile":"desktop","operationId":operation}),
        );
        let paired = pair(fixture.root.path(), port, &offer, operation).await;
        fixture
            .service
            .db
            .transaction(|tx| {
                if unconfirmed {
                    tx.execute(
                        "UPDATE paired_devices SET created_at=? WHERE id=?",
                        rusqlite::params![
                            (chrono::Utc::now() - chrono::Duration::minutes(11)).to_rfc3339(),
                            paired["device"]["id"].as_str().unwrap()
                        ],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE paired_devices SET expires_at=? WHERE id=?",
                        rusqlite::params![
                            (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339(),
                            paired["device"]["id"].as_str().unwrap()
                        ],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        reject_channel(
            &fixture,
            port,
            paired["token"].as_str().unwrap(),
            "control",
            &uuid::Uuid::new_v4().to_string(),
            Value::Null,
        )
        .await;
        let rows: i64 = fixture
            .service
            .db
            .transaction(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM paired_devices WHERE id=?",
                    [paired["device"]["id"].as_str().unwrap()],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(rows, 0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_deny_entry_is_refused_over_peer_control_and_real_locally() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let (mut control, _) = peer(
        fixture.root.path(),
        port,
        paired["token"].as_str().unwrap(),
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
    for method in crate::peer::DENIED_METHODS {
        let denied = control_rpc(&mut control, "deny", method, json!({})).await;
        assert_eq!(
            denied["error"]["code"], "peer_forbidden",
            "{method}: {denied}"
        );
        if let Err(error) = fixture.service.dispatch(
            "desktop",
            RpcRequest {
                v: 1,
                id: "local-check".into(),
                method: (*method).into(),
                params: json!({}),
            },
        ) {
            assert_ne!(error.code, "unknown_method", "{method}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revoke_closes_control_output_browser_and_expires_lease() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let client = uuid::Uuid::new_v4().to_string();
    let (mut control, hello) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &client,
        Value::Null,
    )
    .await;
    let (mut output, _) = peer(
        fixture.root.path(),
        port,
        token,
        "output",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    let (mut browser, _) = peer(
        fixture.root.path(),
        port,
        token,
        "browser",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    let session=fixture.rpc("session.create",json!({"cwd":fixture.root.path(),"provider":"peer-fixture","mode":"chat","operationId":"lease-session"}));
    let id = session["id"].as_str().unwrap();
    let claimed = control_rpc(
        &mut control,
        "claim",
        "session.claim",
        json!({"sessionId":id}),
    )
    .await;
    let epoch = claimed["result"]["leaseEpoch"].as_i64().unwrap();
    let principal = hello["principal"].as_str().unwrap();
    fixture
        .service
        .leases
        .require(&fixture.service.db, id, principal, epoch)
        .unwrap();
    fixture.rpc(
        "device.revoke",
        json!({"deviceId":paired["device"]["id"],"operationId":"revoke"}),
    );
    tokio::join!(
        assert_closed(&mut control),
        assert_closed(&mut output),
        assert_closed(&mut browser)
    );
    assert!(fixture
        .service
        .leases
        .require(&fixture.service.db, id, principal, epoch)
        .is_err());
    assert_eq!(
        crate::peer::guard(&fixture.service, principal, "project.add")
            .unwrap_err()
            .code,
        "peer_revoked"
    );
    reject_channel(
        &fixture,
        port,
        token,
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gate_off_refuses_peer_and_desktop_offers_but_keeps_phone_pairing() {
    let fixture = Fixture::new();
    let status = fixture.rpc("device.enable", json!({"operationId":"listener"}));
    let port = status["port"].as_u64().unwrap() as u16;
    let mut stream = tls(fixture.root.path(), port, crate::peer::ALPN).await;
    assert!(
        tokio::time::timeout(Duration::from_secs(2), stream.read_u8())
            .await
            .unwrap()
            .is_err()
    );
    let denied = fixture.service.dispatch(
        "desktop",
        RpcRequest {
            v: 1,
            id: "gate".into(),
            method: "device.pairing.create".into(),
            params: json!({"permission":"fullcontrol","profile":"desktop","operationId":"blocked"}),
        },
    );
    assert!(denied.is_err());
    let phone = fixture.rpc(
        "device.pairing.create",
        json!({"permission":"readonly","operationId":"phone-offer"}),
    );
    assert_eq!(
        pair_response(fixture.root.path(), port, &phone, "Phone")
            .await
            .0,
        200
    );
    assert!(
        untrusted_tls(port).await,
        "wrong pin must fail before writing any credentials"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turning_the_gate_off_closes_live_peer_channels() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let client = uuid::Uuid::new_v4().to_string();
    let (mut control, hello) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &client,
        Value::Null,
    )
    .await;
    let (mut output, _) = peer(
        fixture.root.path(),
        port,
        token,
        "output",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    let revision: i64 = fixture
        .service
        .db
        .transaction(|tx| {
            Ok(tx.query_row(
                "SELECT revision FROM settings WHERE singleton=1",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    fixture.rpc(
        "settings.update",
        json!({"patch":{"remoteMachines":{"enabled":false}},"expectedRevision":revision,"operationId":"peer-gate-off"}),
    );
    // Validation is cached for up to a second, so this also bounds that window.
    tokio::join!(assert_closed(&mut control), assert_closed(&mut output));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dropped_send_response_is_not_duplicated_after_reconnect() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let (mut control, hello) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
    let created=control_rpc(&mut control,"create","session.create",json!({"cwd":fixture.root.path(),"provider":"peer-fixture","mode":"chat","operationId":"lost-create"})).await;
    let id = created["result"]["id"].as_str().unwrap();
    let claim = control_rpc(
        &mut control,
        "claim",
        "session.claim",
        json!({"sessionId":id}),
    )
    .await;
    let lease = claim["result"]["leaseEpoch"].as_i64().unwrap();
    control_rpc(
        &mut control,
        "connect",
        "chat.connect",
        json!({"sessionId":id,"leaseEpoch":lease,"operationId":"lost-connect"}),
    )
    .await;
    for _ in 0..100 {
        let state = control_rpc(
            &mut control,
            "state",
            "chat.connection",
            json!({"sessionId":id}),
        )
        .await;
        if state["result"]["phase"] == "ready" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    write_frame(&mut control,&json!({"v":1,"id":"lost-response","method":"chat.send","params":{"sessionId":id,"leaseEpoch":lease,"text":"only once","operationId":"lost-send"}})).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.service.db.operation("lost-send").unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // Deliberately never read the successful RPC reply.
    drop(control);
    tokio::time::timeout(Duration::from_secs(2), async {
        while crate::peer::guard(
            &fixture.service,
            hello["principal"].as_str().unwrap(),
            "runtime.health",
        )
        .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (mut reconnected, _) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
    let claim = control_rpc(
        &mut reconnected,
        "claim",
        "session.claim",
        json!({"sessionId":id}),
    )
    .await;
    let replay=control_rpc(&mut reconnected,"receipt","chat.send",json!({"sessionId":id,"leaseEpoch":claim["result"]["leaseEpoch"],"text":"only once","operationId":"lost-send"})).await;
    // The new lease changes request identity. Its explicit retry is refused
    // by the existing operation fence rather than sending a second turn.
    assert_eq!(replay["error"]["code"], "operation_conflict", "{replay}");
    assert_eq!(
        fixture.sends.load(Ordering::SeqCst),
        1,
        "native provider send must never be replayed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saturated_output_capacity_preserves_control_and_pairing() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let client = uuid::Uuid::new_v4().to_string();
    let (_control, hello) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &client,
        Value::Null,
    )
    .await;
    let mut streams = Vec::new();
    for _ in 0..32 {
        streams.push(
            peer(
                fixture.root.path(),
                port,
                token,
                "output",
                &client,
                hello["epoch"].clone(),
            )
            .await
            .0,
        );
    }
    reject_channel(
        &fixture,
        port,
        token,
        "output",
        &client,
        hello["epoch"].clone(),
    )
    .await;
    let (mut extra_control, _) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
    assert!(
        control_rpc(&mut extra_control, "health", "runtime.health", json!({}))
            .await
            .get("error")
            .is_none()
    );
    let offer = fixture.rpc(
        "device.pairing.create",
        json!({"permission":"readonly","operationId":"pair-under-load"}),
    );
    assert_eq!(
        pair_response(fixture.root.path(), port, &offer, "Phone under load")
            .await
            .0,
        200
    );
    drop(streams);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revoke_rejects_work_queued_behind_an_in_flight_send() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let (mut control, _) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
    let created=control_rpc(&mut control,"create","session.create",json!({"cwd":fixture.root.path(),"provider":"peer-fixture","mode":"chat","operationId":"queued-create"})).await;
    let id = created["result"]["id"].as_str().unwrap();
    let claim = control_rpc(
        &mut control,
        "claim",
        "session.claim",
        json!({"sessionId":id}),
    )
    .await;
    let lease = claim["result"]["leaseEpoch"].as_i64().unwrap();
    control_rpc(
        &mut control,
        "connect",
        "chat.connect",
        json!({"sessionId":id,"leaseEpoch":lease,"operationId":"queued-connect"}),
    )
    .await;
    for _ in 0..100 {
        if control_rpc(
            &mut control,
            "state",
            "chat.connection",
            json!({"sessionId":id}),
        )
        .await["result"]["phase"]
            == "ready"
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    *fixture.send_block.lock().unwrap() = Some(SendBlock {
        entered: entered_tx,
        release: release_rx,
    });
    write_frame(&mut control,&json!({"v":1,"id":"in-flight","method":"chat.send","params":{"sessionId":id,"leaseEpoch":lease,"text":"already running","operationId":"queued-first"}})).await;
    let queued_path = fixture.root.path().join("must-not-be-added");
    std::fs::create_dir(&queued_path).unwrap();
    write_frame(&mut control,&json!({"v":1,"id":"queued","method":"project.add","params":{"path":queued_path,"operationId":"queued-project"}})).await;
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();
    // Give the decoder a turn to put the following request on its ordered lane.
    tokio::time::sleep(Duration::from_millis(50)).await;
    fixture.rpc(
        "device.revoke",
        json!({"deviceId":paired["device"]["id"],"operationId":"queued-revoke"}),
    );
    assert_closed(&mut control).await;
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture
            .service
            .db
            .operation("queued-first")
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        fixture
            .service
            .db
            .operation("queued-project")
            .unwrap()
            .is_none(),
        "revoked queued mutation must not execute"
    );
    assert!(fixture
        .service
        .db
        .snapshot()
        .unwrap()
        .projects
        .iter()
        .all(|project| project.path != queued_path.to_str().unwrap()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_certificate_pin_sends_zero_credential_bytes_to_server() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let remote = fixture.service.remote.get().unwrap();
    assert_eq!(remote.peers.credential_bytes.load(Ordering::Relaxed), 0);
    assert!(untrusted_tls(port).await);
    assert_eq!(
        remote.peers.credential_bytes.load(Ordering::Relaxed),
        0,
        "pin failure must precede any auth credential frame"
    );
    let token = paired["token"].as_str().unwrap();
    let (_control, _) = peer(
        fixture.root.path(),
        port,
        token,
        "control",
        &uuid::Uuid::new_v4().to_string(),
        Value::Null,
    )
    .await;
    assert_eq!(
        remote.peers.credential_bytes.load(Ordering::Relaxed),
        token.len(),
        "the counter must observe a correctly pinned auth frame"
    );
}
async fn tunnel_auth(fixture: &Fixture, port: u16, token: &str, client: &str, epoch: Value, target: Value) -> PeerStream {
    let mut stream = tls(fixture.root.path(), port, crate::peer::ALPN).await;
    let challenge = read_frame(&mut stream).await;
    let mut auth = json!({"kind":"auth","protocol":PROTOCOL_VERSION,"contract":PROTOCOL_CONTRACT,
        "nonce":challenge["nonce"],"channel":"tunnel","clientId":client,"credential":token,"epoch":epoch});
    for (key, value) in target.as_object().unwrap() { auth[key] = value.clone(); }
    write_frame(&mut stream, &auth).await;
    stream
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnel_requires_control_epoch_and_exact_target_before_connect() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let client = uuid::Uuid::new_v4().to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"loopback":"127.0.0.1","port":listener.local_addr().unwrap().port()});
    let mut orphan = tunnel_auth(&fixture, port, token, &client, json!("wrong"), target.clone()).await;
    assert_closed(&mut orphan).await;
    let (_control, hello) = peer(fixture.root.path(), port, token, "control", &client, Value::Null).await;
    let mut wrong = tunnel_auth(&fixture, port, token, &client, json!("wrong"), target.clone()).await;
    assert_closed(&mut wrong).await;
    for invalid in [json!({"loopback":"127.0.0.2","port":80}), json!({"loopback":"localhost","port":80}), json!({"loopback":"::1","port":0}), json!({"loopback":"127.0.0.1","port":65536})] {
        let mut stream = tunnel_auth(&fixture, port, token, &client, hello["epoch"].clone(), invalid).await;
        assert_closed(&mut stream).await;
    }
    assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err(), "refused auth must not connect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnel_raw_bytes_failed_connect_and_control_revoke_gate_shutdown() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_port = listener.local_addr().unwrap().port();
    let target = json!({"loopback":"127.0.0.1","port":target_port});
    for reason in ["control", "gate", "revoke"] {
        let client = uuid::Uuid::new_v4().to_string();
        let (control, hello) = peer(fixture.root.path(), port, token, "control", &client, Value::Null).await;
        let mut stream = tunnel_auth(&fixture, port, token, &client, hello["epoch"].clone(), target.clone()).await;
        assert_eq!(read_frame(&mut stream).await["kind"], "authenticated");
        let (mut host, _) = listener.accept().await.unwrap();
        host.write_all(b"HOST\0\xff").await.unwrap();
        let mut bytes = [0; 6]; stream.read_exact(&mut bytes).await.unwrap(); assert_eq!(&bytes, b"HOST\0\xff");
        stream.write_all(b"CLIENT\0\xff").await.unwrap();
        let mut bytes = [0; 8]; host.read_exact(&mut bytes).await.unwrap(); assert_eq!(&bytes, b"CLIENT\0\xff");
        match reason {
            "control" => drop(control),
            "gate" => { fixture.rpc("settings.update", json!({"patch":{"remoteMachines":{"enabled":false}},"expectedRevision":1,"operationId":"tunnel-gate-off"})); },
            _ => { fixture.rpc("device.revoke", json!({"deviceId":paired["device"]["id"],"operationId":"tunnel-revoke"})); }
        }
        assert_closed(&mut stream).await;
        let mut byte = [0]; assert_eq!(tokio::time::timeout(Duration::from_secs(2), host.read(&mut byte)).await.unwrap().unwrap(), 0);
        if reason == "gate" { fixture.rpc("settings.update", json!({"patch":{"remoteMachines":{"enabled":true}},"expectedRevision":2,"operationId":"tunnel-gate-on"})); }
    }
    // A fresh device permits checking failed establishment after the revoke above.
    let offer = fixture.rpc("device.pairing.create", json!({"permission":"fullcontrol","profile":"desktop","operationId":"tunnel-second-device"}));
    let paired = pair(fixture.root.path(), port, &offer, "Second peer").await;
    let token = paired["token"].as_str().unwrap();
    let client = uuid::Uuid::new_v4().to_string();
    let (_control, hello) = peer(fixture.root.path(), port, token, "control", &client, Value::Null).await;
    drop(listener);
    let mut stream = tunnel_auth(&fixture, port, token, &client, hello["epoch"].clone(), target.clone()).await;
    let failed = read_frame(&mut stream).await;
    assert_eq!(failed["kind"], "tunnel_failed"); assert_eq!(failed["code"], "connection_refused");
    assert_closed(&mut stream).await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", target_port)).await.unwrap();
    let mut stream = tunnel_auth(&fixture, port, token, &client, hello["epoch"].clone(), target).await;
    assert_eq!(read_frame(&mut stream).await["kind"], "authenticated");
    fixture.service.shutdown(); assert_closed(&mut stream).await;
    drop(listener);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnel_saturation_preserves_all_other_peer_channels_and_phone_alpn() {
    let fixture = Fixture::new();
    let (status, paired) = fixture.desktop().await;
    let port = status["port"].as_u64().unwrap() as u16;
    let token = paired["token"].as_str().unwrap();
    let client = uuid::Uuid::new_v4().to_string();
    let (_control, hello) = peer(fixture.root.path(), port, token, "control", &client, Value::Null).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"loopback":"127.0.0.1","port":listener.local_addr().unwrap().port()});
    let mut tunnels = Vec::new(); let mut hosts = Vec::new();
    for _ in 0..64 {
        let mut stream = tunnel_auth(&fixture, port, token, &client, hello["epoch"].clone(), target.clone()).await;
        assert_eq!(read_frame(&mut stream).await["kind"], "authenticated");
        hosts.push(listener.accept().await.unwrap().0); tunnels.push(stream);
    }
    let mut extra = tunnel_auth(&fixture, port, token, &client, hello["epoch"].clone(), target).await;
    assert_closed(&mut extra).await;
    let (_extra_control, proof) = peer(fixture.root.path(), port, token, "control", &uuid::Uuid::new_v4().to_string(), Value::Null).await;
    assert_eq!(proof["kind"], "authenticated");
    for channel in ["output", "browser"] {
        let (_stream, proof) = peer(fixture.root.path(), port, token, channel, &client, hello["epoch"].clone()).await;
        assert_eq!(proof["kind"], "authenticated");
    }
    let mut phone = tls(fixture.root.path(), port, b"http/1.1").await;
    let body = r#"{"kind":"auth","channel":"tunnel"}"#;
    phone.write_all(format!("POST /v1/rpc HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
    let mut bytes = Vec::new(); tokio::time::timeout(Duration::from_secs(2), phone.read_to_end(&mut bytes)).await.unwrap().ok();
    assert!(!String::from_utf8_lossy(&bytes).contains("authenticated"));
    assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
}
