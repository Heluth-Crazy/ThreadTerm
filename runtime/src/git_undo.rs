use std::{
    collections::HashSet,
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    git_actions::{discard_worktree_fingerprint, verify_discard_fingerprints},
    git_read::{
        blob_fingerprint, blob_spec, fingerprint_reader, repo_prefix, run_git, run_git_to_file,
        validate_relative, LOCAL_TIMEOUT,
    },
    workspace_services::scoped_path,
};

const DISCARD_PAYLOAD_VERSION: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObjectIdentity {
    oid: String,
    mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum DiscardPath {
    Recycled {
        path: String,
    },
    Tracked {
        path: String,
        index: ObjectIdentity,
        #[serde(skip_serializing_if = "Option::is_none")]
        post_oid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        post_mode: Option<String>,
        #[serde(default)]
        handoff_complete: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        working_oid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        working_mode: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        captured_index: Option<ObjectIdentity>,
    },
}

impl DiscardPath {
    fn path(&self) -> &str {
        match self {
            Self::Recycled { path } | Self::Tracked { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscardPayload {
    version: u8,
    paths: Vec<DiscardPath>,
    /// Present only after an Undo restored some but not all of `paths`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    partial: Option<PartialUndo>,
}

/// Records a partially applied Undo so the entry is never advertised as
/// undoable again and the list can name what was restored and what was not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PartialUndo {
    pub(crate) applied: Vec<String>,
    pub(crate) remaining: Vec<String>,
}

#[derive(Clone, Debug)]
struct PreparedPath {
    path: String,
    index: ObjectIdentity,
    post_oid: String,
    post_mode: String,
    working_oid: Option<String>,
    working_mode: Option<String>,
    captured_index: Option<ObjectIdentity>,
}

/// Validated, object-available discard recovery. Construction performs every
/// comparison for every path before [`apply_discard`] can write one of them.
#[derive(Debug)]
pub(crate) struct PreparedDiscard {
    paths: Vec<PreparedPath>,
}

/// Build an identifier-only journal skeleton before any worktree handoff. The
/// bytes that are actually removed and installed are captured by
/// [`discard_handoff`], after each atomic displacement.
pub(crate) fn capture_discard(
    root: &Path,
    paths: &[String],
    params: &Map<String, Value>,
) -> Result<Value> {
    verify_capture_fence(root, paths, params)?;
    let expected_files = params["expectedFingerprints"]
        .as_object()
        .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
    let mut captured = Vec::with_capacity(paths.len());
    for path in paths {
        validate_relative(path)?;
        let Some(index) = index_entry(root, path)? else {
            captured.push(DiscardPath::Recycled { path: path.clone() });
            continue;
        };
        let expected = expected_files
            .get(path)
            .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
        match expected {
            Value::Null => {
                if discard_worktree_fingerprint(root, path)
                    .map_err(capture_path_error)?
                    .is_some()
                {
                    return Err(anyhow!("discard_conflict"));
                }
                ensure_supported_post_representation(root, &index, None)?;
            }
            Value::String(fingerprint) => {
                let target = regular_scoped_path(root, path).map_err(capture_path_error)?;
                let metadata = fs::symlink_metadata(&target).map_err(capture_path_error)?;
                let mode = physical_mode(&metadata, Some(&index.mode))?;
                let bytes = fs::File::open(&target).map_err(capture_path_error)?;
                if fingerprint_reader(bytes).map_err(capture_path_error)? != *fingerprint {
                    return Err(anyhow!("discard_conflict"));
                }
                ensure_supported_post_representation(root, &index, Some(&mode))?;
            }
            _ => return Err(anyhow!("invalid_fingerprints")),
        }
        let captured_index =
            (head_entry(root, path)? != Some(index.clone())).then(|| index.clone());
        captured.push(DiscardPath::Tracked {
            path: path.clone(),
            index,
            post_oid: None,
            post_mode: None,
            handoff_complete: false,
            working_oid: None,
            working_mode: None,
            captured_index,
        });
    }
    // Catch index or worktree changes after the per-path support checks. The
    // handoff validates the displaced file again before it stores an object.
    verify_capture_fence(root, paths, params)?;
    Ok(serde_json::to_value(DiscardPayload {
        version: DISCARD_PAYLOAD_VERSION,
        paths: captured,
        partial: None,
    })?)
}

#[derive(Debug)]
pub(crate) struct HandoffError {
    path: String,
    kept_displaced: Option<String>,
    detail: String,
}

impl fmt::Display for HandoffError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.detail, self.path)?;
        if let Some(kept) = &self.kept_displaced {
            write!(formatter, "; kept displaced file: {kept}")?;
        }
        Ok(())
    }
}

impl std::error::Error for HandoffError {}

#[derive(Debug)]
struct UndoHandoffError {
    /// `undo_conflict` unless the filesystem cannot install a no-replace copy.
    code: &'static str,
    /// Paths whose worktree content was already restored when this failed.
    applied: Vec<String>,
    remaining: Vec<String>,
    kept_displaced: Option<String>,
    detail: String,
    no_effect: bool,
}

impl fmt::Display for UndoHandoffError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: completed=[{}]; remaining=[{}]",
            self.code,
            self.applied.join(", "),
            self.remaining.join(", ")
        )?;
        if let Some(kept) = &self.kept_displaced {
            write!(formatter, "; kept displaced file: {kept}")?;
        }
        write!(formatter, "; {}", self.detail)
    }
}

impl std::error::Error for UndoHandoffError {}

pub(crate) fn kept_displaced(error: &anyhow::Error) -> Option<&str> {
    if let Some(error) = error.downcast_ref::<HandoffError>() {
        error.kept_displaced.as_deref()
    } else {
        error
            .downcast_ref::<UndoHandoffError>()
            .and_then(|error| error.kept_displaced.as_deref())
    }
}

pub(crate) fn undo_no_effect(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<UndoHandoffError>()
        .is_some_and(|error| error.no_effect)
}

/// Paths already restored and paths still pending after a partial Undo handoff.
/// Callers use this to retire the journal entry instead of advertising it.
pub(crate) fn undo_progress(error: &anyhow::Error) -> Option<(&[String], &[String])> {
    error
        .downcast_ref::<UndoHandoffError>()
        .map(|error| (error.applied.as_slice(), error.remaining.as_slice()))
}

/// Splits a discard payload into the paths Undo can restore (tracked and fully
/// handed off) and the count that is only recoverable outside ThreadTerm, so the
/// journal list never advertises a Recycle-Bin path as undoable.
pub(crate) fn discard_undoable_paths(payload: &Value) -> Option<(Vec<String>, usize)> {
    let payload = decode_payload(payload).ok()?;
    let mut undoable = Vec::new();
    let mut recycled = 0;
    for entry in payload.paths {
        match entry {
            DiscardPath::Tracked {
                path,
                handoff_complete: true,
                ..
            } => undoable.push(path),
            _ => recycled += 1,
        }
    }
    Some((undoable, recycled))
}

/// Atomically hands one tracked path from its confirmed pre-image to its
/// post-discard image. A displaced original is never removed until the updated
/// payload is durable and both the installed and displaced bytes are rechecked.
pub(crate) fn discard_handoff(
    root: &Path,
    path: &str,
    params: &Map<String, Value>,
    payload: &mut Value,
    mut persist: impl FnMut(&Value) -> Result<()>,
) -> Result<()> {
    validate_relative(path)?;
    let expected = params
        .get("expectedFingerprints")
        .and_then(Value::as_object)
        .and_then(|files| files.get(path))
        .ok_or_else(|| anyhow!("invalid_fingerprints"))?;
    let mut decoded = decode_payload(payload)?;
    let entry = decoded
        .paths
        .iter_mut()
        .find(|entry| entry.path() == path)
        .ok_or_else(|| anyhow!("undo_capture_failed"))?;
    let DiscardPath::Tracked {
        index,
        post_oid,
        post_mode,
        handoff_complete,
        working_oid,
        working_mode,
        ..
    } = entry
    else {
        return Ok(());
    };
    if *handoff_complete || index_entry(root, path)?.as_ref() != Some(index) {
        return Err(anyhow!("discard_conflict"));
    }

    let target = root.join(path);
    let mut displaced = None;
    let (captured_oid, captured_mode) = match expected {
        Value::String(fingerprint) => {
            let checked = regular_scoped_path(root, path).map_err(capture_path_error)?;
            let mode = physical_mode(&fs::symlink_metadata(&checked)?, Some(&index.mode))?;
            let displaced_path = unique_displaced(&checked)?;
            fs::rename(&checked, &displaced_path).map_err(|error| {
                handoff_error(root, path, Some(&displaced_path), "discard_conflict", error)
            })?;
            run_discard_after_displace_hook(root, path).map_err(|error| {
                handoff_error(
                    root,
                    path,
                    Some(&displaced_path),
                    "discard_incomplete",
                    error,
                )
            })?;
            let oid = hash_file(root, &displaced_path, true).map_err(|error| {
                handoff_error(
                    root,
                    path,
                    Some(&displaced_path),
                    "undo_capture_failed",
                    error,
                )
            })?;
            let captured_fingerprint = blob_fingerprint(root, &oid).map_err(|error| {
                handoff_error(
                    root,
                    path,
                    Some(&displaced_path),
                    "undo_capture_failed",
                    error,
                )
            })?;
            let displaced_identity =
                file_identity(root, &displaced_path, &mode).map_err(|error| {
                    handoff_error(root, path, Some(&displaced_path), "discard_conflict", error)
                })?;
            if captured_fingerprint != *fingerprint
                || displaced_identity != (oid.clone(), mode.clone())
            {
                return Err(restore_or_keep_error(
                    root,
                    path,
                    &displaced_path,
                    &target,
                    "discard_conflict",
                ));
            }
            displaced = Some((displaced_path, oid.clone(), mode.clone()));
            (Some(oid), Some(mode))
        }
        Value::Null => {
            if fs::symlink_metadata(&target).is_ok() {
                return Err(HandoffError {
                    path: path.to_owned(),
                    kept_displaced: None,
                    detail: "discard_conflict".into(),
                }
                .into());
            }
            (None, None)
        }
        _ => return Err(anyhow!("invalid_fingerprints")),
    };

    if index_entry(root, path).ok().flatten().as_ref() != Some(index) {
        if let Some((displaced_path, _, _)) = &displaced {
            return Err(restore_or_keep_error(
                root,
                path,
                displaced_path,
                &target,
                "discard_conflict",
            ));
        }
        return Err(anyhow!("discard_conflict"));
    }
    let installed_mode =
        post_physical_mode(root, index, captured_mode.as_deref()).map_err(|error| {
            handoff_error(
                root,
                path,
                displaced_path(&displaced),
                "undo_capture_failed",
                error,
            )
        })?;
    // A discarded deletion removed the file's directories with it; the staged
    // post-image lives beside the target, so those directories come back first.
    // Each level is validated, and the target is re-resolved afterwards so a
    // symlinked directory cannot redirect the write outside the registered root.
    ensure_parent(root, &target).map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "undo_capture_failed",
            error,
        )
    })?;
    let target = scoped_path(root, path, false).map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "undo_capture_failed",
            error,
        )
    })?;
    let staged = create_temp_from_git(
        root,
        &target,
        "post",
        &["cat-file", "--filters", &blob_spec("", path)],
        &installed_mode,
    )
    .map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "undo_capture_failed",
            error,
        )
    })?;
    let generated_oid = hash_file(root, &staged.0, true).map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "undo_capture_failed",
            error,
        )
    })?;
    install_no_replace(&staged.0, &target).map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            error.detail(),
            &error,
        )
    })?;
    let actual = file_identity(root, &target, &installed_mode).map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "discard_conflict",
            error,
        )
    })?;
    if actual != (generated_oid, installed_mode.clone()) {
        return Err(handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "discard_conflict",
            anyhow!("installed file changed"),
        ));
    }
    if let Some((displaced_path, oid, mode)) = &displaced {
        let identity = file_identity(root, displaced_path, mode).map_err(|error| {
            handoff_error(root, path, Some(displaced_path), "discard_conflict", error)
        })?;
        if identity != (oid.clone(), mode.clone()) {
            return Err(handoff_error(
                root,
                path,
                Some(displaced_path),
                "discard_conflict",
                anyhow!("displaced file changed"),
            ));
        }
    }

    *working_oid = captured_oid;
    *working_mode = captured_mode;
    *post_oid = Some(actual.0);
    *post_mode = Some(actual.1);
    *handoff_complete = true;
    let updated = serde_json::to_value(&decoded).map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "undo_capture_failed",
            error,
        )
    })?;
    persist(&updated).map_err(|error| {
        handoff_error(
            root,
            path,
            displaced_path(&displaced),
            "undo_capture_failed",
            error,
        )
    })?;
    *payload = updated;

    if let Some((displaced_path, oid, mode)) = &displaced {
        let identity = file_identity(root, displaced_path, mode).map_err(|error| {
            handoff_error(root, path, Some(displaced_path), "discard_conflict", error)
        })?;
        if identity != (oid.clone(), mode.clone()) {
            return Err(handoff_error(
                root,
                path,
                Some(displaced_path),
                "discard_conflict",
                anyhow!("displaced file changed"),
            ));
        }
        fs::remove_file(displaced_path).map_err(|error| {
            handoff_error(
                root,
                path,
                Some(displaced_path),
                "discard_incomplete",
                error,
            )
        })?;
    }
    Ok(())
}

pub(crate) fn preflight_discard(root: &Path, payload: &Value) -> Result<PreparedDiscard> {
    let payload = decode_payload(payload)?;
    let mut seen = HashSet::new();
    let mut conflicts = Vec::new();
    let mut prepared = Vec::new();
    for entry in payload.paths {
        let path = entry.path().to_owned();
        validate_relative(&path).map_err(|_| anyhow!("undo_unavailable"))?;
        if !seen.insert(path.clone()) {
            return Err(anyhow!("undo_unavailable"));
        }
        let DiscardPath::Tracked {
            index,
            post_oid,
            post_mode,
            handoff_complete,
            working_oid,
            working_mode,
            captured_index,
            ..
        } = entry
        else {
            continue;
        };
        if !handoff_complete {
            return Err(anyhow!("undo_unavailable"));
        }
        validate_identity(&index)?;
        let post_oid = post_oid.ok_or_else(|| anyhow!("undo_unavailable"))?;
        let post_mode = post_mode.ok_or_else(|| anyhow!("undo_unavailable"))?;
        validate_oid(&post_oid)?;
        validate_worktree_mode(&post_mode)?;
        if let Some(identity) = &captured_index {
            validate_identity(identity)?;
            if identity != &index {
                return Err(anyhow!("undo_unavailable"));
            }
        }
        match (&working_oid, &working_mode) {
            (Some(oid), Some(mode)) => {
                validate_oid(oid)?;
                validate_worktree_mode(mode)?;
            }
            (None, None) => {}
            _ => return Err(anyhow!("undo_unavailable")),
        }
        for oid in [&index.oid, &post_oid]
            .into_iter()
            .chain(working_oid.iter())
        {
            if !object_exists(root, oid) {
                return Err(anyhow!("undo_unavailable"));
            }
        }
        let current_index = index_entry(root, &path).map_err(|_| anyhow!("undo_unavailable"))?;
        let current_worktree = current_worktree(root, &path, &post_mode);
        if current_index.as_ref() != Some(&index)
            || current_worktree.as_ref().ok() != Some(&(post_oid.clone(), post_mode.clone()))
        {
            conflicts.push(path.clone());
        }
        prepared.push(PreparedPath {
            path,
            index,
            post_oid,
            post_mode,
            working_oid,
            working_mode,
            captured_index,
        });
    }
    if prepared.is_empty() {
        return Err(anyhow!("undo_unavailable"));
    }
    if !conflicts.is_empty() {
        return Err(anyhow!("undo_conflict: {}", conflicts.join(", ")));
    }
    Ok(PreparedDiscard { paths: prepared })
}

pub(crate) fn apply_discard(root: &Path, prepared: PreparedDiscard) -> Result<()> {
    if let Err(error) = recheck_prepared(root, &prepared) {
        return Err(undo_handoff_error(
            root,
            &prepared.paths,
            &[],
            None,
            error,
        ));
    }
    let mut staged = Vec::with_capacity(prepared.paths.len());
    for entry in &prepared.paths {
        let target = root.join(&entry.path);
        let staged_path = if let Some(oid) = &entry.working_oid {
            // The replacement is installed beside the target, so restoring a path
            // whose directories went away recreates them before staging.
            ensure_parent(root, &target).map_err(|error| {
                undo_handoff_error(root, &prepared.paths, &[], None, error)
            })?;
            let target = scoped_path(root, &entry.path, false).map_err(|error| {
                undo_handoff_error(root, &prepared.paths, &[], None, error)
            })?;
            Some(
                create_temp_from_git(
                    root,
                    &target,
                    "undo",
                    &["cat-file", "blob", oid],
                    entry.working_mode.as_deref().unwrap_or("100644"),
                )
                .map_err(|error| {
                    undo_handoff_error(root, &prepared.paths, &[], None, error)
                })?,
            )
        } else {
            None
        };
        staged.push(staged_path);
    }
    run_undo_after_prepare_hook(root)
        .map_err(|error| undo_handoff_error(root, &prepared.paths, &[], None, error))?;

    // Every path whose worktree content was restored, in completion order. A
    // later failure reports these as completed and never as remaining.
    let mut applied: Vec<String> = Vec::new();
    for (position, entry) in prepared.paths.iter().enumerate() {
        // Parents were recreated and validated during preparation; resolve the
        // existing post-image through the root guard before swapping it.
        let target = scoped_path(root, &entry.path, true)
            .map_err(|error| undo_handoff_error(root, &prepared.paths, &applied, None, error))?;
        let displaced = unique_displaced(&target).map_err(|error| {
            undo_handoff_error(root, &prepared.paths, &applied, None, error)
        })?;
        if let Err(error) = fs::rename(&target, &displaced) {
            return Err(undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                None,
                error,
            ));
        }
        let expected = (entry.post_oid.clone(), entry.post_mode.clone());
        if file_identity(root, &displaced, &entry.post_mode).ok() != Some(expected) {
            let error =
                restore_or_keep_error(root, &entry.path, &displaced, &target, "undo_conflict");
            return Err(undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                kept_displaced(&error).map(str::to_owned),
                error,
            ));
        }
        if index_entry(root, &entry.path).ok().flatten().as_ref() != Some(&entry.index) {
            let error =
                restore_or_keep_error(root, &entry.path, &displaced, &target, "undo_conflict");
            return Err(undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                kept_displaced(&error).map(str::to_owned),
                error,
            ));
        }
        if let Some(replacement) = &staged[position] {
            if let Err(error) = install_no_replace(&replacement.0, &target) {
                return Err(undo_handoff_error_with_code(
                    error.detail(),
                    &prepared.paths,
                    &applied,
                    Some(relative_path(root, &displaced)),
                    error,
                ));
            }
        } else if fs::symlink_metadata(&target).is_ok() {
            return Err(undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                Some(relative_path(root, &displaced)),
                anyhow!("replacement path reappeared"),
            ));
        }
        // The worktree now holds the captured content; record it before any
        // remaining step can fail so the failure report stays accurate.
        applied.push(entry.path.clone());
        run_undo_after_install_hook(root, &entry.path).map_err(|error| {
            undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                Some(relative_path(root, &displaced)),
                error,
            )
        })?;
        if index_entry(root, &entry.path).ok().flatten().as_ref() != Some(&entry.index) {
            return Err(undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                Some(relative_path(root, &displaced)),
                anyhow!("index changed during undo"),
            ));
        }
        if let Some(identity) = &entry.captured_index {
            if let Err(error) = update_index(root, &entry.path, identity) {
                return Err(undo_handoff_error(
                    root,
                    &prepared.paths,
                    &applied,
                    Some(relative_path(root, &displaced)),
                    error,
                ));
            }
        }
        if index_entry(root, &entry.path).ok().flatten().as_ref() != Some(&entry.index) {
            return Err(undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                Some(relative_path(root, &displaced)),
                anyhow!("index changed during undo"),
            ));
        }
        let replacement_matches = match (&entry.working_oid, &entry.working_mode) {
            (Some(oid), Some(mode)) => {
                current_worktree(root, &entry.path, mode).ok() == Some((oid.clone(), mode.clone()))
            }
            (None, None) => fs::symlink_metadata(&target).is_err(),
            _ => false,
        };
        if !replacement_matches
            || file_identity(root, &displaced, &entry.post_mode).ok()
                != Some((entry.post_oid.clone(), entry.post_mode.clone()))
        {
            return Err(undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                Some(relative_path(root, &displaced)),
                anyhow!("path changed during undo"),
            ));
        }
        fs::remove_file(&displaced).map_err(|error| {
            undo_handoff_error(
                root,
                &prepared.paths,
                &applied,
                Some(relative_path(root, &displaced)),
                error,
            )
        })?;
    }
    Ok(())
}

pub(crate) fn discard_available(root: &Path, payload: &Value) -> bool {
    let Ok(payload) = decode_payload(payload) else {
        return false;
    };
    // A partially applied Undo was already consumed and is never offered again.
    if payload.partial.is_some() {
        return false;
    }
    let mut tracked = false;
    let mut seen = HashSet::new();
    for entry in payload.paths {
        if validate_relative(entry.path()).is_err() || !seen.insert(entry.path().to_owned()) {
            return false;
        }
        let DiscardPath::Tracked {
            index,
            post_oid,
            post_mode,
            handoff_complete,
            working_oid,
            working_mode,
            captured_index,
            ..
        } = entry
        else {
            continue;
        };
        tracked = true;
        if !handoff_complete
            || validate_identity(&index).is_err()
            || post_oid
                .as_deref()
                .map_or(true, |oid| validate_oid(oid).is_err())
            || post_mode
                .as_deref()
                .map_or(true, |mode| validate_worktree_mode(mode).is_err())
            || captured_index
                .as_ref()
                .is_some_and(|identity| identity != &index || validate_identity(identity).is_err())
            || !matches!(
                (&working_oid, &working_mode),
                (None, None) | (Some(_), Some(_))
            )
            || working_mode
                .as_deref()
                .is_some_and(|mode| validate_worktree_mode(mode).is_err())
            || !object_exists(root, &index.oid)
            || post_oid
                .as_ref()
                .map_or(true, |oid| !object_exists(root, oid))
            || working_oid
                .as_ref()
                .is_some_and(|oid| validate_oid(oid).is_err() || !object_exists(root, oid))
        {
            return false;
        }
    }
    tracked
}

fn decode_payload(payload: &Value) -> Result<DiscardPayload> {
    let payload: DiscardPayload =
        serde_json::from_value(payload.clone()).map_err(|_| anyhow!("undo_unavailable"))?;
    if payload.version != DISCARD_PAYLOAD_VERSION || payload.paths.is_empty() {
        return Err(anyhow!("undo_unavailable"));
    }
    Ok(payload)
}

fn verify_capture_fence(root: &Path, paths: &[String], params: &Map<String, Value>) -> Result<()> {
    verify_discard_fingerprints(root, paths, params).map_err(|error| {
        if matches!(
            error.to_string().as_str(),
            "file_conflict" | "index_conflict"
        ) {
            anyhow!("discard_conflict")
        } else {
            error
        }
    })
}

fn capture_path_error(error: impl Into<anyhow::Error>) -> anyhow::Error {
    let error = error.into();
    let state_changed = matches!(
        error.to_string().as_str(),
        "invalid_path" | "invalid_file_type" | "path_escape"
    ) || error.downcast_ref::<std::io::Error>().is_some_and(|error| {
        matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        )
    });
    if state_changed {
        anyhow!("discard_conflict")
    } else {
        error
    }
}

fn validate_oid(oid: &str) -> Result<()> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(anyhow!("undo_unavailable"))
    }
}

fn validate_worktree_mode(mode: &str) -> Result<()> {
    if matches!(mode, "100644" | "100755") {
        Ok(())
    } else {
        Err(anyhow!("undo_unavailable"))
    }
}

fn validate_identity(identity: &ObjectIdentity) -> Result<()> {
    validate_oid(&identity.oid)?;
    if matches!(identity.mode.as_str(), "100644" | "100755" | "120000") {
        Ok(())
    } else {
        Err(anyhow!("undo_unavailable"))
    }
}

fn object_exists(root: &Path, oid: &str) -> bool {
    validate_oid(oid).is_ok()
        && run_git(
            root,
            &["cat-file", "-e", &format!("{oid}^{{blob}}")],
            &[],
            None,
            LOCAL_TIMEOUT,
        )
        .is_ok()
}

#[cfg(test)]
fn hash_bytes(root: &Path, bytes: &[u8], write: bool) -> Result<String> {
    let mut args = vec!["hash-object"];
    if write {
        args.push("-w");
    }
    args.extend(["--no-filters", "--stdin"]);
    let output = run_git(root, &args, &[], Some(bytes), LOCAL_TIMEOUT)?;
    let oid = String::from_utf8(output)?.trim().to_owned();
    validate_oid(&oid).map_err(|_| anyhow!("git_failed"))?;
    Ok(oid)
}

fn index_entry(root: &Path, path: &str) -> Result<Option<ObjectIdentity>> {
    let literal = format!(":(literal){path}");
    let output = run_git(
        root,
        &["ls-files", "-s", "-z", "--", &literal],
        &[],
        None,
        LOCAL_TIMEOUT,
    )?;
    parse_index_entry(path, &output)
}

fn parse_index_entry(path: &str, output: &[u8]) -> Result<Option<ObjectIdentity>> {
    let normalized = path.replace('\\', "/");
    let mut found = None;
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| anyhow!("git_failed"))?;
        let meta = std::str::from_utf8(&record[..tab])?;
        let listed = std::str::from_utf8(&record[tab + 1..])?;
        if listed != normalized || found.is_some() {
            return Err(anyhow!("git_failed"));
        }
        let mut fields = meta.split_whitespace();
        let mode = fields.next().ok_or_else(|| anyhow!("git_failed"))?;
        let oid = fields.next().ok_or_else(|| anyhow!("git_failed"))?;
        let stage = fields.next().ok_or_else(|| anyhow!("git_failed"))?;
        if fields.next().is_some() || stage != "0" {
            return Err(anyhow!("index_unmerged"));
        }
        let identity = ObjectIdentity {
            oid: oid.to_owned(),
            mode: mode.to_owned(),
        };
        validate_identity(&identity).map_err(|_| anyhow!("git_failed"))?;
        found = Some(identity);
    }
    Ok(found)
}

fn head_entry(root: &Path, path: &str) -> Result<Option<ObjectIdentity>> {
    if run_git(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        &[],
        None,
        LOCAL_TIMEOUT,
    )
    .is_err()
    {
        return Ok(None);
    }
    let full = format!("{}{}", repo_prefix(root)?, path.replace('\\', "/"));
    let literal = format!(":(top,literal){full}");
    let output = run_git(
        root,
        &["ls-tree", "-z", "HEAD", "--", &literal],
        &[],
        None,
        LOCAL_TIMEOUT,
    )?;
    let Some(record) = output
        .split(|byte| *byte == 0)
        .find(|record| !record.is_empty())
    else {
        return Ok(None);
    };
    if output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .count()
        != 1
    {
        return Err(anyhow!("git_failed"));
    }
    let tab = record
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| anyhow!("git_failed"))?;
    let meta = std::str::from_utf8(&record[..tab])?;
    let mut fields = meta.split_whitespace();
    let mode = fields.next().ok_or_else(|| anyhow!("git_failed"))?;
    if fields.next() != Some("blob") {
        return Ok(None);
    }
    let oid = fields.next().ok_or_else(|| anyhow!("git_failed"))?;
    if fields.next().is_some() {
        return Err(anyhow!("git_failed"));
    }
    let identity = ObjectIdentity {
        oid: oid.to_owned(),
        mode: mode.to_owned(),
    };
    validate_identity(&identity).map_err(|_| anyhow!("git_failed"))?;
    Ok(Some(identity))
}

fn regular_scoped_path(root: &Path, path: &str) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(root.join(path))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(anyhow!("undo_capture_unsupported"));
    }
    scoped_path(root, path, true).map_err(|_| anyhow!("invalid_path"))
}

fn checked_current_target(root: &Path, path: &str) -> Result<PathBuf> {
    validate_relative(path)?;
    let target = root.join(path);
    let metadata = fs::symlink_metadata(&target).map_err(|_| anyhow!("undo_conflict: {path}"))?;
    if metadata.is_file() && !metadata.file_type().is_symlink() {
        scoped_path(root, path, true).map_err(|_| anyhow!("invalid_path"))
    } else {
        Err(anyhow!("undo_conflict: {path}"))
    }
}

fn current_worktree(root: &Path, path: &str, expected_mode: &str) -> Result<(String, String)> {
    let target = checked_current_target(root, path)?;
    let metadata = fs::symlink_metadata(&target)?;
    let mode = physical_mode(&metadata, Some(expected_mode))?;
    file_identity(root, &target, &mode)
}

fn physical_mode(metadata: &fs::Metadata, expected_mode: Option<&str>) -> Result<String> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(anyhow!("invalid_file_type"));
    }
    #[cfg(unix)]
    {
        let _ = expected_mode;
        use std::os::unix::fs::PermissionsExt;
        return Ok(if metadata.permissions().mode() & 0o111 == 0 {
            "100644"
        } else {
            "100755"
        }
        .into());
    }
    #[cfg(not(unix))]
    {
        Ok(if expected_mode == Some("100755") {
            "100755"
        } else {
            "100644"
        }
        .into())
    }
}

fn core_symlinks(root: &Path) -> bool {
    run_git(
        root,
        &["config", "--type=bool", "--get", "core.symlinks"],
        &[],
        None,
        LOCAL_TIMEOUT,
    )
    .ok()
    .and_then(|value| String::from_utf8(value).ok())
    .map(|value| value.trim().eq_ignore_ascii_case("true"))
    .unwrap_or(cfg!(unix))
}

fn ensure_supported_post_representation(
    root: &Path,
    index: &ObjectIdentity,
    current_mode: Option<&str>,
) -> Result<()> {
    if index.mode == "120000" && current_mode.is_none() && core_symlinks(root) {
        return Err(anyhow!("undo_capture_unsupported"));
    }
    Ok(())
}

fn post_physical_mode(
    root: &Path,
    index: &ObjectIdentity,
    captured_mode: Option<&str>,
) -> Result<String> {
    if index.mode == "120000" {
        if captured_mode.is_some() || !core_symlinks(root) {
            return Ok("100644".into());
        }
        return Err(anyhow!("undo_capture_unsupported"));
    }
    validate_worktree_mode(&index.mode)?;
    Ok(index.mode.clone())
}

fn unique_sibling(target: &Path, purpose: &str) -> Result<PathBuf> {
    let parent = target.parent().ok_or_else(|| anyhow!("invalid_path"))?;
    let name = target
        .file_name()
        .ok_or_else(|| anyhow!("invalid_path"))?
        .to_string_lossy();
    for _ in 0..8 {
        let path = parent.join(format!(".{name}.tt-{purpose}-{}", uuid::Uuid::new_v4()));
        if !path.exists() {
            return Ok(path);
        }
    }
    Err(anyhow!("undo_write_failed"))
}

fn unique_displaced(target: &Path) -> Result<PathBuf> {
    unique_sibling(target, "displaced")
}

fn set_mode(path: &Path, mode: &str) -> Result<()> {
    validate_worktree_mode(mode)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if mode == "100755" { 0o755 } else { 0o644 }),
        )?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

struct TempArtifact(PathBuf);

impl Drop for TempArtifact {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn create_temp_from_git(
    root: &Path,
    target: &Path,
    purpose: &str,
    args: &[&str],
    mode: &str,
) -> Result<TempArtifact> {
    let path = TempArtifact(unique_sibling(target, purpose)?);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path.0)?;
    run_git_to_file(root, args, file, LOCAL_TIMEOUT)?;
    set_mode(&path.0, mode)?;
    Ok(path)
}

/// Creates the missing parents of `target` one level at a time. Every existing
/// or newly created ancestor is proven to stay inside `root` first, so a
/// junction or symlink ancestor can never redirect the write outside the
/// worktree.
fn ensure_parent(root: &Path, target: &Path) -> Result<()> {
    let Some(parent) = target.parent() else {
        return Ok(());
    };
    let canonical_root = root.canonicalize().map_err(|_| anyhow!("invalid_path"))?;
    let mut missing = Vec::new();
    let mut ancestor = parent.to_path_buf();
    loop {
        match fs::symlink_metadata(&ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(ancestor.clone());
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| anyhow!("invalid_path"))?
                    .to_path_buf();
            }
            Err(error) => return Err(error.into()),
        }
    }
    let canonical = ancestor.canonicalize().map_err(|_| anyhow!("invalid_path"))?;
    if !canonical.starts_with(&canonical_root) || !fs::metadata(&canonical)?.is_dir() {
        return Err(anyhow!("invalid_path"));
    }
    for directory in missing.iter().rev() {
        fs::create_dir(directory)?;
        let created = directory.canonicalize().map_err(|_| anyhow!("invalid_path"))?;
        if !created.starts_with(&canonical_root) {
            return Err(anyhow!("invalid_path"));
        }
    }
    Ok(())
}

/// Why a no-replace installation could not complete. Only `Occupied` is a
/// conflict; a filesystem that cannot hard-link or copy is unsupported.
#[derive(Debug)]
enum InstallError {
    Occupied,
    Unsupported(String),
}

impl InstallError {
    fn detail(&self) -> &'static str {
        match self {
            Self::Occupied => "discard_conflict",
            Self::Unsupported(_) => "undo_capture_unsupported",
        }
    }
}

impl fmt::Display for InstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Occupied => write!(formatter, "target exists"),
            Self::Unsupported(detail) => write!(formatter, "{detail}"),
        }
    }
}

impl std::error::Error for InstallError {}

impl From<std::io::Error> for InstallError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Self::Occupied
        } else {
            Self::Unsupported(error.to_string())
        }
    }
}

fn hard_link(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if HARD_LINK_FAILURE_HOOK.with(|forced| forced.get()) {
        // ERROR_INVALID_FUNCTION on Windows, EOPNOTSUPP-like elsewhere: the
        // class of error a FAT/exFAT or network share reports.
        return Err(std::io::Error::from_raw_os_error(1));
    }
    fs::hard_link(source, target)
}

/// Installs `source` at `target` without replacing anything, keeping hard links
/// as the cheap path and falling back to an exclusive create-and-copy where the
/// filesystem cannot link. The temp source is consumed either way.
fn install_no_replace(source: &Path, target: &Path) -> Result<(), InstallError> {
    match hard_link(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(InstallError::Occupied)
        }
        Err(_) => copy_no_replace(source, target),
    }
}

fn copy_no_replace(source: &Path, target: &Path) -> Result<(), InstallError> {
    let mut input = fs::File::open(source)?;
    // The fallback must install the same mode the hard link would have shared.
    let permissions = input.metadata()?.permissions();
    let mut output = match OpenOptions::new().write(true).create_new(true).open(target) {
        Ok(output) => output,
        Err(error) => return Err(InstallError::from(error)),
    };
    let copied = std::io::copy(&mut input, &mut output)
        .and_then(|_| output.flush())
        .and_then(|_| output.sync_all());
    drop(output);
    let copied = copied.and_then(|_| fs::set_permissions(target, permissions));
    if let Err(error) = copied {
        // The target was created by this attempt; never leave a half copy behind.
        let _ = fs::remove_file(target);
        return Err(InstallError::Unsupported(error.to_string()));
    }
    // The caller's temp artifact is also removed on drop; a failed remove must
    // not turn a completed install into a reported failure.
    let _ = fs::remove_file(source);
    Ok(())
}

fn hash_file(root: &Path, path: &Path, write: bool) -> Result<String> {
    let relative = canonical_relative(root, path)?;
    let mut args = vec!["hash-object"];
    if write {
        args.push("-w");
    }
    args.extend(["--no-filters", "--", &relative]);
    let output = run_git(root, &args, &[], None, LOCAL_TIMEOUT)?;
    let oid = String::from_utf8(output)?.trim().to_owned();
    validate_oid(&oid).map_err(|_| anyhow!("git_failed"))?;
    Ok(oid)
}

fn file_identity(root: &Path, path: &Path, expected_mode: &str) -> Result<(String, String)> {
    let metadata = fs::symlink_metadata(path)?;
    let mode = physical_mode(&metadata, Some(expected_mode))?;
    if mode != expected_mode {
        return Err(anyhow!("file_mode_changed"));
    }
    Ok((hash_file(root, path, false)?, mode))
}

fn relative_path(root: &Path, path: &Path) -> String {
    canonical_relative(root, path).unwrap_or_else(|_| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "displaced-file".into())
    })
}

fn canonical_relative(root: &Path, path: &Path) -> Result<String> {
    let canonical_root = root.canonicalize().map_err(|_| anyhow!("invalid_path"))?;
    let canonical_path = path.canonicalize().map_err(|_| anyhow!("invalid_path"))?;
    let relative = canonical_path
        .strip_prefix(&canonical_root)
        .map_err(|_| anyhow!("invalid_path"))?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn displaced_path(displaced: &Option<(PathBuf, String, String)>) -> Option<&Path> {
    displaced.as_ref().map(|(path, _, _)| path.as_path())
}

fn handoff_error(
    root: &Path,
    path: &str,
    displaced: Option<&Path>,
    detail: &str,
    error: impl fmt::Display,
) -> anyhow::Error {
    let kept_displaced = displaced
        .filter(|path| path.exists())
        .map(|path| relative_path(root, path));
    HandoffError {
        path: path.to_owned(),
        kept_displaced,
        detail: format!("{detail}: {error}"),
    }
    .into()
}

fn restore_or_keep_error(
    root: &Path,
    path: &str,
    displaced: &Path,
    target: &Path,
    detail: &str,
) -> anyhow::Error {
    let restored = install_no_replace(displaced, target)
        .and_then(|()| fs::remove_file(displaced).map_err(InstallError::from));
    handoff_error(
        root,
        path,
        restored.err().map(|_| displaced),
        detail,
        "path changed during handoff",
    )
}

fn recheck_prepared(root: &Path, prepared: &PreparedDiscard) -> Result<()> {
    let mut conflicts = Vec::new();
    for entry in &prepared.paths {
        if index_entry(root, &entry.path)?.as_ref() != Some(&entry.index)
            || current_worktree(root, &entry.path, &entry.post_mode).ok()
                != Some((entry.post_oid.clone(), entry.post_mode.clone()))
        {
            conflicts.push(entry.path.clone());
        }
    }
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(anyhow!("undo_conflict: {}", conflicts.join(", ")))
    }
}

fn update_index(root: &Path, path: &str, identity: &ObjectIdentity) -> Result<()> {
    // `--cacheinfo` resolves its path from the repository top, while journal
    // paths are relative to the registered root (the same rule `head_entry` uses).
    let full = format!("{}{}", repo_prefix(root)?, path.replace('\\', "/"));
    let info = format!("{},{},{}", identity.mode, identity.oid, full);
    run_git(
        root,
        &["update-index", "--add", "--cacheinfo", &info],
        &[],
        None,
        LOCAL_TIMEOUT,
    )?;
    Ok(())
}

fn undo_handoff_error(
    _root: &Path,
    paths: &[PreparedPath],
    applied: &[String],
    kept_displaced: Option<String>,
    error: impl fmt::Display,
) -> anyhow::Error {
    undo_handoff_error_with_code("undo_conflict", paths, applied, kept_displaced, error)
}

fn undo_handoff_error_with_code(
    code: &'static str,
    paths: &[PreparedPath],
    applied: &[String],
    kept_displaced: Option<String>,
    error: impl fmt::Display,
) -> anyhow::Error {
    UndoHandoffError {
        code,
        applied: applied.to_vec(),
        remaining: paths
            .iter()
            .map(|entry| entry.path.clone())
            .filter(|path| !applied.contains(path))
            .collect(),
        no_effect: applied.is_empty() && kept_displaced.is_none(),
        kept_displaced,
        detail: error.to_string(),
    }
    .into()
}

#[cfg(test)]
thread_local! {
    static DISCARD_AFTER_DISPLACE_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&Path, &str) -> Result<()>>>> =
        const { std::cell::RefCell::new(None) };
    static UNDO_AFTER_PREPARE_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&Path) -> Result<()>>>> =
        const { std::cell::RefCell::new(None) };
    static UNDO_AFTER_INSTALL_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&Path, &str) -> Result<()>>>> =
        const { std::cell::RefCell::new(None) };
    /// Forces the hard-link step to fail so the copy fallback is testable off FAT.
    static HARD_LINK_FAILURE_HOOK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn run_discard_after_displace_hook(root: &Path, path: &str) -> Result<()> {
    DISCARD_AFTER_DISPLACE_HOOK.with(|hook| {
        let mut hook = hook.borrow_mut();
        if let Some(hook) = hook.as_mut() {
            hook(root, path)?;
        }
        Ok(())
    })
}

#[cfg(not(test))]
fn run_discard_after_displace_hook(_root: &Path, _path: &str) -> Result<()> {
    Ok(())
}

#[cfg(test)]
fn run_undo_after_prepare_hook(root: &Path) -> Result<()> {
    UNDO_AFTER_PREPARE_HOOK.with(|hook| {
        let mut hook = hook.borrow_mut();
        if let Some(hook) = hook.as_mut() {
            hook(root)?;
        }
        Ok(())
    })
}

#[cfg(not(test))]
fn run_undo_after_prepare_hook(_root: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
fn run_undo_after_install_hook(root: &Path, path: &str) -> Result<()> {
    UNDO_AFTER_INSTALL_HOOK.with(|hook| {
        let mut hook = hook.borrow_mut();
        if let Some(hook) = hook.as_mut() {
            hook(root, path)?;
        }
        Ok(())
    })
}

#[cfg(not(test))]
fn run_undo_after_install_hook(_root: &Path, _path: &str) -> Result<()> {
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_hooks {
    use super::*;

    pub(crate) struct HookGuard {
        slot: HookSlot,
    }

    enum HookSlot {
        Discard,
        Prepare,
        Install,
        HardLink,
    }

    impl Drop for HookGuard {
        fn drop(&mut self) {
            match self.slot {
                HookSlot::Discard => {
                    DISCARD_AFTER_DISPLACE_HOOK.with(|hook| *hook.borrow_mut() = None)
                }
                HookSlot::Prepare => UNDO_AFTER_PREPARE_HOOK.with(|hook| *hook.borrow_mut() = None),
                HookSlot::Install => UNDO_AFTER_INSTALL_HOOK.with(|hook| *hook.borrow_mut() = None),
                HookSlot::HardLink => HARD_LINK_FAILURE_HOOK.with(|forced| forced.set(false)),
            }
        }
    }

    pub(crate) fn install_discard_after_displace(
        hook: impl FnMut(&Path, &str) -> Result<()> + 'static,
    ) -> HookGuard {
        DISCARD_AFTER_DISPLACE_HOOK.with(|slot| {
            assert!(slot.borrow().is_none(), "discard hook already installed");
            *slot.borrow_mut() = Some(Box::new(hook));
        });
        HookGuard {
            slot: HookSlot::Discard,
        }
    }

    pub(crate) fn install_undo_after_prepare(
        hook: impl FnMut(&Path) -> Result<()> + 'static,
    ) -> HookGuard {
        UNDO_AFTER_PREPARE_HOOK.with(|slot| {
            assert!(slot.borrow().is_none(), "undo hook already installed");
            *slot.borrow_mut() = Some(Box::new(hook));
        });
        HookGuard {
            slot: HookSlot::Prepare,
        }
    }

    /// Fails after a path's replacement has been installed, modelling a later
    /// index or journal step that rejects a partially applied Undo.
    pub(crate) fn install_undo_after_install(
        hook: impl FnMut(&Path, &str) -> Result<()> + 'static,
    ) -> HookGuard {
        UNDO_AFTER_INSTALL_HOOK.with(|slot| {
            assert!(slot.borrow().is_none(), "undo install hook already installed");
            *slot.borrow_mut() = Some(Box::new(hook));
        });
        HookGuard {
            slot: HookSlot::Install,
        }
    }

    /// Forces `fs::hard_link` to fail so the no-replace copy fallback runs on a
    /// filesystem (NTFS here) that would normally link.
    pub(crate) fn fail_hard_links() -> HookGuard {
        HARD_LINK_FAILURE_HOOK.with(|forced| {
            assert!(!forced.get(), "hard-link failure already installed");
            forced.set(true);
        });
        HookGuard {
            slot: HookSlot::HardLink,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repo() -> tempfile::TempDir {
        let temp = tempfile::Builder::new()
            .prefix("git-undo-")
            .tempdir()
            .unwrap();
        git(temp.path(), &["init", "-q", "-b", "main"]);
        git(temp.path(), &["config", "user.email", "qa@example.test"]);
        git(temp.path(), &["config", "user.name", "QA"]);
        git(temp.path(), &["config", "core.autocrlf", "false"]);
        temp
    }

    fn index(root: &Path, path: &str) -> ObjectIdentity {
        index_entry(root, path).unwrap().unwrap()
    }

    fn request(root: &Path, paths: &[&str]) -> (Vec<String>, Map<String, Value>) {
        let mut files = Map::new();
        let mut indexes = Map::new();
        for path in paths {
            let work = fs::read(root.join(path))
                .ok()
                .map(|bytes| hex::encode(Sha256::digest(bytes)));
            let staged = index_entry(root, path)
                .unwrap()
                .map(|entry| blob_fingerprint(root, &entry.oid).unwrap());
            files.insert((*path).into(), json!(work));
            indexes.insert((*path).into(), json!(staged));
        }
        let paths = paths
            .iter()
            .map(|path| (*path).to_owned())
            .collect::<Vec<_>>();
        let params = json!({"expectedFingerprints":files,"expectedIndexFingerprints":indexes})
            .as_object()
            .unwrap()
            .clone();
        (paths, params)
    }

    fn handoff_all(
        root: &Path,
        paths: &[String],
        params: &Map<String, Value>,
        mut payload: Value,
    ) -> Value {
        for path in paths {
            discard_handoff(root, path, params, &mut payload, |_| Ok(())).unwrap();
        }
        payload
    }

    #[test]
    fn capture_and_undo_preserve_crlf_working_bytes_and_staged_index() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
        fs::write(root.join("a.txt"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.txt"), b"staged\r\n").unwrap();
        git(root, &["add", "a.txt"]);
        let staged = index(root, "a.txt");
        fs::write(root.join("a.txt"), b"working\r\nexact\r\n").unwrap();
        let (paths, params) = request(root, &["a.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"staged\r\n");
        apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        assert_eq!(
            fs::read(root.join("a.txt")).unwrap(),
            b"working\r\nexact\r\n"
        );
        assert_eq!(index(root, "a.txt"), staged);
    }

    #[test]
    fn undo_of_deleted_file_restores_the_captured_absence() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("gone.txt"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::remove_file(root.join("gone.txt")).unwrap();
        let (paths, params) = request(root, &["gone.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        assert!(!root.join("gone.txt").exists());
    }

    #[test]
    fn one_conflict_prevents_every_discard_restore() {
        let temp = repo();
        let root = temp.path();
        for path in ["a.txt", "b.txt"] {
            fs::write(root.join(path), b"base\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.txt"), b"captured a\n").unwrap();
        fs::write(root.join("b.txt"), b"captured b\n").unwrap();
        let (paths, params) = request(root, &["a.txt", "b.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        fs::write(root.join("b.txt"), b"later edit\n").unwrap();
        let before_a = fs::read(root.join("a.txt")).unwrap();
        let error = preflight_discard(root, &payload).unwrap_err().to_string();
        assert!(error.contains("undo_conflict: b.txt"), "{error}");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), before_a);
    }

    #[test]
    fn pruned_capture_is_unavailable() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("a.txt"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.txt"), b"unique unreachable bytes\n").unwrap();
        let (paths, params) = request(root, &["a.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        git(root, &["reflog", "expire", "--expire=now", "--all"]);
        git(root, &["gc", "--prune=now"]);
        assert!(!discard_available(root, &payload));
        assert_eq!(
            preflight_discard(root, &payload).unwrap_err().to_string(),
            "undo_unavailable"
        );
    }

    #[test]
    fn recycled_only_discard_has_no_in_app_restore() {
        let temp = repo();
        let payload = serde_json::to_value(DiscardPayload {
            version: DISCARD_PAYLOAD_VERSION,
            paths: vec![DiscardPath::Recycled {
                path: "untracked.txt".into(),
            }],
            partial: None,
        })
        .unwrap();
        assert!(!discard_available(temp.path(), &payload));
        assert_eq!(
            preflight_discard(temp.path(), &payload)
                .unwrap_err()
                .to_string(),
            "undo_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn undo_restores_the_working_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("script.sh"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("script.sh"), b"changed\n").unwrap();
        fs::set_permissions(root.join("script.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        let (paths, params) = request(root, &["script.sh"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        assert_ne!(
            fs::metadata(root.join("script.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }

    /// The copy fallback must install the mode the hard link would have shared.
    #[cfg(unix)]
    #[test]
    fn copy_fallback_preserves_the_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("script.sh"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("script.sh"), b"changed\n").unwrap();
        fs::set_permissions(root.join("script.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        let (paths, params) = request(root, &["script.sh"]);
        {
            let _links = test_hooks::fail_hard_links();
            let payload = handoff_all(
                root,
                &paths,
                &params,
                capture_discard(root, &paths, &params).unwrap(),
            );
            assert_eq!(
                fs::metadata(root.join("script.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
            apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        }
        assert_ne!(
            fs::metadata(root.join("script.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
        assert!(no_temp_siblings(root), "temporary files were left behind");
    }

    /// A missing parent must be created inside the worktree only: a junction or
    /// symlink standing in for it is rejected before any directory is created.
    #[test]
    fn parent_creation_refuses_to_escape_through_a_link_ancestor() {
        let temp = repo();
        let root = temp.path().join("work");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        if !link_dir(&outside, &root.join("escape")) {
            return;
        }
        let target = root.join("escape").join("deep").join("x.txt");
        assert_eq!(ensure_parent(&root, &target).unwrap_err().to_string(), "invalid_path");
        assert!(!outside.join("deep").exists());
        fs::remove_dir(root.join("escape")).unwrap();
    }

    /// Creates a directory link; returns false when the platform/CI cannot.
    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let result = {
            use std::os::windows::process::CommandExt;
            let status = Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .creation_flags(0x0800_0000)
                .output();
            match status {
                Ok(output) if output.status.success() => Ok(()),
                Ok(output) => Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    String::from_utf8_lossy(&output.stderr).into_owned(),
                )),
                Err(error) => Err(error),
            }
        };
        #[cfg(not(any(unix, windows)))]
        let result: std::io::Result<()> = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory links are unavailable",
        ));
        if let Err(error) = result {
            eprintln!("SKIP directory link creation unavailable: {error}");
            return false;
        }
        true
    }

    #[test]
    fn discard_recreated_path_is_left_untouched_and_displaced_bytes_are_kept() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("a.txt"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.txt"), b"confirmed edit\n").unwrap();
        let (paths, params) = request(root, &["a.txt"]);
        let mut payload = capture_discard(root, &paths, &params).unwrap();
        let _hook = test_hooks::install_discard_after_displace(|root, path| {
            fs::write(root.join(path), b"editor recreated\n")?;
            Ok(())
        });

        let error = discard_handoff(root, "a.txt", &params, &mut payload, |_| Ok(())).unwrap_err();
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"editor recreated\n");
        let kept = kept_displaced(&error).expect("displaced original retained");
        assert_eq!(fs::read(root.join(kept)).unwrap(), b"confirmed edit\n");
        assert!(!discard_available(root, &payload));
    }

    #[test]
    fn undo_edit_after_preflight_survives_guarded_swap() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("a.txt"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.txt"), b"discarded bytes\n").unwrap();
        let (paths, params) = request(root, &["a.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        let prepared = preflight_discard(root, &payload).unwrap();
        let _hook = test_hooks::install_undo_after_prepare(|root| {
            fs::write(root.join("a.txt"), b"editor save during undo\n")?;
            Ok(())
        });

        let error = apply_discard(root, prepared).unwrap_err();
        assert!(error.to_string().starts_with("undo_conflict:"), "{error}");
        assert!(undo_no_effect(&error));
        assert_eq!(
            fs::read(root.join("a.txt")).unwrap(),
            b"editor save during undo\n"
        );
    }

    #[test]
    fn stateful_smudge_filter_records_the_bytes_actually_installed() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join(".gitattributes"), "*.txt filter=tt\n").unwrap();
        fs::write(root.join("a.txt"), b"base\n").unwrap();
        let script = root.join(".git/tt-smudge.sh");
        fs::write(
            &script,
            "#!/bin/sh\ncount=.git/tt-smudge-count\nn=0\ntest ! -f \"$count\" || n=$(cat \"$count\")\nn=$((n+1))\nprintf '%s' \"$n\" > \"$count\"\ncat >/dev/null\nprintf 'smudge-%s\\n' \"$n\"\n",
        )
        .unwrap();
        git(root, &["config", "filter.tt.clean", "cat"]);
        git(
            root,
            &["config", "filter.tt.smudge", "sh .git/tt-smudge.sh"],
        );
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.txt"), b"working edit\n").unwrap();
        let (paths, params) = request(root, &["a.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );

        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"smudge-1\n");
        assert_eq!(fs::read(root.join(".git/tt-smudge-count")).unwrap(), b"1");
        preflight_discard(root, &payload).unwrap();
    }

    #[test]
    fn emulated_symlink_restores_regular_bytes_with_symlink_index_mode() {
        let temp = repo();
        let root = temp.path();
        git(root, &["config", "core.symlinks", "false"]);
        let oid = hash_bytes(root, b"target.txt", true).unwrap();
        let cache = format!("120000,{oid},link.txt");
        git(root, &["update-index", "--add", "--cacheinfo", &cache]);
        git(root, &["commit", "-qm", "symlink index"]);
        fs::write(root.join("link.txt"), b"edited regular representation").unwrap();
        let (paths, params) = request(root, &["link.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        assert!(fs::symlink_metadata(root.join("link.txt"))
            .unwrap()
            .is_file());
        assert_eq!(fs::read(root.join("link.txt")).unwrap(), b"target.txt");

        apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        let metadata = fs::symlink_metadata(root.join("link.txt")).unwrap();
        assert!(metadata.is_file() && !metadata.file_type().is_symlink());
        assert_eq!(
            fs::read(root.join("link.txt")).unwrap(),
            b"edited regular representation"
        );
        assert_eq!(index(root, "link.txt").mode, "120000");
    }

    /// The journal path is registered-root relative while `update-index --cacheinfo`
    /// is repository-top relative: a project in `pkg/` must never touch a
    /// same-named top-level entry.
    #[test]
    fn undo_in_a_subdirectory_project_changes_only_its_own_index_entry() {
        let temp = repo();
        let top = temp.path();
        let root = top.join("pkg");
        fs::create_dir_all(&root).unwrap();
        fs::write(top.join("a.txt"), b"top base\n").unwrap();
        fs::write(root.join("a.txt"), b"pkg base\n").unwrap();
        git(top, &["add", "."]);
        git(top, &["commit", "-qm", "base"]);
        let top_before = git(top, &["ls-files", "-s", "--", "a.txt"]);
        fs::write(root.join("a.txt"), b"pkg staged\n").unwrap();
        git(top, &["add", "pkg/a.txt"]);
        let staged = index(&root, "a.txt");
        fs::write(root.join("a.txt"), b"pkg working\n").unwrap();

        let (paths, params) = request(&root, &["a.txt"]);
        let payload = handoff_all(
            &root,
            &paths,
            &params,
            capture_discard(&root, &paths, &params).unwrap(),
        );
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"pkg staged\n");
        apply_discard(&root, preflight_discard(&root, &payload).unwrap()).unwrap();

        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"pkg working\n");
        assert_eq!(index(&root, "a.txt"), staged);
        assert_eq!(git(top, &["ls-files", "-s", "--", "a.txt"]), top_before);
        assert_eq!(fs::read(top.join("a.txt")).unwrap(), b"top base\n");
    }

    #[test]
    fn discard_and_undo_restore_a_deleted_file_whose_directory_is_gone() {
        let temp = repo();
        let root = temp.path();
        fs::create_dir_all(root.join("gone")).unwrap();
        fs::write(root.join("gone/x.txt"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::remove_dir_all(root.join("gone")).unwrap();
        let (paths, params) = request(root, &["gone/x.txt"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        assert_eq!(fs::read(root.join("gone/x.txt")).unwrap(), b"base\n");

        apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        assert!(!root.join("gone/x.txt").exists());
    }

    #[test]
    fn install_falls_back_to_a_copy_when_hard_links_are_unsupported() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("a.txt"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("a.txt"), b"captured\n").unwrap();
        let (paths, params) = request(root, &["a.txt"]);

        {
            let _links = test_hooks::fail_hard_links();
            let payload = handoff_all(
                root,
                &paths,
                &params,
                capture_discard(root, &paths, &params).unwrap(),
            );
            assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"base\n");
            apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        }

        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"captured\n");
        assert!(no_temp_siblings(root), "temporary files were left behind");
        // The fallback copies, so the installed file has its own identity.
        assert_eq!(fs::metadata(root.join("a.txt")).unwrap().len(), 9);
    }

    #[test]
    fn a_forced_hard_link_failure_with_an_occupied_target_is_still_a_conflict() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("source"), b"source\n").unwrap();
        fs::write(root.join("target"), b"occupied\n").unwrap();
        let _links = test_hooks::fail_hard_links();
        let error = install_no_replace(&root.join("source"), &root.join("target")).unwrap_err();
        assert_eq!(error.detail(), "discard_conflict");
        assert_eq!(fs::read(root.join("target")).unwrap(), b"occupied\n");
    }

    #[test]
    fn large_captured_content_streams_through_discard_and_undo() {
        let temp = repo();
        let root = temp.path();
        fs::write(root.join("big.bin"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        let mut large = vec![b'x'; 1024 * 1024];
        large.extend_from_slice(b"\nend\n");
        fs::write(root.join("big.bin"), &large).unwrap();
        let (paths, params) = request(root, &["big.bin"]);
        let payload = handoff_all(
            root,
            &paths,
            &params,
            capture_discard(root, &paths, &params).unwrap(),
        );
        assert_eq!(fs::read(root.join("big.bin")).unwrap(), b"base\n");
        apply_discard(root, preflight_discard(root, &payload).unwrap()).unwrap();
        assert_eq!(fs::read(root.join("big.bin")).unwrap(), large);
        assert!(no_temp_siblings(root), "temporary files were left behind");
    }

    fn no_temp_siblings(root: &Path) -> bool {
        fs::read_dir(root)
            .map(|entries| {
                entries.filter_map(Result::ok).all(|entry| {
                    !entry.file_name().to_string_lossy().contains(".tt-")
                })
            })
            .unwrap_or(false)
    }
}
