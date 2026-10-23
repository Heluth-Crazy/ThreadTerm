use super::*;
use crate::providers::ProviderError;

pub(super) fn is_permission_option(provider: &str, option: &Value) -> bool {
    let id = option.get("id").and_then(Value::as_str).unwrap_or_default();
    match provider {
        "codex" => matches!(id, "mode" | "sandbox"),
        "claude" | "kimi" | "grok" => id == "mode",
        "opencode" | "pi" => false,
        _ => option.get("category").and_then(Value::as_str) == Some("mode"),
    }
}

const RESET_OPTION: &str = "threadterm-permission-recovery";

pub(super) fn matches_current(provider: &str, event: &Value, current: &Value) -> bool {
    let rows = event["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| is_permission_option(provider, row))
        .collect::<Vec<_>>();
    !rows.is_empty()
        && rows.iter().all(|row| {
            current["options"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|live| live["id"] == row["id"] && live["value"] == row["value"])
        })
}

fn merge(rows: &mut Vec<Value>, option: Value) {
    if let Some(existing) = rows.iter_mut().find(|row| row["id"] == option["id"]) {
        *existing = option;
    } else {
        rows.push(option);
    }
}

pub(super) fn startup_options(db: &Database, session_id: &str, provider: &str) -> Result<Value> {
    let saved = db.chat_option_selections(session_id, provider)?;
    let mut rows = saved
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| is_permission_option(provider, row))
        .cloned()
        .collect::<Vec<_>>();
    let pending = db.pending_fork_options(session_id)?;
    if pending
        .as_array()
        .into_iter()
        .flatten()
        .any(|row| row["id"] == RESET_OPTION)
    {
        rows.clear();
    }
    for option in pending.as_array().into_iter().flatten() {
        if option["id"] == RESET_OPTION {
            continue;
        }
        if is_permission_option(provider, option)
            || rows.iter().any(|row| row["id"] == option["id"])
        {
            merge(&mut rows, option.clone());
        }
    }
    if provider == "claude"
        && rows
            .iter()
            .any(|row| row["id"] == "mode" && row["value"] == "auto")
    {
        if let Some(model) = pending
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == "model")
            .or_else(|| {
                saved
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|row| row["id"] == "model" && row["startupDependency"] == true)
            })
        {
            let mut dependency = model.clone();
            dependency["startupDependency"] = json!(true);
            merge(&mut rows, dependency);
        }
    }
    Ok(json!(rows))
}

pub(super) fn remember(
    db: &Database,
    session_id: &str,
    provider: &str,
    state: &Value,
) -> Result<()> {
    let mut rows = db
        .chat_option_selections(session_id, provider)?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut changed = false;
    if provider == "claude" {
        rows.retain(|row| row["startupDependency"] != true);
        if state["options"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| row["id"] == "mode" && row["value"] == "auto")
        {
            if let Some(model) = state["options"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|row| row["id"] == "model" && row["value"].is_string())
            {
                merge(
                    &mut rows,
                    json!({"id":"model","value":model["value"],"startupDependency":true}),
                );
            }
        }
    }
    for option in state
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if !is_permission_option(provider, option) {
            continue;
        }
        let (Some(id), Some(value)) = (
            option["id"].as_str(),
            option["value"]
                .as_str()
                .filter(|value| *value != "unavailable"),
        ) else {
            continue;
        };
        let mut selection = json!({"id":id,"value":value});
        if !matches!(provider, "codex" | "claude" | "kimi" | "grok")
            && option.get("category").and_then(Value::as_str) == Some("mode")
        {
            selection["category"] = json!("mode");
        }
        merge(&mut rows, selection);
        changed = true;
    }
    if changed {
        db.set_chat_option_selections(session_id, provider, &json!(rows))?;
    }
    Ok(())
}

pub(super) fn remember_command(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    text: &str,
    previous: Option<&Value>,
) -> Result<()> {
    let Some(session) = db.session_by_id(session_id)? else {
        return Ok(());
    };
    let mut words = text.split_whitespace();
    let command = words.next();
    let argument = words.next();
    let target = match (session.provider.as_str(), command, argument) {
        ("codex", Some("/sandbox"), Some(value)) if !matches!(value, "?" | "status") => {
            Some(("sandbox", value))
        }
        ("codex", Some("/approvals"), Some(value)) if !matches!(value, "?" | "status") => {
            Some(("mode", value))
        }
        ("kimi", Some("/yolo" | "/yes"), None) => Some(("mode", "yolo")),
        ("kimi", Some("/auto"), None) => Some(("mode", "auto")),
        ("kimi", Some("/plan"), Some("on")) => Some(("mode", "plan")),
        ("kimi", Some("/plan"), Some("off")) => Some(("mode", "default")),
        ("kimi", Some("/plan"), None) => previous.map(|state| {
            (
                "mode",
                if state["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|row| row["id"] == "mode" && row["value"] == "plan")
                {
                    "default"
                } else {
                    "plan"
                },
            )
        }),
        _ => None,
    };
    if let Some((id, value)) = target {
        let state = providers.chat_options(session_id)?;
        if crate::providers::verify_permission_options(&state, &json!([{"id":id,"value":value}]))
            .is_ok()
        {
            remember(db, session_id, &session.provider, &state)?;
        }
    }
    Ok(())
}

pub(super) fn verify(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
) -> Result<()> {
    let options = startup_options(db, session_id, provider)?;
    if options.as_array().is_some_and(|rows| !rows.is_empty()) {
        crate::providers::verify_permission_options(
            &providers.chat_options(session_id)?,
            &options,
        )?;
    }
    Ok(())
}

pub(super) fn apply_pending(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
) -> Result<()> {
    let pending = db.pending_fork_options(session_id)?;
    let startup = startup_options(db, session_id, provider)?;
    for option in pending.as_array().into_iter().flatten() {
        if option["id"] == RESET_OPTION {
            continue;
        }
        if provider == "claude"
            && option["id"] == "model"
            && startup.as_array().into_iter().flatten().any(|row| {
                row["id"] == "model"
                    && row["startupDependency"] == true
                    && row["value"] == option["value"]
            })
        {
            continue;
        }
        let id = option["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid_fork_options"))?;
        let value = option["value"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid_fork_options"))?;
        let state = providers.chat_options(session_id)?;
        let current = state["options"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == id);
        // Permission overrides were applied at startup. In particular, do not
        // queue another Claude control request behind connection warm-up.
        if current.is_some_and(|row| is_permission_option(provider, row) && row["value"] == value) {
            continue;
        }
        providers.chat_set_option(session_id, id, value)?;
    }
    if pending.as_array().is_some_and(|rows| !rows.is_empty()) {
        verify(db, providers, session_id, provider)?;
        if pending
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| row["id"] == RESET_OPTION)
        {
            let rows = db
                .chat_option_selections(session_id, provider)?
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| {
                    !is_permission_option(provider, row) && row["startupDependency"] != true
                })
                .cloned()
                .collect::<Vec<_>>();
            db.set_chat_option_selections(session_id, provider, &json!(rows))?;
        }
        remember(
            db,
            session_id,
            provider,
            &providers.chat_options(session_id)?,
        )?;
    }
    db.clear_pending_fork_options(session_id)
}

fn fallback_choices(provider: &str, id: &str) -> &'static [&'static str] {
    match (provider, id) {
        ("codex", "sandbox") => &["read-only", "workspace-write", "danger-full-access"],
        ("codex", "mode") => &["on-request", "never"],
        ("claude", "mode") => &["default", "acceptEdits", "plan", "dontAsk"],
        ("grok", "mode") => &[
            "default",
            "acceptEdits",
            "auto",
            "dontAsk",
            "bypassPermissions",
            "plan",
        ],
        // Kimi's and plugin catalogues are native-owned; only advertise modes
        // actually seen from that provider, rather than inventing valid values.
        _ => &[],
    }
}

pub(super) fn options(db: &Database, providers: &Providers, session_id: &str) -> Result<Value> {
    let state = providers.chat_options(session_id)?;
    if providers.chat_is_open(session_id) {
        return Ok(state);
    }
    let connection = providers.chat_connection(session_id);
    if connection.pointer("/error/code").and_then(Value::as_str)
        != Some("chat_permission_restore_failed")
    {
        return Ok(state);
    }
    let session = db
        .session_by_id(session_id)?
        .ok_or_else(|| anyhow::anyhow!("session_not_found"))?;
    let mut rows = state
        .get("options")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty())
        .cloned()
        .unwrap_or(
            db.latest_chat_options(session_id)?
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
    let saved = db.chat_option_selections(session_id, &session.provider)?;
    for option in saved.as_array().into_iter().flatten() {
        if !is_permission_option(&session.provider, option) {
            continue;
        }
        if rows.iter().any(|row| row["id"] == option["id"]) {
            continue;
        }
        let id = option["id"].as_str().unwrap_or_default();
        rows.push(json!({"id":id,"name":id,"category":"mode","value":option["value"],"choices":fallback_choices(&session.provider,id).iter().map(|value|json!({"value":value,"name":value})).collect::<Vec<_>>()}));
    }
    rows.push(json!({"id":RESET_OPTION,"name":"Saved permissions","category":"mode","value":"unavailable","choices":[{"value":"defaults","name":"Discard saved permissions and use provider defaults"}]}));
    let pending = db.pending_fork_options(session_id)?;
    for row in &mut rows {
        if !is_permission_option(&session.provider, row) && row["id"] != RESET_OPTION {
            continue;
        }
        if let Some(selection) = pending
            .as_array()
            .into_iter()
            .flatten()
            .find(|selection| selection["id"] == row["id"])
        {
            if row["choices"].as_array().is_some_and(|choices| {
                choices
                    .iter()
                    .any(|choice| choice["value"] == selection["value"])
            }) {
                row["value"] = selection["value"].clone();
            }
        }
    }
    Ok(
        json!({"options":rows,"commands":[],"loadState":"error","error":{"code":connection["error"]["code"],"message":connection["error"]["message"]}}),
    )
}

pub(super) fn stage_recovery(
    db: &Database,
    providers: &Providers,
    session_id: &str,
    provider: &str,
    id: &str,
    value: &str,
) -> Result<Value> {
    let state = options(db, providers, session_id)?;
    let row = state["options"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| row["id"] == id)
        .filter(|row| is_permission_option(provider, row) || id == RESET_OPTION);
    let valid = row.is_some_and(|row| {
        row["choices"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|choice| choice["value"] == value)
    });
    if !valid {
        return Err(ProviderError::new(
            "chat_option_invalid",
            "Select an available permission mode, then retry the connection",
        )
        .into());
    }
    let mut rows = db
        .pending_fork_options(session_id)?
        .as_array()
        .cloned()
        .unwrap_or_default();
    if id == RESET_OPTION {
        rows.retain(|row| !is_permission_option(provider, row));
    }
    merge(&mut rows, json!({"id":id,"value":value,"category":"mode"}));
    db.transaction(|tx| {
        tx.execute("INSERT INTO session_fork_options(session_id,data) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data", rusqlite::params![session_id, serde_json::to_string(&rows)?])?;
        Ok(())
    })?;
    let mut state = options(db, providers, session_id)?;
    state["error"] = json!({"code":"chat_permission_restore_failed","message":"Permission choice queued. Retry the connection to confirm it with the provider."});
    Ok(state)
}
