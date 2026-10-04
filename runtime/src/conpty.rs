//! Which console host Windows terminals run on (task 10-03-windows-terminal-hardening).
//!
//! portable-pty loads `conpty.dll` by bare name on its first PTY and otherwise uses the in-box ConPTY
//! in kernel32. The runtime decides once at start, before any PTY exists:
//! - `system`: the in-box ConPTY. The DLL search is narrowed to the default directories first, so no
//!   `conpty.dll` from the current directory or PATH can stand in for it.
//! - `bundled`: Microsoft's OpenConsole pair from `<runtime dir>/conpty/` (pinned and verified at build
//!   time by `runtime/conpty/prepare.mjs`), loaded by absolute path; portable-pty's bare-name load then
//!   returns this already-loaded module. A missing or incomplete pair falls back to `system`.
//!
//! The bundled host asks the terminal for its identity (DA1) when it starts and waits about 3 s for an
//! answer (measured: session start 3,050 ms vs 43 ms). [`DA1_REPLY`] is written before the child starts,
//! and [`StartupQueryFilter`] removes that query from the output: a client terminal answering it later
//! would type `^[[?1;2c` into the shell (measured with cmd.exe).
use serde_json::Value;
use std::{borrow::Cow, sync::OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    System,
    Bundled,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Bundled => "bundled",
        }
    }
}

/// Answer to the host's startup DA1 query (a VT100-class terminal, like other terminals send).
pub const DA1_REPLY: &[u8] = b"\x1b[?61c";

static ACTIVE: OnceLock<Backend> = OnceLock::new();

/// The host in use (`System` until [`initialize`] ran, e.g. in tests).
pub fn active() -> Backend {
    ACTIVE.get().copied().unwrap_or(Backend::System)
}

/// The preferred host: `THREADTERM_V3_CONPTY` (QA, `system` | `bundled`) over the `conptyHost` setting.
/// Bundled is the default (user decision 2026-10-03, after the soak); only `system` opts out.
pub fn preference(settings: &Value) -> Backend {
    let chosen = std::env::var("THREADTERM_V3_CONPTY").ok().or_else(|| settings.get("conptyHost").and_then(Value::as_str).map(str::to_owned));
    match chosen.as_deref() {
        Some("system") => Backend::System,
        _ => Backend::Bundled,
    }
}

/// Whether this build ships the complete pair (`npm run prepare:conpty`); without it `bundled` falls back.
pub fn bundled_available() -> bool {
    bundled_dir().is_some()
}

/// Selects the host once, before the first PTY; later calls return the first choice.
pub fn initialize(preferred: Backend) -> Backend {
    *ACTIVE.get_or_init(|| select(preferred))
}

#[cfg(windows)]
fn select(preferred: Backend) -> Backend {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{
        LoadLibraryExW, SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    };
    // Application directory, System32 and explicitly added directories only: never the current
    // directory or PATH (this also hardens every other bare-name load in the runtime).
    unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) };
    if preferred == Backend::System {
        return Backend::System;
    }
    let Some(dir) = bundled_dir() else { return Backend::System };
    let path: Vec<u16> = dir.join("conpty.dll").as_os_str().encode_wide().chain(Some(0)).collect();
    // Kept loaded for the life of the process: portable-pty holds its entry points.
    let module = unsafe { LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) };
    if module.is_null() { Backend::System } else { Backend::Bundled }
}

#[cfg(not(windows))]
fn select(_preferred: Backend) -> Backend {
    Backend::System
}

/// `<runtime dir>/conpty/` when it holds the complete pair; never half a pair.
fn bundled_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("conpty");
    complete_pair(&dir).then_some(dir)
}

fn complete_pair(dir: &std::path::Path) -> bool {
    dir.join("conpty.dll").is_file() && dir.join("OpenConsole.exe").is_file()
}

/// Removes the host's first DA1 query (`ESC [ c` or `ESC [ 0 c`) from the start of a bundled host's
/// output. Inactive filters pass everything through untouched. While active, at most the 3 bytes that
/// could begin the query are held back across reads, and only within the first [`Self::LIMIT`] bytes.
pub struct StartupQueryFilter {
    active: bool,
    seen: usize,
    held: Vec<u8>,
}

const QUERIES: [&[u8]; 2] = [b"\x1b[c", b"\x1b[0c"];

impl StartupQueryFilter {
    const LIMIT: usize = 256;

    pub fn new(active: bool) -> Self {
        Self { active, seen: 0, held: Vec::new() }
    }

    pub fn feed<'a>(&mut self, chunk: &'a [u8]) -> Cow<'a, [u8]> {
        if !self.active {
            return Cow::Borrowed(chunk);
        }
        let mut data = std::mem::take(&mut self.held);
        data.extend_from_slice(chunk);
        for query in QUERIES {
            if let Some(at) = data.windows(query.len()).position(|window| window == query) {
                data.drain(at..at + query.len());
                self.active = false;
                return Cow::Owned(data);
            }
        }
        self.seen += chunk.len();
        if self.seen >= Self::LIMIT {
            self.active = false;
            return Cow::Owned(data);
        }
        let keep = (1..=3)
            .rev()
            .find(|&length| length <= data.len() && QUERIES.iter().any(|query| query.starts_with(&data[data.len() - length..])))
            .unwrap_or(0);
        self.held = data.split_off(data.len() - keep);
        Cow::Owned(data)
    }

    /// Whatever is still held back (end of output).
    pub fn finish(&mut self) -> Vec<u8> {
        self.active = false;
        std::mem::take(&mut self.held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(filter: &mut StartupQueryFilter, chunks: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend_from_slice(&filter.feed(chunk));
        }
        out.extend(filter.finish());
        out
    }

    #[test]
    fn the_bundled_hosts_startup_query_is_removed_once_and_nothing_else_changes() {
        // Observed OpenConsole 1.24 start: window report, DA1, focus + win32-input requests, autowrap.
        let start: &[u8] = b"\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h\x1b[?7l\x1b[?7h\x1b]0;cmd\x1b\\READY>";
        let out = run(&mut StartupQueryFilter::new(true), &[start]);
        assert_eq!(out, b"\x1b[1t\x1b[?1004h\x1b[?9001h\x1b[?7l\x1b[?7h\x1b]0;cmd\x1b\\READY>".to_vec());
        // Only the first query: a program's own later DA1 must still reach the terminal.
        let mut filter = StartupQueryFilter::new(true);
        assert_eq!(run(&mut filter, &[b"\x1b[cA\x1b[cB"]), b"A\x1b[cB".to_vec());
    }

    #[test]
    fn a_query_split_across_reads_is_still_removed() {
        for split in 1..4 {
            let (head, tail) = b"x\x1b[cy".split_at(split);
            assert_eq!(run(&mut StartupQueryFilter::new(true), &[head, tail]), b"xy".to_vec(), "split at {split}");
        }
        assert_eq!(run(&mut StartupQueryFilter::new(true), &[b"a\x1b[0", b"cb"]), b"ab".to_vec());
    }

    #[test]
    fn inactive_or_late_output_passes_through_untouched() {
        let mut inactive = StartupQueryFilter::new(false);
        assert!(matches!(inactive.feed(b"\x1b[c"), Cow::Borrowed(_)));
        let mut filter = StartupQueryFilter::new(true);
        let filler = vec![b'.'; StartupQueryFilter::LIMIT];
        let out = run(&mut filter, &[&filler, b"\x1b[c"]);
        assert!(out.ends_with(b"\x1b[c"), "after the first 256 bytes nothing is removed");
        // A trailing ESC is held only until the next read or the end.
        let mut filter = StartupQueryFilter::new(true);
        assert_eq!(filter.feed(b"ab\x1b").as_ref(), b"ab");
        assert_eq!(filter.finish(), b"\x1b".to_vec());
    }

    #[test]
    fn bundled_is_the_default_and_only_system_opts_out() {
        std::env::remove_var("THREADTERM_V3_CONPTY");
        assert_eq!(preference(&json!({})), Backend::Bundled);
        assert_eq!(preference(&json!({"conptyHost":"bundled"})), Backend::Bundled);
        assert_eq!(preference(&json!({"conptyHost":"system"})), Backend::System);
        assert_eq!(preference(&json!({"conptyHost":"anything"})), Backend::Bundled);
    }

    #[test]
    fn a_half_pair_is_never_used() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!complete_pair(dir.path()));
        std::fs::write(dir.path().join("conpty.dll"), b"dll").unwrap();
        assert!(!complete_pair(dir.path()), "conpty.dll alone");
        std::fs::write(dir.path().join("OpenConsole.exe"), b"exe").unwrap();
        assert!(complete_pair(dir.path()));
    }
}
