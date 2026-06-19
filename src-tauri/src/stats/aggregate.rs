//! Aggregator: feed parsed sessions, get an `AgentStats` snapshot.
//!
//! Two correctness rules carried over from cc-sessions-viewer:
//!   1. Dedup Claude calls by `message.id` — fork / sub-agent jsonl copy the
//!      same assistant message, which would otherwise double-count.
//!   2. Per-call time-window filter — a session "touched today" (recent mtime)
//!      may contain weeks-old calls; filtering per call (not per session mtime)
//!      keeps "Today" totals honest.

use std::collections::{HashMap, HashSet};

use crate::stats::pricing;
use crate::stats::types::{AgentStats, CallRecord, StatBucket, UsageSummary};

#[derive(Default)]
struct Bucket {
    usage: UsageSummary,
    cost: f64,
    calls: u64,
}

impl Bucket {
    fn add(&mut self, usage: &UsageSummary, cost: f64) {
        self.usage.add(usage);
        self.cost += cost;
        self.calls += 1;
    }
}

pub struct Aggregator {
    lo_ms: Option<u64>,
    hi_ms: Option<u64>,
    seen_message_ids: HashSet<String>,
    total: Bucket,
    session_count: u64,
    by_model: HashMap<String, Bucket>,
    by_project: HashMap<String, Bucket>,
    by_session: HashMap<String, Bucket>,
}

impl Aggregator {
    pub fn new(lo_ms: Option<u64>, hi_ms: Option<u64>) -> Self {
        Self {
            lo_ms,
            hi_ms,
            seen_message_ids: HashSet::new(),
            total: Bucket::default(),
            session_count: 0,
            by_model: HashMap::new(),
            by_project: HashMap::new(),
            by_session: HashMap::new(),
        }
    }

    fn in_window(&self, ts: Option<u64>, fallback: Option<u64>) -> bool {
        match ts.or(fallback) {
            Some(t) => {
                if let Some(lo) = self.lo_ms {
                    if t < lo {
                        return false;
                    }
                }
                if let Some(hi) = self.hi_ms {
                    if t > hi {
                        return false;
                    }
                }
                true
            }
            // No timestamp at all: only count when there's no lower bound ("all").
            None => self.lo_ms.is_none(),
        }
    }

    pub fn feed_session(
        &mut self,
        session_id: &str,
        project_path: &str,
        session_mtime: Option<u64>,
        calls: &[CallRecord],
    ) {
        let mut had_call = false;
        for call in calls {
            if !self.in_window(call.timestamp_ms, session_mtime) {
                continue;
            }
            if let Some(id) = &call.message_id {
                if !self.seen_message_ids.insert(id.clone()) {
                    continue; // duplicate assistant message across files
                }
            }
            let cost = pricing::cost(&call.model, &call.usage);
            self.total.add(&call.usage, cost);
            let model_key = if call.model.is_empty() {
                "unknown".to_string()
            } else {
                call.model.clone()
            };
            self.by_model.entry(model_key).or_default().add(&call.usage, cost);
            self.by_project
                .entry(project_path.to_string())
                .or_default()
                .add(&call.usage, cost);
            self.by_session
                .entry(session_id.to_string())
                .or_default()
                .add(&call.usage, cost);
            had_call = true;
        }
        if had_call {
            self.session_count += 1;
        }
    }

    pub fn snapshot(&self) -> AgentStats {
        AgentStats {
            total_tokens: self.total.usage.total(),
            total_cost_usd: self.total.cost,
            total_calls: self.total.calls,
            session_count: self.session_count,
            usage: self.total.usage,
            by_model: to_buckets(&self.by_model),
            by_project: to_buckets(&self.by_project),
            by_session: to_buckets(&self.by_session),
        }
    }
}

fn to_buckets(map: &HashMap<String, Bucket>) -> Vec<StatBucket> {
    let mut v: Vec<StatBucket> = map
        .iter()
        .map(|(k, b)| StatBucket {
            key: k.clone(),
            label: k.clone(),
            usage: b.usage,
            total_tokens: b.usage.total(),
            cost_usd: b.cost,
            calls: b.calls,
        })
        .collect();
    v.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.total_tokens.cmp(&a.total_tokens))
    });
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(model: &str, id: Option<&str>, input: u64, output: u64, ts: Option<u64>) -> CallRecord {
        CallRecord {
            model: model.to_string(),
            message_id: id.map(str::to_string),
            usage: UsageSummary {
                input,
                output,
                cache_creation: 0,
                cache_read: 0,
            },
            timestamp_ms: ts,
        }
    }

    #[test]
    fn dedups_by_message_id() {
        let mut agg = Aggregator::new(None, None);
        let c = call("claude-opus-4-8", Some("msg_1"), 100, 50, Some(1000));
        agg.feed_session("s1", "/a", Some(1000), &[c.clone()]);
        agg.feed_session("s2", "/a", Some(1000), &[c]); // same id, another file
        assert_eq!(agg.snapshot().total_calls, 1);
    }

    #[test]
    fn per_turn_window_excludes_old_calls() {
        let mut agg = Aggregator::new(Some(5000), None);
        let old = call("claude-opus-4-8", Some("a"), 100, 0, Some(1000));
        let fresh = call("claude-opus-4-8", Some("b"), 200, 0, Some(9000));
        agg.feed_session("s1", "/a", Some(9999), &[old, fresh]);
        let snap = agg.snapshot();
        assert_eq!(snap.total_calls, 1);
        assert_eq!(snap.usage.input, 200);
    }

    #[test]
    fn aggregates_by_model_and_session() {
        let mut agg = Aggregator::new(None, None);
        agg.feed_session(
            "s1",
            "/proj",
            Some(1),
            &[
                call("claude-opus-4-8", Some("a"), 10, 5, Some(1)),
                call("gpt-5-codex", Some("b"), 20, 10, Some(1)),
            ],
        );
        let snap = agg.snapshot();
        assert_eq!(snap.by_model.len(), 2);
        assert_eq!(snap.by_session.len(), 1);
        assert_eq!(snap.total_tokens, 45);
    }
}
