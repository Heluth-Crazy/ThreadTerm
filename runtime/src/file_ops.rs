//! Workspace file management for registered roots: create / rename / delete
//! (Recycle Bin first), the quick-open file list and gitignore-aware text search.
//!
//! Mutations follow the external-operation claim pattern: the operation is only
//! completed after the filesystem change succeeded, and an interrupted claim is
//! reported as `operation_outcome_unknown` instead of being replayed.
use crate::{
    db::Database,
    git_actions::complete,
    workspace_services::{root_for, MAX_DOCUMENT_BYTES},
};
use anyhow::{anyhow, Context, Result};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_LIST_FILES: usize = 20_000;
const MAX_SEARCH_MATCHES: usize = 2_000;
const MAX_MATCHES_PER_FILE: usize = 200;
const WALK_BUDGET: Duration = Duration::from_secs(5);
const PREVIEW_BEFORE: usize = 40;
const PREVIEW_CHARS: usize = 240;

pub fn dispatch(db: &Database, method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(
        method,
        "filesystem.create"
            | "filesystem.rename"
            | "filesystem.delete"
            | "filesystem.files"
            | "filesystem.search"
    ) {
        return Ok(None);
    }
    let object = params
        .as_object()
        .ok_or_else(|| anyhow!("invalid_request"))?;
    let project_id = string(object, "projectId")?;
    let worktree = object.get("worktreePath").and_then(Value::as_str);
    let root = db
        .transaction(|tx| root_for(tx, project_id, worktree))?
        .canonicalize()
        .context("canonicalizing registered root")?;
    match method {
        "filesystem.files" => return list_files(&root).map(Some),
        "filesystem.search" => return search(&root, object).map(Some),
        _ => {}
    }
    let operation_id = string(object, "operationId")?;
    if let Some(result) = db.operation(operation_id)? {
        return Ok(Some(result));
    }
    // Validate before claiming so a rejected request stays retryable.
    let path = string(object, "path")?;
    normal_relative(path)?;
    if method == "filesystem.rename" {
        normal_relative(string(object, "newPath")?)?;
    }
    if !db.claim_external_operation(operation_id)? {
        return Err(anyhow!("operation_outcome_unknown"));
    }
    let result = match method {
        "filesystem.create" => create(&root, path, string(object, "kind")?)?,
        "filesystem.rename" => rename(&root, path, string(object, "newPath")?)?,
        "filesystem.delete" => delete(
            &root,
            path,
            object
                .get("permanent")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )?,
        _ => unreachable!(),
    };
    db.transaction(|tx| complete(tx, operation_id, method, &result))?;
    Ok(Some(result))
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("invalid_request"))
}

/// A relative path made only of ordinary, portable file-name components.
/// `.`/`..`, roots, drive prefixes, alternate data streams, Windows reserved
/// names and trailing dots/spaces are rejected before touching the disk.
pub(crate) fn normal_relative(path: &str) -> Result<PathBuf> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(anyhow!("invalid_path"));
    }
    let mut result = PathBuf::new();
    for component in Path::new(path).components() {
        let Component::Normal(name) = component else {
            return Err(anyhow!("invalid_path"));
        };
        let name = name.to_str().ok_or_else(|| anyhow!("invalid_name"))?;
        valid_name(name)?;
        result.push(name);
    }
    if result.as_os_str().is_empty() {
        return Err(anyhow!("invalid_path"));
    }
    Ok(result)
}

fn valid_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || name.ends_with('.')
        || name.ends_with(' ')
        || name.chars().any(|value| {
            value < ' ' || matches!(value, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/')
        })
    {
        return Err(anyhow!("invalid_name"));
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err(anyhow!("invalid_name"));
    }
    Ok(())
}

fn to_slash(path: &Path) -> String {
    path.components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// The canonical parent directory of `relative`, verified to be inside `root`.
/// Missing parents are created only below the deepest existing, contained ancestor.
fn contained_parent(root: &Path, relative: &Path, create_missing: bool) -> Result<PathBuf> {
    let parent = relative.parent().unwrap_or(Path::new(""));
    let mut existing = root.join(parent);
    let mut missing = Vec::new();
    while fs::symlink_metadata(&existing).is_err() {
        let name = existing
            .file_name()
            .ok_or_else(|| anyhow!("invalid_path"))?
            .to_owned();
        missing.push(name);
        existing = existing
            .parent()
            .ok_or_else(|| anyhow!("invalid_path"))?
            .to_path_buf();
    }
    let canonical = existing.canonicalize()?;
    if !canonical.starts_with(root) {
        return Err(anyhow!("path_escape"));
    }
    if !canonical.is_dir() {
        return Err(anyhow!("parent_not_directory"));
    }
    if missing.is_empty() {
        return Ok(canonical);
    }
    if !create_missing {
        return Err(anyhow!("parent_missing"));
    }
    let mut created = canonical;
    for name in missing.into_iter().rev() {
        created.push(name);
        match fs::create_dir(&created) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists && created.is_dir() => {}
            Err(error) => return Err(error.into()),
        }
    }
    let canonical = created.canonicalize()?;
    if !canonical.starts_with(root) {
        return Err(anyhow!("path_escape"));
    }
    Ok(canonical)
}

/// Write target for `relative` below `root`, creating missing contained parents.
/// The final component is not resolved, so an existing link is replaced, not followed.
pub(crate) fn contained_parent_for(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = normal_relative(relative)?;
    let root = root.canonicalize()?;
    let parent = contained_parent(&root, &relative, true)?;
    Ok(parent.join(
        relative
            .file_name()
            .ok_or_else(|| anyhow!("invalid_path"))?,
    ))
}

fn entry(root: &Path, path: &Path) -> Result<Value> {
    let meta = fs::symlink_metadata(path)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| anyhow!("path_escape"))?;
    let kind = if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "directory"
    } else {
        "file"
    };
    let mut value = Map::new();
    value.insert(
        "name".into(),
        json!(path
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default()),
    );
    value.insert("path".into(), json!(to_slash(relative)));
    value.insert("kind".into(), json!(kind));
    if meta.is_file() {
        value.insert("size".into(), json!(meta.len()));
    }
    Ok(Value::Object(value))
}

fn create(root: &Path, path: &str, kind: &str) -> Result<Value> {
    let relative = normal_relative(path)?;
    let parent = contained_parent(root, &relative, true)?;
    let target = parent.join(
        relative
            .file_name()
            .ok_or_else(|| anyhow!("invalid_path"))?,
    );
    let created = match kind {
        "file" => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map(|_| ()),
        "directory" => fs::create_dir(&target),
        _ => return Err(anyhow!("invalid_request")),
    };
    match created {
        Ok(()) => entry(root, &target),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Err(anyhow!("file_exists")),
        Err(error) => Err(error.into()),
    }
}

/// Lexical entry path (the link itself, never its target) with a contained parent.
fn existing_entry(root: &Path, relative: &Path) -> Result<PathBuf> {
    let parent = contained_parent(root, relative, false)?;
    let target = parent.join(
        relative
            .file_name()
            .ok_or_else(|| anyhow!("invalid_path"))?,
    );
    fs::symlink_metadata(&target).map_err(|_| anyhow!("file_not_found"))?;
    Ok(target)
}

fn rename(root: &Path, from: &str, to: &str) -> Result<Value> {
    let source_relative = normal_relative(from)?;
    let target_relative = normal_relative(to)?;
    let source = existing_entry(root, &source_relative)?;
    if source == root {
        return Err(anyhow!("invalid_path"));
    }
    let parent = contained_parent(root, &target_relative, true)?;
    let target = parent.join(
        target_relative
            .file_name()
            .ok_or_else(|| anyhow!("invalid_path"))?,
    );
    let source_meta = fs::symlink_metadata(&source)?;
    if source_meta.is_dir() && !source_meta.file_type().is_symlink() {
        let source_canonical = source.canonicalize()?;
        if parent.starts_with(&source_canonical) {
            return Err(anyhow!("invalid_path"));
        }
    }
    if fs::symlink_metadata(&target).is_ok() {
        // A case-only rename on a case-insensitive volume targets the same entry.
        let same = source.canonicalize().ok() == target.canonicalize().ok()
            && source.file_name() != target.file_name();
        if !same {
            return Err(anyhow!("file_exists"));
        }
    }
    fs::rename(&source, &target)?;
    entry(root, &target)
}

fn delete(root: &Path, path: &str, permanent: bool) -> Result<Value> {
    let relative = normal_relative(path)?;
    let target = existing_entry(root, &relative)?;
    if target == root {
        return Err(anyhow!("invalid_path"));
    }
    let meta = fs::symlink_metadata(&target)?;
    let recycled = if meta.file_type().is_symlink() {
        // Links and junctions are unlinked; their target is never traversed.
        if meta.is_dir() || fs::remove_file(&target).is_err() {
            fs::remove_dir(&target)?;
        }
        false
    } else if permanent {
        if meta.is_dir() {
            fs::remove_dir_all(&target)?;
        } else {
            fs::remove_file(&target)?;
        }
        false
    } else {
        recycle(&target)?;
        true
    };
    Ok(json!({"path":to_slash(&relative),"recycled":recycled}))
}

/// Moves one entry to the Recycle Bin. Volumes without a Recycle Bin (network,
/// many removable drives) are refused instead of being deleted permanently.
#[cfg(windows)]
pub(crate) fn recycle(path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, SHQueryRecycleBinW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI,
        FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW, SHQUERYRBINFO,
    };
    // Shell APIs do not accept verbatim (\\?\) paths.
    let plain = crate::git_read::plain_path(path);
    let volume = plain
        .ancestors()
        .last()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| plain.clone());
    let wide = |value: &Path| {
        let mut encoded: Vec<u16> = value.as_os_str().encode_wide().collect();
        encoded.push(0);
        encoded
    };
    let volume = wide(&volume);
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        i64Size: 0,
        i64NumItems: 0,
    };
    // SAFETY: both pointers are valid for the duration of the call.
    if unsafe { SHQueryRecycleBinW(volume.as_ptr(), &mut info) } < 0 {
        return Err(anyhow!("recycle_unavailable"));
    }
    let mut from = wide(&plain);
    from.push(0); // pFrom is a double-NUL terminated list.
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `operation` references buffers that outlive the call.
    let code = unsafe { SHFileOperationW(&mut operation) };
    if code != 0 || operation.fAnyOperationsAborted != 0 || fs::symlink_metadata(path).is_ok() {
        return Err(anyhow!("recycle_failed: {code}"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn recycle(_path: &Path) -> Result<()> {
    Err(anyhow!("recycle_unavailable"))
}

fn walker(root: &Path) -> ignore::Walk {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_name(|left, right| left.cmp(right))
        .filter_entry(|entry| entry.file_name() != ".git");
    builder.build()
}

fn list_files(root: &Path) -> Result<Value> {
    let started = Instant::now();
    let mut paths = Vec::new();
    let mut truncated = false;
    for item in walker(root) {
        let Ok(item) = item else { continue };
        if !item.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        if paths.len() >= MAX_LIST_FILES || started.elapsed() > WALK_BUDGET {
            truncated = true;
            break;
        }
        if let Ok(relative) = item.path().strip_prefix(root) {
            paths.push(to_slash(relative));
        }
    }
    Ok(json!({"paths":paths,"truncated":truncated}))
}

/// VS Code style globs: `*.ts` or `dist` match at any depth; `src/**` is anchored.
fn glob_set(spec: Option<&str>) -> Result<Option<GlobSet>> {
    let Some(spec) = spec.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let mut builder = GlobSetBuilder::new();
    for raw in spec
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let pattern = raw
            .trim_start_matches("./")
            .trim_end_matches('/')
            .replace('\\', "/");
        let base = if pattern.contains('/') {
            pattern
        } else {
            format!("**/{pattern}")
        };
        for candidate in [base.clone(), format!("{base}/**")] {
            builder.add(
                GlobBuilder::new(&candidate)
                    .literal_separator(true)
                    .case_insensitive(cfg!(windows))
                    .build()
                    .map_err(|error| anyhow!("invalid_glob: {error}"))?,
            );
        }
    }
    Ok(Some(builder.build()?))
}

fn search(root: &Path, object: &Map<String, Value>) -> Result<Value> {
    let query = string(object, "query")?;
    if query.len() > 1000 {
        return Err(anyhow!("invalid_search_query"));
    }
    let flag = |key: &str| object.get(key).and_then(Value::as_bool).unwrap_or(false);
    let mut pattern = if flag("regex") {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    if flag("wholeWord") {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!flag("caseSensitive"))
        .size_limit(1 << 20)
        .dfa_size_limit(1 << 22)
        .build()
        .map_err(|error| anyhow!("invalid_search_pattern: {error}"))?;
    let include = glob_set(object.get("include").and_then(Value::as_str))?;
    let exclude = glob_set(object.get("exclude").and_then(Value::as_str))?;
    let started = Instant::now();
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut searched = 0usize;
    let mut truncated = false;
    for item in walker(root) {
        if started.elapsed() > WALK_BUDGET {
            truncated = true;
            break;
        }
        let Ok(item) = item else { continue };
        if !item.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(relative) = item.path().strip_prefix(root) else {
            continue;
        };
        let relative = to_slash(relative);
        if include.as_ref().is_some_and(|set| !set.is_match(&relative))
            || exclude.as_ref().is_some_and(|set| set.is_match(&relative))
        {
            continue;
        }
        if item
            .metadata()
            .map(|meta| meta.len() as usize > MAX_DOCUMENT_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(bytes) = fs::read(item.path()) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        searched += 1;
        let mut matches = Vec::new();
        'lines: for (index, line) in text.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            for found in matcher.find_iter(line) {
                if found.start() == found.end() {
                    continue;
                }
                if matches.len() >= MAX_MATCHES_PER_FILE || total >= MAX_SEARCH_MATCHES {
                    truncated = true;
                    break 'lines;
                }
                matches.push(preview(line, index + 1, found.start(), found.end()));
                total += 1;
            }
        }
        if !matches.is_empty() {
            files.push(json!({"path":relative,"matches":matches}));
        }
        if total >= MAX_SEARCH_MATCHES {
            truncated = true;
            break;
        }
    }
    Ok(json!({"files":files,"truncated":truncated,"searchedFiles":searched}))
}

/// Match position in UTF-16 units (CodeMirror offsets) plus a bounded preview
/// window; `previewColumn` is the 0-based UTF-16 offset of the match in `preview`.
fn preview(line: &str, number: usize, start: usize, end: usize) -> Value {
    let utf16 = |value: &str| value.encode_utf16().count();
    let column = utf16(&line[..start]) + 1;
    let length = utf16(&line[start..end]);
    let chars_before = line[..start].chars().count();
    let skip = chars_before.saturating_sub(PREVIEW_BEFORE);
    let window: String = line.chars().skip(skip).take(PREVIEW_CHARS).collect();
    let skipped: String = line.chars().take(skip).collect();
    let preview_column = column - 1 - utf16(&skipped);
    json!({"line":number,"column":column,"length":length,"preview":window,"previewColumn":preview_column})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Database, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("项目 root");
        fs::create_dir(&root).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        crate::workspace_services::initialize(&db).unwrap();
        let project = db
            .add_project(root.to_str().unwrap(), Some("p"), "project-op")
            .unwrap();
        (temp, db, project.id)
    }

    fn call(db: &Database, method: &str, params: Value) -> Result<Value> {
        dispatch(db, method, &params).map(Option::unwrap)
    }

    #[test]
    fn create_rename_and_delete_stay_inside_the_root() {
        let (temp, db, project) = setup();
        let root = temp.path().join("项目 root");
        let file = call(
            &db,
            "filesystem.create",
            json!({"projectId":project,"path":"src/新 文件.ts","kind":"file","operationId":"c1"}),
        )
        .unwrap();
        assert_eq!(file["path"], "src/新 文件.ts");
        assert_eq!(file["kind"], "file");
        assert!(root.join("src").join("新 文件.ts").is_file());
        // Idempotent replay returns the stored result instead of failing with file_exists.
        assert_eq!(call(&db, "filesystem.create", json!({"projectId":project,"path":"src/新 文件.ts","kind":"file","operationId":"c1"})).unwrap(), file);
        let exists = call(
            &db,
            "filesystem.create",
            json!({"projectId":project,"path":"src/新 文件.ts","kind":"file","operationId":"c2"}),
        );
        assert!(exists.unwrap_err().to_string().contains("file_exists"));
        for bad in [
            "../x",
            "a/../../x",
            "C:/x",
            "x:stream",
            "CON",
            "dir/aux.txt",
            "trailing.",
            ".",
            "",
        ] {
            assert!(call(&db, "filesystem.create", json!({"projectId":project,"path":bad,"kind":"file","operationId":format!("bad-{bad}")})).is_err(), "{bad}");
        }
        let renamed = call(&db, "filesystem.rename", json!({"projectId":project,"path":"src/新 文件.ts","newPath":"lib/b.ts","operationId":"r1"})).unwrap();
        assert_eq!(renamed["path"], "lib/b.ts");
        assert!(!root.join("src").join("新 文件.ts").exists());
        call(
            &db,
            "filesystem.create",
            json!({"projectId":project,"path":"lib/c.ts","kind":"file","operationId":"c3"}),
        )
        .unwrap();
        assert!(call(
            &db,
            "filesystem.rename",
            json!({"projectId":project,"path":"lib/c.ts","newPath":"lib/b.ts","operationId":"r2"})
        )
        .unwrap_err()
        .to_string()
        .contains("file_exists"));
        assert!(call(
            &db,
            "filesystem.rename",
            json!({"projectId":project,"path":"lib","newPath":"lib/inner","operationId":"r3"})
        )
        .is_err());
        let deleted = call(
            &db,
            "filesystem.delete",
            json!({"projectId":project,"path":"lib/c.ts","permanent":true,"operationId":"d1"}),
        )
        .unwrap();
        assert_eq!(deleted, json!({"path":"lib/c.ts","recycled":false}));
        assert!(!root.join("lib").join("c.ts").exists());
        assert!(call(
            &db,
            "filesystem.delete",
            json!({"projectId":project,"path":"missing.ts","permanent":true,"operationId":"d2"})
        )
        .unwrap_err()
        .to_string()
        .contains("file_not_found"));
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_unlinked_without_touching_their_target() {
        let (temp, db, project) = setup();
        let root = temp.path().join("项目 root");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&outside)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(call(
            &db,
            "filesystem.create",
            json!({"projectId":project,"path":"link/escape.txt","kind":"file","operationId":"j1"})
        )
        .unwrap_err()
        .to_string()
        .contains("path_escape"));
        call(
            &db,
            "filesystem.delete",
            json!({"projectId":project,"path":"link","operationId":"j2"}),
        )
        .unwrap();
        assert!(!root.join("link").exists());
        assert!(outside.join("keep.txt").is_file());
    }

    #[test]
    fn listing_and_search_respect_ignore_rules_and_limits() {
        let (temp, db, project) = setup();
        let root = temp.path().join("项目 root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        fs::write(root.join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        fs::write(
            root.join("src").join("main.ts"),
            "const 值 = 1;\nconsole.log(值)\nlet foo = 'Foo';\n",
        )
        .unwrap();
        fs::write(root.join("src").join("data.bin"), b"foo\0bar").unwrap();
        fs::write(root.join("debug.log"), "foo").unwrap();
        fs::write(
            root.join("node_modules").join("pkg").join("index.ts"),
            "foo",
        )
        .unwrap();
        let files = call(&db, "filesystem.files", json!({"projectId":project})).unwrap();
        assert_eq!(
            files["paths"],
            json!([".gitignore", "src/data.bin", "src/main.ts"])
        );
        assert_eq!(files["truncated"], false);

        let result = call(
            &db,
            "filesystem.search",
            json!({"projectId":project,"query":"foo"}),
        )
        .unwrap();
        let hits = result["files"].as_array().unwrap();
        assert_eq!(hits.len(), 1, "{result}");
        assert_eq!(hits[0]["path"], "src/main.ts");
        assert_eq!(hits[0]["matches"].as_array().unwrap().len(), 2);
        let first = &hits[0]["matches"][0];
        assert_eq!(
            (
                first["line"].as_u64(),
                first["column"].as_u64(),
                first["length"].as_u64()
            ),
            (Some(3), Some(5), Some(3))
        );

        let cased = call(
            &db,
            "filesystem.search",
            json!({"projectId":project,"query":"Foo","caseSensitive":true}),
        )
        .unwrap();
        assert_eq!(cased["files"][0]["matches"].as_array().unwrap().len(), 1);
        let cjk = call(
            &db,
            "filesystem.search",
            json!({"projectId":project,"query":"值\\)","regex":true}),
        )
        .unwrap();
        assert_eq!(cjk["files"][0]["matches"][0]["column"], 13);
        let excluded = call(
            &db,
            "filesystem.search",
            json!({"projectId":project,"query":"foo","exclude":"src"}),
        )
        .unwrap();
        assert_eq!(excluded["files"], json!([]));
        let included = call(
            &db,
            "filesystem.search",
            json!({"projectId":project,"query":"foo","include":"*.md"}),
        )
        .unwrap();
        assert_eq!(included["files"], json!([]));
        assert!(call(
            &db,
            "filesystem.search",
            json!({"projectId":project,"query":"(","regex":true})
        )
        .unwrap_err()
        .to_string()
        .contains("invalid_search_pattern"));
    }

    #[test]
    fn preview_windows_long_lines_in_utf16_units() {
        let line = format!("{}😀match", "x".repeat(100));
        let start = line.find("match").unwrap();
        let value = preview(&line, 1, start, start + 5);
        assert_eq!(value["column"], 103);
        let preview_text = value["preview"].as_str().unwrap();
        let column = value["previewColumn"].as_u64().unwrap() as usize;
        let units: Vec<u16> = preview_text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[column..column + 5]).unwrap(),
            "match"
        );
    }
}
