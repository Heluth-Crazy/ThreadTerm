use super::types::{
    AgentSessionMetadataKey, AgentSessionMetadataLookup, AgentSessionMetadataResult,
    AgentSessionMetadataState, AgentSessionProvider, AgentSessionSummary,
    ResolveAgentSessionMetadataRequest, MAX_AGENT_SESSION_METADATA_KEYS,
};
use super::{claude, codex, gemini, grok, kimi, opencode};
use std::collections::HashSet;

#[derive(Debug, Clone)]
struct PreparedMetadataKey {
    input_index: usize,
    key: AgentSessionMetadataKey,
    lookup: AgentSessionMetadataLookup,
    provider: AgentSessionProvider,
}

#[derive(Debug)]
enum ProviderResolveFailure {
    Unavailable(String),
    Error(String),
}

pub async fn resolve_agent_session_metadata(
    request: ResolveAgentSessionMetadataRequest,
) -> Result<Vec<AgentSessionMetadataResult>, String> {
    if request.keys.len() > MAX_AGENT_SESSION_METADATA_KEYS {
        return Err(format!(
            "Too many metadata keys (max {MAX_AGENT_SESSION_METADATA_KEYS})"
        ));
    }

    let (prepared, mut indexed_results) = prepare_metadata_keys(request.keys);
    for provider in [
        AgentSessionProvider::Claude,
        AgentSessionProvider::Codex,
        AgentSessionProvider::Opencode,
        AgentSessionProvider::Gemini,
        AgentSessionProvider::Kimi,
        AgentSessionProvider::Grok,
    ] {
        let group = prepared
            .iter()
            .filter(|item| item.provider == provider)
            .cloned()
            .collect::<Vec<_>>();
        if group.is_empty() {
            continue;
        }

        let lookups = group
            .iter()
            .map(|item| item.lookup.clone())
            .collect::<Vec<_>>();
        let resolved = resolve_provider_group(provider, lookups).await;
        indexed_results.extend(results_for_group(group, resolved));
    }

    indexed_results.sort_by_key(|(index, _)| *index);
    Ok(indexed_results
        .into_iter()
        .map(|(_, result)| result)
        .collect())
}

fn prepare_metadata_keys(
    keys: Vec<AgentSessionMetadataKey>,
) -> (
    Vec<PreparedMetadataKey>,
    Vec<(usize, AgentSessionMetadataResult)>,
) {
    let mut seen = HashSet::new();
    let mut prepared = Vec::with_capacity(keys.len());
    let mut errors = Vec::new();

    for (input_index, key) in keys.into_iter().enumerate() {
        let provider_raw = key.provider.trim().to_ascii_lowercase();
        let session_id = key.session_id.trim().to_string();
        let project_path = key
            .project_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let normalized_project_path = project_path
            .as_deref()
            .and_then(crate::workspace::normalize_project_identity_path)
            .unwrap_or_default();
        let identity = format!("{provider_raw}\0{session_id}\0{normalized_project_path}");
        if !seen.insert(identity) {
            continue;
        }

        let result_key = AgentSessionMetadataKey {
            provider: provider_raw.clone(),
            session_id: session_id.clone(),
            project_path: project_path.clone(),
        };
        if session_id.is_empty() || !super::process::is_safe_session_id(&session_id) {
            errors.push((
                input_index,
                error_result(result_key, "Invalid session id".into()),
            ));
            continue;
        }
        let provider = match AgentSessionProvider::parse(&provider_raw) {
            Ok(provider) => provider,
            Err(message) => {
                errors.push((input_index, error_result(result_key, message)));
                continue;
            }
        };
        prepared.push(PreparedMetadataKey {
            input_index,
            key: result_key,
            lookup: AgentSessionMetadataLookup {
                session_id,
                project_path,
            },
            provider,
        });
    }

    (prepared, errors)
}

async fn resolve_provider_group(
    provider: AgentSessionProvider,
    lookups: Vec<AgentSessionMetadataLookup>,
) -> Result<Vec<Option<AgentSessionSummary>>, ProviderResolveFailure> {
    match provider {
        AgentSessionProvider::Opencode => opencode::resolve_opencode_sessions(&lookups)
            .await
            .map_err(|error| match error {
                opencode::OpenCodeListError::MissingCli => ProviderResolveFailure::Unavailable(
                    "missingCli: OpenCode CLI was not found".into(),
                ),
                opencode::OpenCodeListError::TimedOut => {
                    ProviderResolveFailure::Error("OpenCode session list timed out".into())
                }
                opencode::OpenCodeListError::OutputTooLarge => ProviderResolveFailure::Error(
                    "OpenCode session list exceeded its output limit".into(),
                ),
                opencode::OpenCodeListError::MalformedJson => ProviderResolveFailure::Error(
                    "OpenCode returned malformed session list JSON".into(),
                ),
                opencode::OpenCodeListError::CommandFailed(message) => {
                    ProviderResolveFailure::Error(message)
                }
                opencode::OpenCodeListError::Cancelled => {
                    ProviderResolveFailure::Error("OpenCode session scan was cancelled".into())
                }
            }),
        AgentSessionProvider::Claude => {
            spawn_blocking_provider("Claude", move || {
                Ok(claude::resolve_claude_sessions(&lookups))
            })
            .await
        }
        AgentSessionProvider::Codex => {
            spawn_blocking_provider("Codex", move || codex::resolve_codex_sessions(&lookups)).await
        }
        AgentSessionProvider::Gemini => {
            spawn_blocking_provider("Gemini", move || {
                Ok(gemini::resolve_gemini_sessions(&lookups))
            })
            .await
        }
        AgentSessionProvider::Kimi => {
            spawn_blocking_provider("Kimi", move || Ok(kimi::resolve_kimi_sessions(&lookups))).await
        }
        AgentSessionProvider::Grok => {
            spawn_blocking_provider("Grok", move || Ok(grok::resolve_grok_sessions(&lookups))).await
        }
    }
}

async fn spawn_blocking_provider<F>(
    provider_name: &'static str,
    resolver: F,
) -> Result<Vec<Option<AgentSessionSummary>>, ProviderResolveFailure>
where
    F: FnOnce() -> Result<Vec<Option<AgentSessionSummary>>, String> + Send + 'static,
{
    tokio::task::spawn_blocking(resolver)
        .await
        .map_err(|error| {
            ProviderResolveFailure::Error(format!("{provider_name} metadata task failed: {error}"))
        })?
        .map_err(ProviderResolveFailure::Error)
}

fn results_for_group(
    group: Vec<PreparedMetadataKey>,
    resolved: Result<Vec<Option<AgentSessionSummary>>, ProviderResolveFailure>,
) -> Vec<(usize, AgentSessionMetadataResult)> {
    match resolved {
        Ok(summaries) => group
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                let summary = summaries.get(index).cloned().flatten();
                let state = if summary.is_some() {
                    AgentSessionMetadataState::Found
                } else {
                    AgentSessionMetadataState::Missing
                };
                (
                    item.input_index,
                    AgentSessionMetadataResult {
                        key: item.key,
                        state,
                        summary,
                        warning: None,
                    },
                )
            })
            .collect(),
        Err(failure) => {
            let (state, warning) = match failure {
                ProviderResolveFailure::Unavailable(message) => {
                    (AgentSessionMetadataState::Unavailable, message)
                }
                ProviderResolveFailure::Error(message) => {
                    (AgentSessionMetadataState::Error, message)
                }
            };
            group
                .into_iter()
                .map(|item| {
                    (
                        item.input_index,
                        AgentSessionMetadataResult {
                            key: item.key,
                            state,
                            summary: None,
                            warning: Some(warning.clone()),
                        },
                    )
                })
                .collect()
        }
    }
}

fn error_result(key: AgentSessionMetadataKey, warning: String) -> AgentSessionMetadataResult {
    AgentSessionMetadataResult {
        key,
        state: AgentSessionMetadataState::Error,
        summary: None,
        warning: Some(warning),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(
        provider: &str,
        session_id: &str,
        project_path: Option<&str>,
    ) -> AgentSessionMetadataKey {
        AgentSessionMetadataKey {
            provider: provider.into(),
            session_id: session_id.into(),
            project_path: project_path.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn rejects_oversized_batch() {
        let keys = (0..MAX_AGENT_SESSION_METADATA_KEYS + 1)
            .map(|index| key("kimi", &format!("s{index}"), None))
            .collect();
        let error = tauri::async_runtime::block_on(resolve_agent_session_metadata(
            ResolveAgentSessionMetadataRequest { keys },
        ))
        .expect_err("too many");
        assert!(error.contains("Too many"));
    }

    #[test]
    fn invalid_session_ids_are_per_key_errors() {
        let (_, errors) = prepare_metadata_keys(vec![key("kimi", "bad id & whoami", None)]);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].1.state, AgentSessionMetadataState::Error);
    }

    #[test]
    fn dedupe_identity_includes_normalized_project_path() {
        let (prepared, _) = prepare_metadata_keys(vec![
            key("kimi", "abc", Some("C:\\Repo\\App")),
            key("kimi", "abc", Some("c:/repo/app")),
            key("kimi", "abc", Some("D:/repo/app")),
        ]);
        assert_eq!(prepared.len(), 2);
    }

    #[test]
    fn groups_all_provider_rows_into_one_batch() {
        let (prepared, _) = prepare_metadata_keys(vec![
            key("kimi", "one", Some("/repo")),
            key("kimi", "two", Some("/repo")),
            key("grok", "three", Some("/repo")),
        ]);
        assert_eq!(
            prepared
                .iter()
                .filter(|item| item.provider == AgentSessionProvider::Kimi)
                .count(),
            2
        );
        assert_eq!(
            prepared
                .iter()
                .filter(|item| item.provider == AgentSessionProvider::Grok)
                .count(),
            1
        );
    }

    #[test]
    fn provider_failure_is_scoped_to_its_group() {
        let (prepared, _) = prepare_metadata_keys(vec![
            key("opencode", "one", Some("/repo")),
            key("kimi", "two", Some("/repo")),
        ]);
        let opencode_group = prepared
            .iter()
            .filter(|item| item.provider == AgentSessionProvider::Opencode)
            .cloned()
            .collect();
        let kimi_group = prepared
            .iter()
            .filter(|item| item.provider == AgentSessionProvider::Kimi)
            .cloned()
            .collect();
        let unavailable = results_for_group(
            opencode_group,
            Err(ProviderResolveFailure::Unavailable("missingCli".into())),
        );
        let missing = results_for_group(kimi_group, Ok(vec![None]));
        assert_eq!(
            unavailable[0].1.state,
            AgentSessionMetadataState::Unavailable
        );
        assert_eq!(missing[0].1.state, AgentSessionMetadataState::Missing);
    }
}
