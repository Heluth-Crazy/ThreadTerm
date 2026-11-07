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
    if completed.permission != "readonly" {
        return Err(smoke_error(
            "host did not issue a readonly mobile credential",
        ));
    }

    let machine_id = completed.machine_id;
    let connection = client.connect(MachineCredentials {
        machine_id: machine_id.clone(),
        endpoint: completed.endpoint,
        tls_fingerprint: completed.tls_fingerprint,
        credential: completed.credential,
    })?;
    if connection.permission != "readonly" {
        return Err(smoke_error(
            "authenticated connection did not preserve readonly permission",
        ));
    }

    let snapshot = client.request(machine_id.clone(), "mobile.snapshot".into(), "{}".into())?;
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot)?;
    if !snapshot.is_object() {
        return Err(smoke_error("mobile.snapshot did not return a JSON object"));
    }

    match client.request(machine_id.clone(), "chat.send".into(), "{}".into()) {
        Err(ClientError::Remote(message))
            if message == "mobile_readonly: This phone has view-only access" => {}
        Err(error) => {
            return Err(smoke_error(format!(
                "chat.send returned the wrong readonly denial: {error}"
            )))
        }
        Ok(_) => return Err(smoke_error("readonly connection accepted chat.send")),
    }

    write_marker(&options.ready_marker, b"READY\n")?;
    println!("READY");
    wait_for_revoked(&state_events, &machine_id, options.revoke_timeout)?;
    write_marker(&options.revoked_marker, b"REVOKED\n")?;
    Ok(())
}

fn options() -> Result<Options, Box<dyn Error>> {
    let mut args = env::args_os();
    let program = args.next().unwrap_or_default();
    let mut descriptor_path = None;
    let mut device_name = None;
    let mut ready_marker = None;
    let mut revoked_marker = None;
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
        revoke_timeout: Duration::from_secs(timeout),
    };
    if options.ready_marker == options.revoked_marker {
        return Err(smoke_error("ready and revoked marker paths must differ"));
    }
    Ok(options)
}

fn usage(program: &OsString) -> Box<dyn Error> {
    smoke_error(format!(
        "usage: {} --descriptor-file <path> --device-name <unique> --ready-file <new-path> --revoked-file <new-path>",
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
