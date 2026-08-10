//! Shared data shapes for token statistics.
//!
//! `CallRecord` is the intermediate parsed form (one assistant API call);
//! `AgentStats` + `StatBucket` are the camelCase shapes serialized to the
//! frontend.

use serde::{Deserialize, Serialize};

/// Token usage broken down by category. Additive across calls.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub input: u64,
    pub output: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
}

impl UsageSummary {
    pub fn add(&mut self, other: &UsageSummary) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_creation = self.cache_creation.saturating_add(other.cache_creation);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
    }

    pub fn total(&self) -> u64 {
        self.input_output_tokens()
            .saturating_add(self.cache_tokens())
    }

    pub fn input_output_tokens(&self) -> u64 {
        self.input.saturating_add(self.output)
    }

    pub fn cache_tokens(&self) -> u64 {
        self.cache_creation.saturating_add(self.cache_read)
    }

    /// True when every category is zero — such rows carry no billable signal
    /// and only inflate `calls` counts, so parsers/inserters skip them.
    pub fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_creation == 0 && self.cache_read == 0
    }
}

/// One assistant API call parsed from a session jsonl line.
#[derive(Clone, Debug)]
pub struct CallRecord {
    pub model: String,
    /// Dedup key — Claude `message.id`. `None` = not deduplicated (Codex uses
    /// `session_id:event_index` composite keys instead).
    pub message_id: Option<String>,
    pub usage: UsageSummary,
    /// Per-call timestamp (epoch ms, UTC). `None` when the line had no parseable timestamp.
    pub timestamp_ms: Option<u64>,
    /// Claude `stop_reason` (e.g. `end_turn`). Used to pick the final stream
    /// chunk over the `message_start` snapshot when deduping by `message_id`.
    /// `None` for Codex (no equivalent field).
    #[allow(dead_code)]
    pub stop_reason: Option<String>,
    /// Session id parsed from the jsonl (Codex `session_meta.id`, Claude
    /// `sessionId` or file stem). Used to group calls into per-session buckets.
    pub session_id: Option<String>,
}

/// One aggregation bucket (a model / project / session row) for the frontend.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatBucket {
    pub key: String,
    pub label: String,
    pub usage: UsageSummary,
    pub total_tokens: u64,
    pub input_output_tokens: u64,
    pub cache_tokens: u64,
    pub cost_usd: f64,
    pub calls: u64,
}

/// Final aggregated stats payload emitted to the frontend.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStats {
    pub total_tokens: u64,
    pub input_output_tokens: u64,
    pub cache_tokens: u64,
    pub total_cost_usd: f64,
    pub total_calls: u64,
    pub session_count: u64,
    pub usage: UsageSummary,
    pub by_model: Vec<StatBucket>,
    pub by_project: Vec<StatBucket>,
    pub by_session: Vec<StatBucket>,
}

/// Source-aware summary used by the cc-switch-compatible dashboard.  The
/// legacy `AgentStats` payload above intentionally remains unchanged because
/// card badges and older mobile clients depend on its exact shape.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsOverview {
    pub request_count: u64,
    pub success_count: u64,
    pub failure_count: u64,
    pub total_tokens: u64,
    pub real_total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_hit_rate: f64,
    pub success_rate: f64,
    pub total_cost_usd: f64,
    pub unpriced_request_count: u64,
    pub session_count: u64,
    pub proxy_request_count: u64,
    pub session_log_request_count: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsTrendPoint {
    pub period_start: i64,
    pub request_count: u64,
    pub success_count: u64,
    pub total_tokens: u64,
    pub real_total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBreakdown {
    pub key: String,
    pub label: String,
    pub provider: String,
    pub usage: UsageSummary,
    pub total_tokens: u64,
    pub real_total_tokens: u64,
    pub cost_usd: f64,
    pub calls: u64,
    pub success_calls: u64,
    pub failure_calls: u64,
    pub unpriced_calls: u64,
    pub cache_hit_rate: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRequestLog {
    pub request_id: String,
    pub provider: String,
    pub app_type: String,
    pub model: String,
    pub request_model: String,
    pub pricing_model: String,
    pub usage: UsageSummary,
    pub total_tokens: u64,
    pub real_total_tokens: u64,
    pub cost_usd: f64,
    pub pricing_status: String,
    pub status_code: Option<i64>,
    pub success: bool,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
    pub first_token_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub streaming: bool,
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub data_source: String,
    pub created_at: i64,
}

/// Optional dashboard filters. The legacy `stats_compute` contract remains
/// provider/range-only; these filters apply to the source-aware dashboard
/// after provider aliases and token semantics have been normalized.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDashboardFilters {
    pub app_type: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
    pub source: Option<String>,
    /// Exact project/worktree directory from the left-side project selector.
    /// Empty or `all` means no project restriction; `__unassigned__` selects
    /// historical rows that do not carry a project path.
    pub project_path: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDashboard {
    pub overview: StatsOverview,
    pub trends: Vec<StatsTrendPoint>,
    pub by_provider: Vec<StatsBreakdown>,
    pub by_model: Vec<StatsBreakdown>,
    pub request_logs: Vec<StatsRequestLog>,
    pub next_cursor: Option<String>,
    pub pricing_version: String,
}
