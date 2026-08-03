pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod gemini;
pub(crate) mod grok;
pub(crate) mod kimi;
mod metadata;
pub(crate) mod opencode;
mod preview;
pub(crate) mod process;
pub mod types;

use tauri::AppHandle;
use types::{
    normalize_page_limit, AgentSessionMetadataResult, AgentSessionPage, AgentSessionProvider,
    ListAgentSessionsRequest, ResolveAgentSessionMetadataRequest,
};

#[tauri::command]
pub async fn provider_resolve_agent_session_metadata(
    request: ResolveAgentSessionMetadataRequest,
) -> Result<Vec<AgentSessionMetadataResult>, String> {
    metadata::resolve_agent_session_metadata(request).await
}

#[tauri::command]
pub async fn provider_list_agent_sessions(
    app: AppHandle,
    request: ListAgentSessionsRequest,
) -> Result<AgentSessionPage, String> {
    let provider = AgentSessionProvider::parse(&request.provider)?;
    let limit = normalize_page_limit(request.limit);
    let cursor = request.cursor;
    let query = request.query;

    let page = match provider {
        AgentSessionProvider::Claude => {
            let cursor = cursor.clone();
            let query = query.clone();
            tokio::task::spawn_blocking(move || {
                claude::list_claude_session_page(cursor.as_deref(), limit, query.as_deref())
            })
            .await
            .map_err(|e| format!("Claude session catalog task failed: {e}"))?
        }
        AgentSessionProvider::Codex => {
            codex::list_codex_session_page(&app, cursor.as_deref(), limit, query.as_deref()).await
        }
        AgentSessionProvider::Opencode => {
            opencode::list_opencode_session_page(cursor.as_deref(), limit, query.as_deref()).await
        }
        AgentSessionProvider::Gemini => {
            gemini::list_gemini_session_page(cursor.as_deref(), limit, query.as_deref()).await
        }
        AgentSessionProvider::Kimi => {
            let cursor = cursor.clone();
            let query = query.clone();
            tokio::task::spawn_blocking(move || {
                kimi::list_kimi_session_page(cursor.as_deref(), limit, query.as_deref())
            })
            .await
            .map_err(|e| format!("Kimi session catalog task failed: {e}"))?
        }
        AgentSessionProvider::Grok => {
            let cursor = cursor.clone();
            let query = query.clone();
            tokio::task::spawn_blocking(move || {
                grok::list_grok_session_page(cursor.as_deref(), limit, query.as_deref())
            })
            .await
            .map_err(|e| format!("Grok session catalog task failed: {e}"))?
        }
    };

    Ok(page)
}
