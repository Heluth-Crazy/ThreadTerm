//! Detect which agent CLI is running inside a plain shell/custom terminal, and
//! publish that provider id on the session as `terminalAgent`.
//!
//! Windows only: one shared watcher polls every eligible session's Job tree,
//! matches process image paths (and, for script hosts, command lines) against a
//! small signature table, and writes the DB only when the answer changes.
use crate::db::Database;
use crate::pty::PtyManager;
use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Poll about every 1–1.5 s; the exact value is not load-bearing.
pub(crate) const POLL: Duration = Duration::from_millis(1250);

/// Basenames that need a command-line read; everything else matches on image path alone.
const SCRIPT_HOSTS: &[&str] = &["node.exe", "bun.exe", "deno.exe", "python.exe", "pythonw.exe", "py.exe"];

/// One agent signature: image basenames and/or command-line fragments (already lowercased, `/`-separated).
#[derive(Clone, Copy)]
struct Signature {
    id: &'static str,
    images: &'static [&'static str],
    fragments: &'static [&'static str],
    /// When set, an image path that contains this substring also matches (grok's install under `\.grok\`).
    path_contains: Option<&'static str>,
}

const SIGNATURES: &[Signature] = &[
    Signature {
        id: "claude",
        images: &["claude.exe"],
        fragments: &["@anthropic-ai/claude-code"],
        path_contains: None,
    },
    Signature {
        id: "codex",
        images: &["codex.exe"],
        fragments: &["@openai/codex"],
        path_contains: None,
    },
    Signature {
        id: "gemini",
        images: &["gemini.exe"],
        fragments: &["@google/gemini-cli"],
        path_contains: None,
    },
    Signature {
        id: "kimi",
        images: &["kimi.exe"],
        fragments: &["kimi_cli", "kimi-cli"],
        path_contains: None,
    },
    Signature {
        id: "opencode",
        images: &["opencode.exe"],
        fragments: &["opencode-ai"],
        path_contains: None,
    },
    Signature {
        id: "grok",
        images: &["grok.exe"],
        fragments: &[],
        path_contains: Some("/.grok/"),
    },
    Signature {
        id: "pi",
        images: &["pi.exe"],
        fragments: &["pi-coding-agent"],
        path_contains: None,
    },
];

/// Lowercase and collapse `\` to `/` so Windows paths and package ids compare the same way.
pub(crate) fn normalize(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            let lower = ch.to_ascii_lowercase();
            if lower == '\\' {
                '/'
            } else {
                lower
            }
        })
        .collect()
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Pure match against one process's image path and optional command line.
pub(crate) fn match_agent(image: &str, cmdline: Option<&str>) -> Option<&'static str> {
    let image_n = normalize(image);
    let base = basename(&image_n);
    let cmdline_n = cmdline.map(normalize);
    for signature in SIGNATURES {
        if signature.images.iter().any(|name| *name == base) {
            return Some(signature.id);
        }
        if let Some(needle) = signature.path_contains {
            if image_n.contains(needle) {
                return Some(signature.id);
            }
        }
        if let Some(ref line) = cmdline_n {
            if signature.fragments.iter().any(|fragment| line.contains(fragment)) {
                return Some(signature.id);
            }
        }
    }
    None
}

/// Among `(creation_time, icon)` hits, the oldest wins: the agent the user started,
/// not one it runs as a tool (Claude calling `codex exec` stays Claude).
pub(crate) fn pick_outermost(hits: &[(u64, String)]) -> Option<String> {
    hits.iter()
        .min_by_key(|(created, _)| *created)
        .map(|(_, id)| id.clone())
}

/// Icons the renderer draws itself; anything else is a user image (`image:<id>`).
pub(crate) const BUILT_IN_ICONS: &[&str] = &["claude", "codex", "gemini", "kimi", "grok", "opencode", "pi", "shell"];

/// One rule from Settings → Terminal icons: a program name or path fragment, and its icon.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UserRule {
    pattern: String,
    icon: String,
}

/// The user's rules in order. Settings validation keeps them well-formed; a blank one is skipped.
pub(crate) fn user_rules(settings: &Value) -> Vec<UserRule> {
    settings
        .pointer("/terminalIcons/rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|rule| {
            let pattern = normalize(rule.get("match")?.as_str()?.trim());
            let icon = rule.get("icon")?.as_str()?.to_owned();
            (!pattern.is_empty()).then_some(UserRule { pattern, icon })
        })
        .collect()
}

/// A name matches the executable (with or without `.exe`) or one folder, package or file
/// name of a script host's command line (`copilot` in `@github/copilot/index.js`); a pattern
/// with `/` matches anywhere in the path or command line. Inputs are already normalized.
fn rule_matches(pattern: &str, image: &str, cmdline: Option<&str>) -> bool {
    if pattern.contains('/') {
        return image.contains(pattern) || cmdline.is_some_and(|line| line.contains(pattern));
    }
    let base = basename(image);
    if base == pattern || base.strip_suffix(".exe") == Some(pattern) {
        return true;
    }
    let named = |token: &str| {
        token == pattern
            || [".js", ".mjs", ".cjs", ".py", ".exe", ".cmd"].iter().any(|ext| token.strip_suffix(ext) == Some(pattern))
    };
    cmdline.is_some_and(|line| line.split(|c: char| matches!(c, '/' | ' ' | '"' | '\'' | '=' | '\t')).any(named))
}

/// The icon for one process: the user's rules first, then the built-in signatures.
pub(crate) fn match_process(rules: &[UserRule], image: &str, cmdline: Option<&str>) -> Option<String> {
    let (image_n, cmdline_n) = (normalize(image), cmdline.map(normalize));
    rules
        .iter()
        .find(|rule| rule_matches(&rule.pattern, &image_n, cmdline_n.as_deref()))
        .map(|rule| rule.icon.clone())
        .or_else(|| match_agent(image, cmdline).map(str::to_owned))
}

fn needs_cmdline(image: &str) -> bool {
    let normalized = normalize(image);
    let base = basename(&normalized);
    SCRIPT_HOSTS.iter().any(|name| *name == base)
}

/// What the watcher learned about one pid; cached by (pid, creation) so a recycled pid is never reused.
#[derive(Clone, Debug)]
pub(crate) struct ProcessInfo {
    pub image: String,
    pub created: u64,
    pub cmdline: Option<String>,
}

/// Outside world of the watcher. Tests inject a fake so the loop never sleeps for real.
pub(crate) trait WatchHost {
    fn sleep(&self, delay: Duration);
    /// Running shell/custom terminal session ids.
    fn eligible_sessions(&self) -> Vec<String>;
    fn process_ids(&self, session_id: &str) -> Vec<u32>;
    fn inspect(&self, pid: u32) -> Option<ProcessInfo>;
}

/// Persist and publish only when the value actually changes.
pub(crate) fn set_terminal_agent(db: &Database, session_id: &str, agent: Option<&str>) -> Result<bool> {
    db.transaction(|tx| {
        let current: Option<String> = tx
            .query_row(
                "SELECT provider FROM terminal_agents WHERE session_id=?",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        let next = agent.map(str::to_owned);
        if current == next {
            return Ok(false);
        }
        match &next {
            Some(provider) => {
                tx.execute(
                    "INSERT INTO terminal_agents(session_id, provider) VALUES(?, ?) \
                     ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider",
                    params![session_id, provider],
                )?;
            }
            None => {
                tx.execute("DELETE FROM terminal_agents WHERE session_id=?", [session_id])?;
            }
        }
        let data = json!({"kind":"session","sessionId":session_id});
        tx.execute(
            "INSERT INTO outbox(event,data,created_at) VALUES('state.changed',?,?)",
            params![data.to_string(), Utc::now().to_rfc3339()],
        )?;
        Ok(true)
    })
}

/// Drop every row at runtime startup: PTYs do not survive a restart.
pub(crate) fn clear_all(db: &Database) -> Result<()> {
    db.transaction(|tx| {
        tx.execute("DELETE FROM terminal_agents", [])?;
        Ok(())
    })
}

pub(crate) fn initialize_connection(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS terminal_agents (
           session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
           provider TEXT NOT NULL
         );",
    )?;
    Ok(())
}

/// What the watcher remembers between polls: each process's icon, keyed by (pid, creation)
/// so a recycled pid is never misread, and the user rules those answers were made with.
#[derive(Default)]
pub(crate) struct Detection {
    cache: HashMap<(u32, u64), Option<String>>,
    rules: Vec<UserRule>,
}

/// Detect the icon for one session from the host's process tree.
pub(crate) fn detect_session(host: &impl WatchHost, session_id: &str, state: &mut Detection) -> Option<String> {
    let mut hits = Vec::new();
    for pid in host.process_ids(session_id) {
        let Some(info) = host.inspect(pid) else {
            continue;
        };
        let key = (pid, info.created);
        let icon = match state.cache.get(&key) {
            Some(cached) => cached.clone(),
            None => {
                // `inspect` already reads the command line for script hosts only.
                let matched = match_process(&state.rules, &info.image, info.cmdline.as_deref());
                state.cache.insert(key, matched.clone());
                matched
            }
        };
        if let Some(id) = icon {
            hits.push((info.created, id));
        }
    }
    pick_outermost(&hits)
}

/// One poll: reconcile every eligible session and clear rows that no longer apply.
pub(crate) fn poll_once(db: &Database, host: &impl WatchHost, state: &mut Detection) {
    // Edited rules re-match every process on this poll.
    let rules = db.settings_value().map(|settings| user_rules(&settings)).unwrap_or_default();
    if rules != state.rules {
        state.cache.clear();
        state.rules = rules;
    }
    let eligible: HashSet<String> = host.eligible_sessions().into_iter().collect();
    let stored: HashMap<String, String> = db
        .transaction(|tx| {
            let mut stmt = tx.prepare("SELECT session_id, provider FROM terminal_agents")?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<HashMap<_, _>>>()?;
            Ok(rows)
        })
        .unwrap_or_default();
    for session_id in stored.keys() {
        if !eligible.contains(session_id) {
            let _ = set_terminal_agent(db, session_id, None);
        }
    }
    // Compare with the rows just read so an unchanged terminal costs no transaction.
    for session_id in &eligible {
        let icon = detect_session(host, session_id, state);
        if stored.get(session_id) != icon.as_ref() {
            let _ = set_terminal_agent(db, session_id, icon.as_deref());
        }
    }
    // Drop cache entries for pids that no longer appear, so the map cannot grow without bound.
    let live: HashSet<u32> = eligible
        .iter()
        .flat_map(|id| host.process_ids(id))
        .collect();
    state.cache.retain(|(pid, _), _| live.contains(pid));
}

/// Shared watcher loop. Sleeps outside every database and PTY lock.
pub(crate) fn watch(db: &Database, host: &impl WatchHost) {
    let mut state = Detection::default();
    loop {
        poll_once(db, host, &mut state);
        host.sleep(POLL);
    }
}

struct LiveHost {
    db: Arc<Database>,
    pty: PtyManager,
}

impl WatchHost for LiveHost {
    fn sleep(&self, delay: Duration) {
        thread::sleep(delay);
    }
    fn eligible_sessions(&self) -> Vec<String> {
        self.db
            .transaction(|tx| {
                let mut stmt = tx.prepare(
                    "SELECT id FROM sessions WHERE mode='terminal' AND provider IN ('shell','custom') \
                     AND status IN ('starting','running','idle','waiting')",
                )?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap_or_default()
    }
    fn process_ids(&self, session_id: &str) -> Vec<u32> {
        self.pty.process_ids(session_id)
    }
    fn inspect(&self, pid: u32) -> Option<ProcessInfo> {
        inspect_process(pid)
    }
}

/// Start the one watcher for this runtime. Non-Windows builds leave the table empty.
pub(crate) fn spawn(db: &Arc<Database>, pty: &PtyManager) {
    #[cfg(windows)]
    {
        let host = LiveHost {
            db: Arc::clone(db),
            pty: pty.clone(),
        };
        let db = Arc::clone(db);
        if let Err(error) = thread::Builder::new()
            .name("terminal-agents".into())
            .spawn(move || watch(&db, &host))
        {
            eprintln!("terminal agent watcher could not start: {error}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (db, pty);
    }
}

#[cfg(windows)]
fn inspect_process(pid: u32) -> Option<ProcessInfo> {
    windows_inspect::inspect(pid)
}

#[cfg(not(windows))]
fn inspect_process(_pid: u32) -> Option<ProcessInfo> {
    None
}

#[cfg(windows)]
mod windows_inspect {
    use super::{needs_cmdline, ProcessInfo};
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    type NtQueryInformationProcessFn = unsafe extern "system" fn(
        process: HANDLE,
        information_class: u32,
        information: *mut core::ffi::c_void,
        information_length: u32,
        return_length: *mut u32,
    ) -> i32;

    fn nt_query() -> Option<NtQueryInformationProcessFn> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::sync::OnceLock;
        static FN: OnceLock<Option<NtQueryInformationProcessFn>> = OnceLock::new();
        *FN.get_or_init(|| {
            let mut name: Vec<u16> = OsStr::new("ntdll.dll").encode_wide().chain(Some(0)).collect();
            // SAFETY: GetModuleHandleW/GetProcAddress on ntdll are standard and the
            // returned symbol stays valid for the process lifetime.
            unsafe {
                let module = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(name.as_mut_ptr());
                if module.is_null() {
                    return None;
                }
                let proc = windows_sys::Win32::System::LibraryLoader::GetProcAddress(
                    module,
                    c"NtQueryInformationProcess".as_ptr().cast(),
                )?;
                Some(core::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    NtQueryInformationProcessFn,
                >(proc))
            }
        })
    }

    pub(super) fn inspect(pid: u32) -> Option<ProcessInfo> {
        // SAFETY: OpenProcess with limited query rights; every success path closes the handle.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let result = inspect_open(handle);
        // SAFETY: handle was opened above and is not used after this close.
        unsafe {
            CloseHandle(handle);
        }
        result
    }

    fn inspect_open(handle: HANDLE) -> Option<ProcessInfo> {
        let created = creation_time(handle)?;
        let image = image_path(handle)?;
        let cmdline = if needs_cmdline(&image) {
            command_line(handle)
        } else {
            None
        };
        Some(ProcessInfo {
            image,
            created,
            cmdline,
        })
    }

    fn creation_time(handle: HANDLE) -> Option<u64> {
        let mut creation = unsafe { zeroed() };
        let mut exit = unsafe { zeroed() };
        let mut kernel = unsafe { zeroed() };
        let mut user = unsafe { zeroed() };
        // SAFETY: all four FILETIME outs are valid stack slots for this process handle.
        let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
        if ok == 0 {
            return None;
        }
        Some((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }

    fn image_path(handle: HANDLE) -> Option<String> {
        let mut size = 512u32;
        for _ in 0..4 {
            let mut buffer = vec![0u16; size as usize];
            let mut needed = size;
            // SAFETY: buffer length matches `needed` capacity; API writes a null-terminated path.
            let ok = unsafe {
                QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut needed)
            };
            if ok != 0 {
                buffer.truncate(needed as usize);
                return Some(String::from_utf16_lossy(&buffer));
            }
            if needed > size {
                size = needed;
            } else {
                size = size.saturating_mul(2).max(1024);
            }
        }
        None
    }

    fn command_line(handle: HANDLE) -> Option<String> {
        let query = nt_query()?;
        let mut needed = 0u32;
        // SAFETY: sizing probe; NULL info buffer is allowed when asking for the length.
        let status = unsafe {
            query(
                handle,
                PROCESS_COMMAND_LINE_INFORMATION,
                core::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        // STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
        if status as u32 != 0xC000_0004 || needed == 0 || needed > 1024 * 1024 {
            return None;
        }
        let mut buffer = vec![0u8; needed as usize];
        let mut written = 0u32;
        // SAFETY: buffer is exactly `needed` bytes; the API fills a UNICODE_STRING header + payload.
        let status = unsafe {
            query(
                handle,
                PROCESS_COMMAND_LINE_INFORMATION,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut written,
            )
        };
        if status != 0 || written < size_of::<UnicodeString>() as u32 {
            return None;
        }
        // SAFETY: the API wrote a UNICODE_STRING at the start of our buffer.
        let header = unsafe { buffer.as_ptr().cast::<UnicodeString>().read_unaligned() };
        if header.buffer.is_null() || header.length == 0 {
            return None;
        }
        // The string must lie inside the buffer the API filled; never read past it.
        let start = (header.buffer as usize).checked_sub(buffer.as_ptr() as usize)?;
        if start.checked_add(usize::from(header.length))? > written as usize {
            return None;
        }
        let chars = (header.length / 2) as usize;
        // SAFETY: Length is in bytes and points into the same returned buffer.
        let slice = unsafe { std::slice::from_raw_parts(header.buffer, chars) };
        Some(String::from_utf16_lossy(slice))
    }
}

#[cfg(test)]
#[path = "terminal_agents_tests.rs"]
mod tests;
