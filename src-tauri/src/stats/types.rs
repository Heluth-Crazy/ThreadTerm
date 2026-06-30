//! Shared data shapes for token statistics.
//!
//! `CallRecord` is the intermediate parsed form (one assistant API call);
//! `AgentStats` + `StatBucket` are the camelCase shapes serialized to the
//! frontend.

use serde::Serialize;

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
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_creation)
            .saturating_add(self.cache_read)
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
    pub cost_usd: f64,
    pub calls: u64,
}

/// Final aggregated stats payload emitted to the frontend.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStats {
    pub total_tokens: u64,
    pub total_cost_usd: f64,
    pub total_calls: u64,
    pub session_count: u64,
    pub usage: UsageSummary,
    pub by_model: Vec<StatBucket>,
    pub by_project: Vec<StatBucket>,
    pub by_session: Vec<StatBucket>,
}
