use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{
    env,
    error::Error,
    ffi::OsString,
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

use threadterm_mobile_native::{
    ClientError, ClientEventListener, MachineCredentials, NativeClient,
};

const MAX_DESCRIPTOR_BYTES: usize = 128 * 1024;
const DEFAULT_REVOKE_TIMEOUT_SECS: u64 = 60;

#[derive(Debug)]
struct SmokeError(String);

impl fmt::Display for SmokeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for SmokeError {}

#[derive(Debug)]
struct StateEvent {
    machine_id: String,
    state: String,
}

struct SmokeListener {
    states: mpsc::Sender<StateEvent>,
}

impl ClientEventListener for SmokeListener {
    fn runtime_event(&self, _machine_id: String, _event_json: String) {}

    fn connection_state(&self, machine_id: String, state: String, _message: Option<String>) {
        let _ = self.states.send(StateEvent { machine_id, state });
    }
}

struct Options {
    descriptor_path: PathBuf,
    device_name: String,
    ready_marker: PathBuf,
    revoked_marker: PathBuf,
    terminal_session_id: Option<String>,
    chat_session_id: Option<String>,
    revoke_timeout: Duration,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("native host smoke failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let options = options()?;
    let descriptor = read_descriptor(&options.descriptor_path)?;
    let client = NativeClient::new(None)?;
    let result = exercise(&client, &options, descriptor);
    let clear_result = client.clear_event_listener();
    let shutdown_result = client.shutdown();
    result?;
    clear_result?;
    shutdown_result?;
    println!("PASS native host smoke");
    Ok(())
}

fn exercise(
    client: &NativeClient,
    options: &Options,
    descriptor: String,
) -> Result<(), Box<dyn Error>> {
    let (states, state_events) = mpsc::channel();
    client.set_event_listener(Arc::new(SmokeListener { states }))?;

    let prepared = client.prepare_pairing(descriptor)?;
    println!("CHECK_CODE {}", prepared.check_code);
    let completed = client.confirm_pairing(prepared.pending_id, options.device_name.clone())?;
    let expected = if options.terminal_session_id.is_some() || options.chat_session_id.is_some() {
        "fullcontrol"
    } else {
        "readonly"
    };
    if completed.permission != expected {
        return Err(smoke_error("host issued the wrong mobile credential"));
    }

    let machine_id = completed.machine_id;
    let connection = client.connect(MachineCredentials {
        machine_id: machine_id.clone(),
        endpoint: completed.endpoint,
        tls_fingerprint: completed.tls_fingerprint,
        credential: completed.credential,
    })?;
    if connection.permission != expected {
        return Err(smoke_error(
            "authenticated connection did not preserve its permission",
        ));
    }

    let snapshot = client.request(machine_id.clone(), "mobile.snapshot".into(), "{}".into())?;
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot)?;
    if !snapshot.is_object() {
        return Err(smoke_error("mobile.snapshot did not return a JSON object"));
    }

    if options.terminal_session_id.is_none() && options.chat_session_id.is_none() {
        match client.request(machine_id.clone(), "chat.send".into(), "{}".into()) {
            Err(ClientError::Remote(message))
                if message == "mobile_readonly: This phone has view-only access" => {}
            Err(error) => {
                return Err(smoke_error(format!(
                    "readonly chat.send returned the wrong denial: {error}"
                )))
            }
            Ok(_) => return Err(smoke_error("readonly connection accepted chat.send")),
        }
        write_marker(&options.ready_marker, b"READY\n")?;
        wait_for_revoked(&state_events, &machine_id, options.revoke_timeout)?;
        write_marker(&options.revoked_marker, b"REVOKED\n")?;
        return Ok(());
    }

    if let Some(session_id) = options.chat_session_id.as_deref() {
        let claim: serde_json::Value = serde_json::from_str(&client.request(
            machine_id.clone(),
            "session.claim".into(),
            serde_json::json!({"sessionId":session_id}).to_string(),
        )?)?;
        let lease_epoch = claim["leaseEpoch"]
            .as_i64()
            .ok_or_else(|| smoke_error("chat claim omitted leaseEpoch"))?;
        let connection: serde_json::Value = serde_json::from_str(&client.request(
            machine_id.clone(),
            "chat.connect".into(),
            serde_json::json!({"sessionId":session_id,"leaseEpoch":lease_epoch,"operationId":"native-host-smoke-connect"}).to_string(),
        )?)?;
        if connection["phase"].as_str() != Some("ready") {
            return Err(smoke_error("native chat.connect did not become ready"));
        }
        let sent: serde_json::Value = serde_json::from_str(&client.request(
            machine_id.clone(),
            "chat.send".into(),
            serde_json::json!({"sessionId":session_id,"text":"MOBILE_NATIVE_CHAT_SEND","leaseEpoch":lease_epoch,"operationId":"native-host-smoke-send"}).to_string(),
        )?)?;
        if sent["turnId"].as_str().is_none() {
            return Err(smoke_error("native chat.send omitted turnId"));
        }
    }

    let Some(session_id) = options.terminal_session_id.as_deref() else {
        write_marker(&options.ready_marker, b"READY\n")?;
        println!("READY");
        wait_for_revoked(&state_events, &machine_id, options.revoke_timeout)?;
        write_marker(&options.revoked_marker, b"REVOKED\n")?;
        return Ok(());
    };
    let claim: serde_json::Value = serde_json::from_str(&client.request(
        machine_id.clone(),
        "session.claim".into(),
        serde_json::json!({"sessionId":session_id}).to_string(),
    )?)?;
    let lease_epoch = claim["leaseEpoch"]
        .as_i64()
        .ok_or_else(|| smoke_error("terminal claim omitted leaseEpoch"))?;
    client.request(
        machine_id.clone(),
        "terminal.resize".into(),
        serde_json::json!({"sessionId":session_id,"cols":44,"rows":10,"leaseEpoch":lease_epoch})
            .to_string(),
    )?;
    let resized_snapshot: serde_json::Value = serde_json::from_str(&client.request(
        machine_id.clone(),
        "mobile.snapshot".into(),
        "{}".into(),
    )?)?;
    let resized = resized_snapshot["sessions"]
        .as_array()
        .and_then(|sessions| sessions.iter().find(|session| session["id"] == session_id))
        .ok_or_else(|| smoke_error("resized terminal is absent from mobile.snapshot"))?;
    if resized["cols"].as_i64() != Some(44) || resized["rows"].as_i64() != Some(10) {
        return Err(smoke_error(
            "terminal.resize did not persist the requested dimensions",
        ));
    }
    let marker = "MOBILE_NATIVE_ECHO_OK";
    // cmd echoes received input. Set a variable first, then echo its expansion:
    // the literal marker can only occur after cmd has executed the second line.
    // Neither line contains the full marker. If LF were accepted as Enter, cmd
    // would expand the variable and print it; the following bounded read proves
    // that it did not. The subsequent CR pair then proves an executed response.
    client.request(machine_id.clone(),"terminal.input".into(),serde_json::json!({"sessionId":session_id,"data":"set TT_QA_ECHO=MOBILE_NATIVE_\n","leaseEpoch":lease_epoch}).to_string())?;
    client.request(machine_id.clone(),"terminal.input".into(),serde_json::json!({"sessionId":session_id,"data":"echo %TT_QA_ECHO%ECHO_OK\n","leaseEpoch":lease_epoch}).to_string())?;
    let mut cursor = 0_i64;
    let mut output = String::new();
    read_until(
        client,
        &machine_id,
        session_id,
        &mut cursor,
        &mut output,
        Duration::from_secs(1),
        marker,
    )?;
    if output.contains(marker) {
        return Err(smoke_error("LF terminal input unexpectedly executed cmd"));
    }
    client.request(machine_id.clone(),"terminal.input".into(),serde_json::json!({"sessionId":session_id,"data":"set TT_QA_ECHO=MOBILE_NATIVE_\r","leaseEpoch":lease_epoch}).to_string())?;
    client.request(machine_id.clone(),"terminal.input".into(),serde_json::json!({"sessionId":session_id,"data":"echo %TT_QA_ECHO%ECHO_OK\r","leaseEpoch":lease_epoch}).to_string())?;
    read_until(
        client,
        &machine_id,
        session_id,
        &mut cursor,
        &mut output,
        Duration::from_secs(15),
        marker,
    )?;
    if !output.contains(marker) {
        return Err(smoke_error("native terminal CR echo did not round-trip"));
    }

    write_marker(&options.ready_marker, b"READY\n")?;
    println!("READY");
    wait_for_revoked(&state_events, &machine_id, options.revoke_timeout)?;
    write_marker(&options.revoked_marker, b"REVOKED\n")?;
    Ok(())
}

fn read_until(
    client: &NativeClient,
    machine_id: &str,
    session_id: &str,
    cursor: &mut i64,
    output: &mut String,
    timeout: Duration,
    marker: &str,
) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let page: serde_json::Value = serde_json::from_str(&client.request(
            machine_id.to_string(),
            "terminal.read".into(),
            serde_json::json!({"sessionId":session_id,"cursor":cursor,"limit":65536}).to_string(),
        )?)?;
        if page["fromCursor"].as_i64() != Some(*cursor) {
            return Err(smoke_error("terminal read cursor was not contiguous"));
        }
        *cursor = page["nextCursor"]
            .as_i64()
            .ok_or_else(|| smoke_error("terminal read omitted cursor"))?;
        output.push_str(&String::from_utf8(
            STANDARD.decode(
                page["data"]
                    .as_str()
                    .ok_or_else(|| smoke_error("terminal read omitted data"))?,
            )?,
        )?);
        if output.contains(marker) {
            break;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    Ok(())
}

fn options() -> Result<Options, Box<dyn Error>> {
    let mut args = env::args_os();
    let program = args.next().unwrap_or_default();
    let mut descriptor_path = None;
    let mut device_name = None;
    let mut ready_marker = None;
    let mut revoked_marker = None;
    let mut terminal_session_id = None;
    let mut chat_session_id = None;
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| usage(&program))?;
        match flag.to_str() {
            Some("--descriptor-file") if descriptor_path.is_none() => {
                descriptor_path = Some(PathBuf::from(value));
            }
            Some("--device-name") if device_name.is_none() => {
                device_name = Some(value);
            }
            Some("--ready-file") if ready_marker.is_none() => {
                ready_marker = Some(PathBuf::from(value));
            }
            Some("--revoked-file") if revoked_marker.is_none() => {
                revoked_marker = Some(PathBuf::from(value));
            }
            Some("--terminal-session-id") if terminal_session_id.is_none() => {
                terminal_session_id = Some(
                    value
                        .into_string()
                        .map_err(|_| smoke_error("terminal session id is not UTF-8"))?,
                )
            }
            Some("--chat-session-id") if chat_session_id.is_none() => {
                chat_session_id = Some(
                    value
                        .into_string()
                        .map_err(|_| smoke_error("chat session id is not UTF-8"))?,
                )
            }
            _ => return Err(usage(&program)),
        }
    }
    let device_name = device_name
        .ok_or_else(|| usage(&program))?
        .into_string()
        .map_err(|_| smoke_error("device name is not UTF-8"))?;
    if device_name.is_empty()
        || device_name.chars().count() > 80
        || device_name.chars().any(char::is_control)
    {
        return Err(smoke_error(
            "device name is empty, too long, or contains control characters",
        ));
    }
    let timeout = match env::var("THREADTERM_NATIVE_SMOKE_TIMEOUT_SECS") {
        Ok(value) => value
            .parse::<u64>()
            .map_err(|_| smoke_error("THREADTERM_NATIVE_SMOKE_TIMEOUT_SECS is not an integer"))?,
        Err(env::VarError::NotPresent) => DEFAULT_REVOKE_TIMEOUT_SECS,
        Err(error) => return Err(Box::new(error)),
    };
    if !(5..=120).contains(&timeout) {
        return Err(smoke_error(
            "THREADTERM_NATIVE_SMOKE_TIMEOUT_SECS must be between 5 and 120",
        ));
    }
    let options = Options {
        descriptor_path: descriptor_path.ok_or_else(|| usage(&program))?,
        device_name,
        ready_marker: ready_marker.ok_or_else(|| usage(&program))?,
        revoked_marker: revoked_marker.ok_or_else(|| usage(&program))?,
        terminal_session_id,
        chat_session_id,
        revoke_timeout: Duration::from_secs(timeout),
    };
    if options.ready_marker == options.revoked_marker {
        return Err(smoke_error("ready and revoked marker paths must differ"));
    }
    Ok(options)
}

fn usage(program: &OsString) -> Box<dyn Error> {
    smoke_error(format!(
        "usage: {} --descriptor-file <path> --device-name <unique> --ready-file <new-path> --revoked-file <new-path> [--terminal-session-id <id>] [--chat-session-id <id>]",
        Path::new(program).display()
    ))
}

fn read_descriptor(path: &Path) -> Result<String, Box<dyn Error>> {
    let bytes = fs::read(path)?;
    if bytes.is_empty() || bytes.len() > MAX_DESCRIPTOR_BYTES {
        return Err(smoke_error(
            "pairing descriptor is empty or exceeds 128 KiB",
        ));
    }
    Ok(String::from_utf8(bytes)?)
}

fn write_marker(path: &Path, value: &[u8]) -> Result<(), Box<dyn Error>> {
    let mut marker = OpenOptions::new().write(true).create_new(true).open(path)?;
    marker.write_all(value)?;
    marker.sync_all()?;
    Ok(())
}

fn wait_for_revoked(
    events: &mpsc::Receiver<StateEvent>,
    machine_id: &str,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(smoke_error("timed out waiting for the host revoke event"));
        }
        let event = events
            .recv_timeout(remaining)
            .map_err(|error| smoke_error(format!("failed waiting for revoke: {error}")))?;
        if event.machine_id != machine_id {
            continue;
        }
        match event.state.as_str() {
            "revoked" => return Ok(()),
            "disconnected" | "incompatible" | "pin-mismatch" => {
                return Err(smoke_error(format!(
                    "connection entered {} before the revoke event",
                    event.state
                )))
            }
            _ => {}
        }
    }
}

fn smoke_error(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(SmokeError(message.into()))
}
