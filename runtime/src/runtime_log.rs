//! Daemon-owned diagnostics: Electron can disappear without breaking stderr.
use std::{
    fmt::{self, Write as _},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024;
const ARCHIVES: usize = 2; // Active runtime.log plus two archives: three files total.

struct BoundedLine {
    text: String,
    oversized: bool,
}
impl fmt::Write for BoundedLine {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.text.len().saturating_add(value.len()) > MAX_LINE_BYTES {
            self.oversized = true;
        } else if !self.oversized {
            self.text.push_str(value);
        }
        Ok(())
    }
}

fn safe_line(arguments: fmt::Arguments<'_>) -> String {
    let mut line = BoundedLine {
        text: String::new(),
        oversized: false,
    };
    let _ = line.write_fmt(arguments);
    if line.oversized {
        return "[truncated runtime log line]".into();
    }
    static SECRET: OnceLock<regex::Regex> = OnceLock::new();
    let secret = SECRET.get_or_init(|| regex::Regex::new(r#"(?i)(?:\bbearer\s+\S+|\b(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,})"#).expect("static log redaction pattern"));
    if secret.is_match(&line.text) {
        "[redacted runtime stderr line]".into()
    } else {
        line.text
    }
}

struct RuntimeLog {
    path: PathBuf,
}
impl RuntimeLog {
    fn write(&self, text: &str) -> std::io::Result<()> {
        let text = format!("{text}\n");
        let size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size.saturating_add(text.len() as u64) > MAX_BYTES {
            let archive = |index| PathBuf::from(format!("{}.{index}", self.path.display()));
            match fs::remove_file(archive(ARCHIVES)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            for index in (1..ARCHIVES).rev() {
                rename_existing(&archive(index), &archive(index + 1))?;
            }
            rename_existing(&self.path, &archive(1))?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(text.as_bytes())
    }
}
fn rename_existing(from: &Path, to: &Path) -> std::io::Result<()> {
    match fs::rename(from, to) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

static LOG: OnceLock<Mutex<RuntimeLog>> = OnceLock::new();

/// Only the daemon entry point claims the file. Child MCP/bootstrap processes
/// inherit environment variables but must not become competing rotating writers.
pub fn initialize(path: PathBuf) {
    let _ = LOG.set(Mutex::new(RuntimeLog { path }));
}

pub fn emit(arguments: fmt::Arguments<'_>) {
    let line = safe_line(arguments);
    if let Some(log) = LOG.get() {
        if let Ok(log) = log.lock() {
            if log.write(&line).is_ok() {
                return;
            }
        }
    }
    // A failed disk or a closed inherited stderr must never kill the daemon.
    let _ = writeln!(std::io::stderr().lock(), "{line}");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_log_redacts_provider_secrets_and_bounds_formatting() {
        assert_eq!(
            safe_line(format_args!("provider failed token=private-value")),
            "[redacted runtime stderr line]"
        );
        assert_eq!(
            safe_line(format_args!(
                "provider stderr: {{\"api_key\":\"private-value\"}}"
            )),
            "[redacted runtime stderr line]"
        );
        assert_eq!(
            safe_line(format_args!("Authorization: Bearer private")),
            "[redacted runtime stderr line]"
        );
        assert_eq!(
            safe_line(format_args!("{}", "x".repeat(MAX_LINE_BYTES + 1))),
            "[truncated runtime log line]"
        );
        assert_eq!(
            safe_line(format_args!("schema_too_new: update ThreadTerm")),
            "schema_too_new: update ThreadTerm"
        );
    }
    #[test]
    fn runtime_log_rotates_at_five_mib_and_retains_three_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.log");
        let log = RuntimeLog { path: path.clone() };
        for index in 0..4 {
            let file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&path)
                .unwrap();
            file.set_len(MAX_BYTES - 2).unwrap();
            drop(file);
            log.write(&format!("log-{index}")).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), format!("log-{index}\n"));
            assert!(fs::metadata(&path).unwrap().len() <= MAX_BYTES);
        }
        assert!(root.path().join("runtime.log.1").is_file());
        assert!(root.path().join("runtime.log.2").is_file());
        assert!(!root.path().join("runtime.log.3").exists());
        assert_eq!(
            fs::metadata(root.path().join("runtime.log.1"))
                .unwrap()
                .len(),
            MAX_BYTES - 2
        );
    }
}
