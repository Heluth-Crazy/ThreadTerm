//! Restrictive native options are selected from the current participant catalogue.
use crate::{
    db::Database,
    providers::{ProviderRuntime, Providers},
};
use anyhow::Result;
use serde_json::{json, Value};
const PI_READ_ONLY_TOOLS: &str = "read,grep,find,ls";
const CLAUDE_READ_ONLY_TOOLS: &str = "Read,Glob,Grep";

// These names are provider-internal compatibility keys. Renaming them would
// require a coordinated provider migration; Group chat never exposes them.
const STARTUP_TOOLS_KEY: &str = "roundtable-tools";
const REQUIRED_MODE_KEY: &str = "roundtable-required-mode";
const NATIVE_TOOLS_REPORT_KEY: &str = "roundtableToolsReport";

/// Stages restrictive startup choices for a `mode:'read_only'` group member.
/// Default-mode members never call this and retain their ordinary Chat choices.
pub(crate) fn prepare(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
    _model: Option<&str>,
) -> Result<(String, String)> {
    // Group chat owns these selections; native modes are applied after discovery,
    // before any prompt. Old saved modes must not reject an older CLI at startup.
    let saved = db.chat_option_selections(session_id, provider)?;
    let rows = saved
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            !matches!(
                row["id"].as_str(),
                Some("mode" | "sandbox" | "agent" | STARTUP_TOOLS_KEY | REQUIRED_MODE_KEY)
            ) && row["category"] != "mode"
        })
        .cloned()
        .collect::<Vec<_>>();
    db.set_chat_option_selections(session_id, provider, &json!(rows))?;
    if provider == "claude" {
        stage(
            db,
            session_id,
            provider,
            vec![
                json!({"id":"mode","value":"dontAsk"}),
                json!({"id":STARTUP_TOOLS_KEY,"value":CLAUDE_READ_ONLY_TOOLS}),
            ],
        )?;
    }
    if provider == "pi" {
        let probe = providers.pi_read_only_probe();
        if probe.supported {
            stage(
                db,
                session_id,
                provider,
                vec![json!({"id":STARTUP_TOOLS_KEY,"value":PI_READ_ONLY_TOOLS})],
            )?;
        }
        return Ok((
            if probe.supported {
                "enforced"
            } else {
                "prompt"
            }
            .into(),
            probe.note,
        ));
    }
    Ok((
        "prompt".into(),
        "Read-only by instruction; native restrictions are confirmed when the group member starts"
            .into(),
    ))
}

pub(crate) fn after_connect(
    _db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
    model: Option<&str>,
) -> Result<()> {
    apply_model(providers, session_id, provider, model)
}

fn apply_model(
    providers: &Providers,
    session_id: &str,
    provider: &str,
    model: Option<&str>,
) -> Result<()> {
    let Some(model) = model.filter(|model| !model.is_empty()) else {
        return Ok(());
    };
    let state = providers.chat_options(session_id)?;
    let preferred = match provider {
        "opencode" => Some("next-model"),
        _ => Some("model"),
    };
    let option = state["options"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|option| {
            (Some(option["id"].as_str().unwrap_or_default()) == preferred
                || option["category"].as_str() == Some("model"))
                && option["choices"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|choice| choice["value"] == model)
        });
    let Some(id) = option.and_then(|option| option["id"].as_str()) else {
        anyhow::bail!("Group chat model {model} is not advertised by {provider}");
    };
    providers.chat_set_option(session_id, id, model)?;
    Ok(())
}

fn requested(state: &Value, provider: &str) -> Vec<(String, String)> {
    match provider {
        "codex" => vec![
            ("mode".into(), "never".into()),
            ("sandbox".into(), "read-only".into()),
        ],
        "kimi" | "grok" => vec![("mode".into(), "plan".into())],
        "opencode" => vec![("agent".into(), "plan".into())],
        "claude" | "pi" => Vec::new(),
        _ => state["options"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["category"] == "mode" && offered(row, "plan"))
            .and_then(|row| row["id"].as_str())
            .map(|id| vec![(id.into(), "plan".into())])
            .unwrap_or_default(),
    }
}
fn offered(row: &Value, value: &str) -> bool {
    row["choices"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|choice| choice["value"] == value)
}
fn missing_note(provider: &str) -> String {
    format!("{} does not advertise or confirm the required read-only mode — update or configure the provider for enforced read-only; Group chat continues read-only by instruction",crate::providers::builtin_name(provider))
}
fn confirmed(state: &Value, provider: &str, expected: &[(String, String)]) -> (String, String) {
    if provider == "claude" {
        let report = &state[NATIVE_TOOLS_REPORT_KEY];
        return if report["enforced"] == true {
            (
                "enforced".into(),
                "Claude reports only Read, Glob and Grep with no MCP tools".into(),
            )
        } else {
            ("prompt".into(),format!("Claude read-only tools are unconfirmed: {} — update or configure Claude for native tool restrictions",report["reason"].as_str().unwrap_or("the session did not report its tool list")))
        };
    }
    let ok = !expected.is_empty()
        && expected.iter().all(|(id, value)| {
            state["options"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|row| row["id"] == *id && offered(row, value) && row["value"] == *value)
        });
    if ok {
        if provider == "opencode" {
            (
                "prompt".into(),
                "OpenCode reports its Plan agent; read-only is required by instruction".into(),
            )
        } else {
            (
                "enforced".into(),
                "The group member reports the requested native read-only mode".into(),
            )
        }
    } else {
        ("prompt".into(), missing_note(provider))
    }
}
/// Reapply drift before each send; unsupported or rejected settings downgrade visibly.
pub(crate) fn verify(
    _db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
) -> Result<(String, String)> {
    if provider == "pi" {
        let report = providers.roundtable_read_only_report(session_id)?;
        return Ok((if report["enforced"]==true {"enforced"}else{"prompt"}.into(),report["reason"].as_str().unwrap_or("Pi has no confirmed read-only launch restriction — update Pi for enforced read-only").into()));
    }
    let mut state = providers.chat_options(session_id)?;
    if provider == "claude" {
        state[NATIVE_TOOLS_REPORT_KEY] = providers.roundtable_read_only_report(session_id)?;
        return Ok(confirmed(&state, provider, &[]));
    }
    let expected = requested(&state, provider);
    for (id, value) in &expected {
        let row = state["options"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == *id);
        if let Some(row) = row.filter(|row| offered(row, value)) {
            if row["value"] != *value && providers.chat_set_option(session_id, id, value).is_err() {
                return Ok(("prompt".into(), missing_note(provider)));
            }
        } else {
            return Ok(("prompt".into(), missing_note(provider)));
        }
    }
    Ok(confirmed(
        &providers.chat_options(session_id)?,
        provider,
        &expected,
    ))
}

fn stage(db: &Database, session_id: &str, provider: &str, additions: Vec<Value>) -> Result<()> {
    let mut rows = db
        .chat_option_selections(session_id, provider)?
        .as_array()
        .cloned()
        .unwrap_or_default();
    for selection in additions {
        let id = selection["id"].as_str().expect("group read-only option id");
        if let Some(existing) = rows.iter_mut().find(|row| row["id"] == id) {
            *existing = selection;
        } else {
            rows.push(selection);
        }
    }
    db.set_chat_option_selections(session_id, provider, &Value::Array(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_modes_and_drift_never_count_as_enforced() {
        let expected = vec![("mode".into(), "plan".into())];
        assert_eq!(
            confirmed(&json!({"options":[]}), "kimi", &expected).0,
            "prompt"
        );
        let state =
            json!({"options":[{"id":"mode","value":"default","choices":[{"value":"plan"}]}]});
        assert_eq!(confirmed(&state, "grok", &expected).0, "prompt");
        let state = json!({"options":[{"id":"mode","value":"plan","choices":[{"value":"plan"}]}]});
        assert_eq!(confirmed(&state, "grok", &expected).0, "enforced");
    }
    #[test]
    fn claude_requires_a_native_tool_report() {
        assert_eq!(confirmed(&json!({}), "claude", &[]).0, "prompt");
        assert_eq!(
            confirmed(
                &json!({"roundtableToolsReport":{"enforced":false,"reason":"extra tool Bash"}}),
                "claude",
                &[]
            )
            .0,
            "prompt"
        );
        assert_eq!(
            confirmed(
                &json!({"roundtableToolsReport":{"enforced":true}}),
                "claude",
                &[]
            )
            .0,
            "enforced"
        );
    }
}
