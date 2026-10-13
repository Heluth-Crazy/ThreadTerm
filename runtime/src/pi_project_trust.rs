//! Read-only Pi project-trust inspection plus ThreadTerm's separate decision.
//!
//! Pi owns `trust.json` and `settings.json`; this module never mutates either.
use crate::db::Database;
use anyhow::{anyhow, Result};
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
    let protected_resources = protected_resources(&cwd, home);
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
        "protectedResources": protected_resources,
        "piDecision": pi_decision,
        "defaultProjectTrust": default_project_trust,
        "threadtermDecision": threadterm_decision,
        "effective": effective,
    })
}

fn canonical_or_absolute(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        }
    })
}

fn protected_resources(cwd: &Path, home: Option<OsString>) -> Vec<String> {
    let mut found = PI_PROTECTED
        .iter()
        .map(|resource| cwd.join(resource))
        .filter(|path| path.exists())
        .map(|path| relative_display(cwd, &path))
        .collect::<Vec<_>>();
    // Pi checks HOME before falling back to Node's homedir() (USERPROFILE on
    // Windows). Its `HOME` override must therefore win for this exclusion.
    let home_agents = home
        .or_else(|| std::env::var_os("HOME"))
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| canonical_or_absolute(&PathBuf::from(home).join(".agents").join("skills")));
    let mut current = Some(cwd);
    while let Some(directory) = current {
        let skills = directory.join(".agents").join("skills");
        if skills.exists() && home_agents.as_ref() != Some(&canonical_or_absolute(&skills)) {
            found.push(relative_display(cwd, &skills));
        }
        current = directory.parent();
    }
    found.sort();
    found.dedup();
    found
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
        .and_then(|value| value.get("defaultProjectTrust").and_then(Value::as_str).map(str::to_owned))
    {
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

    #[test]
    fn detects_protected_resources_but_not_a_bare_pi_directory() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        fs::create_dir_all(cwd.join(".pi")).unwrap();
        let agent = root.path().join("agent");
        assert_eq!(compute(&cwd, &agent, None)["protectedResources"], json!([]));
        fs::create_dir_all(cwd.join(".pi").join("extensions")).unwrap();
        fs::create_dir_all(root.path().join(".agents").join("skills")).unwrap();
        let resources = compute(&cwd, &agent, None)["protectedResources"]
            .as_array()
            .unwrap()
            .clone();
        assert!(resources.contains(&json!(".pi/extensions")));
        assert!(resources.contains(&json!("../.agents/skills")));
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
