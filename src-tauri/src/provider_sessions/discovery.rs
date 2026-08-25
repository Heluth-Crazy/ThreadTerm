use super::ProviderSessionInfo;

/// Reusable recent-session discovery seam for process-scoped startup effects.
///
/// Keep the provider-specific implementations in the parent module so this
/// seam cannot drift from the existing command's matching and path rules.
pub(crate) async fn find_recent_session(
    provider: &str,
    project_path: &str,
    since_ms: Option<u64>,
    excluded_session_ids: &[String],
) -> Result<Option<ProviderSessionInfo>, String> {
    if provider == "opencode" {
        let summaries =
            crate::agent_sessions::opencode::list_opencode_sessions_for_discovery().await;
        return Ok(super::find_unique_recent_from_summaries(
            summaries,
            "opencode",
            project_path,
            since_ms,
            excluded_session_ids,
        ));
    }

    let provider = provider.to_owned();
    let project_path = project_path.to_owned();
    let excluded_session_ids = excluded_session_ids.to_owned();
    tokio::task::spawn_blocking(move || {
        super::find_recent_provider_session(
            &provider,
            &project_path,
            since_ms,
            &excluded_session_ids,
        )
    })
    .await
    .map_err(|e| format!("Provider session discovery task failed: {e}"))?
}
