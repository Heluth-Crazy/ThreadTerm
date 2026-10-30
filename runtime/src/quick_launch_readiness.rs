//! Port-based readiness for service runs: "Starting" until the run's own process
//! tree listens on a TCP port, or until it prints a local URL (quick_launch's
//! output scanner, which marks the run ready through `observe_output`).
use super::*;
use std::{collections::HashSet, thread, time::Instant};
#[cfg(windows)]
use windows_sys::Win32::{
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
        TCP_TABLE_OWNER_PID_LISTENER,
    },
    Networking::WinSock::{AF_INET, AF_INET6},
};

/// Poll every 500 ms while a server usually starts, then rarely enough to be free.
pub(super) const FAST_POLL: Duration = Duration::from_millis(500);
pub(super) const FAST_WINDOW: Duration = Duration::from_secs(30);
pub(super) const SLOW_POLL: Duration = Duration::from_secs(2);
/// Stop watching long after any reasonable start; the run itself keeps running.
pub(super) const GIVE_UP: Duration = Duration::from_secs(600);
/// Ports a language debugger or test inspector usually listens on, never the app.
const DEBUG_PORTS: [u16; 4] = [9229, 9230, 5005, 5678];
/// A tree with more listeners than this is not a run we can present a URL for.
pub(super) const MAX_PORTS: usize = 64;
/// Consecutive failed state reads before the watcher gives the run up.
const STATE_ATTEMPTS: usize = 3;
/// `GetExtendedTcpTable` grew between its sizing call and its fill call.
#[cfg(any(windows, test))]
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
/// Sizing retries for one poll; a table that keeps growing is not this run's answer.
#[cfg(any(windows, test))]
const TCP_TABLE_ATTEMPTS: usize = 3;

/// True when this platform can tell which ports a process tree listens on.
pub(super) const fn supported() -> bool {
    cfg!(windows)
}

/// What one poll decides, with the clock injected so tests never sleep.
#[derive(Debug, PartialEq)]
pub(super) enum Step {
    Ready(u16),
    GiveUp,
    Wait(Duration),
}

/// Delay before the next poll, or `None` at the give-up time.
pub(super) fn poll_delay(elapsed: Duration) -> Option<Duration> {
    if elapsed >= GIVE_UP {
        None
    } else if elapsed < FAST_WINDOW {
        Some(FAST_POLL)
    } else {
        Some(SLOW_POLL)
    }
}

pub(super) fn next_step(elapsed: Duration, ports: &[u16], printed: Option<u16>) -> Step {
    if let Some(port) = select_port(ports, printed) {
        return Step::Ready(port);
    }
    match poll_delay(elapsed) {
        Some(delay) => Step::Wait(delay),
        None => Step::GiveUp,
    }
}

/// The run's port: the one it printed when that one listens, else the lowest port
/// that is not a debugger port, else the lowest port at all.
pub(super) fn select_port(ports: &[u16], printed: Option<u16>) -> Option<u16> {
    if let Some(port) = printed {
        if ports.contains(&port) {
            return Some(port);
        }
    }
    ports
        .iter()
        .copied()
        .filter(|port| !DEBUG_PORTS.contains(port))
        .min()
        .or_else(|| ports.iter().copied().min())
}

/// The explicit port of a printed URL; `None` for a URL without one.
pub(super) fn url_port(url: &str) -> Option<u16> {
    let authority = url.split_once("://")?.1.split(['/', '?', '#']).next()?;
    let (_, port) = authority.rsplit_once(':')?;
    port.parse().ok().filter(|port| *port != 0)
}

/// One poll's view of the run, read in one transaction and never held further.
struct WatchState {
    active: bool,
    stopped: bool,
    ready: bool,
    printed_port: Option<u16>,
}

fn watch_state(db: &Database, id: &str) -> Result<Option<WatchState>> {
    db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT s.status,q.stop_requested,q.readiness,q.url,q.url_source \
                 FROM quick_launch_runs q JOIN sessions s ON s.id=q.session_id WHERE q.session_id=?",
                [id],
                |r| {
                    let status: String = r.get(0)?;
                    let readiness: Option<String> = r.get(2)?;
                    let url: Option<String> = r.get(3)?;
                    let source: Option<String> = r.get(4)?;
                    Ok(WatchState {
                        active: matches!(
                            status.as_str(),
                            "starting" | "running" | "idle" | "waiting"
                        ),
                        stopped: r.get(1)?,
                        ready: readiness.as_deref() == Some("ready"),
                        printed_port: if source.as_deref() == Some("output") {
                            url.as_deref().and_then(url_port)
                        } else {
                            None
                        },
                    })
                },
            )
            .optional()?)
    })
}

/// Ready by port: one transaction and one change event, as the output scanner does.
/// A port URL never overwrites an address the run printed itself, and the port is only
/// recorded when it is the address, so `port` and `urlSource:'port'` always agree.
pub(super) fn observe_port(db: &Database, id: &str, port: u16) -> Result<()> {
    let url = format!("http://localhost:{port}/");
    db.transaction(|tx| {
        let rows = tx.execute(
            "UPDATE quick_launch_runs SET readiness='ready',\
             ready_port=CASE WHEN url_source IS NULL OR url_source='configured' THEN ? ELSE ready_port END,\
             url=CASE WHEN url_source IS NULL OR url_source='configured' THEN ? ELSE url END,\
             url_source=CASE WHEN url_source IS NULL OR url_source='configured' THEN 'port' ELSE url_source END \
             WHERE session_id=? AND (readiness IS NULL OR readiness!='ready')",
            params![port, url, id],
        )?;
        if rows != 0 {
            changed(tx, "session.run", Some(id))?;
        }
        Ok(())
    })
}

/// The watcher's last word for a run that never answered: `none`, so the UI stops
/// saying Starting. Only a `waiting` row is touched, so a run that became ready
/// through its own output keeps that state.
fn give_up(db: &Database, id: &str) -> Result<()> {
    db.transaction(|tx| {
        if tx.execute(
            "UPDATE quick_launch_runs SET readiness='none' WHERE session_id=? AND readiness='waiting'",
            [id],
        )? != 0
        {
            changed(tx, "session.run", Some(id))?;
        }
        Ok(())
    })
}

/// The watcher's outside world: time, waiting and the run's listening ports. Tests
/// provide a fake, so every exit of the loop is provable without sleeping at all.
pub(super) trait WatchHost {
    /// Time since this watch started; the schedule is a function of it.
    fn elapsed(&self) -> Duration;
    fn sleep(&self, delay: Duration);
    /// Listening ports of the run's process tree right now.
    fn ports(&self, session_id: &str) -> Vec<u16>;
}

/// Polls one run until it is ready, its session ends, its run is stopped, or the
/// give-up time passes. Sleeps outside every database, admission and PTY lock, and
/// settles every exit that is not `ready` to `none`, so a dead run stops claiming it
/// is still starting.
pub(super) fn watch(db: &Database, host: &impl WatchHost, id: &str) {
    let mut failures = 0;
    loop {
        let state = match watch_state(db, id) {
            Ok(Some(state)) => {
                failures = 0;
                state
            }
            // The run row is gone: nothing left to settle.
            Ok(None) => return,
            Err(error) => {
                failures += 1;
                if failures < STATE_ATTEMPTS {
                    host.sleep(FAST_POLL);
                    continue;
                }
                eprintln!("Readiness for run {id} stopped after {failures} failed reads: {error}");
                break;
            }
        };
        if !state.active || state.stopped || state.ready {
            break;
        }
        let ports = host.ports(id);
        match next_step(host.elapsed(), &ports, state.printed_port) {
            Step::Ready(port) => {
                if observe_port(db, id, port).is_ok() {
                    return;
                }
                break;
            }
            Step::GiveUp => break,
            Step::Wait(delay) => host.sleep(delay),
        }
    }
    if let Err(error) = give_up(db, id) {
        eprintln!("Readiness for run {id} could not be settled: {error}");
    }
}

/// The live watcher: a real clock, real sleeps and the session's Windows Job.
struct LiveHost {
    started: Instant,
    pty: PtyManager,
}

impl WatchHost for LiveHost {
    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    fn sleep(&self, delay: Duration) {
        thread::sleep(delay)
    }
    fn ports(&self, session_id: &str) -> Vec<u16> {
        let before = self.pty.process_ids(session_id);
        if before.is_empty() {
            return Vec::new();
        }
        // The table is read between two pid snapshots: a pid can be recycled while it
        // is read, and only an owner present in both snapshots is this run's process.
        let rows = listener_rows();
        let after = self.pty.process_ids(session_id);
        stable_listening_ports(&before, &after, &rows)
    }
}

/// Starts the one watcher of a freshly launched service run. A failed spawn leaves
/// the run `waiting` for startup recovery to settle; it must not fail the launch.
pub(super) fn spawn(db: &Arc<Database>, pty: &PtyManager, id: &str) {
    let (db, pty, id) = (Arc::clone(db), pty.clone(), id.to_owned());
    let named = id.clone();
    let host = LiveHost {
        started: Instant::now(),
        pty,
    };
    if let Err(error) = thread::Builder::new()
        .name(format!("run-readiness-{named}"))
        .spawn(move || watch(&db, &host, &id))
    {
        eprintln!("Readiness for run {named} could not be watched: {error}");
    }
}

/// Sorted, deduplicated and capped: one busy tree owes the UI one address.
pub(super) fn capped(mut ports: Vec<u16>) -> Vec<u16> {
    ports.sort_unstable();
    ports.dedup();
    ports.truncate(MAX_PORTS);
    ports
}

/// Ports whose owner is in both pid snapshots around the table read.
pub(super) fn stable_listening_ports(before: &[u32], after: &[u32], rows: &[(u32, u16)]) -> Vec<u16> {
    let after: HashSet<u32> = after.iter().copied().collect();
    let stable: HashSet<u32> = before
        .iter()
        .copied()
        .filter(|pid| after.contains(pid))
        .collect();
    capped(
        rows.iter()
            .filter(|(pid, _)| stable.contains(pid))
            .map(|(_, port)| port)
            .copied()
            .collect(),
    )
}

/// Every listening TCP row of this machine; the caller decides which pid owns them.
#[cfg(windows)]
fn listener_rows() -> Vec<(u32, u16)> {
    let mut rows = tcp4_listeners();
    rows.extend(tcp6_listeners());
    rows
}
#[cfg(not(windows))]
fn listener_rows() -> Vec<(u32, u16)> {
    Vec::new()
}

/// Fills a buffer whose size the API reports. A table that grows between the sizing
/// call and the fill call answers ERROR_INSUFFICIENT_BUFFER with the size it now needs,
/// so the poll is retried with that size a few times instead of silently losing ports.
#[cfg(any(windows, test))]
pub(super) fn sized_tcp_table(
    mut fill: impl FnMut(&mut [u32], &mut u32) -> u32,
    mut size: u32,
) -> Option<Vec<u32>> {
    for _ in 0..TCP_TABLE_ATTEMPTS {
        if size == 0 {
            return None;
        }
        // Word aligned for the table's own u32 fields.
        let mut buffer = vec![0u32; (size as usize).div_ceil(4) + 1];
        let mut written = size;
        let status = fill(&mut buffer, &mut written);
        if status == 0 {
            return Some(buffer);
        }
        // Only a grown table is worth another call; anything else ends this poll.
        if status != ERROR_INSUFFICIENT_BUFFER || written <= size {
            return None;
        }
        size = written;
    }
    None
}

/// The listener table of one address family, sized by a probe call first.
#[cfg(windows)]
fn tcp_table(family: u32) -> Option<Vec<u32>> {
    let mut size = 0u32;
    unsafe {
        GetExtendedTcpTable(
            core::ptr::null_mut(),
            &raw mut size,
            0,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }
    sized_tcp_table(
        |buffer, written| unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                written,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        },
        size,
    )
}

/// The port is stored in network byte order in the low half of the DWORD.
#[cfg(windows)]
fn be_port(value: u32) -> u16 {
    u16::from_be((value & 0xffff) as u16)
}

#[cfg(windows)]
fn tcp4_listeners() -> Vec<(u32, u16)> {
    let Some(buffer) = tcp_table(u32::from(AF_INET)) else {
        return Vec::new();
    };
    let bytes = buffer.as_ptr().cast::<u8>();
    let count = unsafe { bytes.cast::<u32>().read_unaligned() } as usize;
    let stride = core::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    let first = core::mem::size_of::<u32>();
    // Never read past the table the API wrote, whatever its count claims.
    let rows = buffer.len() * 4 - first;
    (0..count.min(rows / stride))
        .map(|index| unsafe {
            let row = bytes
                .add(first + index * stride)
                .cast::<MIB_TCPROW_OWNER_PID>()
                .read_unaligned();
            (row.dwOwningPid, be_port(row.dwLocalPort))
        })
        .collect()
}

#[cfg(windows)]
fn tcp6_listeners() -> Vec<(u32, u16)> {
    let Some(buffer) = tcp_table(u32::from(AF_INET6)) else {
        return Vec::new();
    };
    let bytes = buffer.as_ptr().cast::<u8>();
    let count = unsafe { bytes.cast::<u32>().read_unaligned() } as usize;
    let stride = core::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
    let first = core::mem::size_of::<u32>();
    let rows = buffer.len() * 4 - first;
    (0..count.min(rows / stride))
        .map(|index| unsafe {
            let row = bytes
                .add(first + index * stride)
                .cast::<MIB_TCP6ROW_OWNER_PID>()
                .read_unaligned();
            (row.dwOwningPid, be_port(row.dwLocalPort))
        })
        .collect()
}
