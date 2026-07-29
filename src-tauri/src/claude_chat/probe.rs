//! Environment probe for chat mode (design D8): resolve `node` and `claude`,
//! enforce minimum versions, and cache the verdict briefly so the UI can gate
//! the chat entry point cheaply.

use crate::agent_sessions::process::background_cli_command;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub(crate) const MIN_NODE_MAJOR: u32 = 20;
/// `-p` slash commands (`/model`, `/effort`, `/config k=v`) landed in 2.1.205.
pub(crate) const MIN_CLAUDE_VERSION: (u32, u32, u32) = (2, 1, 205);
const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    pub(crate) ok: bool,
    /// `node` | `claude` | `node-version` | `claude-version` when not ok.
    pub(crate) missing: Option<String>,
    pub(crate) detail: Option<String>,
    pub(crate) node_version: Option<String>,
    pub(crate) claude_version: Option<String>,
}

static CACHE: Lazy<Mutex<Option<(Instant, ProbeResult)>>> = Lazy::new(|| Mutex::new(None));

pub(crate) async fn probe(force: bool) -> ProbeResult {
    {
        let cache = CACHE.lock().await;
        if !force {
            if let Some((at, result)) = cache.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return result.clone();
                }
            }
        }
    }
    let result = run_probe().await;
    *CACHE.lock().await = Some((Instant::now(), result.clone()));
    result
}

async fn run_probe() -> ProbeResult {
    let node_version = run_version("node").await;
    let Some(node_version) = node_version else {
        return unavailable("node", "Node.js was not found on PATH", None, None);
    };
    let node_ok = parse_node_major(&node_version).is_some_and(|major| major >= MIN_NODE_MAJOR);
    if !node_ok {
        return unavailable(
            "node-version",
            &format!("Node.js {node_version} is older than the required v{MIN_NODE_MAJOR}"),
            Some(node_version),
            None,
        );
    }

    let claude_version = run_version("claude").await;
    let Some(claude_version) = claude_version else {
        return unavailable(
            "claude",
            "The claude CLI was not found on PATH",
            Some(node_version),
            None,
        );
    };
    let claude_ok =
        parse_claude_version(&claude_version).is_some_and(|version| version >= MIN_CLAUDE_VERSION);
    if !claude_ok {
        let (a, b, c) = MIN_CLAUDE_VERSION;
        return unavailable(
            "claude-version",
            &format!("claude {claude_version} is older than the required {a}.{b}.{c}"),
            Some(node_version),
            Some(claude_version),
        );
    }

    ProbeResult {
        ok: true,
        missing: None,
        detail: None,
        node_version: Some(node_version),
        claude_version: Some(claude_version),
    }
}

fn unavailable(
    missing: &str,
    detail: &str,
    node_version: Option<String>,
    claude_version: Option<String>,
) -> ProbeResult {
    ProbeResult {
        ok: false,
        missing: Some(missing.to_owned()),
        detail: Some(detail.to_owned()),
        node_version,
        claude_version,
    }
}

async fn run_version(name: &str) -> Option<String> {
    let output = background_cli_command(name)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_owned())
    }
}

/// The executable handed to the sidecar as `THREADTERM_CLAUDE_PATH`. On
/// Windows this resolves shims per the background-process contract; elsewhere
/// the bare name lets the sidecar inherit PATH lookup.
pub(crate) fn claude_executable() -> String {
    #[cfg(windows)]
    {
        if let Some(path) = crate::agent_sessions::process::resolve_windows_cli_program("claude") {
            return path.to_string_lossy().into_owned();
        }
    }
    "claude".to_owned()
}

pub(crate) fn node_program() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Some(path) = crate::agent_sessions::process::resolve_windows_cli_program("node") {
            return path;
        }
    }
    std::path::PathBuf::from("node")
}

fn parse_node_major(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn parse_claude_version(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.split_whitespace().next()?.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch: u32 = parts
        .next()
        .map(|raw| {
            raw.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .and_then(|digits| digits.parse().ok())?;
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_node_versions() {
        assert_eq!(parse_node_major("v24.13.1"), Some(24));
        assert_eq!(parse_node_major("20.0.0"), Some(20));
        assert_eq!(parse_node_major("weird"), None);
    }

    #[test]
    fn parses_claude_versions() {
        assert_eq!(
            parse_claude_version("2.1.220 (Claude Code)"),
            Some((2, 1, 220))
        );
        assert_eq!(parse_claude_version("2.1.205"), Some((2, 1, 205)));
        assert_eq!(parse_claude_version("nope"), None);
    }

    #[test]
    fn version_gate_comparisons_hold() {
        assert!((2, 1, 220) >= MIN_CLAUDE_VERSION);
        assert!((2, 1, 204) < MIN_CLAUDE_VERSION);
        assert!((3, 0, 0) >= MIN_CLAUDE_VERSION);
    }
}
