//! Agent change review: working-tree checkpoints kept as Git objects in a private
//! object store next to the V3 database.
//!
//! A snapshot copies the repository index into a temporary file, stages the
//! working-tree differences into that copy with `GIT_OBJECT_DIRECTORY` pointing at
//! the private store (repository objects are only alternates), and records the
//! resulting tree. The user's refs, index, working tree and object database are
//! never written. Review is "changed since checkpoint", not authorship.
use crate::{
    db::Database,
    file_ops::{contained_parent_for, recycle},
    git_actions::complete,
    git_read::{
        plain_path, repo_paths, repo_prefix, run_git, text_of, validate_relative, MAX_TEXT_BYTES,
    },
    workspace_services::{fingerprint, root_for, scoped_path},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_SNAPSHOT_FILE: u64 = 5 * 1024 * 1024;
const MAX_SKIPPED: usize = 200;
const TURN_BUDGET: Duration = Duration::from_secs(10);
const REVIEW_BUDGET: Duration = Duration::from_secs(60);
const MAX_LABEL_CHARS: usize = 160;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS review_checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, turn_id TEXT, label TEXT, operation_id TEXT UNIQUE, store TEXT, tree TEXT, status TEXT NOT NULL, error TEXT, skipped TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS review_checkpoints_session ON review_checkpoints(session_id, created_at);";

pub fn initialize(db: &Database) -> Result<()> {
    db.transaction(|tx| Ok(tx.execute_batch(SCHEMA)?))
}

struct Snapshot {
    tree: String,
    skipped: Vec<String>,
}

/// Object-store context for one repository.
struct Store {
    top: PathBuf,
    prefix: String,
    objects: PathBuf,
    alternates: Vec<PathBuf>,
}

impl Store {
    fn open(db: &Database, root: &Path) -> Result<Self> {
        let prefix = repo_prefix(root)?;
        let repo = repo_paths(root)?;
        // Paths handed to Git must not carry the Windows verbatim prefix.
        let common = plain_path(&repo.common.canonicalize()?);
        let key = hex::encode(Sha256::digest(
            common.to_string_lossy().to_lowercase().as_bytes(),
        ));
        let base = db
            .path()
            .parent()
            .ok_or_else(|| anyhow!("review_unavailable"))?;
        let objects = plain_path(&base.join("review-objects").join(key));
        fs::create_dir_all(&objects)?;
        let repo_objects = common.join("objects");
        let mut alternates = vec![repo_objects.clone()];
        // Keep objects the repository borrows from its own alternates readable.
        if let Ok(list) = fs::read_to_string(repo_objects.join("info").join("alternates")) {
            for line in list
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
            {
                let path = Path::new(line);
                alternates.push(plain_path(&if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    repo_objects.join(path)
                }));
            }
        }
        Ok(Self {
            top: repo.top,
            prefix,
            objects,
            alternates,
        })
    }

    /// Environment that reads `extra` stores (older checkpoints) as alternates.
    fn env(
        &self,
        index: Option<&Path>,
        extra: &[PathBuf],
    ) -> Result<Vec<(&'static str, OsString)>> {
        let mut alternates: Vec<PathBuf> = extra
            .iter()
            .filter(|path| **path != self.objects)
            .cloned()
            .collect();
        alternates.extend(self.alternates.iter().cloned());
        let mut env = vec![
            (
                "GIT_OBJECT_DIRECTORY",
                self.objects.clone().into_os_string(),
            ),
            (
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                std::env::join_paths(alternates)?,
            ),
        ];
        if let Some(index) = index {
            env.push(("GIT_INDEX_FILE", index.as_os_str().to_owned()));
        }
        Ok(env)
    }

    fn run(
        &self,
        args: &[&str],
        env: &[(&'static str, OsString)],
        stdin: Option<&[u8]>,
        deadline: Instant,
    ) -> Result<Vec<u8>> {
        let borrowed: Vec<(&str, &OsStr)> = env
            .iter()
            .map(|(key, value)| (*key, value.as_os_str()))
            .collect();
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(500));
        run_git(&self.top, args, &borrowed, stdin, remaining)
    }

    fn snapshot(&self, deadline: Instant) -> Result<Snapshot> {
        let repo = repo_paths(&self.top)?;
        let index = self.objects.join(format!("index-{}", uuid::Uuid::new_v4()));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(index.clone());
        if repo.index.exists() {
            fs::copy(&repo.index, &index)?;
        }
        let env = self.env(Some(&index), &[])?;
        let status = self.run(
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--no-renames",
                "--ignore-submodules=all",
            ],
            &env,
            None,
            deadline,
        )?;
        let text = String::from_utf8_lossy(&status);
        let mut update = Vec::new();
        let mut skipped = Vec::new();
        for record in text.split('\0').filter(|record| record.len() > 3) {
            let (x, y) = (&record[..1], &record[1..2]);
            let path = &record[3..];
            if !(x == "?" || y != " " || x == "U" || y == "U") {
                continue;
            }
            let full = self.top.join(path);
            match fs::symlink_metadata(&full) {
                Ok(meta) if meta.is_dir() => continue,
                Ok(meta) if meta.is_file() && meta.len() > MAX_SNAPSHOT_FILE => {
                    if skipped.len() < MAX_SKIPPED {
                        if let Some(relative) = path.strip_prefix(&self.prefix) {
                            skipped.push(relative.to_owned());
                        }
                    }
                    continue;
                }
                _ => {}
            }
            update.extend_from_slice(path.as_bytes());
            update.push(0);
        }
        if !update.is_empty() {
            self.run(
                &["update-index", "-z", "--add", "--remove", "--stdin"],
                &env,
                Some(&update),
                deadline,
            )?;
        }
        let tree = String::from_utf8(self.run(&["write-tree"], &env, None, deadline)?)?
            .trim()
            .to_owned();
        if tree.is_empty() {
            return Err(anyhow!("snapshot_failed"));
        }
        Ok(Snapshot { tree, skipped })
    }

    fn blob(
        &self,
        tree: &str,
        path: &str,
        extra: &[PathBuf],
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>> {
        let env = self.env(None, extra)?;
        let spec = format!("{tree}:{}{}", self.prefix, path.replace('\\', "/"));
        if self
            .run(&["cat-file", "-e", &spec], &env, None, deadline)
            .is_err()
        {
            return Ok(None);
        }
        let size: usize =
            String::from_utf8(self.run(&["cat-file", "-s", &spec], &env, None, deadline)?)?
                .trim()
                .parse()
                .map_err(|_| anyhow!("git_failed"))?;
        if size > MAX_TEXT_BYTES {
            return Err(anyhow!("file_too_large"));
        }
        self.run(&["cat-file", "blob", &spec], &env, None, deadline)
            .map(Some)
    }

    /// Changed files between two trees, restricted to the registered root.
    fn changes(
        &self,
        from: &str,
        to: &str,
        extra: &[PathBuf],
        deadline: Instant,
    ) -> Result<Vec<Value>> {
        let env = self.env(None, extra)?;
        let output = self.run(
            &[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--name-status",
                from,
                to,
            ],
            &env,
            None,
            deadline,
        )?;
        let text = String::from_utf8_lossy(&output);
        let mut fields = text.split('\0').filter(|field| !field.is_empty());
        let mut files = Vec::new();
        while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
            let Some(relative) = path
                .strip_prefix(&self.prefix)
                .filter(|rest| !rest.is_empty())
            else {
                continue;
            };
            let status = match status.chars().next() {
                Some('A') => "A",
                Some('D') => "D",
                _ => "M",
            };
            files.push(json!({"path":relative,"status":status}));
        }
        Ok(files)
    }
}

struct Scope {
    root: PathBuf,
    project_id: String,
    worktree_path: Option<String>,
}

fn session_scope(db: &Database, session_id: &str) -> Result<Option<Scope>> {
    db.transaction(|tx| {
        tx.execute_batch(SCHEMA)?;
        let row: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT project_id, worktree_path FROM sessions WHERE id=?",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (project, worktree) = row.ok_or_else(|| anyhow!("session_not_found"))?;
        let Some(project) = project else {
            return Ok(None);
        };
        let root = root_for(tx, &project, worktree.as_deref())?;
        Ok(Some(Scope {
            root,
            project_id: project,
            worktree_path: worktree,
        }))
    })
}

struct Row {
    store: Option<String>,
    tree: Option<String>,
    status: String,
}

fn checkpoint_row(db: &Database, session_id: &str, id: &str) -> Result<Row> {
    db.transaction(|tx| {
        tx.query_row(
            "SELECT store, tree, status FROM review_checkpoints WHERE id=? AND session_id=?",
            params![id, session_id],
            |row| {
                Ok(Row {
                    store: row.get(0)?,
                    tree: row.get(1)?,
                    status: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| anyhow!("checkpoint_missing"))
    })
}

fn ready_tree(row: &Row) -> Result<(String, Vec<PathBuf>)> {
    match (&row.tree, row.status.as_str()) {
        (Some(tree), "ready") => Ok((tree.clone(), row.store.iter().map(PathBuf::from).collect())),
        _ => Err(anyhow!("checkpoint_failed")),
    }
}

fn checkpoint_json(db: &Database, id: &str) -> Result<Value> {
    db.transaction(|tx| {
        tx.query_row(
            "SELECT id, session_id, kind, turn_id, label, status, error, skipped, created_at FROM review_checkpoints WHERE id=?",
            [id],
            |row| Ok(row_json(row)),
        )
        .map_err(Into::into)
    })?
}

fn row_json(row: &rusqlite::Row<'_>) -> Result<Value> {
    let mut value = Map::new();
    value.insert("id".into(), json!(row.get::<_, String>(0)?));
    value.insert("sessionId".into(), json!(row.get::<_, String>(1)?));
    value.insert("kind".into(), json!(row.get::<_, String>(2)?));
    if let Some(turn) = row.get::<_, Option<String>>(3)? {
        value.insert("turnId".into(), json!(turn));
    }
    if let Some(label) = row.get::<_, Option<String>>(4)? {
        value.insert("label".into(), json!(label));
    }
    value.insert("status".into(), json!(row.get::<_, String>(5)?));
    if let Some(error) = row.get::<_, Option<String>>(6)? {
        value.insert("error".into(), json!(error));
    }
    let skipped: Value = serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or(json!([]));
    value.insert("skipped".into(), skipped);
    value.insert("createdAt".into(), json!(row.get::<_, String>(8)?));
    Ok(Value::Object(value))
}

/// Records a checkpoint for the session's registered root. Non-Git roots and
/// sessions without a project return `review_unavailable` without a row; other
/// snapshot failures are persisted as `failed` so the UI can report them.
fn capture(
    db: &Database,
    session_id: &str,
    kind: &str,
    operation_id: Option<&str>,
    label: Option<&str>,
    budget: Duration,
) -> Result<String> {
    if let Some(operation) = operation_id {
        let existing: Option<String> = db.transaction(|tx| {
            tx.execute_batch(SCHEMA)?;
            Ok(tx
                .query_row(
                    "SELECT id FROM review_checkpoints WHERE operation_id=?",
                    [operation],
                    |row| row.get(0),
                )
                .optional()?)
        })?;
        if let Some(id) = existing {
            return Ok(id);
        }
    }
    let scope = session_scope(db, session_id)?.ok_or_else(|| anyhow!("review_unavailable"))?;
    let store = Store::open(db, &scope.root).map_err(|error| {
        if error.to_string().contains("git_unavailable") {
            anyhow!("review_unavailable")
        } else {
            error
        }
    })?;
    let deadline = Instant::now() + budget;
    let (tree, status, error, skipped) = match store.snapshot(deadline) {
        Ok(snapshot) => (Some(snapshot.tree), "ready", None, snapshot.skipped),
        Err(error) => (None, "failed", Some(error.to_string()), Vec::new()),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let label = label.map(|value| {
        let single = value.split_whitespace().collect::<Vec<_>>().join(" ");
        single.chars().take(MAX_LABEL_CHARS).collect::<String>()
    });
    db.transaction(|tx| {
        tx.execute(
            "INSERT INTO review_checkpoints(id,session_id,kind,label,operation_id,store,tree,status,error,skipped,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                session_id,
                kind,
                label,
                operation_id,
                store.objects.to_string_lossy(),
                tree,
                status,
                error,
                serde_json::to_string(&skipped)?,
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

/// Chat hook: snapshot before a turn is sent. Never fails the send.
pub fn capture_before_turn(
    db: &Database,
    session_id: &str,
    operation_id: &str,
    text: &str,
) -> Option<String> {
    capture(
        db,
        session_id,
        "turn",
        Some(operation_id),
        Some(text),
        TURN_BUDGET,
    )
    .ok()
}

/// Attaches the provider turn id once `chat.send` has returned one.
pub fn attach_turn(db: &Database, checkpoint_id: &str, turn_id: Option<&str>) {
    let Some(turn_id) = turn_id else { return };
    let _ = db.transaction(|tx| {
        tx.execute(
            "UPDATE review_checkpoints SET turn_id=? WHERE id=? AND turn_id IS NULL",
            params![turn_id, checkpoint_id],
        )?;
        Ok(())
    });
}

/// Terminal hook: snapshot an agent terminal launch in the background.
pub fn capture_launch_in_background(db: std::sync::Arc<Database>, session_id: String) {
    std::thread::spawn(move || {
        let _ = capture(&db, &session_id, "launch", None, None, REVIEW_BUDGET);
    });
}

pub fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(
        method,
        "review.list" | "review.changes" | "review.diff" | "review.revert" | "review.checkpoint"
    ) {
        return Ok(None);
    }
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("invalid_request"))
    };
    let session_id = string("sessionId")?;
    let result = match method {
        "review.list" => list(db, session_id)?,
        "review.checkpoint" => {
            let kind = string("kind")?;
            if !matches!(kind, "manual" | "baseline") {
                return Err(anyhow!("invalid_request"));
            }
            let operation_id = string("operationId")?;
            let id = capture(
                db,
                session_id,
                kind,
                Some(operation_id),
                None,
                REVIEW_BUDGET,
            )?;
            let value = checkpoint_json(db, &id)?;
            db.transaction(|tx| complete(tx, operation_id, method, &value))?;
            value
        }
        "review.changes" | "review.diff" => {
            let scope =
                session_scope(db, session_id)?.ok_or_else(|| anyhow!("review_unavailable"))?;
            let store = Store::open(db, &scope.root)?;
            let deadline = Instant::now() + REVIEW_BUDGET;
            let (from, mut extra) = ready_tree(&checkpoint_row(db, session_id, string("from")?)?)?;
            let to = match object.get("to").and_then(Value::as_str) {
                Some(id) => {
                    let (tree, stores) = ready_tree(&checkpoint_row(db, session_id, id)?)?;
                    extra.extend(stores);
                    Some(tree)
                }
                None => None,
            };
            if method == "review.changes" {
                let target = match to {
                    Some(tree) => tree,
                    None => store.snapshot(deadline)?.tree,
                };
                json!({"files":store.changes(&from, &target, &extra, deadline)?})
            } else {
                let path = string("path")?;
                validate_relative(path)?;
                diff(
                    &scope.root,
                    &store,
                    &from,
                    to.as_deref(),
                    &extra,
                    path,
                    deadline,
                )?
            }
        }
        "review.revert" => revert(db, session_id, object)?,
        _ => unreachable!(),
    };
    Ok(Some(result))
}

fn list(db: &Database, session_id: &str) -> Result<Value> {
    let Some(scope) = session_scope(db, session_id)? else {
        return Ok(json!({"available":false,"reason":"session_has_no_project","checkpoints":[]}));
    };
    let mut value = Map::new();
    value.insert("projectId".into(), json!(scope.project_id));
    if let Some(worktree) = &scope.worktree_path {
        value.insert("worktreePath".into(), json!(worktree));
    }
    if repo_prefix(&scope.root).is_err() {
        value.insert("available".into(), json!(false));
        value.insert("reason".into(), json!("git_unavailable"));
        value.insert("checkpoints".into(), json!([]));
        return Ok(Value::Object(value));
    }
    let checkpoints = db.transaction(|tx| {
        let mut statement = tx.prepare(
            "SELECT id, session_id, kind, turn_id, label, status, error, skipped, created_at FROM review_checkpoints WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200",
        )?;
        let rows = statement.query_map([session_id], |row| Ok(row_json(row)))?;
        let mut values = Vec::new();
        for row in rows {
            values.push(row??);
        }
        Ok(values)
    })?;
    value.insert("available".into(), json!(true));
    value.insert("checkpoints".into(), json!(checkpoints));
    Ok(Value::Object(value))
}

fn current_file(root: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    let lexical = scoped_path(root, path, false)?;
    match fs::symlink_metadata(&lexical) {
        Ok(meta) if meta.is_file() => {
            let target = scoped_path(root, path, true)?;
            if fs::metadata(&target)?.len() as usize > MAX_TEXT_BYTES {
                return Err(anyhow!("file_too_large"));
            }
            Ok(Some(fs::read(target)?))
        }
        Ok(_) => Err(anyhow!("file_reference_not_file")),
        Err(_) => Ok(None),
    }
}

fn diff(
    root: &Path,
    store: &Store,
    from: &str,
    to: Option<&str>,
    extra: &[PathBuf],
    path: &str,
    deadline: Instant,
) -> Result<Value> {
    let old = store.blob(from, path, extra, deadline)?;
    let (new, current) = match to {
        Some(tree) => (store.blob(tree, path, extra, deadline)?, None),
        None => {
            let current = current_file(root, path)?;
            (current.clone(), Some(current))
        }
    };
    let mut value = Map::new();
    value.insert("path".into(), json!(path));
    value.insert("exists".into(), json!(new.is_some()));
    if let Some(Some(bytes)) = &current {
        value.insert("fingerprint".into(), json!(fingerprint(bytes)));
    }
    match (
        text_of(old.as_deref().unwrap_or_default()),
        text_of(new.as_deref().unwrap_or_default()),
    ) {
        (Some(old), Some(new)) => {
            value.insert("oldText".into(), json!(old));
            value.insert("newText".into(), json!(new));
            value.insert("binary".into(), json!(false));
        }
        _ => {
            value.insert("oldText".into(), json!(""));
            value.insert("newText".into(), json!(""));
            value.insert("binary".into(), json!(true));
        }
    }
    Ok(Value::Object(value))
}

fn revert(db: &Database, session_id: &str, object: &Map<String, Value>) -> Result<Value> {
    let operation_id = object
        .get("operationId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))?;
    if let Some(result) = db.operation(operation_id)? {
        return Ok(result);
    }
    let checkpoint_id = object
        .get("checkpointId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let paths: Vec<&str> = object
        .get("paths")
        .and_then(Value::as_array)
        .filter(|paths| !paths.is_empty() && paths.len() <= 500)
        .ok_or_else(|| anyhow!("invalid_paths"))?
        .iter()
        .map(|path| path.as_str().ok_or_else(|| anyhow!("invalid_path")))
        .collect::<Result<_>>()?;
    let expected = object
        .get("expectedFingerprints")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
    let scope = session_scope(db, session_id)?.ok_or_else(|| anyhow!("review_unavailable"))?;
    let store = Store::open(db, &scope.root)?;
    let (tree, extra) = ready_tree(&checkpoint_row(db, session_id, checkpoint_id)?)?;
    let deadline = Instant::now() + REVIEW_BUDGET;
    // Preflight every file before changing any of them.
    let mut plan = Vec::new();
    for path in &paths {
        validate_relative(path)?;
        let current = current_file(&scope.root, path)?;
        let wanted = match expected.get(*path) {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            _ => return Err(anyhow!("invalid_fingerprints")),
        };
        if current.as_deref().map(fingerprint).as_deref() != wanted {
            return Err(anyhow!("file_conflict"));
        }
        plan.push((
            *path,
            store.blob(&tree, path, &extra, deadline)?,
            current.is_some(),
        ));
    }
    if !db.claim_external_operation(operation_id)? {
        return Err(anyhow!("operation_outcome_unknown"));
    }
    let mut restored = Vec::new();
    let mut recycled = Vec::new();
    for (path, content, exists) in plan {
        match content {
            Some(bytes) => {
                let target = if exists {
                    scoped_path(&scope.root, path, true)?
                } else {
                    contained_parent_for(&scope.root, path)?
                };
                let temporary =
                    target.with_extension(format!("threadterm-review-{}", std::process::id()));
                fs::write(&temporary, &bytes)?;
                fs::rename(&temporary, &target).inspect_err(|_| {
                    let _ = fs::remove_file(&temporary);
                })?;
                restored.push(path.to_owned());
            }
            None if exists => {
                recycle(&scoped_path(&scope.root, path, false)?)?;
                recycled.push(path.to_owned());
            }
            None => {}
        }
    }
    let result = json!({"restored":restored,"recycled":recycled});
    db.transaction(|tx| complete(tx, operation_id, "review.revert", &result))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_services::git;

    fn setup() -> (tempfile::TempDir, Database, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo 仓库");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        git(&repo, &["config", "user.email", "qa@example.test"]).unwrap();
        git(&repo, &["config", "user.name", "QA"]).unwrap();
        git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        fs::write(repo.join("gone.txt"), "bye\n").unwrap();
        fs::write(repo.join(".gitignore"), "ignored/\n").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-qm", "init"]).unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let db = Database::open(&data.join("db.sqlite")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(repo.to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        let session = db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES('s1',?,'t','codex','chat','idle','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                    [&project.id],
                )?;
                Ok("s1".to_owned())
            })
            .unwrap();
        (temp, db, repo, session)
    }

    fn call(db: &Database, method: &str, params: Value) -> Result<Value> {
        dispatch(db, method, &params).map(Option::unwrap)
    }

    #[test]
    fn checkpoints_capture_review_and_revert_without_touching_the_repository() {
        let (temp, db, repo, session) = setup();
        // Uncommitted state before the turn is part of the baseline.
        fs::write(repo.join("a.txt"), "one\nlocal\n").unwrap();
        let index_before = fs::read(repo.join(".git").join("index")).unwrap();
        let refs_before = git(&repo, &["for-each-ref"]).unwrap();
        let objects_before = git(&repo, &["count-objects", "-v"]).unwrap();

        let checkpoint = capture_before_turn(&db, &session, "send-1", "Fix   the\nbug").unwrap();
        attach_turn(&db, &checkpoint, Some("turn-1"));
        assert_eq!(
            capture_before_turn(&db, &session, "send-1", "again").unwrap(),
            checkpoint
        );

        // The "agent" edits, adds (including an ignored file) and deletes.
        fs::write(repo.join("a.txt"), "one\nlocal\nagent\n").unwrap();
        fs::create_dir(repo.join("src")).unwrap();
        fs::write(repo.join("src").join("新.ts"), "new\n").unwrap();
        fs::create_dir(repo.join("ignored")).unwrap();
        fs::write(repo.join("ignored").join("x"), "x").unwrap();
        fs::remove_file(repo.join("gone.txt")).unwrap();

        let listed = call(&db, "review.list", json!({"sessionId":session})).unwrap();
        assert_eq!(listed["available"], true);
        assert_eq!(listed["checkpoints"][0]["turnId"], "turn-1");
        assert_eq!(listed["checkpoints"][0]["label"], "Fix the bug");
        assert_eq!(
            listed["checkpoints"][0]["status"], "ready",
            "{}",
            listed["checkpoints"][0]["error"]
        );

        let changes = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":checkpoint}),
        )
        .unwrap();
        let mut files: Vec<(String, String)> = changes["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                (
                    file["path"].as_str().unwrap().to_owned(),
                    file["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        files.sort();
        assert_eq!(
            files,
            vec![
                ("a.txt".to_owned(), "M".to_owned()),
                ("gone.txt".to_owned(), "D".to_owned()),
                ("src/新.ts".to_owned(), "A".to_owned()),
            ]
        );

        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"a.txt"}),
        )
        .unwrap();
        assert_eq!(diff["oldText"], "one\nlocal\n");
        assert_eq!(diff["newText"], "one\nlocal\nagent\n");
        assert_eq!(diff["exists"], true);
        let current = diff["fingerprint"].as_str().unwrap().to_owned();

        // Stale fingerprints are refused before anything changes.
        assert!(call(&db, "review.revert", json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt"],"expectedFingerprints":{"a.txt":"stale"},"operationId":"r0"})).unwrap_err().to_string().contains("file_conflict"));
        let reverted = call(
            &db,
            "review.revert",
            json!({"sessionId":session,"checkpointId":checkpoint,"paths":["a.txt","gone.txt"],"expectedFingerprints":{"a.txt":current,"gone.txt":null},"operationId":"r1"}),
        )
        .unwrap();
        assert_eq!(reverted["restored"], json!(["a.txt", "gone.txt"]));
        assert_eq!(
            fs::read_to_string(repo.join("a.txt")).unwrap(),
            "one\nlocal\n"
        );
        assert_eq!(fs::read_to_string(repo.join("gone.txt")).unwrap(), "bye\n");

        // The repository itself was never written by checkpointing or review.
        assert_eq!(
            fs::read(repo.join(".git").join("index")).unwrap(),
            index_before
        );
        assert_eq!(git(&repo, &["for-each-ref"]).unwrap(), refs_before);
        assert_eq!(
            git(&repo, &["count-objects", "-v"]).unwrap(),
            objects_before
        );
        assert!(temp.path().join("data").join("review-objects").is_dir());

        let manual = call(
            &db,
            "review.checkpoint",
            json!({"sessionId":session,"kind":"baseline","operationId":"cp"}),
        )
        .unwrap();
        assert_eq!(manual["kind"], "baseline");
        let since = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":manual["id"]}),
        )
        .unwrap();
        assert_eq!(since["files"], json!([]));
        let between = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":checkpoint,"to":manual["id"]}),
        )
        .unwrap();
        assert_eq!(between["files"], json!([{"path":"src/新.ts","status":"A"}]));
    }

    #[test]
    fn non_git_roots_report_unavailable_without_rows() {
        let temp = tempfile::tempdir().unwrap();
        let plain = temp.path().join("plain");
        fs::create_dir(&plain).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        let project = db
            .add_project(plain.to_str().unwrap(), Some("p"), "op")
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO sessions(id,project_id,title,provider,mode,status,created_at,updated_at) VALUES('s2',?,'t','shell','terminal','idle','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [&project.id],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(capture_before_turn(&db, "s2", "op-1", "x").is_none());
        let listed = call(&db, "review.list", json!({"sessionId":"s2"})).unwrap();
        assert_eq!(listed["available"], false);
        assert_eq!(listed["reason"], "git_unavailable");
    }

    #[test]
    fn subdirectory_roots_only_review_their_own_files() {
        let (_temp, db, repo, session) = setup();
        fs::create_dir(repo.join("pkg")).unwrap();
        fs::write(repo.join("pkg").join("in.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(&repo, &["commit", "-qm", "pkg"]).unwrap();
        let project = db
            .add_project(
                repo.join("pkg").to_str().unwrap(),
                Some("pkg"),
                "project-pkg",
            )
            .unwrap();
        db.transaction(|tx| {
            tx.execute(
                "UPDATE sessions SET project_id=? WHERE id=?",
                params![project.id, session],
            )?;
            Ok(())
        })
        .unwrap();
        let checkpoint = capture_before_turn(&db, &session, "send-sub", "x").unwrap();
        fs::write(repo.join("pkg").join("in.txt"), "b\n").unwrap();
        fs::write(repo.join("a.txt"), "outside\n").unwrap();
        let changes = call(
            &db,
            "review.changes",
            json!({"sessionId":session,"from":checkpoint}),
        )
        .unwrap();
        assert_eq!(changes["files"], json!([{"path":"in.txt","status":"M"}]));
        let diff = call(
            &db,
            "review.diff",
            json!({"sessionId":session,"from":checkpoint,"path":"in.txt"}),
        )
        .unwrap();
        assert_eq!(diff["oldText"], "a\n");
    }
}
