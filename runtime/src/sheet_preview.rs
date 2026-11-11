//! Sheet preview host (`design.md` §3.3, §3.5): the handle table, the helper
//! lifecycle and the four wire methods.
//!
//! The runtime process never reads a workbook. It resolves the path, checks the size
//! and the change token against metadata, and hands the file to a hidden helper — this
//! binary started with `--sheet-worker` — which opens and parses it. One helper per open
//! workbook, in a kill-on-close job with a 2 GiB process memory limit (S2), so a helper
//! that dies or hits the limit is an error for that handle only.
//!
//! Handles are 128 random bits bound to the principal that opened them and, through
//! [`SheetPresence`], to that principal's control connections. No request waits for a
//! load or a helper start: the host answers `loading` and the client polls.

use crate::db::Database;
use crate::job::SessionJob;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use threadterm_sheet_core::{SheetFormat, OFFICE_PREVIEW_MAX_BYTES};

/// `design.md` §3.5: no `rows` call for this long ends the helper. The handle stays.
pub(crate) const SHEET_IDLE: Duration = Duration::from_secs(300);
/// A shorter idle time for the QA script only, set by `--sheet-idle-seconds` on this
/// process. Never a production environment variable (`implement.md` step 1).
static SHEET_IDLE_OVERRIDE: OnceLock<Duration> = OnceLock::new();

fn sheet_idle() -> Duration {
    SHEET_IDLE_OVERRIDE.get().copied().unwrap_or(SHEET_IDLE)
}

/// Test-only: the QA script shortens the idle time so the helper's timeout is observable.
pub fn configure_idle(seconds: u64) {
    let _ = SHEET_IDLE_OVERRIDE.set(Duration::from_secs(seconds.max(1)));
}
/// At most this many live helpers per host; the least recently used idle one goes first.
pub(crate) const SHEET_MAX_HELPERS: usize = 3;
/// A handle that sees no request for this long is forgotten (`sheet_not_found`).
pub(crate) const SHEET_HANDLE_FORGET: Duration = Duration::from_secs(30 * 60);
/// R1/D2: the preview limit, checked from metadata before anything is read.
pub(crate) const SHEET_MAX_BYTES: u64 = OFFICE_PREVIEW_MAX_BYTES;
/// S2 (owner, 2026-11-11): the helper job's process memory limit.
pub(crate) const SHEET_HELPER_MEMORY_LIMIT: usize = 2 * 1024 * 1024 * 1024;
/// How often the reaper looks for idle helpers and stale handles.
const SHEET_SWEEP: Duration = Duration::from_secs(30);
/// `STATUS_COMMITMENT_LIMIT`: the job's memory limit stopped the helper.
const STATUS_COMMITMENT_LIMIT: i32 = 0xC000_0017u32 as i32;
/// `STATUS_STACK_BUFFER_OVERRUN`: Rust's `abort` (`__fastfail`), which is how the
/// helper ends when an allocation fails at the job's memory limit.
const STATUS_FAST_FAIL: i32 = 0xC000_0409u32 as i32;
/// A lower helper memory limit for the QA script only, set by
/// `--sheet-helper-memory-mib` on this process, so the limit path is observable with a
/// 100 MiB fixture. Never a production environment variable.
static SHEET_HELPER_MEMORY_OVERRIDE: OnceLock<usize> = OnceLock::new();

fn helper_memory_limit() -> usize {
    SHEET_HELPER_MEMORY_OVERRIDE
        .get()
        .copied()
        .unwrap_or(SHEET_HELPER_MEMORY_LIMIT)
}

/// Test-only: see [`SHEET_HELPER_MEMORY_OVERRIDE`].
pub fn configure_helper_memory(mebibytes: usize) {
    let _ = SHEET_HELPER_MEMORY_OVERRIDE.set(mebibytes.max(16) * 1024 * 1024);
}

pub(crate) const ERROR_CODES: &[&str] = &[
    "invalid_path",
    "invalid_request",
    "file_too_large",
    "file_changed",
    "file_not_found",
    "file_unavailable",
    "file_not_file",
    "external_file_unknown",
    "external_file_not_found",
    "external_file_unavailable",
    "unsupported_document",
    "document_protected",
    "sheet_too_complex",
    "sheet_out_of_memory",
    "sheet_worker_failed",
    "sheet_not_found",
];

/// One live helper process. Shared, so a request runs without the host lock.
struct Helper {
    /// The pipes: one request at a time per helper.
    io: Mutex<HelperIo>,
    /// Apart from `io`, so ending a helper never waits for a request in flight: the
    /// kill closes the pipes and that request fails at once.
    child: Mutex<Child>,
    /// Kill-on-close with the memory limit: runtime exit ends every helper.
    job: Option<SessionJob>,
    memory_limit: usize,
}

struct HelperIo {
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
}

impl Helper {
    /// The helper is this binary, hidden, with no console window.
    fn start() -> Result<Helper> {
        let exe = std::env::current_exe()?;
        let mut command = Command::new(&exe);
        command
            .arg("--sheet-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|error| anyhow!("sheet_worker_failed: {error}"))?;
        // S2: 2 GiB. A helper that passes it is stopped, and only its handle sees that.
        let memory_limit = helper_memory_limit();
        let job = match SessionJob::assign_with_memory_limit(child.id(), memory_limit) {
            Ok(job) => job,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow!("sheet_worker_failed"));
            }
        };
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("sheet_worker_failed"));
        };
        Ok(Helper {
            io: Mutex::new(HelperIo {
                stdin: Some(stdin),
                stdout: Some(BufReader::new(stdout)),
            }),
            child: Mutex::new(child),
            job: Some(job),
            memory_limit,
        })
    }

    /// One JSON line out, one JSON line back. The helper answers `rows` while a load
    /// runs on its own thread, so this never waits for a sheet.
    fn request(&self, value: &Value) -> Result<Value> {
        let mut io = self
            .io
            .lock()
            .map_err(|_| anyhow!("sheet_worker_failed"))?;
        let sent = (|| -> std::io::Result<()> {
            let stdin = io
                .stdin
                .as_mut()
                .ok_or_else(|| std::io::Error::other("closed"))?;
            stdin.write_all(value.to_string().as_bytes())?;
            stdin.write_all(b"\n")?;
            stdin.flush()
        })();
        if sent.is_err() {
            io.stdin.take();
            drop(io);
            return Err(anyhow!(self.stopped_code()));
        }
        let mut line = String::new();
        let read = match io.stdout.as_mut() {
            Some(stdout) => stdout.read_line(&mut line),
            None => Ok(0),
        };
        drop(io);
        match read {
            Ok(0) | Err(_) => Err(anyhow!(self.stopped_code())),
            Ok(_) => {
                let reply: Value = serde_json::from_str(line.trim_end())
                    .map_err(|_| anyhow!("sheet_worker_failed"))?;
                if reply["ok"].as_bool().unwrap_or(false) {
                    Ok(reply["result"].clone())
                } else {
                    Err(anyhow!(
                        "{}",
                        reply["error"].as_str().unwrap_or("sheet_worker_failed")
                    ))
                }
            }
        }
    }

    /// Why a helper stopped answering: `sheet_out_of_memory` when its job's memory
    /// limit stopped it, `sheet_worker_failed` otherwise. Either way the error belongs
    /// to this handle only.
    fn stopped_code(&self) -> &'static str {
        // The pipe closes a moment before the exit status can be read.
        let mut status = None;
        for _ in 0..20 {
            status = self
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten());
            if status.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let code = status.and_then(|status| status.code());
        let peak = self
            .job
            .as_ref()
            .and_then(SessionJob::peak_process_memory)
            .unwrap_or(0);
        stop_code(code, peak, self.memory_limit)
    }

    /// Kill and reap. Never waits for a request in flight (see `child`).
    fn end(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The classification behind [`Helper::stopped_code`], apart so it can be tested.
///
/// A helper that meets the job limit fails an allocation: Rust then aborts with
/// `__fastfail` (`STATUS_STACK_BUFFER_OVERRUN`), or the process ends with
/// `STATUS_COMMITMENT_LIMIT`. A growing buffer can fail well below the limit, so the
/// job's peak is only a second signal.
fn stop_code(exit_code: Option<i32>, peak_bytes: usize, limit_bytes: usize) -> &'static str {
    let aborted = matches!(
        exit_code,
        Some(code) if code == STATUS_COMMITMENT_LIMIT || code == STATUS_FAST_FAIL
    );
    let near_limit = peak_bytes >= limit_bytes / 16 * 15;
    if aborted || near_limit {
        "sheet_out_of_memory"
    } else {
        "sheet_worker_failed"
    }
}

/// One open workbook, bound to the principal and, through [`SheetPresence`], to that
/// principal's control connections.
struct Handle {
    principal: String,
    path: PathBuf,
    format: SheetFormat,
    size: u64,
    change_token: String,
    helper: Option<Arc<Helper>>,
    /// A helper is being started for this handle on another thread.
    starting: bool,
    /// That start failed; the next `rows` reports it once.
    start_failed: Option<String>,
    /// The helper's last answer for this handle was `loading`: not idle.
    loading: bool,
    last_used: Instant,
}

#[derive(Clone)]
struct SheetInfo {
    name: String,
    visible: bool,
}

fn to_sheet_info(value: &Value) -> Result<Vec<SheetInfo>> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .map(|entry| SheetInfo {
                    name: entry["name"].as_str().unwrap_or_default().to_owned(),
                    visible: entry["visible"].as_bool().unwrap_or(true),
                })
                .collect()
        })
        .ok_or_else(|| anyhow!("sheet_worker_failed"))
}

/// The handle table. Never held across a helper request or a helper start: those take
/// seconds on a large workbook, and every other workbook's requests need this lock.
struct Host {
    handles: HashMap<String, Handle>,
}

static HOST: OnceLock<Mutex<Host>> = OnceLock::new();

fn host() -> MutexGuard<'static, Host> {
    let host = HOST.get_or_init(|| {
        // The reaper ends idle helpers and forgets stale handles even when nobody asks.
        let sweep = sheet_idle().min(SHEET_SWEEP).max(Duration::from_millis(250));
        std::thread::Builder::new()
            .name("sheet-sweep".into())
            .spawn(move || loop {
                std::thread::sleep(sweep);
                sweep_once();
            })
            .ok();
        Mutex::new(Host {
            handles: HashMap::new(),
        })
    });
    host.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn end_all(helpers: Vec<Arc<Helper>>) {
    for helper in helpers {
        helper.end();
    }
}

fn sweep_once() {
    let ended = {
        let mut host = host();
        let now = Instant::now();
        let mut ended = host.end_idle(now);
        ended.extend(host.forget_stale(now));
        ended
    };
    end_all(ended);
}

impl Host {
    /// Helpers alive or being started.
    fn live_helpers(&self) -> usize {
        self.handles
            .values()
            .filter(|handle| handle.helper.is_some() || handle.starting)
            .count()
    }

    /// `design.md` §3.5: at most [`SHEET_MAX_HELPERS`] live helpers; the least recently
    /// used idle one is ended first, and a loading one only when none is idle. Returns
    /// the helper to end, which the caller ends after dropping the lock.
    fn make_room(&mut self, keep: &str) -> Result<Option<Arc<Helper>>> {
        if self.live_helpers() < SHEET_MAX_HELPERS {
            return Ok(None);
        }
        let pick = |idle_only: bool| {
            self.handles
                .iter()
                .filter(|(id, handle)| {
                    id.as_str() != keep && handle.helper.is_some() && (!idle_only || !handle.loading)
                })
                .min_by_key(|(_, handle)| handle.last_used)
                .map(|(id, _)| id.clone())
        };
        let Some(id) = pick(true).or_else(|| pick(false)) else {
            // Every slot is a helper still starting.
            return Err(anyhow!("sheet_out_of_memory"));
        };
        Ok(self.handles.get_mut(&id).and_then(|handle| {
            handle.loading = false;
            handle.helper.take()
        }))
    }

    fn end_idle(&mut self, now: Instant) -> Vec<Arc<Helper>> {
        let idle = sheet_idle();
        self.handles
            .values_mut()
            .filter(|handle| now.duration_since(handle.last_used) >= idle)
            .filter_map(|handle| {
                handle.loading = false;
                handle.helper.take()
            })
            .collect()
    }

    fn forget_stale(&mut self, now: Instant) -> Vec<Arc<Helper>> {
        let stale: Vec<String> = self
            .handles
            .iter()
            .filter(|(_, handle)| now.duration_since(handle.last_used) >= SHEET_HANDLE_FORGET)
            .map(|(id, _)| id.clone())
            .collect();
        stale
            .into_iter()
            .filter_map(|id| self.handles.remove(&id).and_then(|handle| handle.helper))
            .collect()
    }

    /// The principal's last control connection closed: its handles go.
    fn disconnect(&mut self, principal: &str) -> Vec<Arc<Helper>> {
        let owned: Vec<String> = self
            .handles
            .iter()
            .filter(|(_, handle)| handle.principal == principal)
            .map(|(id, _)| id.clone())
            .collect();
        owned
            .into_iter()
            .filter_map(|id| self.handles.remove(&id).and_then(|handle| handle.helper))
            .collect()
    }
}

/// Live control connections per principal, apart from [`HOST`] so a connection
/// never starts the sheet host.
static CONNECTED: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

fn connected() -> MutexGuard<'static, HashMap<String, usize>> {
    CONNECTED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Held by each control connection (`transport::serve_control`), like the lease and
/// preview presences beside it. When a principal's last connection closes, its
/// handles are closed and their helpers end (`design.md` §3.1: a handle is bound to the
/// principal and connection that opened it).
pub(crate) struct SheetPresence {
    principal: String,
}

pub(crate) fn connect(principal: &str) -> SheetPresence {
    *connected().entry(principal.to_owned()).or_default() += 1;
    SheetPresence {
        principal: principal.to_owned(),
    }
}

impl Drop for SheetPresence {
    fn drop(&mut self) {
        let last = {
            let mut connected = connected();
            match connected.get_mut(&self.principal) {
                Some(count) if *count > 1 => {
                    *count -= 1;
                    false
                }
                _ => {
                    connected.remove(&self.principal);
                    true
                }
            }
        };
        if !last || HOST.get().is_none() {
            return;
        }
        let ended = host().disconnect(&self.principal);
        end_all(ended);
    }
}

/// A fresh 128-bit handle.
fn new_handle_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

// --- wire methods ---------------------------------------------------------

pub(crate) fn dispatch(
    db: &Database,
    principal: &str,
    method: &str,
    params: &Value,
) -> Result<Option<Value>> {
    match method {
        "filesystem.sheet.open" => open_project(db, principal, params).map(Some),
        "filesystem.external.sheet.open" => open_external(db, principal, params).map(Some),
        "filesystem.sheet.rows" => rows(principal, params).map(Some),
        "filesystem.sheet.close" => close(principal, params).map(Some),
        _ => Ok(None),
    }
}

fn object(params: &Value) -> Result<&serde_json::Map<String, Value>> {
    params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))
}

fn string(params: &Value, key: &str) -> Result<String> {
    object(params)?
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("invalid_request"))
}

fn count(params: &Value, key: &str) -> Result<u64> {
    object(params)?
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("invalid_request"))
}

/// `filesystem.sheet.open`: the same root and scope rules as `filesystem.readWindow`.
fn open_project(db: &Database, principal: &str, params: &Value) -> Result<Value> {
    let allowed = ["projectId", "worktreePath", "path"];
    if object(params)?
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(anyhow!("invalid_request"));
    }
    let project_id = string(params, "projectId")?;
    let worktree_path = object(params)?.get("worktreePath").and_then(Value::as_str);
    let relative = string(params, "path")?;
    let root =
        db.transaction(|tx| crate::workspace_services::root_for(tx, &project_id, worktree_path))?;
    let resolved = crate::workspace_services::scoped_path(&root, &relative, true)?;
    open_resolved(principal, &resolved)
}

/// `filesystem.external.sheet.open`: registered external files only, by ID.
fn open_external(db: &Database, principal: &str, params: &Value) -> Result<Value> {
    if object(params)?.keys().any(|key| key != "id") {
        return Err(anyhow!("invalid_request"));
    }
    let id = string(params, "id")?;
    let path = crate::external_files::resolve_registered(db, &id)?;
    open_resolved(principal, &path)
}

/// Start a helper and have it open the workbook. Seconds on a large workbook, so it
/// never runs under the host lock.
fn start_helper(path: &Path, format: SheetFormat) -> Result<(Helper, Vec<SheetInfo>)> {
    let helper = Helper::start()?;
    let opened = helper
        .request(&json!({
            "method": "open",
            "path": path.to_string_lossy(),
            "format": format_name(format),
        }))
        .and_then(|opened| to_sheet_info(&opened["sheets"]));
    match opened {
        Ok(sheets) => Ok((helper, sheets)),
        Err(error) => {
            helper.end();
            Err(error)
        }
    }
}

/// Metadata fence, then the helper's sheet list. No workbook bytes are read here.
fn open_resolved(principal: &str, path: &Path) -> Result<Value> {
    let (path, size, change_token) = metadata_fence(path)?;
    let format = SheetFormat::from_path(&path.to_string_lossy())
        .ok_or_else(|| anyhow!("unsupported_document"))?;
    let id = new_handle_id();
    // Reserve the helper slot under the lock, so parallel opens cannot pass the limit;
    // start the helper outside it.
    let evicted = {
        let mut host = host();
        let evicted = host.make_room(&id)?;
        host.handles.insert(
            id.clone(),
            Handle {
                principal: principal.to_owned(),
                path: path.clone(),
                format,
                size,
                change_token: change_token.clone(),
                helper: None,
                starting: true,
                start_failed: None,
                loading: false,
                last_used: Instant::now(),
            },
        );
        evicted
    };
    if let Some(helper) = evicted {
        helper.end();
    }
    let started = start_helper(&path, format);
    let mut host = host();
    match started {
        Ok((helper, sheets)) => {
            let Some(handle) = host.handles.get_mut(&id) else {
                // The principal's connection closed meanwhile.
                drop(host);
                helper.end();
                return Err(anyhow!("sheet_not_found"));
            };
            handle.helper = Some(Arc::new(helper));
            handle.starting = false;
            Ok(json!({
                "handle": id,
                "size": size,
                "changeToken": change_token,
                "sheets": sheets
                    .iter()
                    .map(|sheet| json!({"name": sheet.name, "visible": sheet.visible}))
                    .collect::<Vec<_>>(),
            }))
        }
        Err(error) => {
            host.handles.remove(&id);
            Err(error)
        }
    }
}

fn format_name(format: SheetFormat) -> &'static str {
    match format {
        SheetFormat::Xlsx => "xlsx",
        SheetFormat::Xlsb => "xlsb",
        SheetFormat::Xls => "xls",
        SheetFormat::Ods => "ods",
    }
}

/// Size, existence and the `read_window_path` change token, from metadata only.
fn metadata_fence(path: &Path) -> Result<(PathBuf, u64, String)> {
    let canonical = path.canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            anyhow!("file_not_found")
        } else {
            anyhow!("file_unavailable")
        }
    })?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| anyhow!("file_unavailable"))?;
    if !metadata.is_file() {
        return Err(anyhow!("file_not_file"));
    }
    if metadata.len() > SHEET_MAX_BYTES {
        return Err(anyhow!("file_too_large"));
    }
    let token = crate::workspace_services::file_change_token(&metadata)?;
    Ok((canonical, metadata.len(), token))
}

/// The `loading` answer the host gives itself while a helper starts.
fn loading_reply(start: u64, column_start: u64) -> Value {
    json!({
        "state": "loading",
        "totalRows": 0,
        "totalColumns": 0,
        "start": start,
        "columnStart": column_start,
        "rows": [],
    })
}

/// A helper restart after idle or a failure (`design.md` §3.5): off the request, which
/// answers `loading`; the client's next poll finds the helper or the start's error.
fn restart_in_background(id: String, path: PathBuf, format: SheetFormat) {
    let thread_id = id.clone();
    let spawned = std::thread::Builder::new()
        .name("sheet-start".into())
        .spawn(move || {
            let started = start_helper(&path, format);
            let orphan = {
                let mut host = host();
                match host.handles.get_mut(&thread_id) {
                    Some(handle) if handle.starting => {
                        handle.starting = false;
                        match started {
                            Ok((helper, _)) => handle.helper = Some(Arc::new(helper)),
                            Err(error) => handle.start_failed = Some(error.to_string()),
                        }
                        None
                    }
                    // Closed or forgotten meanwhile.
                    _ => started.ok().map(|(helper, _)| helper),
                }
            };
            if let Some(helper) = orphan {
                helper.end();
            }
        });
    if spawned.is_err() {
        if let Some(handle) = host().handles.get_mut(&id) {
            handle.starting = false;
            handle.start_failed = Some("sheet_worker_failed".into());
        }
    }
}

/// `filesystem.sheet.rows`: one window, or `loading` while the helper starts or loads.
fn rows(principal: &str, params: &Value) -> Result<Value> {
    let allowed = ["handle", "sheet", "start", "count", "columnStart", "columnCount"];
    if object(params)?
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(anyhow!("invalid_request"));
    }
    let id = string(params, "handle")?;
    let sheet = count(params, "sheet")?;
    let start = count(params, "start")?;
    let count_rows = count(params, "count")?;
    let lifted = object(params)?;
    let column_start = lifted
        .get("columnStart")
        .map(|value| value.as_u64().ok_or_else(|| anyhow!("invalid_request")))
        .transpose()?
        .unwrap_or(0);
    let column_count = lifted
        .get("columnCount")
        .map(|value| value.as_u64().ok_or_else(|| anyhow!("invalid_request")))
        .transpose()?
        .unwrap_or(200);

    let helper = {
        let mut host = host();
        // Ownership, then the change fence, both before the helper is asked anything.
        let handle = host
            .handles
            .get_mut(&id)
            .filter(|handle| handle.principal == principal)
            .ok_or_else(|| anyhow!("sheet_not_found"))?;
        handle.last_used = Instant::now();
        let (_, size, token) = metadata_fence(&handle.path).map_err(|error| {
            if error.to_string() == "file_not_found" {
                anyhow!("file_changed")
            } else {
                error
            }
        })?;
        if size != handle.size || token != handle.change_token {
            handle.loading = false;
            let stale = handle.helper.take();
            drop(host);
            if let Some(helper) = stale {
                helper.end();
            }
            return Err(anyhow!("file_changed"));
        }
        if let Some(code) = handle.start_failed.take() {
            return Err(anyhow!(code));
        }
        if handle.starting {
            return Ok(loading_reply(start, column_start));
        }
        match handle.helper.as_ref() {
            Some(helper) => Arc::clone(helper),
            None => {
                // Idle or a failure ended the helper: start a fresh one off this request.
                let (path, format) = (handle.path.clone(), handle.format);
                handle.starting = true;
                let evicted = match host.make_room(&id) {
                    Ok(evicted) => evicted,
                    Err(error) => {
                        if let Some(handle) = host.handles.get_mut(&id) {
                            handle.starting = false;
                        }
                        return Err(error);
                    }
                };
                drop(host);
                if let Some(helper) = evicted {
                    helper.end();
                }
                restart_in_background(id, path, format);
                return Ok(loading_reply(start, column_start));
            }
        }
    };
    let reply = helper.request(&json!({
        "method": "rows",
        "sheet": sheet,
        "start": start,
        "count": count_rows,
        "columnStart": column_start,
        "columnCount": column_count,
    }));
    let mut host = host();
    // The handle may have been closed, or its helper replaced, while the request ran.
    let ours = host
        .handles
        .get_mut(&id)
        .filter(|handle| handle.helper.as_ref().is_some_and(|live| Arc::ptr_eq(live, &helper)));
    match reply {
        Ok(reply) => {
            if let Some(handle) = ours {
                handle.loading = reply["state"] == "loading";
            }
            Ok(reply)
        }
        Err(error) => {
            // A crash or a memory-limit stop is an error for this handle only; the next
            // `rows` starts a fresh helper. A sheet error (`sheet_too_complex`) keeps the
            // helper, which remembers it and answers it at once next time.
            if matches!(
                error.to_string().as_str(),
                "sheet_worker_failed" | "sheet_out_of_memory"
            ) {
                if let Some(handle) = ours {
                    handle.helper = None;
                    handle.loading = false;
                }
                drop(host);
                helper.end();
            }
            Err(error)
        }
    }
}

/// `filesystem.sheet.close`: idempotent, and silent about handles of another principal.
fn close(principal: &str, params: &Value) -> Result<Value> {
    if object(params)?.keys().any(|key| key != "handle") {
        return Err(anyhow!("invalid_request"));
    }
    let id = string(params, "handle")?;
    let removed = {
        let mut host = host();
        let owned = host
            .handles
            .get(&id)
            .is_some_and(|handle| handle.principal == principal);
        if owned {
            host.handles.remove(&id)
        } else {
            None
        }
    };
    if let Some(helper) = removed.and_then(|handle| handle.helper) {
        helper.end();
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_host() -> Host {
        Host {
            handles: HashMap::new(),
        }
    }

    fn handle(principal: &str, last_used: Instant) -> Handle {
        Handle {
            principal: principal.to_owned(),
            path: PathBuf::from("nope.xlsx"),
            format: SheetFormat::Xlsx,
            size: 0,
            change_token: String::new(),
            helper: None,
            starting: false,
            start_failed: None,
            loading: false,
            last_used,
        }
    }

    #[test]
    fn handles_are_128_random_bits() {
        let first = new_handle_id();
        let second = new_handle_id();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn another_principal_can_neither_read_nor_close_a_handle() {
        let id = new_handle_id();
        let mut owned = handle("owner", Instant::now());
        owned.starting = true;
        host().handles.insert(id.clone(), owned);
        let request = json!({"handle": id, "sheet": 0, "start": 0, "count": 10});
        assert_eq!(rows("intruder", &request).unwrap_err().to_string(), "sheet_not_found");
        close("intruder", &json!({"handle": id})).unwrap();
        assert!(host().handles.contains_key(&id), "another principal closed it");
        close("owner", &json!({"handle": id})).unwrap();
        assert!(!host().handles.contains_key(&id));
    }

    #[test]
    fn a_handle_whose_helper_is_starting_answers_loading_at_once() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("sheet-core/tests/fixtures/features.xlsx");
        let (_, size, token) = metadata_fence(&fixture).unwrap();
        let id = new_handle_id();
        let mut starting = handle("owner", Instant::now());
        starting.path = fixture;
        starting.size = size;
        starting.change_token = token;
        starting.starting = true;
        host().handles.insert(id.clone(), starting);
        let reply = rows(
            "owner",
            &json!({"handle": id, "sheet": 0, "start": 7, "count": 10, "columnStart": 2}),
        )
        .unwrap();
        assert_eq!(reply["state"], "loading");
        assert_eq!(reply["start"], 7);
        assert_eq!(reply["columnStart"], 2);
        host().handles.get_mut(&id).unwrap().start_failed = Some("sheet_out_of_memory".into());
        host().handles.get_mut(&id).unwrap().starting = false;
        let request = json!({"handle": id, "sheet": 0, "start": 0, "count": 10});
        assert_eq!(rows("owner", &request).unwrap_err().to_string(), "sheet_out_of_memory");
        close("owner", &json!({"handle": id})).unwrap();
    }

    #[test]
    fn stale_handles_are_swept_and_fresh_ones_kept() {
        let mut host = test_host();
        let old = Instant::now() - SHEET_HANDLE_FORGET - Duration::from_secs(1);
        host.handles.insert("old".into(), handle("owner", old));
        host.handles.insert("fresh".into(), handle("owner", Instant::now()));
        host.forget_stale(Instant::now());
        assert!(!host.handles.contains_key("old"));
        assert!(host.handles.contains_key("fresh"));
    }

    #[test]
    fn a_closed_connection_drops_only_that_principals_handles() {
        let mut host = test_host();
        host.handles.insert("a".into(), handle("left", Instant::now()));
        host.handles.insert("b".into(), handle("left", Instant::now()));
        host.handles.insert("c".into(), handle("stays", Instant::now()));
        host.disconnect("left");
        assert_eq!(host.handles.keys().collect::<Vec<_>>(), vec!["c"]);
    }

    #[test]
    fn a_principal_keeps_its_handles_until_its_last_connection_closes() {
        let principal = format!("presence-{}", new_handle_id());
        let id = new_handle_id();
        host().handles.insert(id.clone(), handle(&principal, Instant::now()));
        let first = connect(&principal);
        let second = connect(&principal);
        drop(first);
        assert!(host().handles.contains_key(&id));
        drop(second);
        assert!(!host().handles.contains_key(&id));
    }

    #[test]
    fn the_helper_limit_counts_starting_helpers_and_refuses_when_all_are_starting() {
        let mut host = test_host();
        for id in ["a", "b", "c"] {
            let mut starting = handle("owner", Instant::now());
            starting.starting = true;
            host.handles.insert(id.into(), starting);
        }
        assert_eq!(host.live_helpers(), SHEET_MAX_HELPERS);
        let refused = host.make_room("d").err().map(|error| error.to_string());
        assert_eq!(refused.as_deref(), Some("sheet_out_of_memory"));
        host.handles.get_mut("a").unwrap().starting = false;
        assert!(host.make_room("d").unwrap().is_none());
    }

    #[test]
    fn a_memory_limit_stop_is_out_of_memory_and_anything_else_failed() {
        let limit = SHEET_HELPER_MEMORY_LIMIT;
        assert_eq!(stop_code(Some(STATUS_FAST_FAIL), 0, limit), "sheet_out_of_memory");
        assert_eq!(stop_code(Some(STATUS_COMMITMENT_LIMIT), 0, limit), "sheet_out_of_memory");
        assert_eq!(stop_code(Some(1), limit - 1024, limit), "sheet_out_of_memory");
        assert_eq!(stop_code(Some(101), 64 << 20, limit), "sheet_worker_failed");
        assert_eq!(stop_code(None, 0, limit), "sheet_worker_failed");
    }

    #[test]
    fn close_is_idempotent_and_rejects_extra_keys() {
        assert_eq!(
            close("owner", &json!({"handle": "absent"})).unwrap(),
            Value::Null
        );
        assert_eq!(
            close("owner", &json!({"handle": "absent"})).unwrap(),
            Value::Null
        );
        assert_eq!(
            close("owner", &json!({"handle": "absent", "extra": 1}))
                .unwrap_err()
                .to_string(),
            "invalid_request"
        );
    }

    #[test]
    fn rows_of_an_unknown_handle_is_sheet_not_found() {
        let error = rows(
            "owner",
            &json!({"handle": "absent", "sheet": 0, "start": 0, "count": 10}),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "sheet_not_found");
    }

    #[test]
    fn a_row_request_only_allows_the_documented_keys() {
        let error = rows("owner", &json!({"handle": "x", "offset": 0})).unwrap_err();
        assert_eq!(error.to_string(), "invalid_request");
    }

    #[test]
    fn the_helper_budget_and_the_idle_time_are_the_designed_values() {
        assert_eq!(SHEET_MAX_HELPERS, 3);
        assert_eq!(SHEET_IDLE, Duration::from_secs(300));
        assert_eq!(SHEET_HANDLE_FORGET, Duration::from_secs(30 * 60));
        assert_eq!(SHEET_HELPER_MEMORY_LIMIT, 2 * 1024 * 1024 * 1024);
        assert_eq!(SHEET_MAX_BYTES, 100 * 1024 * 1024);
    }
}
