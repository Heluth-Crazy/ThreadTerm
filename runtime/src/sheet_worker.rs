//! The helper side of the sheet host: this binary started with `--sheet-worker`
//! (`design.md` §3.3). One process per open workbook, hidden, in a kill-on-close job.
//!
//! It owns the parser, opens the file itself and speaks one JSON object per line on
//! stdin and stdout. Requests are answered at once: a sheet's first `rows` starts its
//! load on a background thread and answers `loading`, so the client can poll without
//! ever waiting for a multi-second parse. Nothing here touches the runtime's database,
//! socket, log or singleton.

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use threadterm_sheet_core::{
    RowsRequest, SheetError, SheetFormat, CODE_INVALID, CODE_NOT_FOUND,
};

/// One JSON request line longer than this is refused; the runtime sends a few hundred
/// bytes and a corrupt stream must not be allowed to allocate without bound.
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Loading,
    Ready,
    Failed(&'static str),
}

type Engine = threadterm_sheet_core::Engine;

/// No progress number for the current load (`.xls`/`.ods`, small sheets, none started).
const PROGRESS_UNKNOWN: u32 = u32::MAX;

struct Shared {
    /// Held by the load thread for a whole load: only touch it once `status` says no
    /// load runs, or `rows` would wait for the load.
    engine: Mutex<Option<Engine>>,
    status: Mutex<HashMap<u32, Status>>,
    /// A workbook is open. Read without the engine lock for the same reason.
    opened: AtomicBool,
    /// The running load's share in thousandths, or [`PROGRESS_UNKNOWN`].
    progress: AtomicU32,
}

impl Shared {
    fn new() -> Shared {
        Shared {
            engine: Mutex::new(None),
            status: Mutex::new(HashMap::new()),
            opened: AtomicBool::new(false),
            progress: AtomicU32::new(PROGRESS_UNKNOWN),
        }
    }

    fn lock_engine(&self) -> MutexGuard<'_, Option<Engine>> {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_status(&self) -> MutexGuard<'_, HashMap<u32, Status>> {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Run the helper loop until stdin closes. The return value is the exit code.
pub fn run() -> i32 {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run_io(stdin.lock(), stdout.lock())
}

pub fn run_io(mut input: impl BufRead, mut output: impl Write) -> i32 {
    let shared = Arc::new(Shared::new());
    let mut line = String::new();
    loop {
        line.clear();
        let read = (&mut input)
            .take(MAX_REQUEST_BYTES + 1)
            .read_line(&mut line);
        match read {
            Ok(0) | Err(_) => return 0,
            Ok(_) => {}
        }
        if line.len() as u64 > MAX_REQUEST_BYTES {
            let _ = writeln!(output, "{}", reply_error(CODE_INVALID, "request too large"));
            let _ = output.flush();
            return 1;
        }
        let request = line.trim_end();
        if request.is_empty() {
            continue;
        }
        let (body, stop) = serve(&shared, request);
        if writeln!(output, "{body}").is_err() || output.flush().is_err() {
            return 0;
        }
        if stop {
            return 0;
        }
    }
}

fn serve(shared: &Arc<Shared>, text: &str) -> (String, bool) {
    let request: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return (reply_error(CODE_INVALID, "bad json"), false),
    };
    let method = request["method"].as_str().unwrap_or_default();
    match method {
        "open" => (open(shared, &request), false),
        "rows" => (rows(shared, &request), false),
        "close" => {
            shared.opened.store(false, Ordering::Release);
            *shared.lock_engine() = None;
            shared.lock_status().clear();
            (reply_ok(&serde_json::Value::Null), false)
        }
        "exit" => {
            shared.opened.store(false, Ordering::Release);
            *shared.lock_engine() = None;
            (reply_ok(&serde_json::Value::Null), true)
        }
        other => (reply_error(CODE_INVALID, &format!("unknown method {other}")), false),
    }
}

/// Signature, zip caps and the sheet list. The helper is the only process that reads
/// the workbook, and it reads it with its own access rights.
fn open(shared: &Shared, request: &serde_json::Value) -> String {
    let path = match request["path"].as_str() {
        Some(path) if !path.is_empty() => path.to_owned(),
        _ => return reply_error(CODE_INVALID, "open needs a path"),
    };
    let format = match request["format"].as_str().and_then(|name| match name {
        "xlsx" => Some(SheetFormat::Xlsx),
        "xlsb" => Some(SheetFormat::Xlsb),
        "xls" => Some(SheetFormat::Xls),
        "ods" => Some(SheetFormat::Ods),
        _ => None,
    }) {
        Some(format) => format,
        None => return reply_error(CODE_INVALID, "open needs a format"),
    };
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        // The runtime checked the path a moment ago; a file gone or locked since then is
        // a file problem, not a lost handle.
        Err(_) => return reply_error("file_unavailable", "the workbook could not be opened"),
    };
    let mut engine = Engine::default();
    match engine.open_source(Box::new(file), format) {
        Ok(info) => {
            let body = serde_json::json!({
                "sheets": info.sheets.iter().map(|sheet| serde_json::json!({
                    "name": sheet.name,
                    "visible": sheet.visible,
                })).collect::<Vec<_>>(),
                "date1904": info.date1904,
            });
            *shared.lock_engine() = Some(engine);
            shared.lock_status().clear();
            shared.opened.store(true, Ordering::Release);
            reply_ok(&body)
        }
        Err(error) => reply_sheet_error(&error),
    }
}

/// One window. Never waits for a load: the sheet's first request starts it and answers
/// `loading`.
fn rows(shared: &Arc<Shared>, request: &serde_json::Value) -> String {
    let window = match RowsRequest::from_json(request) {
        Ok(window) => window,
        Err(error) => return reply_sheet_error(&error),
    };
    // Not `lock_engine()`: a load holds that lock, and this must answer at once.
    if !shared.opened.load(Ordering::Acquire) {
        return reply_error(CODE_NOT_FOUND, "no workbook");
    }
    {
        let mut status = shared.lock_status();
        // One load at a time: while a sheet loads, every window answers `loading`.
        if status.values().any(|value| *value == Status::Loading) {
            return reply_loading(shared, window.start, window.column_start);
        }
        match status.get(&window.sheet).copied() {
            Some(Status::Ready) => {}
            Some(Status::Failed(code)) => return reply_error(code, "the sheet could not be read"),
            Some(Status::Loading) => {
                return reply_loading(shared, window.start, window.column_start)
            }
            None => {
                status.insert(window.sheet, Status::Loading);
                drop(status);
                shared.progress.store(PROGRESS_UNKNOWN, Ordering::Release);
                start_load(Arc::clone(shared), window.sheet);
                return reply_loading(shared, window.start, window.column_start);
            }
        }
    }
    let engine = shared.lock_engine();
    let Some(engine) = engine.as_ref() else {
        return reply_error(CODE_NOT_FOUND, "no workbook");
    };
    // `try_lock` would be needed only if a load could run beside a read; loads hold this
    // lock for their whole duration and the status check above already answered them.
    match engine.rows(&window) {
        Ok(value) => reply_ok(&value),
        Err(error) => reply_sheet_error(&error),
    }
}

fn start_load(shared: Arc<Shared>, sheet: u32) {
    let loader = Arc::clone(&shared);
    let spawned = std::thread::Builder::new()
        .name("sheet-load".into())
        .spawn(move || {
            let outcome = {
                let mut engine = loader.lock_engine();
                let progress = &loader.progress;
                match engine.as_mut() {
                    Some(engine) => engine.load_with_progress(sheet, &mut |share| {
                        progress.store((share * 1000.0) as u32, Ordering::Release)
                    }),
                    None => Err(SheetError::new(CODE_NOT_FOUND, "no workbook")),
                }
            };
            let status = match outcome {
                Ok(()) => Status::Ready,
                Err(error) => Status::Failed(error.code),
            };
            loader.lock_status().insert(sheet, status);
        });
    if spawned.is_err() {
        shared
            .lock_status()
            .insert(sheet, Status::Failed("sheet_worker_failed"));
    }
}

fn reply_loading(shared: &Shared, start: u32, column_start: u32) -> String {
    let mut body = serde_json::json!({
        "state": "loading",
        "totalRows": 0,
        "totalColumns": 0,
        "start": start,
        "columnStart": column_start,
        "rows": [],
    });
    // `SheetRows.progress`: 0..1 while loading, only when known.
    let progress = shared.progress.load(Ordering::Acquire);
    if progress != PROGRESS_UNKNOWN {
        body["progress"] = serde_json::json!(f64::from(progress.min(1000)) / 1000.0);
    }
    reply_ok(&body)
}

fn reply_ok(value: &serde_json::Value) -> String {
    serde_json::json!({"ok": true, "result": value}).to_string()
}

fn reply_error(code: &str, message: &str) -> String {
    serde_json::json!({"ok": false, "error": code, "message": message}).to_string()
}

fn reply_sheet_error(error: &SheetError) -> String {
    reply_error(error.code, &error.detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(input: &str) -> String {
        let mut output = Vec::new();
        run_io(std::io::Cursor::new(input.as_bytes().to_vec()), &mut output);
        String::from_utf8_lossy(&output).into_owned()
    }

    #[test]
    fn an_unknown_method_is_an_error_and_the_loop_continues() {
        let text = reply("{\"method\":\"nope\"}\n{\"method\":\"close\"}\n");
        assert!(text.contains("\"error\":\"invalid_request\""), "{text}");
        assert!(text.contains("\"ok\":true"), "{text}");
    }

    #[test]
    fn bad_json_and_missing_arguments_are_errors_not_panics() {
        let text = reply("not json\n{\"method\":\"open\"}\n{\"method\":\"rows\"}\n");
        assert_eq!(text.matches("\"ok\":false").count(), 3, "{text}");
        assert!(text.contains("\"error\":\"invalid_request\""), "{text}");
    }

    #[test]
    fn a_missing_workbook_is_file_unavailable() {
        let text = reply("{\"method\":\"open\",\"path\":\"Z:/nope.xlsx\",\"format\":\"xlsx\"}\n");
        assert!(text.contains("\"error\":\"file_unavailable\""), "{text}");
    }

    /// `design.md` §3.1: no request waits for a load. A load holds the engine lock for
    /// its whole run; a `rows` meanwhile must answer `loading` without taking it.
    #[test]
    fn rows_during_a_load_answers_loading_without_waiting() {
        let shared = Arc::new(Shared::new());
        shared.opened.store(true, Ordering::Release);
        shared.lock_status().insert(0, Status::Loading);
        shared.progress.store(250, Ordering::Release);
        let held = shared.lock_engine();
        let (sender, receiver) = std::sync::mpsc::channel();
        let asking = Arc::clone(&shared);
        std::thread::spawn(move || {
            let request = "{\"method\":\"rows\",\"sheet\":1,\"start\":0,\"count\":10}";
            let _ = sender.send(serve(&asking, request).0);
        });
        let text = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("rows waited for the load");
        drop(held);
        assert!(text.contains("\"state\":\"loading\""), "{text}");
        assert!(text.contains("\"progress\":0.25"), "{text}");
    }

    #[test]
    fn rows_without_an_open_workbook_is_sheet_not_found() {
        let text = reply("{\"method\":\"rows\",\"sheet\":0,\"start\":0,\"count\":10}\n");
        // No workbook: no load is started and the answer is a code.
        assert!(text.contains("\"error\":\"sheet_not_found\""), "{text}");
    }

    #[test]
    fn exit_stops_the_loop() {
        let text = reply("{\"method\":\"exit\"}\n{\"method\":\"rows\"}\n");
        assert_eq!(text.matches("\"ok\":true").count(), 1, "{text}");
    }

    #[test]
    fn a_real_workbook_answers_loading_then_ready() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("sheet-core")
            .join("tests")
            .join("fixtures")
            .join("features.xlsx");
        let open = format!(
            "{{\"method\":\"open\",\"path\":{},\"format\":\"xlsx\"}}\n",
            serde_json::to_string(&fixture.to_string_lossy()).unwrap()
        );
        let shared = Arc::new(Shared::new());
        let first = serve(&shared, open.trim_end());
        assert!(first.0.contains("\"ok\":true"), "{}", first.0);
        let request = "{\"method\":\"rows\",\"sheet\":0,\"start\":4,\"count\":1}";
        let loading = serve(&shared, request).0;
        assert!(loading.contains("\"state\":\"loading\""), "{loading}");
        // Wait for the load thread, then the same request answers a window.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let text = serve(&shared, request).0;
            if text.contains("\"state\":\"ready\"") {
                assert!(text.contains("42"), "{text}");
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the sheet never finished loading"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
