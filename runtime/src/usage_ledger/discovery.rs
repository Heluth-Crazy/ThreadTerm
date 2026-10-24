use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Root {
    pub provider: String,
    pub path: PathBuf,
    pub trees: Vec<PathBuf>,
}

pub fn roots() -> Vec<Root> {
    resolve(&env::vars().collect(), cfg!(windows))
}

pub fn resolve(vars: &HashMap<String, String>, windows: bool) -> Vec<Root> {
    let home = vars
        .get(if windows { "USERPROFILE" } else { "HOME" })
        .or_else(|| vars.get("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let at = |name: &str, default: PathBuf| {
        vars.get(name)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or(default)
    };
    let make = |provider: &str, path: PathBuf, trees: &[&str]| Root {
        provider: provider.into(),
        trees: trees.iter().map(|s| path.join(s)).collect(),
        path,
    };
    let pi = at("PI_CODING_AGENT_DIR", home.join(".pi/agent"));
    let pi_sessions = vars
        .get("PI_CODING_AGENT_SESSION_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| pi_session_setting(&pi))
        .unwrap_or_else(|| pi.join("sessions"));
    let pi_root = if pi.is_absolute() {
        pi
    } else if pi_sessions.is_absolute() {
        pi_sessions.clone()
    } else {
        pi
    };
    let data = at("XDG_DATA_HOME", home.join(".local/share"));
    // A missing home directory must not turn a provider default into a
    // workspace-relative path. Explicit portable roots are absolute too.
    vec![
        make(
            "claude",
            at("CLAUDE_CONFIG_DIR", home.join(".claude")),
            &["projects"],
        ),
        make(
            "codex",
            at("CODEX_HOME", home.join(".codex")),
            &["sessions", "archived_sessions"],
        ),
        make(
            "kimi",
            at("KIMI_CODE_HOME", home.join(".kimi-code")),
            &["sessions"],
        ),
        make("grok", at("GROK_HOME", home.join(".grok")), &["sessions"]),
        make(
            "opencode",
            data.join("opencode"),
            &["opencode.db", "storage/message"],
        ),
        Root {
            provider: "pi".into(),
            path: pi_root,
            trees: vec![pi_sessions],
        },
        make(
            "gemini",
            at("GEMINI_CLI_HOME", home).join(".gemini"),
            &["tmp"],
        ),
    ]
    .into_iter()
    .filter(|root| root.path.is_absolute())
    .collect()
}

fn pi_session_setting(root: &Path) -> Option<PathBuf> {
    use std::io::Read;
    let mut file = std::fs::File::open(root.join("settings.json")).ok()?;
    if file.metadata().ok()?.len() > 256 * 1024 {
        return None;
    }
    let mut raw = String::new();
    file.read_to_string(&mut raw).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let path = PathBuf::from(settings.get("sessionDir")?.as_str()?);
    Some(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

pub fn accepted(provider: &str, path: &Path) -> bool {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if matches!(
        name,
        "auth.json" | ".credentials.json" | "credentials.json" | "tokens.json" | "oauth.json"
    ) {
        return false;
    }
    match provider {
        "kimi" => name == "wire.jsonl",
        "grok" => name == "updates.jsonl",
        "opencode" => name == "opencode.db" || path.extension().is_some_and(|s| s == "json"),
        "gemini" => false,
        "codex" => name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"),
        _ => name.ends_with(".jsonl"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_roots_and_native_overrides() {
        let temp = std::env::temp_dir().join("usage-root-fixture");
        for windows in [true, false] {
            let mut vars = HashMap::from([
                ("HOME".into(), temp.to_string_lossy().into_owned()),
                ("USERPROFILE".into(), temp.to_string_lossy().into_owned()),
            ]);
            let defaults = resolve(&vars, windows);
            assert_eq!(defaults[0].path, temp.join(".claude"));
            assert_eq!(defaults[4].path, temp.join(".local/share/opencode"));
            for (provider, key) in [
                ("claude", "CLAUDE_CONFIG_DIR"),
                ("codex", "CODEX_HOME"),
                ("kimi", "KIMI_CODE_HOME"),
                ("grok", "GROK_HOME"),
                ("pi", "PI_CODING_AGENT_DIR"),
            ] {
                let custom = temp.join(provider);
                vars.insert(key.into(), custom.to_string_lossy().into_owned());
                assert_eq!(
                    resolve(&vars, windows)
                        .into_iter()
                        .find(|r| r.provider == provider)
                        .unwrap()
                        .path,
                    custom
                );
            }
            vars.insert(
                "GEMINI_CLI_HOME".into(),
                temp.join("redirect").to_string_lossy().into_owned(),
            );
            assert_eq!(
                resolve(&vars, windows)[6].path,
                temp.join("redirect/.gemini")
            );
        }
    }
    #[test]
    fn credentials_are_never_candidates() {
        for provider in [
            "claude", "codex", "kimi", "grok", "opencode", "pi", "gemini",
        ] {
            assert!(!accepted(provider, Path::new("auth.json")));
        }
        // OpenCode candidates are restricted to its message tree by discovery.
        assert!(!accepted("kimi", Path::new(".credentials.json")));
    }

    #[test]
    fn missing_home_never_discovers_workspace_relative_defaults() {
        assert!(resolve(&HashMap::new(), true).is_empty());
    }

    #[test]
    fn explicit_pi_session_root_survives_without_a_home_directory() {
        let sessions = std::env::temp_dir().join("usage-pi-sessions");
        let roots = resolve(
            &HashMap::from([(
                "PI_CODING_AGENT_SESSION_DIR".into(),
                sessions.to_string_lossy().into_owned(),
            )]),
            true,
        );
        let pi = roots.iter().find(|root| root.provider == "pi").unwrap();
        assert_eq!(pi.trees, vec![sessions]);
    }
}
