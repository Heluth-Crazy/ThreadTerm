mod claude;
mod codex;
mod gemini;
mod opencode;
mod preview;
mod process;
pub mod types;

use tauri::AppHandle;
use types::{
    normalize_page_limit, AgentSessionPage, AgentSessionProvider, ListAgentSessionsRequest,
};

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
    };

    Ok(page)
}
