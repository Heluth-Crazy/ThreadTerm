//! Atomic selected-file commits built from a private index.
//!
//! The wire contract remains owned by `protocol/index.ts`; this module accepts
//! and returns JSON at its public boundary and keeps its Rust request types
//! private. The user's index is locked for the operation but never rewritten.

use crate::{db::Database, git_read::validate_relative, workspace_services::root_for};
use anyhow::{anyhow, Context, Result};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

pub(crate) const METHOD: &str = "git.commit.selected";
pub(crate) const ERROR_CODES: &[&str] = &[
    "git_selected_commit_unsupported",
    "git_selected_commit_stale",
    "git_selected_commit_conflict_state",
    "git_selected_commit_index_locked",
    "git_selected_commit_invalid_selection",
    "git_selected_commit_cross_root_rename",
    "git_selected_commit_invalid_message",
    "git_selected_commit_hook_failed",
    "git_selected_commit_hook_changed_index",
    "git_selected_commit_signing_failed",
    "git_selected_commit_ref_conflict",
    "git_selected_commit_cleanup_failed",
    "operation_outcome_unknown",
];

const MAX_PATHS: usize = 500;
const MAX_PATH_BYTES: usize = 4096;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETAINED_RESULT_BYTES: usize = 512 * 1024;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(test))]
const HOOK_TIMEOUT: Duration = Duration::from_secs(300);
#[cfg(test)]
const HOOK_TIMEOUT: Duration = Duration::from_secs(1);
const STATUS_RETRIES: usize = 3;
const CAPABILITY_CACHE_ENTRIES: usize = 8;

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    project_id: String,
    worktree_path: Option<String>,
    operation_id: String,
    message: String,
    selected: Vec<SelectedRow>,
    expected_head: Head,
    expected_index_fingerprint: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Head {
    Branch { oid: String, target: String },
    Detached { oid: String },
    Unborn { target: String },
}

impl Head {
    fn oid(&self) -> Option<&str> {
        match self {
            Self::Branch { oid, .. } | Self::Detached { oid } => Some(oid),
            Self::Unborn { .. } => None,
        }
    }

    fn target(&self) -> Option<&str> {
        match self {
            Self::Branch { target, .. } | Self::Unborn { target } => Some(target),
            Self::Detached { .. } => None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectedRow {
    path: String,
    index_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
}

#[derive(Debug, Clone)]
struct IndexEntry {
    mode: String,
    oid: String,
}

struct IndexState {
    fingerprint: String,
    entries: BTreeMap<String, IndexEntry>,
    unmerged: bool,
}

#[derive(Debug, Clone)]
struct StagedRow {
    wire: SelectedRow,
    repo_path: String,
    repo_original_path: Option<String>,
    original_outside_root: bool,
}

#[derive(Debug, Clone)]
struct Capabilities {
    version: String,
    supported: bool,
    unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExecutableCacheKey {
    path: PathBuf,
    length: u64,
    modified_nanos: u128,
    fingerprint: [u8; 32],
}

#[derive(Debug, Clone)]
struct GitExecutable {
    path: PathBuf,
    cache_key: ExecutableCacheKey,
}

/// Pins executable selection for all Git calls that make up one status read.
/// Construct a new reader for each status request so an in-place Git upgrade
/// is observed on the next request.
pub(crate) struct GitStatusReader {
    root: PathBuf,
    executable: GitExecutable,
}

struct GitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Handles only `git.commit.selected`; all other methods are left to the next
/// service dispatcher.
pub(crate) fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if method != METHOD {
        return Ok(None);
    }
    let request: Request = serde_json::from_value(params.clone())
        .map_err(|_| anyhow!("git_selected_commit_invalid_selection"))?;
    validate_request(&request)?;

    // The service currently binds every operation before module routing. Keep
    // this idempotent bind so direct module tests and future callers retain the
    // same exact-request replay fence.
    db.bind_operation(&request.operation_id, METHOD, params)?;
    if let Some(result) = db.operation(&request.operation_id)? {
        return Ok(Some(result));
    }
    if external_operation_claimed(db, &request.operation_id)? {
        return Err(anyhow!("operation_outcome_unknown"));
    }

    let root =
        db.transaction(|tx| root_for(tx, &request.project_id, request.worktree_path.as_deref()))?;
    let git = GitExecutable::resolve()?;
    let capabilities = capabilities(&root, &git);
    if !capabilities.supported {
        return Err(anyhow!("git_selected_commit_unsupported"));
    }
    reject_in_progress_repository(&root, &git)?;

    let index_path = absolute_git_path(&root, "index", &git)?;
    let mut real_index_lock = GitLock::acquire(&index_path, "git_selected_commit_index_locked")?;
    // Everything that depends on mutable Git state is repeated with the real
    // index lock held. HEAD itself is guarded again by the final ref transaction.
    reject_in_progress_repository(&root, &git)?;
    let current_head = read_head(&root, &git)?;
    let current_index = read_index(&root, &git)?;
    if current_head != request.expected_head
        || current_index.fingerprint != request.expected_index_fingerprint
    {
        return Err(anyhow!("git_selected_commit_stale"));
    }
    if current_index.unmerged || has_intent_to_add(&root, &git)? {
        return Err(anyhow!("git_selected_commit_conflict_state"));
    }

    let prefix = repo_prefix(&root, &git)?;
    let staged = read_staged_rows(&root, &prefix, &git)?;
    let selected = validate_selected_rows(&request.selected, &staged)?;
    let (retained_staged_paths, retained_staged_paths_truncated) =
        retained_paths(&staged, &selected);

    let mut artifacts =
        PrivateArtifacts::new(index_path.parent().ok_or_else(|| anyhow!("git_failed"))?)?;
    let private_env = vec![(
        OsString::from("GIT_INDEX_FILE"),
        artifacts.index.as_os_str().to_owned(),
    )];
    build_private_index(
        &root,
        &request.expected_head,
        &current_index.entries,
        &selected,
        &artifacts.index,
        &private_env,
        &git,
    )?;
    let tree = write_tree(&root, &private_env, &git)?;

    // Creating objects in the object database is harmless and recoverable.
    // Claim immediately before the first hook, which can have arbitrary
    // external side effects.
    if !db.claim_external_operation(&request.operation_id)? {
        return Err(anyhow!("operation_outcome_unknown"));
    }

    run_hook(&root, "pre-commit", &[], &private_env, &git)?;
    require_private_tree(&root, &private_env, &tree, &git)?;

    write_message(&artifacts.message, request.message.as_bytes())?;
    let message_arg = path_text(&artifacts.message)?;
    run_hook(
        &root,
        "prepare-commit-msg",
        &[message_arg.clone(), "message".to_owned()],
        &private_env,
        &git,
    )?;
    require_private_tree(&root, &private_env, &tree, &git)?;
    cleanup_message(&root, &artifacts.message, &git)?;
    validate_message_file(&artifacts.message)?;
    run_hook(
        &root,
        "commit-msg",
        std::slice::from_ref(&message_arg),
        &private_env,
        &git,
    )?;
    require_private_tree(&root, &private_env, &tree, &git)?;
    validate_message_file(&artifacts.message)?;

    // A hook that deliberately bypasses GIT_INDEX_FILE should have been
    // stopped by index.lock. Detect a forced replacement before publication.
    if read_index(&root, &git)?.fingerprint != request.expected_index_fingerprint {
        return Err(anyhow!("git_selected_commit_stale"));
    }
    if read_head(&root, &git)? != request.expected_head {
        return Err(anyhow!("git_selected_commit_ref_conflict"));
    }

    let signed = config_bool(&root, "commit.gpgSign", &git)?;
    let commit = create_commit(
        &root,
        &tree,
        request.expected_head.oid(),
        &artifacts.message,
        signed,
        &private_env,
        &git,
    )?;
    // Signing can run an external helper for a long time. Revalidate the
    // user's index and our ownership of its lock at the final publication
    // boundary, after every hook and helper has completed.
    if read_index(&root, &git)?.fingerprint != request.expected_index_fingerprint
        || !real_index_lock.owns_path()
    {
        return Err(anyhow!("git_selected_commit_stale"));
    }
    publish_ref(
        &root,
        &request.expected_head,
        &commit,
        &artifacts.message,
        &private_env,
        &git,
    )?;

    let post_commit_error = run_hook(&root, "post-commit", &[], &private_env, &git)
        .err()
        .map(|error| error.to_string());
    let committed_paths = request
        .selected
        .iter()
        .map(|row| row.path.clone())
        .collect::<Vec<_>>();
    let mut fields = Map::new();
    fields.insert("commit".into(), json!(commit));
    fields.insert("tree".into(), json!(tree));
    fields.insert("parent".into(), json!(request.expected_head.oid()));
    fields.insert("refTarget".into(), json!(request.expected_head.target()));
    fields.insert("committedPaths".into(), json!(committed_paths));
    fields.insert("retainedStagedPaths".into(), json!(retained_staged_paths));
    if retained_staged_paths_truncated {
        fields.insert("retainedStagedPathsTruncated".into(), json!(true));
    }
    if let Some(error) = post_commit_error {
        fields.insert("postCommitError".into(), json!(error));
    }
    // All managed children have been reaped before this point. Remove the
    // private material and release the user's index lock before recording a
    // receipt. Attempt both cleanups even if the first one fails. Publication
    // is already known to have succeeded, so surface cleanup as a committed
    // warning and persist it for exact replay rather than returning an error
    // that could be mistaken for an uncommitted operation.
    let artifacts_cleaned = artifacts.cleanup().is_ok();
    let index_unlocked = real_index_lock.cleanup().is_ok();
    if !artifacts_cleaned || !index_unlocked {
        fields.insert(
            "cleanupError".into(),
            json!("git_selected_commit_cleanup_failed"),
        );
    }
    let result = Value::Object(fields);

    // Publication already happened. A receipt failure is an uncertain outcome,
    // never an invitation to repeat hooks or create a second commit.
    if db
        .transaction(|tx| crate::git_actions::complete(tx, &request.operation_id, METHOD, &result))
        .is_err()
    {
        return Err(anyhow!("operation_outcome_unknown"));
    }
    Ok(Some(result))
}

impl GitStatusReader {
    pub(crate) fn new(root: &Path) -> Result<Self> {
        Ok(Self {
            root: root.to_owned(),
            executable: GitExecutable::resolve()?,
        })
    }

    /// Read-only metadata added to `GitStatus` by the service integration.
    pub(crate) fn snapshot(&self) -> Result<Value> {
        let identity = self.identity()?;
        let capabilities = capabilities(&self.root, &self.executable);
        let mut fields = identity
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("git_failed"))?;
        fields.insert("supported".into(), json!(capabilities.supported));
        fields.insert("gitVersion".into(), json!(capabilities.version));
        if let Some(reason) = capabilities.unsupported_reason {
            fields.insert("unsupportedReason".into(), json!(reason));
        }
        Ok(Value::Object(fields))
    }

    /// Cheap identity reread used to fence a multi-command status collection.
    /// Capability probing is intentionally excluded.
    pub(crate) fn identity(&self) -> Result<Value> {
        let head = stable_head(&self.root, &self.executable)?;
        let index = read_index(&self.root, &self.executable)?;
        Ok(json!({"head":head,"indexFingerprint":index.fingerprint}))
    }

    /// Runs a read-only Git command with the executable pinned by this reader.
    pub(crate) fn read(&self, args: &[&str]) -> Result<String> {
        read_git_with(&self.root, args, &self.executable)
    }
}

fn read_git_with(root: &Path, args: &[&str], git: &GitExecutable) -> Result<String> {
    let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let output = run_direct_git(root, &args, &[], None, LOCAL_TIMEOUT, git)?;
    checked_text(output)
}

fn validate_request(request: &Request) -> Result<()> {
    if request.project_id.is_empty()
        || request.operation_id.is_empty()
        || request
            .message
            .len()
            .saturating_add(usize::from(!request.message.ends_with('\n')))
            > MAX_MESSAGE_BYTES
        || request.message.as_bytes().contains(&0)
        || request
            .message
            .as_bytes()
            .iter()
            .all(u8::is_ascii_whitespace)
        || request.selected.is_empty()
        || request.selected.len() > MAX_PATHS
        || request.expected_index_fingerprint.len() != 64
        || !request
            .expected_index_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(anyhow!("git_selected_commit_invalid_selection"));
    }
    validate_head(&request.expected_head)?;
    let mut paths = HashSet::new();
    for row in &request.selected {
        if row.path.len() > MAX_PATH_BYTES
            || row
                .original_path
                .as_ref()
                .is_some_and(|path| path.len() > MAX_PATH_BYTES)
        {
            return Err(anyhow!("git_selected_commit_invalid_selection"));
        }
        validate_relative(&row.path)
            .map_err(|_| anyhow!("git_selected_commit_invalid_selection"))?;
        if let Some(original) = row.original_path.as_deref() {
            validate_relative(original)
                .map_err(|_| anyhow!("git_selected_commit_invalid_selection"))?;
        }
        if !matches!(row.index_status.as_str(), "A" | "C" | "D" | "M" | "R" | "T")
            || !paths.insert(row.path.as_str())
        {
            return Err(anyhow!("git_selected_commit_invalid_selection"));
        }
    }
    Ok(())
}

fn validate_head(head: &Head) -> Result<()> {
    match head {
        Head::Branch { oid, target } => {
            validate_oid(oid)?;
            validate_head_target(target)
        }
        Head::Detached { oid } => validate_oid(oid),
        Head::Unborn { target } => validate_head_target(target),
    }
}

fn validate_oid(oid: &str) -> Result<()> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(anyhow!("git_selected_commit_invalid_selection"))
    }
}

fn validate_head_target(target: &str) -> Result<()> {
    if target.starts_with("refs/heads/")
        && !target.contains(['\r', '\n', '\0', ' '])
        && target.len() <= 1024
    {
        Ok(())
    } else {
        Err(anyhow!("git_selected_commit_invalid_selection"))
    }
}

fn external_operation_claimed(db: &Database, operation_id: &str) -> Result<bool> {
    db.transaction(|tx| {
        Ok(tx
            .query_row(
                "SELECT 1 FROM external_operations WHERE id=?",
                [operation_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some())
    })
}

fn stable_head(root: &Path, git: &GitExecutable) -> Result<Head> {
    for _ in 0..STATUS_RETRIES {
        let before = read_head(root, git)?;
        let after = read_head(root, git)?;
        if before == after {
            return Ok(after);
        }
    }
    Err(anyhow!("git_status_changed"))
}

fn read_head(root: &Path, git: &GitExecutable) -> Result<Head> {
    let symbolic = run_direct_git(
        root,
        &[
            "symbolic-ref".into(),
            "--quiet".into(),
            "--no-recurse".into(),
            "HEAD".into(),
        ],
        &[],
        None,
        LOCAL_TIMEOUT,
        git,
    )?;
    if symbolic.status.success() {
        let target = output_text(&symbolic.stdout)?;
        let target = target.trim().to_owned();
        validate_head_target(&target).map_err(|_| anyhow!("git_failed"))?;
        let oid = run_direct_git(
            root,
            &[
                "rev-parse".into(),
                "--verify".into(),
                "--quiet".into(),
                "HEAD^{commit}".into(),
            ],
            &[],
            None,
            LOCAL_TIMEOUT,
            git,
        )?;
        if oid.status.success() {
            let oid = output_text(&oid.stdout)?.trim().to_owned();
            validate_oid(&oid).map_err(|_| anyhow!("git_failed"))?;
            Ok(Head::Branch { oid, target })
        } else {
            Ok(Head::Unborn { target })
        }
    } else {
        let oid = run_direct_git(
            root,
            &[
                "rev-parse".into(),
                "--verify".into(),
                "--quiet".into(),
                "HEAD^{commit}".into(),
            ],
            &[],
            None,
            LOCAL_TIMEOUT,
            git,
        )?;
        if !oid.status.success() {
            return Err(anyhow!("git_unavailable"));
        }
        let oid = output_text(&oid.stdout)?.trim().to_owned();
        validate_oid(&oid).map_err(|_| anyhow!("git_failed"))?;
        Ok(Head::Detached { oid })
    }
}

fn read_index(root: &Path, git: &GitExecutable) -> Result<IndexState> {
    let output = checked_bytes(run_direct_git(
        root,
        &[
            "ls-files".into(),
            "--full-name".into(),
            "--stage".into(),
            "-z".into(),
            "--".into(),
            ":/".into(),
        ],
        &[],
        None,
        LOCAL_TIMEOUT,
        git,
    )?)?;
    let fingerprint = hex::encode(Sha256::digest(&output));
    let mut entries = BTreeMap::new();
    let mut unmerged = false;
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| anyhow!("git_failed"))?;
        let meta = std::str::from_utf8(&record[..tab]).map_err(|_| anyhow!("git_failed"))?;
        let path = std::str::from_utf8(&record[tab + 1..])
            .map_err(|_| anyhow!("git_failed"))?
            .to_owned();
        let mut fields = meta.split_whitespace();
        let mode = fields.next().ok_or_else(|| anyhow!("git_failed"))?;
        let oid = fields.next().ok_or_else(|| anyhow!("git_failed"))?;
        let stage = fields
            .next()
            .ok_or_else(|| anyhow!("git_failed"))?
            .parse::<u8>()
            .map_err(|_| anyhow!("git_failed"))?;
        if fields.next().is_some() {
            return Err(anyhow!("git_failed"));
        }
        validate_oid(oid).map_err(|_| anyhow!("git_failed"))?;
        if stage == 0 {
            entries.insert(
                path,
                IndexEntry {
                    mode: mode.to_owned(),
                    oid: oid.to_owned(),
                },
            );
        } else {
            unmerged = true;
        }
    }
    Ok(IndexState {
        fingerprint,
        entries,
        unmerged,
    })
}

fn has_intent_to_add(root: &Path, git: &GitExecutable) -> Result<bool> {
    let debug = read_git_with(
        root,
        &["ls-files", "--full-name", "--debug", "--", ":/"],
        git,
    )?;
    for line in debug.lines() {
        let Some((_, flags)) = line.split_once("flags: ") else {
            continue;
        };
        let flags = u64::from_str_radix(flags.trim(), 16).map_err(|_| anyhow!("git_failed"))?;
        if flags & 0x2000_0000 != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn repo_prefix(root: &Path, git: &GitExecutable) -> Result<String> {
    let inside = read_git_with(root, &["rev-parse", "--is-inside-work-tree"], git)?;
    if inside.trim() != "true" {
        return Err(anyhow!("git_unavailable"));
    }
    Ok(read_git_with(root, &["rev-parse", "--show-prefix"], git)?
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}

fn read_staged_rows(
    root: &Path,
    prefix: &str,
    git: &GitExecutable,
) -> Result<BTreeMap<String, StagedRow>> {
    let bytes = checked_bytes(run_direct_git(
        root,
        &[
            "-c".into(),
            "core.fsmonitor=false".into(),
            "status".into(),
            "--porcelain=v1".into(),
            "-z".into(),
            "--untracked-files=no".into(),
            // Avoid scanning submodule worktrees while retaining staged
            // gitlink additions and changes in the superproject index.
            "--ignore-submodules=dirty".into(),
        ],
        &[],
        None,
        LOCAL_TIMEOUT,
        git,
    )?)?;
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut rows = BTreeMap::new();
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err(anyhow!("git_failed"));
        }
        let index_status = char::from(record[0]).to_string();
        let worktree_status = char::from(record[1]).to_string();
        let repo_path = std::str::from_utf8(&record[3..])
            .map_err(|_| anyhow!("git_failed"))?
            .to_owned();
        let has_original = matches!(index_status.as_str(), "R" | "C")
            || matches!(worktree_status.as_str(), "R" | "C");
        let repo_original_path = if has_original {
            Some(
                std::str::from_utf8(records.next().ok_or_else(|| anyhow!("git_failed"))?)
                    .map_err(|_| anyhow!("git_failed"))?
                    .to_owned(),
            )
        } else {
            None
        };
        if !matches!(index_status.as_str(), "A" | "C" | "D" | "M" | "R" | "T") {
            continue;
        }
        let Some(path) = root_relative(prefix, &repo_path) else {
            continue;
        };
        let original = repo_original_path
            .as_deref()
            .and_then(|value| root_relative(prefix, value));
        let original_outside_root = repo_original_path.is_some() && original.is_none();
        let wire = SelectedRow {
            path: path.to_owned(),
            index_status,
            original_path: original.map(str::to_owned),
        };
        rows.insert(
            wire.path.clone(),
            StagedRow {
                wire,
                repo_path,
                repo_original_path,
                original_outside_root,
            },
        );
    }
    Ok(rows)
}

fn root_relative<'a>(prefix: &str, repo_path: &'a str) -> Option<&'a str> {
    repo_path
        .strip_prefix(prefix)
        .filter(|path| !path.is_empty())
}

fn validate_selected_rows(
    requested: &[SelectedRow],
    staged: &BTreeMap<String, StagedRow>,
) -> Result<BTreeMap<String, StagedRow>> {
    let mut selected = BTreeMap::new();
    for row in requested {
        let current = staged
            .get(&row.path)
            .filter(|current| current.wire == *row)
            .ok_or_else(|| anyhow!("git_selected_commit_stale"))?;
        if current.wire.index_status == "R" && current.original_outside_root {
            return Err(anyhow!("git_selected_commit_cross_root_rename"));
        }
        selected.insert(row.path.clone(), current.clone());
    }
    Ok(selected)
}

fn retained_paths(
    staged: &BTreeMap<String, StagedRow>,
    selected: &BTreeMap<String, StagedRow>,
) -> (Vec<String>, bool) {
    let mut paths = Vec::new();
    let mut encoded_bytes = 2usize; // JSON array brackets.
    let mut truncated = false;
    for path in staged.keys().filter(|path| !selected.contains_key(*path)) {
        // Four bytes covers the quotes, comma, and common one-byte escaping
        // overhead. serde_json can expand a control character to six bytes,
        // so use its exact encoded length for the hard result bound.
        let encoded = serde_json::to_vec(path).map(|value| value.len() + 1);
        let Ok(encoded) = encoded else {
            truncated = true;
            continue;
        };
        if paths.len() >= MAX_PATHS
            || encoded_bytes.saturating_add(encoded) > MAX_RETAINED_RESULT_BYTES
        {
            truncated = true;
            continue;
        }
        encoded_bytes += encoded;
        paths.push(path.clone());
    }
    (paths, truncated)
}

fn build_private_index(
    root: &Path,
    head: &Head,
    entries: &BTreeMap<String, IndexEntry>,
    selected: &BTreeMap<String, StagedRow>,
    private_index: &Path,
    env: &[(OsString, OsString)],
    git: &GitExecutable,
) -> Result<()> {
    let mut read_tree = vec!["read-tree".to_owned()];
    if let Some(oid) = head.oid() {
        read_tree.push(oid.to_owned());
    } else {
        read_tree.push("--empty".to_owned());
    }
    checked_bytes(run_managed_git(
        root,
        &read_tree,
        env,
        None,
        LOCAL_TIMEOUT,
        git,
    )?)?;

    let object_format = read_git_with(root, &["rev-parse", "--show-object-format"], git)?;
    let zero_oid = match object_format.trim() {
        "sha1" => "0".repeat(40),
        "sha256" => "0".repeat(64),
        _ => return Err(anyhow!("git_failed")),
    };
    let mut changes = BTreeMap::<String, Option<IndexEntry>>::new();
    for row in selected.values() {
        match row.wire.index_status.as_str() {
            "D" => {
                changes.insert(row.repo_path.clone(), None);
            }
            "R" => {
                let entry = entries
                    .get(&row.repo_path)
                    .cloned()
                    .ok_or_else(|| anyhow!("git_selected_commit_stale"))?;
                let original = row
                    .repo_original_path
                    .as_ref()
                    .ok_or_else(|| anyhow!("git_selected_commit_invalid_selection"))?;
                changes.insert(original.clone(), None);
                changes.insert(row.repo_path.clone(), Some(entry));
            }
            "A" | "C" | "M" | "T" => {
                let entry = entries
                    .get(&row.repo_path)
                    .cloned()
                    .ok_or_else(|| anyhow!("git_selected_commit_stale"))?;
                changes.insert(row.repo_path.clone(), Some(entry));
            }
            _ => return Err(anyhow!("git_selected_commit_invalid_selection")),
        }
    }
    let mut input = Vec::new();
    for (path, entry) in changes {
        match entry {
            Some(entry) => {
                input.extend_from_slice(entry.mode.as_bytes());
                input.push(b' ');
                input.extend_from_slice(entry.oid.as_bytes());
            }
            None => {
                input.extend_from_slice(b"0 ");
                input.extend_from_slice(zero_oid.as_bytes());
            }
        }
        input.push(b'\t');
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    checked_bytes(run_managed_git(
        root,
        &["update-index".into(), "-z".into(), "--index-info".into()],
        env,
        Some(&input),
        LOCAL_TIMEOUT,
        git,
    )?)?;
    if !private_index.exists() {
        return Err(anyhow!("git_failed"));
    }
    Ok(())
}

fn write_tree(root: &Path, env: &[(OsString, OsString)], git: &GitExecutable) -> Result<String> {
    let output = checked_bytes(run_managed_git(
        root,
        &["write-tree".into()],
        env,
        None,
        LOCAL_TIMEOUT,
        git,
    )?)?;
    let tree = output_text(&output)?.trim().to_owned();
    validate_oid(&tree).map_err(|_| anyhow!("git_failed"))?;
    Ok(tree)
}

fn require_private_tree(
    root: &Path,
    env: &[(OsString, OsString)],
    expected: &str,
    git: &GitExecutable,
) -> Result<()> {
    if write_tree(root, env, git)? == expected {
        Ok(())
    } else {
        Err(anyhow!("git_selected_commit_hook_changed_index"))
    }
}

fn run_hook(
    root: &Path,
    hook: &str,
    hook_args: &[String],
    env: &[(OsString, OsString)],
    git: &GitExecutable,
) -> Result<()> {
    let mut args = vec![
        "hook".to_owned(),
        "run".to_owned(),
        "--ignore-missing".to_owned(),
        hook.to_owned(),
    ];
    if !hook_args.is_empty() {
        args.push("--".to_owned());
        args.extend_from_slice(hook_args);
    }
    let output = run_managed_git(root, &args, env, None, HOOK_TIMEOUT, git)
        .map_err(|_| anyhow!("git_selected_commit_hook_failed"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(anyhow!("git_selected_commit_hook_failed"))
    }
}

fn write_message(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut message = bytes.to_vec();
    if !message.ends_with(b"\n") {
        message.push(b'\n');
    }
    fs::write(path, message).map_err(Into::into)
}

fn cleanup_message(root: &Path, path: &Path, git: &GitExecutable) -> Result<()> {
    let mode =
        config_value(root, "commit.cleanup", git)?.unwrap_or_else(|| "whitespace".to_owned());
    if mode == "verbatim" {
        return Ok(());
    }
    let mut bytes = read_file_bounded(path, MAX_MESSAGE_BYTES)
        .map_err(|_| anyhow!("git_selected_commit_invalid_message"))?;
    let strip_comments = match mode.as_str() {
        "whitespace" | "default" => false,
        "strip" => true,
        "scissors" => {
            bytes = truncate_at_scissors(root, &bytes, git)?;
            true
        }
        _ => return Err(anyhow!("git_selected_commit_invalid_message")),
    };
    let mut args = vec!["stripspace".to_owned()];
    if strip_comments {
        args.push("--strip-comments".to_owned());
    }
    let cleaned = checked_bytes(run_managed_git(
        root,
        &args,
        &[],
        Some(&bytes),
        LOCAL_TIMEOUT,
        git,
    )?)?;
    fs::write(path, cleaned)?;
    Ok(())
}

fn truncate_at_scissors(root: &Path, bytes: &[u8], git: &GitExecutable) -> Result<Vec<u8>> {
    let comment = config_value(root, "core.commentChar", git)?
        .filter(|value| value != "auto")
        .unwrap_or_else(|| "#".to_owned());
    let marker = format!("{comment} ------------------------ >8 ------------------------");
    let text =
        std::str::from_utf8(bytes).map_err(|_| anyhow!("git_selected_commit_invalid_message"))?;
    let mut kept = Vec::new();
    for line in text.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == marker {
            break;
        }
        kept.extend_from_slice(line.as_bytes());
    }
    Ok(kept)
}

fn validate_message_file(path: &Path) -> Result<()> {
    let bytes = read_file_bounded(path, MAX_MESSAGE_BYTES)
        .map_err(|_| anyhow!("git_selected_commit_invalid_message"))?;
    if bytes.is_empty()
        || bytes.len() > MAX_MESSAGE_BYTES
        || bytes.contains(&0)
        || bytes.iter().all(u8::is_ascii_whitespace)
    {
        Err(anyhow!("git_selected_commit_invalid_message"))
    } else {
        Ok(())
    }
}

fn create_commit(
    root: &Path,
    tree: &str,
    parent: Option<&str>,
    message: &Path,
    signed: bool,
    env: &[(OsString, OsString)],
    git: &GitExecutable,
) -> Result<String> {
    let mut args = vec!["commit-tree".to_owned(), tree.to_owned()];
    if let Some(parent) = parent {
        args.extend(["-p".to_owned(), parent.to_owned()]);
    }
    if signed {
        args.push("-S".to_owned());
    }
    args.extend(["-F".to_owned(), path_text(message)?]);
    let output = run_managed_git(root, &args, env, None, HOOK_TIMEOUT, git).map_err(|_| {
        anyhow!(if signed {
            "git_selected_commit_signing_failed"
        } else {
            "git_failed"
        })
    })?;
    if !output.status.success() {
        return Err(anyhow!(if signed {
            "git_selected_commit_signing_failed"
        } else {
            "git_failed"
        }));
    }
    let oid = output_text(&output.stdout)?.trim().to_owned();
    validate_oid(&oid).map_err(|_| anyhow!("git_failed"))?;
    Ok(oid)
}

fn publish_ref(
    root: &Path,
    expected: &Head,
    commit: &str,
    message: &Path,
    env: &[(OsString, OsString)],
    git: &GitExecutable,
) -> Result<()> {
    publish_ref_with_prepared_check(root, expected, commit, message, env, git, || {})
}

fn publish_ref_with_prepared_check(
    root: &Path,
    expected: &Head,
    commit: &str,
    message: &Path,
    env: &[(OsString, OsString)],
    git: &GitExecutable,
    prepared_check: impl FnOnce(),
) -> Result<()> {
    let reason = reflog_message(expected, message)?;
    let mut input = String::from("start\noption no-deref\n");
    match expected {
        Head::Branch { oid, target } => {
            input.push_str(&format!("update {target} {commit} {oid}\n"));
        }
        Head::Unborn { target } => {
            input.push_str(&format!("create {target} {commit}\n"));
        }
        Head::Detached { oid } => {
            input.push_str(&format!("update HEAD {commit} {oid}\n"));
        }
    }
    input.push_str("prepare\n");

    let head_path = absolute_git_path(root, "HEAD", git)?;
    let mut head_lock_name = head_path.as_os_str().to_owned();
    head_lock_name.push(".lock");
    let head_lock_path = PathBuf::from(head_lock_name);
    if head_lock_path.exists() {
        return Err(anyhow!("git_selected_commit_ref_conflict"));
    }

    let args = vec![
        "update-ref".to_owned(),
        "-m".to_owned(),
        reason,
        "--stdin".to_owned(),
    ];
    let (mut child, mut process_tree) = spawn_prepared_git(root, &args, env, git)?;
    let pipes = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
        (Some(stdin), Some(stdout), Some(stderr)) => Ok((stdin, stdout, stderr)),
        _ => Err(anyhow!("git_failed")),
    };
    let (mut child_stdin, child_stdout, child_stderr) = match pipes {
        Ok(pipes) => pipes,
        Err(error) => {
            process_tree.terminate(&mut child);
            return Err(error);
        }
    };
    let (lines, stdout) = spawn_line_reader(child_stdout);
    let stderr = thread::spawn(move || read_bounded(child_stderr));
    let deadline = Instant::now() + LOCAL_TIMEOUT;

    if child_stdin
        .write_all(input.as_bytes())
        .and_then(|_| child_stdin.flush())
        .is_err()
    {
        process_tree.terminate(&mut child);
        let _ = stdout.join();
        let _ = stderr.join();
        return Err(anyhow!("git_selected_commit_ref_conflict"));
    }
    if let Err(error) = wait_for_prepared(&mut child, &mut process_tree, &lines, deadline) {
        drop(child_stdin);
        process_tree.terminate(&mut child);
        let _ = stdout.join();
        let _ = stderr.join();
        return Err(error);
    }

    // Once prepare succeeds, Git holds HEAD.lock if and only if HEAD points to
    // the ref being changed (or HEAD itself is being changed). Requiring that
    // lock, then checking HEAD's canonical raw bytes, closes the race that a
    // separate symref-verify command cannot close in the same transaction.
    prepared_check();
    let expected_head = match expected {
        Head::Branch { target, .. } | Head::Unborn { target } => {
            format!("ref: {target}\n").into_bytes()
        }
        Head::Detached { oid } => format!("{oid}\n").into_bytes(),
    };
    let head_matches = head_lock_path.exists()
        && read_file_bounded(&head_path, expected_head.len())
            .map(|actual| actual == expected_head)
            .unwrap_or(false);
    let decision: &[u8] = if head_matches {
        b"commit\n"
    } else {
        b"abort\n"
    };
    let write_result = child_stdin
        .write_all(decision)
        .and_then(|_| child_stdin.flush());
    drop(child_stdin);
    if write_result.is_err() {
        process_tree.terminate(&mut child);
        let _ = stdout.join();
        let _ = stderr.join();
        return Err(anyhow!(if head_matches {
            "operation_outcome_unknown"
        } else {
            "git_selected_commit_ref_conflict"
        }));
    }

    let status = wait_for_child(&mut child, &mut process_tree, deadline);
    process_tree.close_descendants();
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    let status = status.map_err(|_| {
        anyhow!(if head_matches {
            "operation_outcome_unknown"
        } else {
            "git_selected_commit_ref_conflict"
        })
    })?;
    let output = GitOutput {
        status,
        stdout,
        stderr,
    };
    if head_matches {
        if output.status.success() {
            Ok(())
        } else {
            // Git accepted the commit decision, so an unsuccessful exit does
            // not prove whether the atomic ref transaction was published.
            Err(anyhow!("operation_outcome_unknown"))
        }
    } else {
        Err(anyhow!("git_selected_commit_ref_conflict"))
    }
}

fn spawn_line_reader(
    stdout: impl Read + Send + 'static,
) -> (mpsc::Receiver<Vec<u8>>, thread::JoinHandle<Vec<u8>>) {
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout.take((MAX_CAPTURE_BYTES + 1) as u64));
        let mut captured = Vec::new();
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let remaining = MAX_CAPTURE_BYTES.saturating_sub(captured.len());
                    captured.extend_from_slice(&line[..line.len().min(remaining)]);
                    let _ = sender.send(line);
                }
            }
        }
        captured
    });
    (receiver, reader)
}

fn wait_for_prepared(
    child: &mut Child,
    process_tree: &mut PreparedProcessTree,
    lines: &mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
) -> Result<()> {
    loop {
        if Instant::now() >= deadline {
            process_tree.terminate(child);
            return Err(anyhow!("git_selected_commit_ref_conflict"));
        }
        match lines.recv_timeout(Duration::from_millis(10)) {
            Ok(line) if line == b"prepare: ok\n" => return Ok(()),
            Ok(line) if line.starts_with(b"fatal:") || line.starts_with(b"prepare: ") => {
                process_tree.terminate(child);
                return Err(anyhow!("git_selected_commit_ref_conflict"));
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                process_tree.terminate(child);
                return Err(anyhow!("git_selected_commit_ref_conflict"));
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                process_tree.close_descendants();
                let _ = child.wait();
                return Err(anyhow!("git_selected_commit_ref_conflict"));
            }
            Ok(None) => {}
            Err(error) => {
                process_tree.terminate(child);
                return Err(error.into());
            }
        }
    }
}

fn wait_for_child(
    child: &mut Child,
    process_tree: &mut PreparedProcessTree,
    deadline: Instant,
) -> Result<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(error) => {
                process_tree.terminate(child);
                return Err(error.into());
            }
        }
        if Instant::now() >= deadline {
            process_tree.terminate(child);
            return Err(anyhow!("git_timeout"));
        }
        thread::sleep(Duration::from_millis(5));
    }
}

struct PreparedProcessTree {
    #[cfg(windows)]
    job: Option<crate::job::SessionJob>,
    #[cfg(unix)]
    process_group: Option<u32>,
}

impl PreparedProcessTree {
    fn close_descendants(&mut self) {
        #[cfg(windows)]
        {
            self.job.take();
        }
        #[cfg(unix)]
        if let Some(process_group) = self.process_group.take() {
            terminate_process_group(process_group);
        }
    }

    fn terminate(&mut self, child: &mut Child) {
        self.close_descendants();
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for PreparedProcessTree {
    fn drop(&mut self) {
        self.close_descendants();
    }
}

#[cfg(windows)]
fn spawn_prepared_git(
    root: &Path,
    args: &[String],
    env: &[(OsString, OsString)],
    git: &GitExecutable,
) -> Result<(Child, PreparedProcessTree)> {
    let program = git
        .path
        .to_str()
        .ok_or_else(|| anyhow!("git_selected_commit_unsupported"))?;
    let root_text = path_text(root)?;
    let gate = crate::bootstrap::BootstrapGate::new()?;
    let mut command = gate.service_command(program, &base_git_args(args), &root_text)?;
    configure_git_command(&mut command, root, env, true);
    let mut child = command
        .spawn()
        .context("launching supervised ref transaction")?;
    let job = match crate::job::SessionJob::assign(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if let Err(error) = gate.release(child.id()) {
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((child, PreparedProcessTree { job: Some(job) }))
}

#[cfg(unix)]
fn spawn_prepared_git(
    root: &Path,
    args: &[String],
    env: &[(OsString, OsString)],
    git: &GitExecutable,
) -> Result<(Child, PreparedProcessTree)> {
    let mut command = Command::new(&git.path);
    command.args(base_git_args(args));
    configure_git_command(&mut command, root, env, true);
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let child = command
        .spawn()
        .context("launching supervised ref transaction")?;
    let process_group = child.id();
    Ok((
        child,
        PreparedProcessTree {
            process_group: Some(process_group),
        },
    ))
}

#[cfg(not(any(windows, unix)))]
fn spawn_prepared_git(
    _root: &Path,
    _args: &[String],
    _env: &[(OsString, OsString)],
    _git: &GitExecutable,
) -> Result<(Child, PreparedProcessTree)> {
    Err(anyhow!("git_selected_commit_unsupported"))
}

fn reflog_message(head: &Head, message: &Path) -> Result<String> {
    let bytes = read_file_bounded(message, MAX_MESSAGE_BYTES)
        .map_err(|_| anyhow!("git_selected_commit_invalid_message"))?;
    let text = String::from_utf8_lossy(&bytes);
    let subject = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("selected commit")
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .take(200)
        .collect::<String>();
    Ok(if matches!(head, Head::Unborn { .. }) {
        format!("commit (initial): {subject}")
    } else {
        format!("commit: {subject}")
    })
}

fn config_value(root: &Path, name: &str, git: &GitExecutable) -> Result<Option<String>> {
    let output = run_direct_git(
        root,
        &["config".into(), "--get".into(), name.to_owned()],
        &[],
        None,
        LOCAL_TIMEOUT,
        git,
    )?;
    if output.status.success() {
        Ok(Some(output_text(&output.stdout)?.trim().to_owned()))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(git_failure(&output))
    }
}

fn config_bool(root: &Path, name: &str, git: &GitExecutable) -> Result<bool> {
    let output = run_direct_git(
        root,
        &[
            "config".into(),
            "--type=bool".into(),
            "--get".into(),
            name.to_owned(),
        ],
        &[],
        None,
        LOCAL_TIMEOUT,
        git,
    )?;
    if output.status.success() {
        Ok(output_text(&output.stdout)?.trim() == "true")
    } else if output.status.code() == Some(1) {
        Ok(false)
    } else {
        Err(git_failure(&output))
    }
}

fn reject_in_progress_repository(root: &Path, git: &GitExecutable) -> Result<()> {
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
    ] {
        if absolute_git_path(root, marker, git)?.exists() {
            return Err(anyhow!("git_selected_commit_conflict_state"));
        }
    }
    Ok(())
}

fn absolute_git_path(root: &Path, name: &str, git: &GitExecutable) -> Result<PathBuf> {
    let text = read_git_with(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
        git,
    )?;
    let path = PathBuf::from(text.trim());
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

struct GitLock {
    path: PathBuf,
    file: Option<File>,
    token: Vec<u8>,
    cleaned: bool,
}

impl GitLock {
    fn acquire(target: &Path, conflict_code: &'static str) -> Result<Self> {
        let mut name = target.as_os_str().to_owned();
        name.push(".lock");
        let path = PathBuf::from(name);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    anyhow!(conflict_code)
                } else {
                    anyhow!(error)
                }
            })?;
        let token = format!("threadterm-selected-{}\n", uuid::Uuid::new_v4()).into_bytes();
        let mut lock = Self {
            path,
            file: Some(file),
            token,
            cleaned: false,
        };
        let file = lock.file.as_mut().ok_or_else(|| anyhow!("git_failed"))?;
        file.write_all(&lock.token)?;
        file.flush()?;
        Ok(lock)
    }

    fn owns_path(&self) -> bool {
        read_file_bounded(&self.path, self.token.len())
            .map(|contents| contents == self.token)
            .unwrap_or(false)
    }

    fn cleanup(&mut self) -> Result<()> {
        // Another process can unlink and replace a lock path on platforms that
        // allow it. Only remove the pathname if it still contains our nonce.
        if !self.owns_path() {
            return Err(anyhow!("git_selected_commit_cleanup_failed"));
        }
        self.file.take();
        match fs::remove_file(&self.path) {
            Ok(()) => {
                self.cleaned = true;
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl Drop for GitLock {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = self.cleanup();
        }
    }
}

struct PrivateArtifacts {
    directory: PathBuf,
    index: PathBuf,
    message: PathBuf,
    cleaned: bool,
}

impl PrivateArtifacts {
    fn new(parent: &Path) -> Result<Self> {
        let directory = parent.join(format!(
            ".threadterm-selected-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&directory)?;
        Ok(Self {
            index: directory.join("index"),
            message: directory.join("COMMIT_EDITMSG"),
            directory,
            cleaned: false,
        })
    }

    fn cleanup(&mut self) -> Result<()> {
        match fs::remove_dir_all(&self.directory) {
            Ok(()) => {
                self.cleaned = true;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.cleaned = true;
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl Drop for PrivateArtifacts {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("git_failed"))
}

fn capabilities(root: &Path, git: &GitExecutable) -> Capabilities {
    static CACHE: OnceLock<Mutex<VecDeque<(ExecutableCacheKey, Capabilities)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Ok(mut entries) = cache.lock() {
        if let Some(position) = entries.iter().position(|(key, _)| key == &git.cache_key) {
            if let Some(entry) = entries.remove(position) {
                let result = entry.1.clone();
                entries.push_front(entry);
                return result;
            }
        }
    }

    let probed = probe_capabilities(root, git).unwrap_or_else(|_| Capabilities {
        version: String::new(),
        supported: false,
        unsupported_reason: Some("git_capability_probe_failed".to_owned()),
    });
    if let Ok(mut entries) = cache.lock() {
        // Another caller may have completed the same probe while this one ran.
        if let Some((_, found)) = entries.iter().find(|(key, _)| key == &git.cache_key) {
            return found.clone();
        }
        entries.push_front((git.cache_key.clone(), probed.clone()));
        entries.truncate(CAPABILITY_CACHE_ENTRIES);
    }
    probed
}

fn probe_capabilities(root: &Path, git: &GitExecutable) -> Result<Capabilities> {
    let version_output =
        run_direct_git(root, &["--version".into()], &[], None, LOCAL_TIMEOUT, git)?;
    if !version_output.status.success() {
        return Ok(Capabilities {
            version: String::new(),
            supported: false,
            unsupported_reason: Some("git_unavailable".to_owned()),
        });
    }
    let version = output_text(&version_output.stdout)?.trim().to_owned();
    let probe = CapabilityProbe::new()?;
    let init = run_direct_git(
        &probe.directory,
        &["init".into(), "-q".into()],
        &[],
        None,
        LOCAL_TIMEOUT,
        git,
    )?;
    if !init.status.success() {
        return Ok(Capabilities {
            version,
            supported: false,
            unsupported_reason: Some("git_capability_probe_failed".to_owned()),
        });
    }
    fs::create_dir(&probe.hooks)?;
    let hook_path = path_text(&probe.hooks)?;
    let hook = run_managed_git(
        &probe.directory,
        &[
            "-c".into(),
            format!("core.hooksPath={hook_path}"),
            "hook".into(),
            "run".into(),
            "--ignore-missing".into(),
            "pre-commit".into(),
        ],
        &[],
        None,
        LOCAL_TIMEOUT,
        git,
    )?;
    if !hook.status.success() {
        return Ok(Capabilities {
            version,
            supported: false,
            unsupported_reason: Some("git_hook_run_unavailable".to_owned()),
        });
    }
    let input = b"start\nprepare\nabort\n";
    let transaction = run_managed_git(
        &probe.directory,
        &[
            "-c".into(),
            format!("core.hooksPath={hook_path}"),
            "update-ref".into(),
            "--stdin".into(),
        ],
        &[],
        Some(input),
        LOCAL_TIMEOUT,
        git,
    )?;
    if !transaction.status.success() {
        return Ok(Capabilities {
            version,
            supported: false,
            unsupported_reason: Some("git_ref_transaction_unavailable".to_owned()),
        });
    }
    Ok(Capabilities {
        version,
        supported: true,
        unsupported_reason: None,
    })
}

struct CapabilityProbe {
    directory: PathBuf,
    hooks: PathBuf,
}

impl CapabilityProbe {
    fn new() -> Result<Self> {
        let directory = std::env::temp_dir().join(format!(
            "threadterm-selected-capability-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&directory)?;
        Ok(Self {
            hooks: directory.join("empty-hooks"),
            directory,
        })
    }
}

impl Drop for CapabilityProbe {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

impl GitExecutable {
    fn resolve() -> Result<Self> {
        let requested = match std::env::var_os("THREADTERM_TEST_GIT") {
            Some(value) if !value.is_empty() => {
                let path = PathBuf::from(value);
                if !path.is_absolute() {
                    return Err(anyhow!("git_selected_commit_unsupported"));
                }
                path
            }
            _ => resolve_from_path(OsStr::new("git"))?,
        };
        let path = fs::canonicalize(&requested)
            .with_context(|| format!("resolving Git executable {}", requested.display()))?;
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() {
            return Err(anyhow!("git_selected_commit_unsupported"));
        }
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let mut file = File::open(&path)?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        let fingerprint: [u8; 32] = digest.finalize().into();
        Ok(Self {
            path: path.clone(),
            cache_key: ExecutableCacheKey {
                path,
                length: metadata.len(),
                modified_nanos,
                fingerprint,
            },
        })
    }
}

fn resolve_from_path(program: &OsStr) -> Result<PathBuf> {
    let search_path =
        std::env::var_os("PATH").ok_or_else(|| anyhow!("git_selected_commit_unsupported"))?;
    #[cfg(windows)]
    let suffixes = std::env::var_os("PATHEXT")
        .unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"))
        .to_string_lossy()
        .split(';')
        .filter(|suffix| !suffix.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for directory in std::env::split_paths(&search_path) {
        #[cfg(windows)]
        {
            for suffix in &suffixes {
                let candidate = directory.join(format!("{}{suffix}", program.to_string_lossy()));
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        #[cfg(not(windows))]
        {
            let candidate = directory.join(program);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(anyhow!("git_selected_commit_unsupported"))
}

fn base_git_args(args: &[String]) -> Vec<String> {
    let mut full = vec![
        "-C".to_owned(),
        ".".to_owned(),
        "-c".to_owned(),
        "core.quotepath=off".to_owned(),
    ];
    full.extend_from_slice(args);
    full
}

fn configure_git_command(
    command: &mut Command,
    root: &Path,
    env: &[(OsString, OsString)],
    stdin: bool,
) {
    command
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
}

fn run_direct_git(
    root: &Path,
    args: &[String],
    env: &[(OsString, OsString)],
    stdin: Option<&[u8]>,
    timeout: Duration,
    git: &GitExecutable,
) -> Result<GitOutput> {
    let mut command = Command::new(&git.path);
    command.args(base_git_args(args));
    configure_git_command(&mut command, root, env, stdin.is_some());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command.spawn().context("launching git")?;
    collect_direct_child(child, stdin, timeout)
}

fn collect_direct_child(
    mut child: Child,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<GitOutput> {
    let input = spawn_stdin_writer(&mut child, stdin)?;
    let (stdout, stderr) = spawn_readers(&mut child)?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // This runner is for read-only status commands and owns no
            // quarantine files. Match the existing read runner: do not block
            // forever on a helper that retained an inherited pipe.
            drop(input);
            drop(stdout);
            drop(stderr);
            return Err(anyhow!("git_timeout"));
        }
        thread::sleep(Duration::from_millis(5));
    };
    join_writer(input);
    Ok(GitOutput {
        status,
        stdout: join_reader(stdout),
        stderr: join_reader(stderr),
    })
}

#[cfg(windows)]
fn run_managed_git(
    root: &Path,
    args: &[String],
    env: &[(OsString, OsString)],
    stdin: Option<&[u8]>,
    timeout: Duration,
    git: &GitExecutable,
) -> Result<GitOutput> {
    let program = git
        .path
        .to_str()
        .ok_or_else(|| anyhow!("git_selected_commit_unsupported"))?;
    let root_text = path_text(root)?;
    let gate = crate::bootstrap::BootstrapGate::new()?;
    let mut command = gate.service_command(program, &base_git_args(args), &root_text)?;
    configure_git_command(&mut command, root, env, stdin.is_some());
    let mut child = command.spawn().context("launching supervised git")?;
    let mut job = match crate::job::SessionJob::assign(child.id()) {
        Ok(job) => Some(job),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if let Err(error) = gate.release(child.id()) {
        job.take();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let input = match spawn_stdin_writer(&mut child, stdin) {
        Ok(input) => input,
        Err(error) => {
            job.take();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let (stdout, stderr) = match spawn_readers(&mut child) {
        Ok(readers) => readers,
        Err(error) => {
            job.take();
            let _ = child.kill();
            let _ = child.wait();
            join_writer(input);
            return Err(error);
        }
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                job.take();
                let _ = child.kill();
                let _ = child.wait();
                join_writer(input);
                let _ = join_reader(stdout);
                let _ = join_reader(stderr);
                return Err(error.into());
            }
        }
        if Instant::now() >= deadline {
            job.take();
            let _ = child.kill();
            let _ = child.wait();
            join_writer(input);
            let _ = join_reader(stdout);
            let _ = join_reader(stderr);
            return Err(anyhow!("git_timeout"));
        }
        thread::sleep(Duration::from_millis(5));
    };
    // Kill any deliberately backgrounded descendants before joining inherited
    // pipes and before callers remove private files.
    job.take();
    join_writer(input);
    Ok(GitOutput {
        status,
        stdout: normalize_managed_stdout(join_reader(stdout)),
        stderr: join_reader(stderr),
    })
}

#[cfg(windows)]
fn normalize_managed_stdout(stdout: Vec<u8>) -> Vec<u8> {
    // In unit tests BootstrapGate starts the current libtest executable as its
    // helper. Libtest prints this preamble before the helper replaces itself
    // with Git. Production bootstraps do not emit it.
    #[cfg(test)]
    if let Some(stdout) = stdout.strip_prefix(b"\nrunning 1 test\n") {
        return stdout.to_vec();
    }
    stdout
}

#[cfg(unix)]
fn run_managed_git(
    root: &Path,
    args: &[String],
    env: &[(OsString, OsString)],
    stdin: Option<&[u8]>,
    timeout: Duration,
    git: &GitExecutable,
) -> Result<GitOutput> {
    let mut command = Command::new(&git.path);
    command.args(base_git_args(args));
    configure_git_command(&mut command, root, env, stdin.is_some());
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let mut child = command.spawn().context("launching supervised git")?;
    let pid = child.id();
    let input = match spawn_stdin_writer(&mut child, stdin) {
        Ok(input) => input,
        Err(error) => {
            terminate_process_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let (stdout, stderr) = match spawn_readers(&mut child) {
        Ok(readers) => readers,
        Err(error) => {
            terminate_process_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            join_writer(input);
            return Err(error);
        }
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                terminate_process_group(pid);
                let _ = child.kill();
                let _ = child.wait();
                join_writer(input);
                let _ = join_reader(stdout);
                let _ = join_reader(stderr);
                return Err(error.into());
            }
        }
        if Instant::now() >= deadline {
            terminate_process_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            join_writer(input);
            let _ = join_reader(stdout);
            let _ = join_reader(stderr);
            return Err(anyhow!("git_timeout"));
        }
        thread::sleep(Duration::from_millis(5));
    };
    terminate_process_group(pid);
    join_writer(input);
    Ok(GitOutput {
        status,
        stdout: join_reader(stdout),
        stderr: join_reader(stderr),
    })
}

#[cfg(not(any(windows, unix)))]
fn run_managed_git(
    _root: &Path,
    _args: &[String],
    _env: &[(OsString, OsString)],
    _stdin: Option<&[u8]>,
    _timeout: Duration,
    _git: &GitExecutable,
) -> Result<GitOutput> {
    Err(anyhow!("git_selected_commit_unsupported"))
}

#[cfg(unix)]
fn terminate_process_group(pid: u32) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    // SAFETY: kill is called with a negative child-created process group id;
    // failure is harmless because the direct child is waited separately.
    unsafe {
        let _ = kill(-pid, SIGKILL);
    }
}

type Writer = Option<thread::JoinHandle<()>>;
type Reader = thread::JoinHandle<Vec<u8>>;

fn spawn_stdin_writer(child: &mut Child, stdin: Option<&[u8]>) -> Result<Writer> {
    let Some(bytes) = stdin else {
        return Ok(None);
    };
    let mut pipe = child.stdin.take().ok_or_else(|| anyhow!("git_failed"))?;
    let bytes = bytes.to_vec();
    Ok(Some(thread::spawn(move || {
        let _ = pipe.write_all(&bytes);
    })))
}

fn spawn_readers(child: &mut Child) -> Result<(Reader, Reader)> {
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("git_failed"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("git_failed"))?;
    Ok((
        thread::spawn(move || read_bounded(stdout)),
        thread::spawn(move || read_bounded(stderr)),
    ))
}

fn read_file_bounded(path: &Path, max_bytes: usize) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut bytes = Vec::with_capacity(max_bytes.min(8192));
    file.take((max_bytes.saturating_add(1)) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        Err(anyhow!("git_input_too_large"))
    } else {
        Ok(bytes)
    }
}

fn read_bounded(mut pipe: impl Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                // Keep one sentinel byte beyond the public capture bound so
                // parsers can never accept a silently truncated Git record.
                let remaining = (MAX_CAPTURE_BYTES + 1).saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..count.min(remaining)]);
            }
        }
    }
    kept
}

fn join_writer(writer: Writer) {
    if let Some(writer) = writer {
        let _ = writer.join();
    }
}

fn join_reader(reader: Reader) -> Vec<u8> {
    reader.join().unwrap_or_default()
}

fn checked_bytes(output: GitOutput) -> Result<Vec<u8>> {
    if output.stdout.len() > MAX_CAPTURE_BYTES || output.stderr.len() > MAX_CAPTURE_BYTES {
        Err(anyhow!("git_output_too_large"))
    } else if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(git_failure(&output))
    }
}

fn checked_text(output: GitOutput) -> Result<String> {
    let bytes = checked_bytes(output)?;
    output_text(&bytes)
}

fn output_text(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| anyhow!("git_failed"))
}

fn git_failure(output: &GitOutput) -> anyhow::Error {
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        anyhow!("git_failed")
    } else {
        anyhow!("git_failed: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_services::initialize;
    use std::cell::Cell;
    use std::fs;

    struct Repository {
        directory: tempfile::TempDir,
        db: Database,
        project_id: String,
        git: GitExecutable,
    }

    impl Repository {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let git = test_git();
            command(&git, directory.path(), &["init", "-q"]).unwrap();
            command(
                &git,
                directory.path(),
                &["config", "user.email", "selected@threadterm.invalid"],
            )
            .unwrap();
            command(
                &git,
                directory.path(),
                &["config", "user.name", "Selected Commit Tests"],
            )
            .unwrap();
            fs::write(directory.path().join("a.txt"), "a0\n").unwrap();
            fs::write(directory.path().join("b.txt"), "b0\n").unwrap();
            command(&git, directory.path(), &["add", "a.txt", "b.txt"]).unwrap();
            command(&git, directory.path(), &["commit", "-q", "-m", "initial"]).unwrap();

            let db = Database::open(&directory.path().join("runtime.sqlite")).unwrap();
            fs::write(
                directory.path().join(".git/info/exclude"),
                "runtime.sqlite*\nhook-count\n",
            )
            .unwrap();
            initialize(&db).unwrap();
            let project_id = db
                .add_project(
                    directory.path().to_str().unwrap(),
                    Some("selected"),
                    "project-add",
                )
                .unwrap()
                .id;
            Self {
                directory,
                db,
                project_id,
                git,
            }
        }

        fn root(&self) -> &Path {
            self.directory.path()
        }

        fn request(&self, operation_id: &str, selected_paths: &[&str]) -> Value {
            request_for(
                &self.project_id,
                self.root(),
                None,
                operation_id,
                selected_paths,
                &self.git,
            )
        }

        fn index_bytes(&self) -> Vec<u8> {
            fs::read(self.root().join(".git/index")).unwrap()
        }
    }

    fn command(git: &GitExecutable, root: &Path, args: &[&str]) -> Result<String> {
        let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
        checked_text(run_direct_git(root, &args, &[], None, LOCAL_TIMEOUT, git)?)
    }

    fn test_git() -> GitExecutable {
        assert!(
            std::env::var_os("THREADTERM_TEST_GIT").is_some(),
            "selected-commit tests require absolute THREADTERM_TEST_GIT (the QA MinGit fixture)"
        );
        GitExecutable::resolve().expect("THREADTERM_TEST_GIT must name a readable executable")
    }

    fn request_for(
        project_id: &str,
        root: &Path,
        worktree_path: Option<&str>,
        operation_id: &str,
        selected_paths: &[&str],
        git: &GitExecutable,
    ) -> Value {
        let head = read_head(root, git).unwrap();
        let index = read_index(root, git).unwrap();
        let prefix = repo_prefix(root, git).unwrap();
        let staged = read_staged_rows(root, &prefix, git).unwrap();
        let selected = selected_paths
            .iter()
            .map(|path| staged.get(*path).unwrap().wire.clone())
            .collect::<Vec<_>>();
        let mut request = json!({
            "projectId": project_id,
            "operationId": operation_id,
            "message": "selected subject\n\nselected body\n",
            "selected": selected,
            "expectedHead": head,
            "expectedIndexFingerprint": index.fingerprint,
        });
        if let Some(worktree_path) = worktree_path {
            request["worktreePath"] = json!(worktree_path);
        }
        request
    }

    fn command_input(
        git: &GitExecutable,
        root: &Path,
        args: &[&str],
        input: &[u8],
    ) -> Result<String> {
        let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
        checked_text(run_direct_git(
            root,
            &args,
            &[],
            Some(input),
            LOCAL_TIMEOUT,
            git,
        )?)
    }

    #[test]
    fn selected_commit_uses_index_content_and_preserves_the_real_index() {
        let repository = Repository::new();

        // The worktree contains a second, unstaged line; only the explicit
        // blob below is placed in the user's index.
        fs::write(repository.root().join("a.txt"), "a1\nworktree only\n").unwrap();
        let a_blob = command_input(
            &repository.git,
            repository.root(),
            &["hash-object", "-w", "--stdin"],
            b"a1\n",
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("100644,{},a.txt", a_blob.trim()),
            ],
        )
        .unwrap();
        fs::write(repository.root().join("b.txt"), "b1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "b.txt"]).unwrap();

        let before = repository.index_bytes();
        let request = repository.request("selected-one", &["a.txt"]);
        let result = dispatch(&repository.db, METHOD, &request).unwrap().unwrap();

        assert_eq!(result["committedPaths"], json!(["a.txt"]));
        assert_eq!(result["retainedStagedPaths"], json!(["b.txt"]));
        assert!(result["parent"].is_string());
        assert_eq!(result["refTarget"], "refs/heads/master");
        assert_eq!(repository.index_bytes(), before);
        assert_eq!(
            command(&repository.git, repository.root(), &["show", "HEAD:a.txt"]).unwrap(),
            "a1\n"
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["show", "HEAD:b.txt"]).unwrap(),
            "b0\n"
        );
        assert_eq!(
            fs::read_to_string(repository.root().join("a.txt")).unwrap(),
            "a1\nworktree only\n"
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["diff", "--cached", "--name-only"]
            )
            .unwrap(),
            "b.txt\n"
        );
    }

    #[test]
    fn selected_tree_preserves_add_delete_rename_copy_mode_symlink_and_gitlink_entries() {
        let repository = Repository::new();
        for (path, content) in [
            ("delete.txt", "delete\n"),
            ("rename.txt", "rename\n"),
            ("copy-source.txt", "copy\n"),
            ("mode.txt", "mode\n"),
            ("type.txt", "regular file\n"),
        ] {
            fs::write(repository.root().join(path), content).unwrap();
        }
        command(&repository.git, repository.root(), &["add", "."]).unwrap();
        command(
            &repository.git,
            repository.root(),
            &["commit", "-q", "-m", "entry baseline"],
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["config", "status.renames", "copies"],
        )
        .unwrap();

        fs::write(repository.root().join("added.txt"), "added\n").unwrap();
        fs::copy(
            repository.root().join("copy-source.txt"),
            repository.root().join("copied.txt"),
        )
        .unwrap();
        // Give diffcore a modified source candidate so status.renames=copies
        // reports the exact copy relationship instead of a plain addition.
        fs::write(repository.root().join("copy-source.txt"), "copy changed\n").unwrap();
        fs::write(repository.root().join("a.txt"), "modified\n").unwrap();
        command(
            &repository.git,
            repository.root(),
            &["rm", "-q", "delete.txt"],
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["mv", "rename.txt", "renamed.txt"],
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["add", "added.txt", "copied.txt", "copy-source.txt", "a.txt"],
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["update-index", "--chmod=+x", "mode.txt"],
        )
        .unwrap();
        let link_blob = command_input(
            &repository.git,
            repository.root(),
            &["hash-object", "-w", "--stdin"],
            b"target.txt",
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("120000,{},type.txt", link_blob.trim()),
            ],
        )
        .unwrap();
        let gitlink = command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap();
        command(
            &repository.git,
            repository.root(),
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{},gitlink", gitlink.trim()),
            ],
        )
        .unwrap();

        let staged = read_staged_rows(repository.root(), "", &repository.git).unwrap();
        let statuses = staged
            .values()
            .map(|row| row.wire.index_status.as_str())
            .collect::<HashSet<_>>();
        assert!(
            statuses.is_superset(&HashSet::from(["A", "C", "D", "M", "R", "T"])),
            "unexpected staged statuses: {statuses:?}"
        );
        let selected = staged.keys().map(String::as_str).collect::<Vec<_>>();
        let before = repository.index_bytes();
        let request = repository.request("entry-types", &selected);
        dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        assert_eq!(repository.index_bytes(), before);

        let tree = command(
            &repository.git,
            repository.root(),
            &["ls-tree", "-r", "HEAD"],
        )
        .unwrap();
        assert!(tree.contains("100755 blob") && tree.contains("\tmode.txt"));
        assert!(tree.contains("120000 blob") && tree.contains("\ttype.txt"));
        assert!(
            tree.contains("160000 commit") && tree.contains("\tgitlink"),
            "unexpected committed tree:\n{tree}"
        );
        assert!(tree.contains("\tadded.txt"));
        assert!(tree.contains("\tcopied.txt"));
        assert!(tree.contains("\trenamed.txt"));
        assert!(!tree.contains("\tdelete.txt"));
        assert!(!tree.contains("\trename.txt"));
    }

    #[test]
    fn exact_replay_returns_the_receipt_without_rerunning_hooks() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "pre-commit",
            "#!/bin/sh\nprintf x >> hook-count\n",
        );
        let request = repository.request("replayed", &["a.txt"]);

        let first = dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        let second = dispatch(&repository.db, METHOD, &request).unwrap().unwrap();

        assert_eq!(second, first);
        assert_eq!(
            fs::read_to_string(repository.root().join("hook-count")).unwrap(),
            "x"
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["rev-list", "--count", "HEAD"]
            )
            .unwrap()
            .trim(),
            "2"
        );
    }

    #[test]
    fn cleanup_failure_is_receipted_as_a_committed_warning() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "committed\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "post-commit",
            "#!/bin/sh\nprintf 'replacement-lock\\n' > .git/index.lock\nprintf x >> cleanup-hook-count\n",
        );
        let request = repository.request("cleanup-warning", &["a.txt"]);

        let first = dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        assert_eq!(first["cleanupError"], "git_selected_commit_cleanup_failed");
        assert_eq!(
            command(&repository.git, repository.root(), &["show", "HEAD:a.txt"]).unwrap(),
            "committed\n"
        );
        assert_eq!(
            fs::read(repository.root().join(".git/index.lock")).unwrap(),
            b"replacement-lock\n"
        );

        let replay = dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        assert_eq!(replay, first);
        assert_eq!(
            fs::read_to_string(repository.root().join("cleanup-hook-count")).unwrap(),
            "x"
        );
    }

    #[test]
    fn hooks_run_in_order_can_rewrite_the_message_and_post_failure_is_reported() {
        let repository = Repository::new();
        fs::write(
            repository.root().join(".git/info/exclude"),
            "runtime.sqlite*\nhook-order\n",
        )
        .unwrap();
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "pre-commit",
            "#!/bin/sh\ncase \"$GIT_INDEX_FILE\" in *threadterm-selected*) ;; *) exit 9;; esac\nprintf 'pre\\n' >> hook-order\n",
        );
        write_hook(
            &repository,
            "prepare-commit-msg",
            "#!/bin/sh\nprintf 'prepare:%s\\n' \"$2\" >> hook-order\nprintf '\\nprepared by hook\\n' >> \"$1\"\n",
        );
        write_hook(
            &repository,
            "commit-msg",
            "#!/bin/sh\nprintf 'commit\\n' >> hook-order\n",
        );
        write_hook(
            &repository,
            "post-commit",
            "#!/bin/sh\nprintf 'post\\n' >> hook-order\nexit 7\n",
        );
        let request = repository.request("hook-order", &["a.txt"]);

        let result = dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        assert_eq!(result["postCommitError"], "git_selected_commit_hook_failed");
        assert_eq!(
            fs::read_to_string(repository.root().join("hook-order")).unwrap(),
            "pre\nprepare:message\ncommit\npost\n"
        );
        assert!(command(
            &repository.git,
            repository.root(),
            &["log", "-1", "--format=%B"]
        )
        .unwrap()
        .contains("prepared by hook"));
    }

    #[test]
    fn index_lock_and_stale_snapshot_fail_before_the_external_claim() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        let request = repository.request("preclaim-failure", &["a.txt"]);
        let index = absolute_git_path(repository.root(), "index", &repository.git).unwrap();
        let lock = GitLock::acquire(&index, "test-lock").unwrap();
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_index_locked"
        );
        assert!(!external_operation_claimed(&repository.db, "preclaim-failure").unwrap());
        drop(lock);

        fs::write(repository.root().join("b.txt"), "b1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "b.txt"]).unwrap();
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_stale"
        );
        assert!(!external_operation_claimed(&repository.db, "preclaim-failure").unwrap());
    }

    #[test]
    fn unmerged_and_intent_to_add_indexes_are_rejected_before_claim() {
        let unmerged = Repository::new();
        command(
            &unmerged.git,
            unmerged.root(),
            &["checkout", "-q", "-b", "other"],
        )
        .unwrap();
        fs::write(unmerged.root().join("a.txt"), "other\n").unwrap();
        command(&unmerged.git, unmerged.root(), &["add", "a.txt"]).unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["commit", "-q", "-m", "other"],
        )
        .unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["checkout", "-q", "master"],
        )
        .unwrap();
        fs::write(unmerged.root().join("a.txt"), "master\n").unwrap();
        command(&unmerged.git, unmerged.root(), &["add", "a.txt"]).unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["commit", "-q", "-m", "master"],
        )
        .unwrap();
        assert!(command(&unmerged.git, unmerged.root(), &["merge", "other"]).is_err());
        fs::remove_file(absolute_git_path(unmerged.root(), "MERGE_HEAD", &unmerged.git).unwrap())
            .unwrap();
        let head = read_head(unmerged.root(), &unmerged.git).unwrap();
        let index = read_index(unmerged.root(), &unmerged.git).unwrap();
        assert!(index.unmerged);
        let request = json!({
            "projectId": unmerged.project_id,
            "operationId": "unmerged-index",
            "message": "must reject",
            "selected": [{"path":"a.txt","indexStatus":"M"}],
            "expectedHead": head,
            "expectedIndexFingerprint": index.fingerprint,
        });
        assert_eq!(
            dispatch(&unmerged.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_conflict_state"
        );
        assert!(!external_operation_claimed(&unmerged.db, "unmerged-index").unwrap());

        let ita = Repository::new();
        fs::write(ita.root().join("intent.txt"), "intent\n").unwrap();
        command(
            &ita.git,
            ita.root(),
            &["add", "--intent-to-add", "intent.txt"],
        )
        .unwrap();
        let head = read_head(ita.root(), &ita.git).unwrap();
        let index = read_index(ita.root(), &ita.git).unwrap();
        let index_path = absolute_git_path(ita.root(), "index", &ita.git).unwrap();
        let lock = GitLock::acquire(&index_path, "test-lock").unwrap();
        assert_eq!(
            read_index(ita.root(), &ita.git).unwrap().fingerprint,
            index.fingerprint
        );
        drop(lock);
        let debug = read_git_with(
            ita.root(),
            &["ls-files", "--full-name", "--debug", "--", ":/"],
            &ita.git,
        )
        .unwrap();
        assert!(
            has_intent_to_add(ita.root(), &ita.git).unwrap(),
            "unexpected ls-files --debug output:\n{debug}"
        );
        let request = json!({
            "projectId": ita.project_id,
            "operationId": "intent-to-add-index",
            "message": "must reject",
            "selected": [{"path":"intent.txt","indexStatus":"A"}],
            "expectedHead": head,
            "expectedIndexFingerprint": index.fingerprint,
        });
        assert_eq!(
            dispatch(&ita.db, METHOD, &request).unwrap_err().to_string(),
            "git_selected_commit_conflict_state"
        );
        assert!(!external_operation_claimed(&ita.db, "intent-to-add-index").unwrap());
    }

    #[test]
    fn failing_pre_commit_hook_preserves_head_index_and_cleans_private_files() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "selected\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(&repository, "pre-commit", "#!/bin/sh\nexit 7\n");
        let request = repository.request("pre-commit-fails", &["a.txt"]);
        let before_head =
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap();
        let before_index = repository.index_bytes();

        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_hook_failed"
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap(),
            before_head
        );
        assert_eq!(repository.index_bytes(), before_index);
        assert!(!repository.root().join(".git/index.lock").exists());
        let leftovers = fs::read_dir(repository.root().join(".git"))
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".threadterm-selected-")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn oversized_hook_messages_are_rejected_with_bounded_reads() {
        for hook in ["prepare-commit-msg", "commit-msg"] {
            let repository = Repository::new();
            fs::write(repository.root().join("a.txt"), "selected\n").unwrap();
            command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
            write_hook(
                &repository,
                hook,
                "#!/bin/sh\ndd if=/dev/zero bs=65537 count=1 2>/dev/null | tr '\\000' x > \"$1\"\n",
            );
            let operation = format!("oversized-{hook}");
            let request = repository.request(&operation, &["a.txt"]);
            let before =
                command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap();

            assert_eq!(
                dispatch(&repository.db, METHOD, &request)
                    .unwrap_err()
                    .to_string(),
                "git_selected_commit_invalid_message"
            );
            assert_eq!(
                command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap(),
                before
            );
            assert!(!repository.root().join(".git/index.lock").exists());
        }
    }

    #[test]
    fn stale_head_and_hook_retarget_are_rejected_without_selected_publication() {
        let stale = Repository::new();
        fs::write(stale.root().join("a.txt"), "a1\n").unwrap();
        command(&stale.git, stale.root(), &["add", "a.txt"]).unwrap();
        let request = stale.request("stale-head", &["a.txt"]);
        command(
            &stale.git,
            stale.root(),
            &["commit", "-q", "-m", "concurrent advance"],
        )
        .unwrap();
        assert_eq!(
            dispatch(&stale.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_stale"
        );
        assert!(!external_operation_claimed(&stale.db, "stale-head").unwrap());

        let retarget = Repository::new();
        command(&retarget.git, retarget.root(), &["branch", "other"]).unwrap();
        fs::write(retarget.root().join("a.txt"), "selected\n").unwrap();
        command(&retarget.git, retarget.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &retarget,
            "pre-commit",
            "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/other\n",
        );
        let request = retarget.request("retarget", &["a.txt"]);
        assert_eq!(
            dispatch(&retarget.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_ref_conflict"
        );
        assert_eq!(
            command(&retarget.git, retarget.root(), &["symbolic-ref", "HEAD"])
                .unwrap()
                .trim(),
            "refs/heads/other"
        );
        assert_eq!(
            command(&retarget.git, retarget.root(), &["show", "HEAD:a.txt"]).unwrap(),
            "a0\n"
        );
    }

    #[test]
    fn hook_replaced_index_lock_is_not_published_or_removed() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "selected\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "pre-commit",
            "#!/bin/sh\nprintf 'replacement-lock\\n' > .git/index.lock\n",
        );
        let request = repository.request("lock-replaced", &["a.txt"]);

        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_stale"
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["show", "HEAD:a.txt"]).unwrap(),
            "a0\n"
        );
        assert_eq!(
            fs::read(repository.root().join(".git/index.lock")).unwrap(),
            b"replacement-lock\n"
        );
    }

    #[test]
    fn hook_replaced_real_index_is_preserved_and_claim_replay_is_unknown() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "selected\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        let selected_index = repository.index_bytes();

        fs::write(repository.root().join("b.txt"), "foreign\n").unwrap();
        command(&repository.git, repository.root(), &["add", "b.txt"]).unwrap();
        let foreign_index = repository.index_bytes();
        assert_ne!(foreign_index, selected_index);
        fs::write(repository.root().join(".git/foreign-index"), &foreign_index).unwrap();
        fs::write(repository.root().join(".git/index"), &selected_index).unwrap();

        write_hook(
            &repository,
            "pre-commit",
            "#!/bin/sh\nprintf x >> hook-count\nmv -f .git/foreign-index .git/index\n",
        );
        let request = repository.request("real-index-replaced", &["a.txt"]);
        let before_head =
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap();

        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_stale"
        );
        assert_eq!(repository.index_bytes(), foreign_index);
        assert_eq!(
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap(),
            before_head
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["show", "HEAD:a.txt"]).unwrap(),
            "a0\n"
        );
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "operation_outcome_unknown"
        );
        assert_eq!(
            fs::read_to_string(repository.root().join("hook-count")).unwrap(),
            "x"
        );
    }

    #[test]
    fn hook_branch_advance_after_claim_rejects_selected_publication() {
        let repository = Repository::new();
        let before = command(&repository.git, repository.root(), &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        let baseline_tree = command(
            &repository.git,
            repository.root(),
            &["rev-parse", "HEAD^{tree}"],
        )
        .unwrap();
        let advanced = command(
            &repository.git,
            repository.root(),
            &[
                "commit-tree",
                baseline_tree.trim(),
                "-p",
                &before,
                "-m",
                "concurrent advance",
            ],
        )
        .unwrap();
        fs::write(repository.root().join("a.txt"), "selected\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "pre-commit",
            &format!(
                "#!/bin/sh\ngit update-ref refs/heads/master {} {}\n",
                advanced.trim(),
                before
            ),
        );
        let request = repository.request("hook-advanced-branch", &["a.txt"]);

        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_ref_conflict"
        );
        assert!(external_operation_claimed(&repository.db, "hook-advanced-branch").unwrap());
        assert_eq!(
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"])
                .unwrap()
                .trim(),
            advanced.trim()
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["show", "HEAD:a.txt"]).unwrap(),
            "a0\n"
        );
    }

    #[test]
    fn subdirectory_status_is_scoped_and_cross_root_rename_is_rejected() {
        let repository = Repository::new();
        fs::create_dir(repository.root().join("pkg")).unwrap();
        fs::write(repository.root().join("outside.txt"), "outside\n").unwrap();
        fs::write(repository.root().join("pkg/inside.txt"), "inside\n").unwrap();
        command(&repository.git, repository.root(), &["add", "."]).unwrap();
        command(
            &repository.git,
            repository.root(),
            &["commit", "-q", "-m", "subdir baseline"],
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["mv", "outside.txt", "pkg/moved-in.txt"],
        )
        .unwrap();
        let subdir = repository.root().join("pkg").canonicalize().unwrap();
        let project = repository
            .db
            .add_project(subdir.to_str().unwrap(), Some("subdir"), "add-subdir")
            .unwrap();
        let status = crate::workspace_services::git_status(&subdir).unwrap();
        assert_eq!(status["selectedCommit"]["supported"], true);
        assert!(status["selectedCommit"]["head"]["oid"].is_string());
        assert!(status["selectedCommit"]["indexFingerprint"].is_string());
        assert_eq!(status["changes"].as_array().unwrap().len(), 1);
        assert_eq!(status["changes"][0]["path"], "moved-in.txt");

        let request = request_for(
            &project.id,
            &subdir,
            None,
            "cross-root",
            &["moved-in.txt"],
            &repository.git,
        );
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_cross_root_rename"
        );
        assert!(!external_operation_claimed(&repository.db, "cross-root").unwrap());
    }

    #[test]
    fn nested_root_commit_uses_the_whole_index_and_retains_outside_staging() {
        let repository = Repository::new();
        fs::create_dir(repository.root().join("pkg")).unwrap();
        fs::write(repository.root().join("pkg/inside.txt"), "inside-0\n").unwrap();
        fs::write(repository.root().join("outside.txt"), "outside-0\n").unwrap();
        command(&repository.git, repository.root(), &["add", "."]).unwrap();
        command(
            &repository.git,
            repository.root(),
            &["commit", "-q", "-m", "nested baseline"],
        )
        .unwrap();
        fs::write(repository.root().join("pkg/inside.txt"), "inside-1\n").unwrap();
        fs::write(repository.root().join("outside.txt"), "outside-1\n").unwrap();
        command(
            &repository.git,
            repository.root(),
            &["add", "pkg/inside.txt", "outside.txt"],
        )
        .unwrap();
        let before_index = repository.index_bytes();
        let nested = repository.root().join("pkg").canonicalize().unwrap();
        let project = repository
            .db
            .add_project(nested.to_str().unwrap(), Some("nested"), "nested-project")
            .unwrap();
        let request = request_for(
            &project.id,
            &nested,
            None,
            "nested-selected",
            &["inside.txt"],
            &repository.git,
        );

        let result = dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        assert_eq!(result["committedPaths"], json!(["inside.txt"]));
        assert_eq!(repository.index_bytes(), before_index);
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["show", "HEAD:pkg/inside.txt"]
            )
            .unwrap(),
            "inside-1\n"
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["show", "HEAD:outside.txt"]
            )
            .unwrap(),
            "outside-0\n"
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["diff", "--cached", "--name-only"]
            )
            .unwrap(),
            "outside.txt\n"
        );
    }

    #[test]
    fn nested_root_can_commit_a_copy_whose_source_is_outside_scope() {
        let repository = Repository::new();
        fs::create_dir(repository.root().join("pkg")).unwrap();
        fs::write(repository.root().join("copy-source.txt"), "copy\n").unwrap();
        command(
            &repository.git,
            repository.root(),
            &["add", "copy-source.txt"],
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["commit", "-q", "-m", "copy baseline"],
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["config", "status.renames", "copies"],
        )
        .unwrap();
        fs::copy(
            repository.root().join("copy-source.txt"),
            repository.root().join("pkg/copied.txt"),
        )
        .unwrap();
        fs::write(
            repository.root().join("copy-source.txt"),
            "source changed\n",
        )
        .unwrap();
        command(
            &repository.git,
            repository.root(),
            &["add", "copy-source.txt", "pkg/copied.txt"],
        )
        .unwrap();
        let before_index = repository.index_bytes();
        let nested = repository.root().join("pkg").canonicalize().unwrap();
        let prefix = repo_prefix(&nested, &repository.git).unwrap();
        let staged = read_staged_rows(&nested, &prefix, &repository.git).unwrap();
        assert_eq!(staged["copied.txt"].wire.index_status, "C");
        assert_eq!(staged["copied.txt"].wire.original_path, None);
        assert!(staged["copied.txt"].original_outside_root);
        let project = repository
            .db
            .add_project(nested.to_str().unwrap(), Some("nested"), "copy-nested")
            .unwrap();
        let request = request_for(
            &project.id,
            &nested,
            None,
            "outside-copy-source",
            &["copied.txt"],
            &repository.git,
        );

        dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        assert_eq!(repository.index_bytes(), before_index);
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["show", "HEAD:pkg/copied.txt"]
            )
            .unwrap(),
            "copy\n"
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["show", "HEAD:copy-source.txt"]
            )
            .unwrap(),
            "copy\n"
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["diff", "--cached", "--name-only"]
            )
            .unwrap(),
            "copy-source.txt\n"
        );
    }

    #[test]
    fn nested_root_rejects_unmerged_and_intent_to_add_entries_outside_scope() {
        let unmerged = Repository::new();
        fs::create_dir(unmerged.root().join("pkg")).unwrap();
        fs::write(unmerged.root().join("pkg/inside.txt"), "inside-0\n").unwrap();
        fs::write(unmerged.root().join("outside.txt"), "outside-0\n").unwrap();
        command(&unmerged.git, unmerged.root(), &["add", "."]).unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["commit", "-q", "-m", "nested baseline"],
        )
        .unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["checkout", "-q", "-b", "other"],
        )
        .unwrap();
        fs::write(unmerged.root().join("outside.txt"), "other\n").unwrap();
        command(&unmerged.git, unmerged.root(), &["add", "outside.txt"]).unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["commit", "-q", "-m", "other"],
        )
        .unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["checkout", "-q", "master"],
        )
        .unwrap();
        fs::write(unmerged.root().join("outside.txt"), "master\n").unwrap();
        command(&unmerged.git, unmerged.root(), &["add", "outside.txt"]).unwrap();
        command(
            &unmerged.git,
            unmerged.root(),
            &["commit", "-q", "-m", "master"],
        )
        .unwrap();
        assert!(command(&unmerged.git, unmerged.root(), &["merge", "other"]).is_err());
        fs::remove_file(absolute_git_path(unmerged.root(), "MERGE_HEAD", &unmerged.git).unwrap())
            .unwrap();
        fs::write(unmerged.root().join("pkg/inside.txt"), "inside-1\n").unwrap();
        command(&unmerged.git, unmerged.root(), &["add", "pkg/inside.txt"]).unwrap();
        let nested = unmerged.root().join("pkg").canonicalize().unwrap();
        let project = unmerged
            .db
            .add_project(nested.to_str().unwrap(), Some("nested"), "unmerged-nested")
            .unwrap();
        let request = request_for(
            &project.id,
            &nested,
            None,
            "outside-unmerged",
            &["inside.txt"],
            &unmerged.git,
        );
        assert_eq!(
            dispatch(&unmerged.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_conflict_state"
        );
        assert!(!external_operation_claimed(&unmerged.db, "outside-unmerged").unwrap());

        let ita = Repository::new();
        fs::create_dir(ita.root().join("pkg")).unwrap();
        fs::write(ita.root().join("pkg/inside.txt"), "inside-0\n").unwrap();
        command(&ita.git, ita.root(), &["add", "pkg/inside.txt"]).unwrap();
        command(
            &ita.git,
            ita.root(),
            &["commit", "-q", "-m", "nested baseline"],
        )
        .unwrap();
        fs::write(ita.root().join("pkg/inside.txt"), "inside-1\n").unwrap();
        fs::write(ita.root().join("outside-intent.txt"), "intent\n").unwrap();
        command(&ita.git, ita.root(), &["add", "pkg/inside.txt"]).unwrap();
        command(
            &ita.git,
            ita.root(),
            &["add", "--intent-to-add", "outside-intent.txt"],
        )
        .unwrap();
        let nested = ita.root().join("pkg").canonicalize().unwrap();
        let project = ita
            .db
            .add_project(nested.to_str().unwrap(), Some("nested"), "ita-nested")
            .unwrap();
        let request = request_for(
            &project.id,
            &nested,
            None,
            "outside-ita",
            &["inside.txt"],
            &ita.git,
        );
        assert_eq!(
            dispatch(&ita.db, METHOD, &request).unwrap_err().to_string(),
            "git_selected_commit_conflict_state"
        );
        assert!(!external_operation_claimed(&ita.db, "outside-ita").unwrap());
    }

    #[test]
    fn a_hook_that_changes_the_private_index_aborts_before_publication() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        fs::write(repository.root().join("hook-added.txt"), "hook\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        let before_index = repository.index_bytes();
        let before_head =
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap();
        write_hook(
            &repository,
            "pre-commit",
            "#!/bin/sh\nprintf x >> hook-count\ngit add hook-added.txt\n",
        );
        let request = repository.request("hook-mutates-index", &["a.txt"]);

        let error = dispatch(&repository.db, METHOD, &request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("git_selected_commit_hook_changed_index"));
        assert_eq!(repository.index_bytes(), before_index);
        assert_eq!(
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap(),
            before_head
        );
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "operation_outcome_unknown"
        );
        assert_eq!(
            fs::read_to_string(repository.root().join("hook-count")).unwrap(),
            "x"
        );
    }

    #[test]
    fn reference_transaction_rejection_never_partially_publishes() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "reference-transaction",
            "#!/bin/sh\nif [ \"$1\" = prepared ]; then exit 17; fi\n",
        );
        let before = command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap();
        let request = repository.request("ref-hook-reject", &["a.txt"]);
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_ref_conflict"
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap(),
            before
        );
        assert!(!repository.root().join(".git/HEAD.lock").exists());
        assert!(!repository
            .root()
            .join(".git/refs/heads/master.lock")
            .exists());
    }

    #[test]
    fn claimed_operation_without_receipt_is_never_reexecuted() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        let request = repository.request("claimed-only", &["a.txt"]);
        repository
            .db
            .bind_operation("claimed-only", METHOD, &request)
            .unwrap();
        assert!(repository
            .db
            .claim_external_operation("claimed-only")
            .unwrap());
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "operation_outcome_unknown"
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["rev-list", "--count", "HEAD"]
            )
            .unwrap()
            .trim(),
            "1"
        );
    }

    #[test]
    fn timed_out_hook_kills_descendants_and_cleans_private_files() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "pre-commit",
            "#!/bin/sh\n(sh -c 'sleep 3; printf leaked > descendant-leaked') &\nsleep 30\n",
        );
        let request = repository.request("hook-timeout", &["a.txt"]);
        let started = Instant::now();
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_hook_failed"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_secs(4));
        assert!(!repository.root().join("descendant-leaked").exists());
        assert!(!repository.root().join(".git/index.lock").exists());
        let leftovers = fs::read_dir(repository.root().join(".git"))
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".threadterm-selected-")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn ssh_signed_commit_verifies_and_signer_failure_does_not_publish() {
        let repository = Repository::new();
        let key = repository.root().join("signing-key");
        let key_status = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .status()
            .expect("selected-commit signing test requires ssh-keygen");
        assert!(key_status.success());
        let public_key = fs::read_to_string(key.with_extension("pub")).unwrap();
        let allowed = repository.root().join("allowed-signers");
        fs::write(
            &allowed,
            format!("selected@threadterm.invalid {public_key}"),
        )
        .unwrap();
        for (name, value) in [
            ("gpg.format", "ssh"),
            ("user.signingKey", key.to_str().unwrap()),
            ("gpg.ssh.allowedSignersFile", allowed.to_str().unwrap()),
            ("commit.gpgSign", "true"),
        ] {
            command(&repository.git, repository.root(), &["config", name, value]).unwrap();
        }
        fs::write(repository.root().join("a.txt"), "signed\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        let request = repository.request("signed", &["a.txt"]);
        dispatch(&repository.db, METHOD, &request).unwrap().unwrap();
        command(
            &repository.git,
            repository.root(),
            &["verify-commit", "HEAD"],
        )
        .unwrap();

        fs::write(repository.root().join("b.txt"), "unsigned\n").unwrap();
        command(&repository.git, repository.root(), &["add", "b.txt"]).unwrap();
        let before = command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap();
        command(
            &repository.git,
            repository.root(),
            &[
                "config",
                "gpg.ssh.program",
                repository.root().join("missing-signer").to_str().unwrap(),
            ],
        )
        .unwrap();
        let request = repository.request("signing-fails", &["b.txt"]);
        assert_eq!(
            dispatch(&repository.db, METHOD, &request)
                .unwrap_err()
                .to_string(),
            "git_selected_commit_signing_failed"
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"]).unwrap(),
            before
        );
    }

    #[test]
    fn prepared_ref_transaction_blocks_head_retargeting_and_updates_both_reflogs() {
        let repository = Repository::new();
        command(&repository.git, repository.root(), &["branch", "racer"]).unwrap();
        let index_path = absolute_git_path(repository.root(), "index", &repository.git).unwrap();
        let index_lock = GitLock::acquire(&index_path, "index-busy").unwrap();
        let switch_started = Instant::now();
        assert!(command(&repository.git, repository.root(), &["switch", "racer"]).is_err());
        assert!(switch_started.elapsed() < Duration::from_secs(2));
        drop(index_lock);
        fs::write(repository.root().join("a.txt"), "a1\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        let expected = read_head(repository.root(), &repository.git).unwrap();
        let tree = command(&repository.git, repository.root(), &["write-tree"])
            .unwrap()
            .trim()
            .to_owned();
        let message = repository.root().join(".git/SELECTED_MESSAGE");
        fs::write(&message, "atomic subject\n").unwrap();
        let commit = create_commit(
            repository.root(),
            &tree,
            expected.oid(),
            &message,
            false,
            &[],
            &repository.git,
        )
        .unwrap();
        let switch_was_blocked = Cell::new(false);

        publish_ref_with_prepared_check(
            repository.root(),
            &expected,
            &commit,
            &message,
            &[],
            &repository.git,
            || {
                switch_was_blocked.set(
                    command(
                        &repository.git,
                        repository.root(),
                        &["symbolic-ref", "HEAD", "refs/heads/racer"],
                    )
                    .is_err(),
                );
            },
        )
        .unwrap();

        assert!(switch_was_blocked.get());
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["symbolic-ref", "HEAD"]
            )
            .unwrap()
            .trim(),
            "refs/heads/master"
        );
        assert_eq!(
            command(&repository.git, repository.root(), &["rev-parse", "HEAD"])
                .unwrap()
                .trim(),
            commit
        );
        for reference in ["HEAD", "refs/heads/master"] {
            assert_eq!(
                command(
                    &repository.git,
                    repository.root(),
                    &["reflog", "show", "-1", "--format=%gs", reference]
                )
                .unwrap()
                .trim(),
                "commit: atomic subject"
            );
        }
        assert!(!repository.root().join(".git/HEAD.lock").exists());
    }

    #[test]
    fn prepared_ref_transaction_aborts_after_raw_head_rewrite() {
        let repository = Repository::new();
        command(&repository.git, repository.root(), &["branch", "racer"]).unwrap();
        fs::write(repository.root().join("a.txt"), "selected\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        let expected = read_head(repository.root(), &repository.git).unwrap();
        let before = expected.oid().unwrap().to_owned();
        let tree = command(&repository.git, repository.root(), &["write-tree"])
            .unwrap()
            .trim()
            .to_owned();
        let message = repository.root().join(".git/SELECTED_MESSAGE");
        fs::write(&message, "must abort\n").unwrap();
        let commit = create_commit(
            repository.root(),
            &tree,
            Some(&before),
            &message,
            false,
            &[],
            &repository.git,
        )
        .unwrap();
        let head = absolute_git_path(repository.root(), "HEAD", &repository.git).unwrap();
        let mut head_lock = head.as_os_str().to_owned();
        head_lock.push(".lock");
        let head_lock = PathBuf::from(head_lock);
        let lock_seen = Cell::new(false);

        let error = publish_ref_with_prepared_check(
            repository.root(),
            &expected,
            &commit,
            &message,
            &[],
            &repository.git,
            || {
                lock_seen.set(head_lock.exists());
                fs::write(&head, "ref: refs/heads/racer\n").unwrap();
            },
        )
        .unwrap_err();

        assert!(lock_seen.get());
        assert_eq!(error.to_string(), "git_selected_commit_ref_conflict");
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["rev-parse", "refs/heads/master"]
            )
            .unwrap()
            .trim(),
            before
        );
        assert_eq!(
            command(
                &repository.git,
                repository.root(),
                &["rev-parse", "refs/heads/racer"]
            )
            .unwrap()
            .trim(),
            before
        );
        assert!(!head_lock.exists());
    }

    #[test]
    fn prepared_ref_transaction_publishes_unborn_and_detached_heads() {
        let git = test_git();
        let unborn = tempfile::tempdir().unwrap();
        command(&git, unborn.path(), &["init", "-q"]).unwrap();
        command(&git, unborn.path(), &["config", "user.name", "Unborn"]).unwrap();
        command(
            &git,
            unborn.path(),
            &["config", "user.email", "unborn@threadterm.invalid"],
        )
        .unwrap();
        fs::write(unborn.path().join("new.txt"), "new\n").unwrap();
        command(&git, unborn.path(), &["add", "new.txt"]).unwrap();
        let expected = read_head(unborn.path(), &git).unwrap();
        assert!(matches!(expected, Head::Unborn { .. }));
        let tree = command(&git, unborn.path(), &["write-tree"])
            .unwrap()
            .trim()
            .to_owned();
        let message = unborn.path().join(".git/SELECTED_MESSAGE");
        fs::write(&message, "first\n").unwrap();
        let commit = create_commit(unborn.path(), &tree, None, &message, false, &[], &git).unwrap();
        publish_ref(unborn.path(), &expected, &commit, &message, &[], &git).unwrap();
        assert_eq!(
            command(&git, unborn.path(), &["rev-parse", "HEAD"])
                .unwrap()
                .trim(),
            commit
        );

        let detached = Repository::new();
        command(
            &detached.git,
            detached.root(),
            &["checkout", "-q", "--detach"],
        )
        .unwrap();
        fs::write(detached.root().join("a.txt"), "detached\n").unwrap();
        command(&detached.git, detached.root(), &["add", "a.txt"]).unwrap();
        let expected = read_head(detached.root(), &detached.git).unwrap();
        assert!(matches!(expected, Head::Detached { .. }));
        let tree = command(&detached.git, detached.root(), &["write-tree"])
            .unwrap()
            .trim()
            .to_owned();
        let message = detached.root().join(".git/SELECTED_MESSAGE");
        fs::write(&message, "detached\n").unwrap();
        let commit = create_commit(
            detached.root(),
            &tree,
            expected.oid(),
            &message,
            false,
            &[],
            &detached.git,
        )
        .unwrap();
        publish_ref(
            detached.root(),
            &expected,
            &commit,
            &message,
            &[],
            &detached.git,
        )
        .unwrap();
        assert_eq!(
            command(&detached.git, detached.root(), &["rev-parse", "HEAD"])
                .unwrap()
                .trim(),
            commit
        );
        assert!(command(
            &detached.git,
            detached.root(),
            &["symbolic-ref", "-q", "HEAD"]
        )
        .is_err());
    }

    #[test]
    fn dispatch_publishes_unborn_detached_and_registered_linked_worktrees() {
        let git = test_git();
        let unborn = tempfile::tempdir().unwrap();
        command(&git, unborn.path(), &["init", "-q"]).unwrap();
        command(&git, unborn.path(), &["config", "user.name", "Shapes"]).unwrap();
        command(
            &git,
            unborn.path(),
            &["config", "user.email", "shapes@threadterm.invalid"],
        )
        .unwrap();
        fs::write(unborn.path().join("new.txt"), "new\n").unwrap();
        command(&git, unborn.path(), &["add", "new.txt"]).unwrap();
        let db = Database::open(&unborn.path().join("runtime.sqlite")).unwrap();
        fs::write(unborn.path().join(".git/info/exclude"), "runtime.sqlite*\n").unwrap();
        initialize(&db).unwrap();
        let project = db
            .add_project(
                unborn.path().to_str().unwrap(),
                Some("unborn"),
                "add-unborn",
            )
            .unwrap();
        let request = request_for(
            &project.id,
            unborn.path(),
            None,
            "dispatch-unborn",
            &["new.txt"],
            &git,
        );
        let unborn_result = dispatch(&db, METHOD, &request).unwrap().unwrap();
        assert!(unborn_result["parent"].is_null());
        assert_eq!(unborn_result["refTarget"], "refs/heads/master");
        assert_eq!(
            command(&git, unborn.path(), &["show", "HEAD:new.txt"]).unwrap(),
            "new\n"
        );

        let detached = Repository::new();
        command(
            &detached.git,
            detached.root(),
            &["checkout", "-q", "--detach"],
        )
        .unwrap();
        fs::write(detached.root().join("a.txt"), "detached\n").unwrap();
        command(&detached.git, detached.root(), &["add", "a.txt"]).unwrap();
        let request = detached.request("dispatch-detached", &["a.txt"]);
        let detached_result = dispatch(&detached.db, METHOD, &request).unwrap().unwrap();
        assert!(detached_result["parent"].is_string());
        assert!(detached_result["refTarget"].is_null());
        assert!(command(
            &detached.git,
            detached.root(),
            &["symbolic-ref", "-q", "HEAD"]
        )
        .is_err());
        assert_eq!(
            command(&detached.git, detached.root(), &["show", "HEAD:a.txt"]).unwrap(),
            "detached\n"
        );

        let linked = Repository::new();
        command(&linked.git, linked.root(), &["branch", "linked"]).unwrap();
        let worktree_parent = tempfile::tempdir().unwrap();
        let worktree = worktree_parent.path().join("worktree");
        command(
            &linked.git,
            linked.root(),
            &[
                "worktree",
                "add",
                "-q",
                worktree.to_str().unwrap(),
                "linked",
            ],
        )
        .unwrap();
        let canonical = worktree.canonicalize().unwrap();
        let head = command(&linked.git, &canonical, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        linked
            .db
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO worktrees(id,project_id,path,branch,head,is_main,locked) VALUES('selected-linked',?,?,?,?,0,0)",
                    rusqlite::params![linked.project_id, canonical.to_string_lossy(), "linked", head],
                )?;
                Ok(())
            })
            .unwrap();
        fs::write(canonical.join("a.txt"), "linked\n").unwrap();
        command(&linked.git, &canonical, &["add", "a.txt"]).unwrap();
        let worktree_text = canonical.to_str().unwrap();
        let request = request_for(
            &linked.project_id,
            &canonical,
            Some(worktree_text),
            "dispatch-linked",
            &["a.txt"],
            &linked.git,
        );
        dispatch(&linked.db, METHOD, &request).unwrap().unwrap();
        assert_eq!(
            command(&linked.git, &canonical, &["show", "HEAD:a.txt"]).unwrap(),
            "linked\n"
        );
        assert_eq!(
            command(&linked.git, linked.root(), &["rev-parse", "master"])
                .unwrap()
                .trim(),
            command(&linked.git, linked.root(), &["rev-parse", "HEAD"])
                .unwrap()
                .trim()
        );
    }

    #[test]
    fn status_reader_reports_identity_and_required_git_capabilities() {
        let repository = Repository::new();
        let reader = GitStatusReader::new(repository.root()).unwrap();
        let snapshot = reader.snapshot().unwrap();
        assert_eq!(snapshot["supported"], true);
        assert_eq!(snapshot["head"]["kind"], "branch");
        assert_eq!(snapshot["indexFingerprint"].as_str().unwrap().len(), 64);
        assert!(snapshot["gitVersion"]
            .as_str()
            .unwrap()
            .starts_with("git version "));
        assert_eq!(reader.identity().unwrap()["head"], snapshot["head"]);
        assert_eq!(
            reader.read(&["rev-parse", "--show-prefix"]).unwrap().trim(),
            ""
        );
    }

    #[test]
    fn capability_infrastructure_failure_is_reported_as_unsupported() {
        let repository = Repository::new();
        let mut unavailable = repository.git.clone();
        let missing = repository.root().join("missing-git.exe");
        unavailable.path = missing.clone();
        unavailable.cache_key.path = missing;
        unavailable.cache_key.fingerprint = [0xa5; 32];

        let result = capabilities(repository.root(), &unavailable);
        assert!(!result.supported);
        assert_eq!(
            result.unsupported_reason.as_deref(),
            Some("git_capability_probe_failed")
        );
    }

    #[test]
    fn staged_row_snapshot_does_not_invoke_configured_fsmonitor() {
        let repository = Repository::new();
        fs::write(repository.root().join("a.txt"), "staged\n").unwrap();
        command(&repository.git, repository.root(), &["add", "a.txt"]).unwrap();
        write_hook(
            &repository,
            "fsmonitor-test",
            "#!/bin/sh\nprintf x >> fsmonitor-count\nprintf '\\n'\n",
        );
        let hook = repository.root().join(".git/hooks/fsmonitor-test");
        command(
            &repository.git,
            repository.root(),
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
        )
        .unwrap();

        let staged = read_staged_rows(repository.root(), "", &repository.git).unwrap();
        assert!(staged.contains_key("a.txt"));
        assert!(!repository.root().join("fsmonitor-count").exists());
    }

    #[test]
    fn request_validation_rejects_ambiguous_or_unsafe_inputs() {
        let valid = Request {
            project_id: "p".to_owned(),
            worktree_path: None,
            operation_id: "o".to_owned(),
            message: "message".to_owned(),
            selected: vec![SelectedRow {
                path: "a.txt".to_owned(),
                index_status: "M".to_owned(),
                original_path: None,
            }],
            expected_head: Head::Detached {
                oid: "1".repeat(40),
            },
            expected_index_fingerprint: "2".repeat(64),
        };
        assert!(validate_request(&valid).is_ok());

        let mut duplicate = serde_json::to_value(&valid).unwrap();
        duplicate["selected"] = json!([
            {"path":"a.txt","indexStatus":"M"},
            {"path":"a.txt","indexStatus":"M"}
        ]);
        let duplicate: Request = serde_json::from_value(duplicate).unwrap();
        assert!(validate_request(&duplicate).is_err());

        let mut blank_message = serde_json::to_value(&valid).unwrap();
        blank_message["message"] = json!(" \r\n\t");
        let blank_message: Request = serde_json::from_value(blank_message).unwrap();
        assert!(validate_request(&blank_message).is_err());

        let mut message_boundary = valid.clone();
        message_boundary.message = "x".repeat(MAX_MESSAGE_BYTES - 1);
        assert!(validate_request(&message_boundary).is_ok());
        message_boundary.message.push('x');
        assert!(validate_request(&message_boundary).is_err());
        message_boundary.message.pop();
        message_boundary.message.push('\n');
        assert_eq!(message_boundary.message.len(), MAX_MESSAGE_BYTES);
        assert!(validate_request(&message_boundary).is_ok());

        for params in [
            json!({
                "projectId":"p", "operationId":"o", "message":"m",
                "selected":[{"path":"../escape","indexStatus":"M"}],
                "expectedHead":{"kind":"detached","oid":"1111111111111111111111111111111111111111"},
                "expectedIndexFingerprint":"22"
            }),
            json!({
                "projectId":"p", "operationId":"o", "message":"m", "extra":true,
                "selected":[{"path":"a","indexStatus":"M"}],
                "expectedHead":{"kind":"detached","oid":"1111111111111111111111111111111111111111"},
                "expectedIndexFingerprint":"2222222222222222222222222222222222222222222222222222222222222222"
            }),
        ] {
            assert!(dispatch(
                &Database::open(&tempfile::NamedTempFile::new().unwrap().path()).unwrap(),
                METHOD,
                &params
            )
            .is_err());
        }
    }

    #[test]
    fn retained_path_receipt_is_bounded_and_marks_truncation() {
        let mut staged = BTreeMap::new();
        for index in 0..(MAX_PATHS + 1) {
            let path = format!("{index:04}.txt");
            staged.insert(
                path.clone(),
                StagedRow {
                    wire: SelectedRow {
                        path: path.clone(),
                        index_status: "M".to_owned(),
                        original_path: None,
                    },
                    repo_path: path,
                    repo_original_path: None,
                    original_outside_root: false,
                },
            );
        }
        let (retained, truncated) = retained_paths(&staged, &BTreeMap::new());
        assert_eq!(retained.len(), MAX_PATHS);
        assert!(truncated);
        assert!(serde_json::to_vec(&retained).unwrap().len() <= MAX_RETAINED_RESULT_BYTES);
    }

    fn write_hook(repository: &Repository, name: &str, body: &str) {
        let path = repository.root().join(".git/hooks").join(name);
        fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }
}
