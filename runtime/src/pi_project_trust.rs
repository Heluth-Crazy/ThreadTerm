//! Read-only Pi project-trust inspection plus ThreadTerm's separate decision.
//!
//! Pi owns `trust.json` and `settings.json`; this module never mutates either.
use crate::db::Database;
#[cfg(test)]
use anyhow::anyhow;
use anyhow::Result;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const PI_PROTECTED: &[&str] = &[
    ".pi/settings.json",
    ".pi/mcp.json",
    ".pi/extensions",
    ".pi/skills",
    ".pi/prompts",
    ".pi/themes",
    ".pi/SYSTEM.md",
    ".pi/APPEND_SYSTEM.md",
];

pub(crate) fn read(db: &Database, project_id: &str) -> Result<Option<String>> {
    db.transaction(|tx| {
        ensure_table(tx)?;
        tx.query_row(
            "SELECT decision FROM pi_project_trust WHERE project_id=?",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    })
}

#[cfg(test)]
pub(crate) fn set(db: &Database, project_id: &str, decision: &str) -> Result<()> {
    if !matches!(decision, "trusted" | "declined" | "none") {
        return Err(anyhow!("invalid Pi project trust decision"));
    }
    db.transaction(|tx| {
        ensure_table(tx)?;
        if decision == "none" {
            tx.execute(
                "DELETE FROM pi_project_trust WHERE project_id=?",
                [project_id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO pi_project_trust(project_id,decision) VALUES (?,?) \
                 ON CONFLICT(project_id) DO UPDATE SET decision=excluded.decision",
                (project_id, decision),
            )?;
        }
        Ok(())
    })
}

fn ensure_table(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS pi_project_trust (\
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,\
            decision TEXT NOT NULL CHECK(decision IN ('trusted','declined'))\
         );",
    )
}

/// Resolves Pi's documented config directory without consulting or changing Pi.
pub(crate) fn agent_dir_for(
    env_override: Option<OsString>,
    home: Option<OsString>,
    cwd: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = env_override.filter(|path| !path.is_empty()) {
        let path = expand_home(PathBuf::from(path), home.as_deref());
        return Some(if path.is_relative() {
            cwd.map(|cwd| cwd.join(&path)).unwrap_or(path)
        } else {
            path
        });
    }
    home.map(|home| PathBuf::from(home).join(".pi").join("agent"))
}

/// Atomically claims an externally visible decision operation and persists its
/// value. A foreign-key or validation failure rolls the claim back, so retries
/// never become permanently outcome-unknown.
#[cfg(test)]
pub(crate) fn claim_and_set(
    db: &Database,
    project_id: &str,
    decision: &str,
    operation_id: &str,
) -> Result<bool> {
    if !matches!(decision, "trusted" | "declined" | "none") {
        return Err(anyhow!("invalid Pi project trust decision"));
    }
    db.transaction(|tx| {
        ensure_table(tx)?;
        let claimed = tx.execute(
            "INSERT OR IGNORE INTO external_operations(id,started_at) VALUES (?,CURRENT_TIMESTAMP)",
            [operation_id],
        )? > 0;
        if !claimed {
            return Ok(false);
        }
        if decision == "none" {
            tx.execute(
                "DELETE FROM pi_project_trust WHERE project_id=?",
                [project_id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO pi_project_trust(project_id,decision) VALUES (?,?) \
                 ON CONFLICT(project_id) DO UPDATE SET decision=excluded.decision",
                (project_id, decision),
            )?;
        }
        Ok(true)
    })
}

fn expand_home(path: PathBuf, home: Option<&std::ffi::OsStr>) -> PathBuf {
    let Some(home) = home else { return path };
    let text = path.to_string_lossy();
    if text == "~" {
        return PathBuf::from(home);
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        return PathBuf::from(home).join(rest);
    }
    path
}

pub(crate) fn launch_flag(decision: Option<&str>) -> Option<&'static str> {
    match decision {
        Some("trusted") => Some("--approve"),
        Some("declined") => Some("--no-approve"),
        _ => None,
    }
}

/// Builds the one-time connect snapshot consumed by the Chat UI.
#[cfg(test)]
pub(crate) fn compute(cwd: &Path, agent_dir: &Path, decision: Option<&str>) -> Value {
    compute_with_home(cwd, agent_dir, None, decision)
}

/// Like [`compute`], using the same HOME value as the Pi child for the
/// documented home-level `.agents/skills` exception.
pub(crate) fn compute_with_home(
    cwd: &Path,
    agent_dir: &Path,
    home: Option<OsString>,
    decision: Option<&str>,
) -> Value {
    compute_with_optional_agent_dir(cwd, Some(agent_dir), home, decision)
}

/// Builds the Pi snapshot when the agent directory could not be resolved.
/// There is then no safe Pi-owned config path to inspect.
pub(crate) fn compute_without_agent_dir(
    cwd: &Path,
    home: Option<OsString>,
    decision: Option<&str>,
) -> Value {
    compute_with_optional_agent_dir(cwd, None, home, decision)
}

fn compute_with_optional_agent_dir(
    cwd: &Path,
    agent_dir: Option<&Path>,
    home: Option<OsString>,
    decision: Option<&str>,
) -> Value {
    let cwd = canonical_or_absolute(cwd);
    let resources = protected_resources(&cwd, home);
    let pi_decision = agent_dir
        .and_then(|dir| pi_saved_decision(&cwd, dir))
        .unwrap_or("none");
    let default_project_trust = agent_dir.map(default_project_trust).unwrap_or("ask");
    let threadterm_decision = match decision {
        Some("trusted") => "trusted",
        Some("declined") => "declined",
        _ => "none",
    };
    let effective = match threadterm_decision {
        "trusted" => "loaded",
        "declined" => "skipped",
        _ => match pi_decision {
            "trusted" => "loaded",
            "declined" => "skipped",
            _ if default_project_trust == "always" => "loaded",
            _ => "skipped",
        },
    };
    json!({
        "protectedResources": resources.contained,
        "outsideProtectedResources": resources.outside.iter().map(|resource| json!({
            "path": resource.path,
            "target": resource.target,
        })).collect::<Vec<_>>(),
        "piDecision": pi_decision,
        "defaultProjectTrust": default_project_trust,
        "threadtermDecision": threadterm_decision,
        "effective": effective,
    })
}

fn canonical_or_absolute(path: &Path) -> PathBuf {
    path.canonicalize()
        .unwrap_or_else(|_| lexical_absolute(path))
}

fn lexical_absolute(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[derive(Debug, PartialEq, Eq)]
struct OutsideProtectedResource {
    path: String,
    target: String,
}

#[derive(Default)]
struct ProtectedResources {
    contained: Vec<String>,
    outside: Vec<OutsideProtectedResource>,
}

fn protected_resources(cwd: &Path, home: Option<OsString>) -> ProtectedResources {
    let mut found = ProtectedResources::default();
    for resource in PI_PROTECTED {
        inspect_protected_root(cwd, cwd, &cwd.join(resource), &mut found);
    }
    // Pi checks HOME before falling back to Node's homedir() (USERPROFILE on
    // Windows). Its `HOME` override must therefore win for this exclusion.
    let home_agents = home
        .or_else(|| std::env::var_os("HOME"))
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| lexical_absolute(&PathBuf::from(home).join(".agents").join("skills")));
    let mut current = Some(cwd);
    while let Some(directory) = current {
        let skills = directory.join(".agents").join("skills");
        if !home_agents
            .as_ref()
            .is_some_and(|home_agents| same_lexical_path(home_agents, &skills))
        {
            inspect_protected_root(cwd, directory, &skills, &mut found);
        }
        current = directory.parent();
    }
    found.contained.sort();
    found.contained.dedup();
    found.outside.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.target.cmp(&right.target))
    });
    found.outside.dedup();
    found
}

fn same_lexical_path(left: &Path, right: &Path) -> bool {
    let left = path_display(&lexical_absolute(left));
    let right = path_display(&lexical_absolute(right));
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn inspect_protected_root(
    project_root: &Path,
    lexical_root: &Path,
    path: &Path,
    found: &mut ProtectedResources,
) {
    let metadata = match lexical_path_state(lexical_root, path) {
        LexicalPathState::Missing => return,
        LexicalPathState::Linked(link) => {
            let real = resolved_path(&link);
            if real.starts_with(project_root) {
                found.contained.push(relative_display(project_root, &link));
            } else {
                push_outside(project_root, &link, &real, found);
            }
            // The link itself is enough to explain why Pi may load project
            // resources. Do not inspect any descendant through it, even when
            // its target happens to remain inside the project.
            return;
        }
        LexicalPathState::Plain(metadata) => metadata,
    };
    let real = resolved_path(path);
    if !real.starts_with(project_root) {
        push_outside(project_root, path, &real, found);
        return;
    }

    found.contained.push(relative_display(project_root, path));
    if !metadata.is_dir() {
        return;
    }
    inspect_protected_directory(project_root, path, found);
}

enum LexicalPathState {
    Missing,
    Linked(PathBuf),
    Plain(fs::Metadata),
}

fn lexical_path_state(root: &Path, path: &Path) -> LexicalPathState {
    let Ok(relative) = path.strip_prefix(root) else {
        return LexicalPathState::Missing;
    };
    let mut current = root.to_owned();
    let mut last = None;
    for component in relative.components() {
        current.push(component.as_os_str());
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            return LexicalPathState::Missing;
        };
        if is_link(&metadata) {
            return LexicalPathState::Linked(current);
        }
        last = Some(metadata);
    }
    last.map_or(LexicalPathState::Missing, LexicalPathState::Plain)
}

fn inspect_protected_directory(
    project_root: &Path,
    directory: &Path,
    found: &mut ProtectedResources,
) {
    let mut pending = vec![directory.to_owned()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let linked = is_link(&metadata);
            let real = resolved_path(&path);
            let contained = real.starts_with(project_root);
            if !contained {
                push_outside(project_root, &path, &real, found);
            }
            // Never traverse a symlink or Windows reparse point, even when
            // its target is contained. Pi may load the entry, but inspection
            // must not duplicate trees or walk a cycle through a link.
            if !linked && metadata.is_dir() && contained {
                pending.push(path);
            }
        }
    }
}

fn push_outside(project_root: &Path, path: &Path, target: &Path, found: &mut ProtectedResources) {
    found.outside.push(OutsideProtectedResource {
        path: relative_display(project_root, path),
        target: path_display(target),
    });
}

fn resolved_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        fs::read_link(path)
            .ok()
            .map(|target| {
                if target.is_absolute() {
                    target
                } else {
                    path.parent().unwrap_or_else(|| Path::new("")).join(target)
                }
            })
            .map(|target| canonical_or_absolute(&target))
            .unwrap_or_else(|| canonical_or_absolute(path))
    })
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

fn path_display(path: &Path) -> String {
    pi_trust_key(path).replace('\\', "/")
}

fn relative_display(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .map(PathBuf::from)
        .unwrap_or_else(|_| lexical_relative(base, path))
        .to_string_lossy()
        .replace('\\', "/")
}

fn lexical_relative(base: &Path, path: &Path) -> PathBuf {
    let base = base.components().collect::<Vec<_>>();
    let path = path.components().collect::<Vec<_>>();
    let common = base
        .iter()
        .zip(&path)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = PathBuf::new();
    for component in &base[common..] {
        if !matches!(component, Component::CurDir) {
            relative.push("..");
        }
    }
    for component in &path[common..] {
        relative.push(component.as_os_str());
    }
    relative
}

fn pi_saved_decision(cwd: &Path, agent_dir: &Path) -> Option<&'static str> {
    let raw = read_limited(&agent_dir.join("trust.json"))?;
    let values = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
        .ok()?
        .as_object()?
        .clone();
    // Pi validates the whole store before looking up a project. A partly
    // malformed store must not accidentally inherit another directory's grant.
    if !values
        .values()
        .all(|value| matches!(value, Value::Bool(_) | Value::Null))
    {
        return Some("none");
    }
    let mut current = Some(cwd);
    while let Some(directory) = current {
        let key = pi_trust_key(directory);
        if let Some(value) = values.get(key.as_str()) {
            return match value {
                Value::Bool(true) => Some("trusted"),
                Value::Bool(false) => Some("declined"),
                // Pi uses null as an erased entry and keeps walking parents.
                Value::Null => {
                    current = directory.parent();
                    continue;
                }
                _ => unreachable!("validated above"),
            };
        }
        current = directory.parent();
    }
    Some("none")
}

/// Node's `realpathSync` stores ordinary Windows paths while Rust's
/// `canonicalize` can return a verbatim `\\?\\` path. Match Pi's keys without
/// altering the canonical path used for filesystem traversal.
fn pi_trust_key(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path.into_owned()
    }
}

fn default_project_trust(agent_dir: &Path) -> &'static str {
    let Some(raw) = read_limited(&agent_dir.join("settings.json")) else {
        return "ask";
    };
    match serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
        .ok()
        .and_then(|value| {
            value
                .get("defaultProjectTrust")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }) {
        Some(value) if value == "always" => "always",
        Some(value) if value == "never" => "never",
        _ => "ask",
    }
}

fn read_limited(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outside_resources(value: &Value) -> Vec<(String, String)> {
        value["outsideProtectedResources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|resource| {
                (
                    resource["path"].as_str().unwrap().to_owned(),
                    resource["target"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    #[cfg(any(unix, windows))]
    fn create_directory_symlink(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(target, link).unwrap();
    }

    #[cfg(windows)]
    fn create_junction(target: &Path, link: &Path) {
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn detects_protected_resources_but_not_a_bare_pi_directory() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        fs::create_dir_all(cwd.join(".pi")).unwrap();
        let agent = root.path().join("agent");
        assert_eq!(compute(&cwd, &agent, None)["protectedResources"], json!([]));
        fs::create_dir_all(cwd.join(".pi").join("extensions")).unwrap();
        let resources = compute(&cwd, &agent, None)["protectedResources"]
            .as_array()
            .unwrap()
            .clone();
        assert!(resources.contains(&json!(".pi/extensions")));
    }

    #[test]
    fn separates_plain_ancestor_agents_skills_with_its_real_target() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let skills = root.path().join(".agents").join("skills");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&skills).unwrap();

        let value = compute(&cwd, &root.path().join("agent"), None);
        assert_eq!(value["protectedResources"], json!([]));
        assert_eq!(
            outside_resources(&value),
            vec![(
                "../.agents/skills".to_owned(),
                path_display(&skills.canonicalize().unwrap()),
            )]
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[cfg_attr(windows, ignore = "requires Windows symbolic-link privilege; run outside the sandbox")]
    fn separates_a_protected_symlink_that_resolves_outside_the_project() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let outside = root.path().join("outside-skills");
        fs::create_dir_all(cwd.join(".pi")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        create_directory_symlink(&outside, &cwd.join(".pi").join("skills"));

        let value = compute(&cwd, &root.path().join("agent"), None);
        assert!(!value["protectedResources"]
            .as_array()
            .unwrap()
            .contains(&json!(".pi/skills")));
        assert_eq!(
            outside_resources(&value),
            vec![(
                ".pi/skills".to_owned(),
                path_display(&outside.canonicalize().unwrap()),
            )]
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[cfg_attr(windows, ignore = "requires Windows symbolic-link privilege; run outside the sandbox")]
    fn finds_a_nested_outside_symlink_without_following_contained_links() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let extensions = cwd.join(".pi").join("extensions");
        let nested = extensions.join("nested");
        let outside = root.path().join("outside-extension");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&outside).unwrap();
        create_directory_symlink(&outside, &nested.join("escape"));

        // This contained link points at a project directory that itself has an
        // outside link. Inspection deliberately stops at the first link.
        let safe_target = cwd.join("safe-target");
        fs::create_dir_all(&safe_target).unwrap();
        create_directory_symlink(&outside, &safe_target.join("not-traversed"));
        create_directory_symlink(&safe_target, &extensions.join("safe-link"));

        let value = compute(&cwd, &root.path().join("agent"), None);
        assert!(value["protectedResources"]
            .as_array()
            .unwrap()
            .contains(&json!(".pi/extensions")));
        assert_eq!(
            outside_resources(&value),
            vec![(
                ".pi/extensions/nested/escape".to_owned(),
                path_display(&outside.canonicalize().unwrap()),
            )]
        );
    }

    #[cfg(windows)]
    #[test]
    fn finds_a_nested_outside_junction_and_shows_its_real_target() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let nested = cwd.join(".pi").join("extensions").join("nested-junction");
        let outside = root.path().join("outside-junction");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&outside).unwrap();
        create_junction(&outside, &nested.join("escape"));
        let safe_target = cwd.join("safe-junction-target");
        fs::create_dir_all(&safe_target).unwrap();
        create_junction(&outside, &safe_target.join("not-traversed"));
        create_junction(
            &safe_target,
            &cwd.join(".pi").join("extensions").join("safe-link"),
        );

        let value = compute(&cwd, &root.path().join("agent"), None);
        assert_eq!(
            outside_resources(&value),
            vec![(
                ".pi/extensions/nested-junction/escape".to_owned(),
                path_display(&outside.canonicalize().unwrap()),
            )]
        );
    }

    #[cfg(windows)]
    #[test]
    fn separates_an_outside_linked_pi_ancestor_without_walking_it() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let outside_pi = root.path().join("outside-pi");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(outside_pi.join("extensions")).unwrap();
        create_junction(&outside_pi, &cwd.join(".pi"));

        let value = compute(&cwd, &root.path().join("agent"), None);
        assert!(!value["protectedResources"]
            .as_array()
            .unwrap()
            .contains(&json!(".pi")));
        assert_eq!(
            outside_resources(&value),
            vec![(
                ".pi".to_owned(),
                path_display(&outside_pi.canonicalize().unwrap()),
            )]
        );
    }

    #[cfg(windows)]
    #[test]
    fn contained_linked_pi_ancestor_is_reported_but_never_walked() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let linked_pi = cwd.join("linked-pi");
        let outside = root.path().join("outside-nested-link");
        fs::create_dir_all(linked_pi.join("extensions")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        create_junction(
            &outside,
            &linked_pi.join("extensions").join("must-not-be-read"),
        );
        create_junction(&linked_pi, &cwd.join(".pi"));

        let value = compute(&cwd, &root.path().join("agent"), None);
        assert_eq!(value["protectedResources"], json!([".pi"]));
        assert_eq!(value["outsideProtectedResources"], json!([]));
    }

    #[cfg(windows)]
    #[test]
    fn linked_ancestor_agents_directory_is_stopped_at_the_link() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let outside_agents = root.path().join("outside-agents");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(outside_agents.join("skills")).unwrap();
        create_junction(&outside_agents, &root.path().join(".agents"));

        let value = compute(&cwd, &root.path().join("agent"), None);
        assert_eq!(value["protectedResources"], json!([]));
        assert_eq!(
            outside_resources(&value),
            vec![(
                "../.agents".to_owned(),
                path_display(&outside_agents.canonicalize().unwrap()),
            )]
        );
    }

    #[test]
    fn closest_pi_decision_wins_and_null_continues_inheritance() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("parent");
        let cwd = parent.join("child");
        fs::create_dir_all(&cwd).unwrap();
        let agent = root.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        let parent_key = pi_trust_key(&parent.canonicalize().unwrap());
        let cwd_key = pi_trust_key(&cwd.canonicalize().unwrap());
        let mut trust = serde_json::Map::new();
        trust.insert(parent_key.clone(), Value::Bool(true));
        trust.insert(cwd_key.clone(), Value::Bool(false));
        fs::write(
            agent.join("trust.json"),
            serde_json::to_string(&trust).unwrap(),
        )
        .unwrap();
        assert_eq!(compute(&cwd, &agent, None)["piDecision"], "declined");
        trust.insert(cwd_key, Value::Null);
        fs::write(
            agent.join("trust.json"),
            serde_json::to_string(&trust).unwrap(),
        )
        .unwrap();
        assert_eq!(compute(&cwd, &agent, None)["piDecision"], "trusted");
    }

    #[test]
    fn malformed_settings_and_trust_fail_closed_and_flags_are_exact() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let agent = root.path().join("agent");
        fs::create_dir_all(cwd.join(".pi")).unwrap();
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("trust.json"), "not json").unwrap();
        fs::write(agent.join("settings.json"), "not json").unwrap();
        let value = compute(&cwd, &agent, None);
        assert_eq!(value["piDecision"], "none");
        assert_eq!(value["defaultProjectTrust"], "ask");
        assert_eq!(value["effective"], "skipped");
        assert_eq!(launch_flag(Some("trusted")), Some("--approve"));
        assert_eq!(launch_flag(Some("declined")), Some("--no-approve"));
        assert_eq!(launch_flag(Some("none")), None);
    }

    #[test]
    fn trust_store_bom_invalid_values_and_verbatim_windows_keys_are_safe() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let agent = root.path().join("agent");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&agent).unwrap();
        let key = pi_trust_key(&cwd.canonicalize().unwrap());
        fs::write(
            agent.join("trust.json"),
            format!("\u{feff}{{{key:?}:true}}"),
        )
        .unwrap();
        assert_eq!(compute(&cwd, &agent, None)["piDecision"], "trusted");
        fs::write(
            agent.join("settings.json"),
            "\u{feff}{\"defaultProjectTrust\":\"always\"}",
        )
        .unwrap();
        assert_eq!(compute(&cwd, &agent, None)["defaultProjectTrust"], "always");
        fs::write(agent.join("trust.json"), format!("{{{key:?}:\"bad\"}}")).unwrap();
        assert_eq!(compute(&cwd, &agent, None)["piDecision"], "none");
        assert_eq!(pi_trust_key(Path::new(r"\\?\D:\repo")), r"D:\repo");
        assert_eq!(
            pi_trust_key(Path::new(r"\\?\UNC\server\share")),
            r"\\server\share"
        );
        #[cfg(windows)]
        assert!(same_lexical_path(
            Path::new(r"\\?\D:\Repo\.agents\skills"),
            Path::new(r"d:\repo\.agents\skills")
        ));
    }

    #[test]
    fn settings_override_and_threadterm_decision_control_effective_state() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let agent = root.path().join("agent");
        fs::create_dir_all(cwd.join(".pi").join("skills")).unwrap();
        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"defaultProjectTrust":"always"}"#,
        )
        .unwrap();
        assert_eq!(compute(&cwd, &agent, None)["effective"], "loaded");
        assert_eq!(
            compute(&cwd, &agent, Some("declined"))["effective"],
            "skipped"
        );
        assert_eq!(
            agent_dir_for(Some(OsString::from("D:/configured")), None, Some(&cwd)),
            Some(PathBuf::from("D:/configured"))
        );
        assert_eq!(
            agent_dir_for(Some(OsString::from("agent")), None, Some(&cwd)),
            Some(cwd.join("agent"))
        );
        assert_eq!(
            agent_dir_for(None, Some(OsString::from("D:/home")), Some(&cwd)),
            Some(PathBuf::from("D:/home/.pi/agent"))
        );
        assert_eq!(
            agent_dir_for(
                Some(OsString::from("~/agent")),
                Some(OsString::from("D:/home")),
                Some(&cwd)
            ),
            Some(PathBuf::from("D:/home/agent"))
        );
    }

    #[test]
    fn threadterm_decision_persists_without_touching_pi_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("trust.sqlite");
        let db = Database::open(&path).unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO projects(id,name,path,created_at) VALUES ('project','project','/project','now')",
                [],
            )?;
            Ok(())
        }).unwrap();
        set(&db, "project", "trusted").unwrap();
        assert_eq!(read(&db, "project").unwrap().as_deref(), Some("trusted"));
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            read(&reopened, "project").unwrap().as_deref(),
            Some("trusted")
        );
        set(&reopened, "project", "none").unwrap();
        assert_eq!(read(&reopened, "project").unwrap(), None);
    }

    #[test]
    fn failed_project_write_does_not_leave_an_external_operation_claim() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("trust.sqlite")).unwrap();
        assert!(claim_and_set(&db, "missing", "trusted", "operation").is_err());
        let claimed = db
            .transaction(|tx| {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM external_operations WHERE id='operation')",
                    [],
                    |row| row.get(0),
                )?;
                Ok(exists)
            })
            .unwrap();
        assert!(!claimed);
    }
}
