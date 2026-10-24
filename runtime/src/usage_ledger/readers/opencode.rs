use crate::usage_ledger::facts::{number, text, timestamp, Buckets, Fact, Parsed, ReaderState};
use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde_json::Value;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Default)]
pub struct DatabaseRead {
    pub bytes_read: u64,
    pub facts: usize,
    pub covered_sessions: Vec<String>,
    pub problems: Vec<String>,
}

fn parse_message(
    data: &Value,
    session: &str,
    message: &str,
    occurred_at: String,
    parent: Option<String>,
    cwd: Option<String>,
    source: String,
) -> Option<Fact> {
    if text(data, &["role", "type"]) != Some("assistant") {
        return None;
    }
    let tokens = data.get("tokens")?;
    let completed = data.pointer("/time/completed").and_then(timestamp)?;
    let reasoning = number(tokens, &["reasoning"]);
    let output = number(tokens, &["output"]).map(|v| v.saturating_add(reasoning.unwrap_or(0)));
    let mut fact = Fact::new(
        "opencode",
        session,
        &format!("{session}:{message}"),
        &completed,
    );
    fact.model = data
        .pointer("/model/id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| text(data, &["model", "modelID"]).map(str::to_owned));
    fact.parent_native_session_id = parent;
    fact.subagent = fact.parent_native_session_id.is_some();
    fact.cwd = cwd;
    fact.source = source;
    fact.buckets = Buckets {
        input: number(tokens, &["input"]),
        cache_read: number(tokens.pointer("/cache").unwrap_or(&Value::Null), &["read"]),
        cache_write5m: None,
        cache_write1h: None,
        cache_write_unknown: number(tokens.pointer("/cache").unwrap_or(&Value::Null), &["write"]),
        output,
        reasoning,
        ..Default::default()
    };
    fact.reported_cost = data
        .get("cost")
        .and_then(Value::as_f64)
        .filter(|cost| *cost > 0.0);
    if fact.buckets.total() == 0
        && [
            fact.buckets.input,
            fact.buckets.cache_read,
            fact.buckets.cache_write5m,
            fact.buckets.output,
        ]
        .iter()
        .all(Option::is_none)
    {
        return None;
    }
    let _ = occurred_at; // completed is the provider's final request timestamp.
    Some(fact)
}

/// Parses the legacy JSON/JSONL OpenCode assistant-message shape when it is
/// discovered by the generic line scanner. SQLite is the authoritative format.
pub fn parse(value: &Value, offset: u64, file_id: &str, state: &mut ReaderState) -> Parsed {
    let mut parsed = Parsed::default();
    let data = value.get("data").unwrap_or(value);
    let Some(message) = text(data, &["id", "messageID", "message_id"]) else {
        return parsed;
    };
    let session = text(data, &["sessionID", "session_id"]).unwrap_or(&state.session_id);
    let occurred = data
        .pointer("/time/completed")
        .and_then(timestamp)
        .or_else(|| value.get("time").and_then(timestamp));
    let Some(occurred) = occurred else {
        return parsed;
    };
    if session.is_empty() {
        parsed
            .problems
            .push("opencode message has no session id".into());
        return parsed;
    }
    if let Some(fact) = parse_message(
        data,
        session,
        message,
        occurred,
        state.parent_session_id.clone(),
        state.cwd.clone().or_else(|| {
            data.pointer("/path/cwd")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }),
        format!("native:{file_id}@{offset}"),
    ) {
        parsed.covered_sessions.push(fact.native_session_id.clone());
        parsed.facts.push(fact);
    }
    parsed
}

fn temp_snapshot_path() -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    let base = std::env::temp_dir().join("threadterm-usage-opencode");
    fs::create_dir_all(&base)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let dir = base.join(format!("{}-{nonce}", std::process::id()));
    fs::create_dir(&dir)?;
    Ok((dir.clone(), dir.join("opencode-snapshot.db")))
}

fn source_fingerprint(source: &Path) -> Result<Vec<(String, u64, Option<SystemTime>)>> {
    let mut files = vec![source.to_path_buf()];
    let wal = source.with_file_name(format!(
        "{}-wal",
        source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("opencode.db")
    ));
    if wal.is_file() {
        files.push(wal);
    }
    files
        .into_iter()
        .map(|path| {
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(anyhow!("opencode source sidecar is a symlink"));
            }
            Ok((
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned(),
                metadata.len(),
                metadata.modified().ok(),
            ))
        })
        .collect()
}

fn copy_snapshot(source: &Path, snapshot: &Path) -> Result<u64> {
    // Never let SQLite open the provider copy: even a read-only connection can
    // create a shared-memory sidecar for a WAL database. Copying the database
    // and its WAL together preserves SQLite's overlay while confining any SHM
    // creation and recovery writes to the disposable snapshot directory.
    let snapshot_wal = snapshot.with_file_name("opencode-snapshot.db-wal");
    let mut bytes = 0;
    for _ in 0..2 {
        let before = source_fingerprint(source)?;
        bytes += fs::copy(source, snapshot)?;
        let source_wal = source.with_file_name(format!(
            "{}-wal",
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("opencode.db")
        ));
        let _ = fs::remove_file(&snapshot_wal);
        if source_wal.is_file() {
            bytes += fs::copy(&source_wal, &snapshot_wal)?;
        }
        if before == source_fingerprint(source)? {
            return Ok(bytes);
        }
    }
    Err(anyhow!("opencode source changed during snapshot read"))
}

/// Reads OpenCode from a temp copy of the database and its WAL overlay. SQLite
/// never opens the provider database, so it cannot create `-wal`, `-shm`, or
/// journal files beside the source.
pub fn read_database(
    path: &Path,
    emit: &mut dyn FnMut(Fact) -> Result<()>,
    cancelled: &AtomicBool,
) -> Result<DatabaseRead> {
    if !path.is_file() {
        return Err(anyhow!("OpenCode database is not a file"));
    }
    let (dir, snapshot) = temp_snapshot_path()?;
    let result = (|| -> Result<DatabaseRead> {
        let bytes_read = copy_snapshot(path, &snapshot)?;
        let destination = Connection::open(&snapshot)?;
        destination.pragma_update(None, "query_only", "ON")?;
        let mut statement = destination.prepare(
            "SELECT m.id, m.session_id, m.time_created, m.data, s.parent_id, s.directory, s.time_created
             FROM message m JOIN session s ON s.id=m.session_id ORDER BY m.time_created, m.id",
        )?;
        let mut rows = statement.query([])?;
        let mut summary = DatabaseRead {
            bytes_read,
            ..Default::default()
        };
        while let Some(row) = rows.next()? {
            if cancelled.load(Ordering::Relaxed) {
                break;
            }
            let message: String = row.get(0)?;
            let session: String = row.get(1)?;
            let created: i64 = row.get(2)?;
            let raw: String = row.get(3)?;
            let parent: Option<String> = row.get(4)?;
            let cwd: Option<String> = row.get(5)?;
            let session_created: Option<i64> = row.get(6)?;
            // Forks retain copied parent messages. Only messages produced after
            // the child session began belong to the child native ledger.
            if parent.is_some() && session_created.is_some_and(|start| created < start) {
                continue;
            }
            let data: Value = match serde_json::from_str(&raw) {
                Ok(data) => data,
                Err(_) => {
                    if summary.problems.len() < 64
                        && !summary
                            .problems
                            .iter()
                            .any(|problem| problem == "opencode message data is invalid JSON")
                    {
                        summary
                            .problems
                            .push("opencode message data is invalid JSON".into());
                    }
                    continue;
                }
            };
            let occurred = timestamp(&Value::from(created)).unwrap_or_default();
            if let Some(fact) = parse_message(
                &data,
                &session,
                &message,
                occurred,
                parent,
                cwd,
                format!("native:opencode.db@{message}"),
            ) {
                emit(fact)?;
                summary.facts += 1;
            }
        }
        Ok(summary)
    })();
    let _ = fs::remove_dir_all(dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use sha2::Digest;

    fn folder_listing(root: &Path) -> Vec<(String, u64, Option<std::time::SystemTime>, String)> {
        let mut listing: Vec<_> = fs::read_dir(root)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let metadata = entry.metadata().unwrap();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    metadata.len(),
                    metadata.modified().ok(),
                    hex::encode(sha2::Sha256::digest(fs::read(entry.path()).unwrap())),
                )
            })
            .collect();
        listing.sort();
        listing
    }

    #[test]
    fn readonly_snapshot_emits_exact_tokens_and_does_not_touch_source_folder() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("opencode.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        conn.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,time_created INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);").unwrap();
        conn.execute(
            "INSERT INTO session VALUES(?1,NULL,?2,1)",
            params!["s", "/repo"],
        )
        .unwrap();
        conn.execute("INSERT INTO message VALUES(?1,?2,?3,?4)", params!["m", "s", 2, r#"{"role":"assistant","model":{"id":"m"},"tokens":{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}},"cost":2.5,"time":{"completed":2}}"#]).unwrap();
        drop(conn);
        // A closed OpenCode writer need not leave a shared-memory file. The
        // reader must not manufacture one while opening the immutable source.
        assert!(!path.with_file_name("opencode.db-shm").exists());
        let before = folder_listing(root.path());
        let cancelled = AtomicBool::new(false);
        let mut facts = Vec::new();
        let result = read_database(
            &path,
            &mut |fact| {
                facts.push(fact);
                Ok(())
            },
            &cancelled,
        )
        .unwrap();
        let after = folder_listing(root.path());
        assert_eq!(before, after);
        assert_eq!(result.facts, 1);
        assert_eq!(facts[0].buckets.output, Some(5));
        assert_eq!(facts[0].buckets.reasoning, Some(3));
        assert_eq!(facts[0].reported_cost, Some(2.5));
    }
}
