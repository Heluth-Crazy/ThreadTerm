//! Bounded, allow-listed session metadata needed before a journal is streamed.
//!
//! This deliberately never opens a transcript, prompt, history, or credential
//! file.  The returned state contains only identifiers, model IDs, cwd and a
//! small format marker that a reader needs for reconciliation.

use crate::usage_ledger::facts::ReaderState;
use serde_json::{json, Value};
use std::path::{Component, Path};

const MAX_METADATA_BYTES: u64 = 256 * 1024;
const MAX_ID_BYTES: usize = 512;
const MAX_CWD_BYTES: usize = 4096;

pub fn initial_state(provider: &str, path: &Path) -> ReaderState {
    match provider {
        "claude" => ReaderState {
            data: json!({"claudeAgentId":path.file_name().and_then(|s|s.to_str()).and_then(|s|s.strip_prefix("agent-")).and_then(|s|s.strip_suffix(".jsonl")).and_then(|s|bounded(Some(s),MAX_ID_BYTES))}),
            ..Default::default()
        },
        "kimi" => kimi(path),
        "grok" => grok(path),
        _ => ReaderState::default(),
    }
}

fn bounded(value: Option<&str>, limit: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= limit && !value.contains('\0'))
        .map(str::to_owned)
}

fn read_json(path: &Path) -> Option<Value> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_METADATA_BYTES
    {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn read_cwd(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_METADATA_BYTES
    {
        return None;
    }
    let text = String::from_utf8(std::fs::read(path).ok()?).ok()?;
    bounded(Some(text.trim()), MAX_CWD_BYTES)
}

fn components(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str().map(str::to_owned),
            _ => None,
        })
        .collect()
}

fn with_problem(problem: &str) -> ReaderState {
    ReaderState {
        data: json!({"sourceMetadataProblem": problem}),
        ..Default::default()
    }
}

fn kimi(path: &Path) -> ReaderState {
    let parts = components(path);
    let Some(sessions) = parts.iter().rposition(|part| part == "sessions") else {
        return with_problem("unsupported kimi journal path");
    };
    let tail = &parts[sessions + 1..];
    // The v2 addressing contract is sessions/<handler>/<session>/wire.jsonl
    // and nested agents use sessions/<handler>/<session>/agents/<agent>/wire.jsonl.
    let (session, agent) = match tail {
        [handler, session, file]
            if !handler.is_empty() && handler != "agents" && file == "wire.jsonl" =>
        {
            (bounded(Some(session), MAX_ID_BYTES), None)
        }
        [handler, session, agents, agent, file]
            if !handler.is_empty()
                && handler != "agents"
                && agents == "agents"
                && file == "wire.jsonl" =>
        {
            (
                bounded(Some(session), MAX_ID_BYTES),
                bounded(Some(agent), MAX_ID_BYTES),
            )
        }
        _ => return with_problem("unsupported kimi journal path"),
    };
    let Some(session) = session else {
        return with_problem("unsupported kimi journal path");
    };
    let session_dir = match agent.as_ref() {
        Some(_) => path.parent().and_then(Path::parent).and_then(Path::parent),
        None => path.parent(),
    };
    let Some(session_dir) = session_dir else {
        return with_problem("unsupported kimi journal path");
    };
    // Kimi v2 stores SessionMeta in state.json at the session scope; the
    // predecessor used the same key below the session-meta scope.
    let meta = [
        session_dir.join("state.json"),
        session_dir.join("session-meta").join("state.json"),
    ]
    .into_iter()
    .find_map(|candidate| read_json(&candidate));
    if meta
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(Value::as_u64)
        .is_some_and(|v| v > 2)
    {
        return with_problem("unsupported_kimi_session_metadata_version");
    }
    let root_agent = meta
        .as_ref()
        .and_then(|value| {
            value
                .get("agents")
                .and_then(Value::as_object)
                .and_then(|agents| {
                    agents
                        .iter()
                        .find(|(_, v)| v.get("type").and_then(Value::as_str) == Some("main"))
                })
                .and_then(|(id, _)| bounded(Some(id), MAX_ID_BYTES))
        })
        .or_else(|| {
            agent
                .as_deref()
                .filter(|id| *id == "main")
                .map(str::to_owned)
        });
    let is_subagent = match (&agent, &root_agent) {
        (Some(agent), Some(root)) => agent != root,
        (None, _) => false,
        // A nested journal without its documented root agent metadata cannot
        // be safely attached to a parent session.
        (Some(_), None) => {
            return ReaderState {
                session_id: session,
                data: json!({
                    "sourceMetadataProblem": "kimi agent journal has no rootAgentId metadata",
                    "sourceMetadataVersion": 2,
                }),
                ..Default::default()
            }
        }
    };
    let independent = agent
        .as_deref()
        .and_then(|id| meta.as_ref()?.get("agents")?.get(id)?.get("type")?.as_str())
        == Some("independent");
    ReaderState {
        session_id: session,
        cwd: meta
            .as_ref()
            .and_then(|v| bounded(v.get("cwd").and_then(Value::as_str), MAX_CWD_BYTES)),
        parent_session_id: meta
            .as_ref()
            .and_then(|v| bounded(v.get("forkedFrom").and_then(Value::as_str), MAX_ID_BYTES)),
        data: json!({
            "sourceMetadataVersion": 2,
            "kimiAgentId": agent,
            "kimiRootAgentId": root_agent,
            "kimiSubagent": is_subagent && !independent,
            "kimiIndependent": independent,
            "kimiForkCreatedAt": meta.as_ref().filter(|v|v.get("forkedFrom").is_some()).and_then(|v|v.get("createdAt")).and_then(metadata_millis),
        }),
        ..Default::default()
    }
}

fn decode_cwd(component: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(component.len());
    let source = component.as_bytes();
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            if index + 2 >= source.len() {
                return None;
            }
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            bytes.push(digit(source[index + 1])? * 16 + digit(source[index + 2])?);
            index += 3;
        } else {
            bytes.push(source[index]);
            index += 1;
        }
    }
    bounded(std::str::from_utf8(&bytes).ok(), MAX_CWD_BYTES)
}

fn metadata_millis(value: &Value) -> Option<i64> {
    if let Some(value) = value.as_i64() {
        return if value.abs() < 100_000_000_000 {
            value.checked_mul(1000)
        } else {
            Some(value)
        };
    }
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn grok(path: &Path) -> ReaderState {
    let parts = components(path);
    let Some(sessions) = parts.iter().rposition(|part| part == "sessions") else {
        return with_problem("unsupported grok journal path");
    };
    let tail = &parts[sessions + 1..];
    let [encoded_cwd, session, file] = tail else {
        return with_problem("unsupported grok journal path");
    };
    if file != "updates.jsonl" {
        return with_problem("unsupported grok journal path");
    }
    let Some(session_id) = bounded(Some(session), MAX_ID_BYTES) else {
        return with_problem("unsupported grok journal path");
    };
    let Some(session_dir) = path.parent() else {
        return with_problem("unsupported grok journal path");
    };
    let summary = read_json(&session_dir.join("summary.json"));
    let value = summary.as_ref();
    let model = value.and_then(|value| {
        bounded(
            value.get("current_model_id").and_then(Value::as_str),
            MAX_ID_BYTES,
        )
    });
    let parent = value.and_then(|value| {
        bounded(
            value.get("parent_session_id").and_then(Value::as_str),
            MAX_ID_BYTES,
        )
    });
    let created_at = value.and_then(|value| value.get("created_at").and_then(metadata_millis));
    let cwd = read_cwd(&session_dir.parent().unwrap_or(Path::new("")).join(".cwd"))
        .or_else(|| decode_cwd(encoded_cwd));
    ReaderState {
        session_id,
        parent_session_id: parent,
        cwd,
        model,
        data: json!({
            "sourceMetadataVersion": 1,
            "grokForkCreatedAt": created_at,
            "modelFromSummary": true,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kimi_metadata_maps_only_the_documented_agent_scope() {
        let temp = tempfile::tempdir().unwrap();
        let journal = temp
            .path()
            .join("sessions/handler/session-a/agents/main/wire.jsonl");
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        std::fs::write(
            journal
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("state.json"),
            r#"{"version":2,"agents":{"main":{"type":"main"}},"private":"DISTINCTIVE_PROMPT_DO_NOT_STORE"}"#,
        )
        .unwrap();
        let state = initial_state("kimi", &journal);
        assert_eq!(state.session_id, "session-a");
        assert_eq!(state.data["kimiSubagent"], false);
        assert!(!state
            .data
            .to_string()
            .contains("DISTINCTIVE_PROMPT_DO_NOT_STORE"));
    }

    #[test]
    fn grok_metadata_uses_allowlisted_summary_and_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let journal = temp
            .path()
            .join("sessions/%2Fworkspace/session-b/updates.jsonl");
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        std::fs::write(
            journal.parent().unwrap().join("summary.json"),
            r#"{"current_model_id":"fixture-grok-model","parent_session_id":"parent-b","created_at":12,"title":"DISTINCTIVE_PROMPT_DO_NOT_STORE"}"#,
        )
        .unwrap();
        let state = initial_state("grok", &journal);
        assert_eq!(state.session_id, "session-b");
        assert_eq!(state.model.as_deref(), Some("fixture-grok-model"));
        assert_eq!(state.parent_session_id.as_deref(), Some("parent-b"));
        assert_eq!(state.cwd.as_deref(), Some("/workspace"));
        assert!(!state
            .data
            .to_string()
            .contains("DISTINCTIVE_PROMPT_DO_NOT_STORE"));
    }
}
