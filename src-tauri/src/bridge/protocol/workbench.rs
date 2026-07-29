use serde::{Deserialize, Serialize};

use super::terminal::CardMeta;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRouting {
    pub origin: String,
    pub family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEntry {
    pub id: String,
    pub card_id: String,
    pub kind: String,
    pub message: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<NotificationRouting>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileAttentionCapability {
    pub open_request: bool,
    pub open_terminal: bool,
    pub open_notification: bool,
    pub open_evidence: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileAttentionItem {
    pub id: String,
    pub card_id: String,
    pub kind: String,
    pub severity: String,
    pub source_kind: String,
    pub source_id: String,
    pub occurred_at: u64,
    pub project_path: String,
    pub project_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_label: Option<String>,
    pub terminal_type: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub reason_code: String,
    pub capability: MobileAttentionCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileExecutionGroup {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub worktree_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_label: Option<String>,
    pub card_ids: Vec<String>,
    pub terminal_count: usize,
    pub terminal_types: Vec<String>,
    pub attention_count: usize,
    pub status: String,
    pub terminal_statuses: Vec<String>,
    pub last_activity: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileProjectWorkbenchOverview {
    pub project_path: String,
    pub project_name: String,
    pub followed_count: usize,
    pub running_count: usize,
    pub attention_count: usize,
    pub review_count: usize,
    pub failed_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchSummary {
    pub attention: usize,
    pub normal_running: usize,
    pub review: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchRules {
    pub include_waiting: bool,
    pub include_failed: bool,
    pub include_completed_review: bool,
    pub stalled_enabled: bool,
    pub stalled_threshold_minutes: u64,
    pub stalled_excluded_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchCapabilities {
    pub open_terminal: bool,
    pub respond_to_structured_request: bool,
    pub update_rules: bool,
    pub update_notification_read_state: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileWorkbenchProjection {
    pub generated_at: u64,
    pub summary: MobileWorkbenchSummary,
    pub attention_items: Vec<MobileAttentionItem>,
    pub execution_groups: Vec<MobileExecutionGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub followed_card_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_overviews: Vec<MobileProjectWorkbenchOverview>,
    pub rules: MobileWorkbenchRules,
    pub capabilities: MobileWorkbenchCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSnapshot {
    pub cards: Vec<CardMeta>,
    pub notifications: Vec<NotificationEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workbench: Option<MobileWorkbenchProjection>,
    #[serde(default)]
    pub warming_up: bool,
    pub server_id: String,
    pub runtime_id: String,
    pub stream_seq: u64,
}
