use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::manager::CLAUDE_CHAT_MANAGER;
use super::owner::{self, SessionOwner};
use super::probe;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeChatStartResult {
    /// Pre-resume id (or null for a fresh session). The bound — possibly
    /// rotated — id arrives via the `session.status ready` event after the
    /// first message (streaming-input init semantics).
    session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeChatImage {
    media_type: String,
    base64: String,
}

#[tauri::command]
pub async fn claude_chat_probe(force: Option<bool>) -> probe::ProbeResult {
    probe::probe(force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn claude_chat_start(
    app: AppHandle,
    card_id: String,
    cwd: String,
    session_id: Option<String>,
    fork_session: Option<bool>,
    model: Option<String>,
    permission_mode: Option<String>,
) -> Result<ClaudeChatStartResult, String> {
    let environment = probe::probe(false).await;
    if !environment.ok {
        return Err(environment
            .detail
            .unwrap_or_else(|| "Claude chat environment is unavailable".to_string()));
    }

    // Session ids reach the sidecar as SDK arguments; enforce the same
    // untrusted-id whitelist the other provider subprocess paths use.
    if let Some(resume_id) = session_id.as_deref() {
        if !crate::agent_sessions::process::is_safe_session_id(resume_id) {
            return Err("Invalid Claude session id".to_string());
        }
    }

    let chat_owner = SessionOwner::Chat {
        card_id: card_id.clone(),
    };
    // Resuming an existing session: claim it before the sidecar touches it so
    // a session opened in a terminal can never be double-attached.
    if let Some(resume_id) = session_id.as_deref() {
        owner::acquire(resume_id, chat_owner.clone()).map_err(owner_conflict_message)?;
    }

    let mut params = Map::new();
    params.insert("cardId".into(), json!(card_id));
    params.insert("cwd".into(), json!(cwd));
    if let Some(resume_id) = session_id.as_deref() {
        params.insert("sessionId".into(), json!(resume_id));
    }
    if fork_session.unwrap_or(false) {
        params.insert("forkSession".into(), json!(true));
    }
    if let Some(model) = model.as_deref() {
        params.insert("model".into(), json!(model));
    }
    if let Some(mode) = permission_mode.as_deref() {
        params.insert("permissionMode".into(), json!(mode));
    }

    let response = CLAUDE_CHAT_MANAGER
        .send_request(&app, "session.start", Value::Object(params), true)
        .await;
    let response = match response {
        Ok(response) => response,
        Err(err) => {
            if let Some(resume_id) = session_id.as_deref() {
                owner::release(resume_id, &chat_owner);
            }
            return Err(err);
        }
    };

    let bound_session_id = response
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    if let Some(bound) = bound_session_id.clone() {
        CLAUDE_CHAT_MANAGER
            .register_card_session(card_id, bound)
            .await;
    }
    // A fresh session has no id yet; the reader claims it (and handles the
    // resume rotation, design P0-2) when `session.status ready` arrives.
    Ok(ClaudeChatStartResult {
        session_id: bound_session_id,
    })
}

#[tauri::command]
pub async fn claude_chat_send(
    app: AppHandle,
    card_id: String,
    text: String,
    images: Option<Vec<ClaudeChatImage>>,
) -> Result<(), String> {
    let images: Vec<Value> = images
        .unwrap_or_default()
        .into_iter()
        .map(|image| json!({ "mediaType": image.media_type, "base64": image.base64 }))
        .collect();
    CLAUDE_CHAT_MANAGER
        .send_request(
            &app,
            "session.send",
            json!({ "cardId": card_id, "text": text, "images": images }),
            false,
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn claude_chat_interrupt(app: AppHandle, card_id: String) -> Result<(), String> {
    CLAUDE_CHAT_MANAGER
        .send_request(
            &app,
            "session.interrupt",
            json!({ "cardId": card_id }),
            false,
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn claude_chat_set_model(
    app: AppHandle,
    card_id: String,
    model: Option<String>,
) -> Result<(), String> {
    CLAUDE_CHAT_MANAGER
        .send_request(
            &app,
            "session.set_model",
            json!({ "cardId": card_id, "model": model }),
            false,
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn claude_chat_set_permission_mode(
    app: AppHandle,
    card_id: String,
    mode: String,
) -> Result<(), String> {
    CLAUDE_CHAT_MANAGER
        .send_request(
            &app,
            "session.set_permission_mode",
            json!({ "cardId": card_id, "mode": mode }),
            false,
        )
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn claude_chat_decision(
    app: AppHandle,
    card_id: String,
    request_id: String,
    behavior: String,
    updated_input: Option<Value>,
    updated_permissions: Option<Value>,
    message: Option<String>,
) -> Result<(), String> {
    if behavior != "allow" && behavior != "deny" {
        return Err(format!("invalid decision behavior: {behavior}"));
    }
    let mut params = Map::new();
    params.insert("cardId".into(), json!(card_id));
    params.insert("requestId".into(), json!(request_id));
    params.insert("behavior".into(), json!(behavior));
    if let Some(updated_input) = updated_input {
        params.insert("updatedInput".into(), updated_input);
    }
    if let Some(updated_permissions) = updated_permissions {
        params.insert("updatedPermissions".into(), updated_permissions);
    }
    if let Some(message) = message {
        params.insert("message".into(), json!(message));
    }
    CLAUDE_CHAT_MANAGER
        .send_request(&app, "session.decision", Value::Object(params), false)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn claude_chat_stop(app: AppHandle, card_id: String) -> Result<(), String> {
    // Stop is idempotent teardown: whether the sidecar is dead or the session
    // is already gone, local cleanup below is the part that must happen.
    if let Err(err) = CLAUDE_CHAT_MANAGER
        .send_request(&app, "session.stop", json!({ "cardId": card_id }), false)
        .await
    {
        tracing::debug!(target: "claude_chat", card_id, error = %err, "session.stop skipped");
    }
    CLAUDE_CHAT_MANAGER.unregister_card_session(&card_id).await;
    Ok(())
}

#[tauri::command]
pub async fn claude_chat_history(
    app: AppHandle,
    session_id: String,
    dir: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    if !crate::agent_sessions::process::is_safe_session_id(&session_id) {
        return Err("Invalid Claude session id".to_string());
    }
    let mut params = Map::new();
    params.insert("sessionId".into(), json!(session_id));
    if let Some(dir) = dir {
        params.insert("dir".into(), json!(dir));
    }
    if let Some(limit) = limit {
        params.insert("limit".into(), json!(limit));
    }
    CLAUDE_CHAT_MANAGER
        .send_request(&app, "session.history", Value::Object(params), true)
        .await
}

fn owner_conflict_message(existing: SessionOwner) -> String {
    format!(
        "SESSION_OWNED_BY:{}",
        serde_json::to_string(&existing).unwrap_or_else(|_| owner::describe(&existing))
    )
}
