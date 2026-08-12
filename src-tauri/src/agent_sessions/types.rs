use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_AGENT_SESSION_PAGE_LIMIT: usize = 40;
pub const MAX_AGENT_SESSION_PAGE_LIMIT: usize = 100;
pub const MAX_PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionProvider {
    Claude,
    Codex,
    Opencode,
    Gemini,
    Kimi,
    Grok,
}

impl AgentSessionProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Gemini => "gemini",
            Self::Kimi => "kimi",
            Self::Grok => "grok",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::Opencode),
            "gemini" => Ok(Self::Gemini),
            "kimi" => Ok(Self::Kimi),
            "grok" => Ok(Self::Grok),
            other => Err(format!("Unsupported agent session provider: {other}")),
        }
    }
}

pub const MAX_AGENT_SESSION_METADATA_KEYS: usize = 100;
pub const MAX_METADATA_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionMetadataState {
    Found,
    Missing,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionMetadataKey {
    pub provider: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionMetadataResult {
    pub key: AgentSessionMetadataKey,
    pub state: AgentSessionMetadataState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<AgentSessionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAgentSessionMetadataRequest {
    pub keys: Vec<AgentSessionMetadataKey>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentSessionMetadataLookup {
    pub(crate) session_id: String,
    pub(crate) project_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TitleKind {
    Explicit,
    Generated,
    Unknown,
    FirstPrompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionAvailability {
    Available,
    MissingCli,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub provider: AgentSessionProvider,
    pub id: String,
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_title: Option<String>,
    pub title_kind: TitleKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_user_message_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    pub resumable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionPage {
    pub provider: AgentSessionProvider,
    pub availability: AgentSessionAvailability,
    pub items: Vec<AgentSessionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub scanned_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentSessionsRequest {
    pub request_id: u64,
    pub provider: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionCatalogPhase {
    Discovering,
    Connecting,
    Listing,
    Scanning,
    Enriching,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionCatalogProgress {
    pub request_id: u64,
    pub provider: AgentSessionProvider,
    pub phase: AgentSessionCatalogPhase,
    pub completed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    pub elapsed_ms: u64,
}

pub fn normalize_page_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_AGENT_SESSION_PAGE_LIMIT)
        .clamp(1, MAX_AGENT_SESSION_PAGE_LIMIT)
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

pub(crate) fn read_timestamp_ms(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(raw) = value
        .as_u64()
        .or_else(|| value.as_str()?.parse::<u64>().ok())
    {
        return Some(if raw < 1_000_000_000_000 {
            raw.saturating_mul(1000)
        } else {
            raw
        });
    }
    crate::stats::parse::parse_iso8601_ms(value.as_str()?)
}

pub fn empty_page(
    provider: AgentSessionProvider,
    availability: AgentSessionAvailability,
    warning: Option<String>,
) -> AgentSessionPage {
    AgentSessionPage {
        provider,
        availability,
        items: Vec::new(),
        next_cursor: None,
        scanned_at: now_ms(),
        warning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_provider() {
        assert!(AgentSessionProvider::parse("other").is_err());
    }

    #[test]
    fn clamps_page_limit() {
        assert_eq!(normalize_page_limit(None), DEFAULT_AGENT_SESSION_PAGE_LIMIT);
        assert_eq!(normalize_page_limit(Some(0)), 1);
        assert_eq!(
            normalize_page_limit(Some(10_000)),
            MAX_AGENT_SESSION_PAGE_LIMIT
        );
    }

    #[test]
    fn serializes_camel_case_summary() {
        let summary = AgentSessionSummary {
            provider: AgentSessionProvider::Claude,
            id: "abc".into(),
            project_path: "/repo".into(),
            native_title: Some("Renamed".into()),
            title_kind: TitleKind::Explicit,
            first_user_message_preview: Some("hello".into()),
            created_at: Some(1),
            updated_at: Some(2),
            message_count: Some(3),
            git_branch: None,
            source_kind: None,
            parent_session_id: None,
            resumable: true,
        };
        let json = serde_json::to_value(&summary).expect("serialize");
        assert_eq!(json["provider"], "claude");
        assert_eq!(json["projectPath"], "/repo");
        assert_eq!(json["nativeTitle"], "Renamed");
        assert_eq!(json["titleKind"], "explicit");
        assert_eq!(json["firstUserMessagePreview"], "hello");
        assert_eq!(json["createdAt"], 1);
        assert_eq!(json["updatedAt"], 2);
        assert_eq!(json["messageCount"], 3);
        assert!(json.get("gitBranch").is_none());
    }

    #[test]
    fn serializes_privacy_safe_catalog_progress() {
        let progress = AgentSessionCatalogProgress {
            request_id: 42,
            provider: AgentSessionProvider::Opencode,
            phase: AgentSessionCatalogPhase::Enriching,
            completed: 2,
            total: Some(4),
            elapsed_ms: 1250,
        };
        let json = serde_json::to_value(progress).expect("serialize progress");
        assert_eq!(json["requestId"], 42);
        assert_eq!(json["provider"], "opencode");
        assert_eq!(json["phase"], "enriching");
        assert_eq!(json["completed"], 2);
        assert_eq!(json["total"], 4);
        assert_eq!(json["elapsedMs"], 1250);
        assert_eq!(json.as_object().map(serde_json::Map::len), Some(6));
    }

    #[test]
    fn reads_seconds_millis_and_iso8601_timestamps() {
        assert_eq!(
            read_timestamp_ms(Some(&serde_json::json!(1_700_000_000u64))),
            Some(1_700_000_000_000)
        );
        assert_eq!(
            read_timestamp_ms(Some(&serde_json::json!(1_700_000_000_123u64))),
            Some(1_700_000_000_123)
        );
        assert_eq!(
            read_timestamp_ms(Some(&serde_json::json!("2021-01-01T00:00:00.500Z"))),
            Some(1_609_459_200_500)
        );
    }
}
