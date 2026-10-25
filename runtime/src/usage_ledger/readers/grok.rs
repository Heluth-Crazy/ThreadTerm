use crate::usage_ledger::facts::{number, text, timestamp, Buckets, Fact, Parsed, ReaderState};
use serde_json::Value;

fn counters(usage: &Value) -> Buckets {
    let cached = number(usage, &["cachedReadTokens", "cached_read_tokens"]);
    let inclusive_input = number(usage, &["inputTokens", "input_tokens"]);
    Buckets {
        // Grok cache reads are a subset of the provider's inclusive input.
        // Without the cache field, an uncached-input value would be guessed.
        input: inclusive_input
            .zip(cached)
            .map(|(n, cached)| n.saturating_sub(cached)),
        cache_read: cached,
        cache_write5m: None,
        cache_write1h: None,
        cache_write_unknown: number(usage, &["cacheCreationTokens", "cache_creation_tokens"]),
        output: number(usage, &["outputTokens", "output_tokens"]),
        reasoning: number(usage, &["reasoningTokens", "reasoning_tokens"]),
        ..Default::default()
    }
}

fn timestamp_millis(value: &Value) -> Option<i64> {
    let value = value.as_i64()?;
    if value.abs() < 100_000_000_000 {
        value.checked_mul(1000)
    } else {
        Some(value)
    }
}

/// Parses durable Grok Build turn-completed updates. Each prompt carries its
/// own reported turn totals; repeated snapshots share a stable fact key and
/// are merged by the ledger's max-merge rule.
pub fn parse(value: &Value, offset: u64, file_id: &str, state: &mut ReaderState) -> Parsed {
    let mut parsed = Parsed::default();
    let params = value.get("params").unwrap_or(value);
    let update = params.get("update").unwrap_or(params);
    if text(update, &["sessionUpdate", "session_update"]) != Some("turn_completed") {
        return parsed;
    }
    if let Some(problem) = state
        .data
        .get("sourceMetadataProblem")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        if state.data["sourceMetadataProblemReported"].as_bool() != Some(true) {
            parsed.problems.push(problem);
        }
        state.data["sourceMetadataProblemReported"] = Value::Bool(true);
        return parsed;
    }
    let Some(prompt) = text(update, &["prompt_id", "promptId"]) else {
        parsed
            .problems
            .push("grok turn_completed has no prompt_id".into());
        return parsed;
    };
    let Some(usage) = update.get("usage") else {
        parsed
            .problems
            .push("grok turn_completed has no usage".into());
        return parsed;
    };
    let Some(occurred_at) = value.get("timestamp").and_then(timestamp) else {
        parsed
            .problems
            .push("grok turn_completed has no usable timestamp".into());
        return parsed;
    };
    let session = text(params, &["sessionId", "session_id"])
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| state.session_id.clone());
    if session.is_empty() {
        parsed
            .problems
            .push("grok turn_completed has no session id".into());
        return parsed;
    }
    let now = counters(usage);
    if number(usage, &["inputTokens", "input_tokens"]).is_some()
        && number(usage, &["cachedReadTokens", "cached_read_tokens"]).is_none()
    {
        parsed
            .problems
            .push("grok inclusive input has no cache-read breakdown".into());
    }
    let cost_ticks = number(usage, &["costUsdTicks", "cost_usd_ticks"]);
    // A fork archive can contain the parent's pre-fork prompt records under
    // the child source. Those records are not child usage; later child turns
    // retain their full per-prompt totals.
    let before_child_creation = state.parent_session_id.is_some()
        && state
            .data
            .get("grokForkCreatedAt")
            .and_then(Value::as_i64)
            .zip(value.get("timestamp").and_then(timestamp_millis))
            .is_some_and(|(created, event)| event < created);
    if before_child_creation {
        parsed.covered_sessions.push(session.clone());
        return parsed;
    }
    emit_fact(
        &mut parsed,
        update,
        state,
        file_id,
        offset,
        &session,
        prompt,
        &occurred_at,
        now,
        cost_ticks,
    )
}

#[allow(clippy::too_many_arguments)]
fn emit_fact(
    parsed: &mut Parsed,
    update: &Value,
    state: &ReaderState,
    file_id: &str,
    offset: u64,
    session: &str,
    prompt: &str,
    occurred_at: &str,
    buckets: Buckets,
    cost_ticks: Option<i64>,
) -> Parsed {
    if buckets.total() == 0
        && [
            buckets.input,
            buckets.cache_read,
            buckets.cache_write5m,
            buckets.cache_write_unknown,
            buckets.output,
        ]
        .iter()
        .all(Option::is_none)
    {
        return std::mem::take(parsed);
    }
    let key = format!("{session}:{prompt}");
    let mut fact = Fact::new("grok", session, &key, occurred_at);
    fact.buckets = buckets;
    fact.quality = "derived".into();
    fact.model = text(update, &["model", "modelId", "model_id"])
        .map(str::to_owned)
        .or_else(|| {
            if state.data["modelFromSummary"].as_bool() == Some(true) {
                None
            } else {
                state.model.clone()
            }
        });
    if fact.model.is_none() {
        parsed
            .problems
            .push("model_not_reported_per_request".into());
    }
    fact.parent_native_session_id = state.parent_session_id.clone();
    fact.subagent = fact.parent_native_session_id.is_some();
    fact.cwd = state.cwd.clone();
    fact.source = format!("native:{file_id}@{offset}");
    fact.reported_cost = cost_ticks.map(|ticks| ticks as f64 / 10_000_000_000.0);
    parsed.covered_sessions.push(session.to_owned());
    parsed.facts.push(fact);
    std::mem::take(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completed_turns_keep_reported_buckets_and_reasoning_stays_in_output() {
        let mut state = ReaderState::default();
        let first = parse(
            &json!({"timestamp":1,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p1","usage":{"inputTokens":100,"cachedReadTokens":90,"outputTokens":5,"reasoningTokens":3,"costUsdTicks":10}}}}),
            0,
            "updates",
            &mut state,
        );
        let second = parse(
            &json!({"timestamp":2,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p2","usage":{"inputTokens":140,"cachedReadTokens":120,"outputTokens":9,"reasoningTokens":4}}}}),
            1,
            "updates",
            &mut state,
        );
        assert_eq!(first.facts[0].buckets.input, Some(10));
        assert_eq!(second.facts[0].buckets.input, Some(20));
        assert_eq!(second.facts[0].buckets.output, Some(9));
        assert_eq!(second.facts[0].buckets.reasoning, Some(4));
    }

    #[test]
    fn repeated_prompt_snapshots_replace_with_the_full_prompt_delta() {
        let mut state = ReaderState::default();
        let first = parse(
            &json!({"timestamp":1,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":100,"cachedReadTokens":0,"outputTokens":10}}}}),
            0,
            "updates",
            &mut state,
        );
        let revised = parse(
            &json!({"timestamp":2,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":120,"cachedReadTokens":0,"outputTokens":12}}}}),
            1,
            "updates",
            &mut state,
        );
        assert_eq!(first.facts[0].key, revised.facts[0].key);
        assert_eq!(revised.facts[0].buckets.input, Some(120));
        assert_eq!(revised.facts[0].buckets.output, Some(12));
    }

    #[test]
    fn distinct_completed_prompts_keep_their_full_reported_usage_and_cost() {
        let mut state = ReaderState::default();
        let first = parse(
            &json!({"timestamp":1,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p1","usage":{"inputTokens":100,"cachedReadTokens":80,"outputTokens":10,"costUsdTicks":100}}}}),
            0,
            "updates",
            &mut state,
        );
        let second = parse(
            &json!({"timestamp":2,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p2","usage":{"inputTokens":150,"cachedReadTokens":100,"outputTokens":20,"costUsdTicks":150}}}}),
            1,
            "updates",
            &mut state,
        );
        assert_eq!(first.facts[0].buckets.input, Some(20));
        assert_eq!(second.facts[0].buckets.input, Some(50));
        assert_eq!(second.facts[0].buckets.output, Some(20));
        assert_eq!(second.facts[0].reported_cost, Some(0.000000015));
    }

    #[test]
    fn lower_repeated_prompt_snapshot_keeps_the_same_request_coordinate() {
        let mut state = ReaderState::default();
        let first = parse(
            &json!({"timestamp":1,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":100,"cachedReadTokens":0,"outputTokens":10}}}}),
            0,
            "updates",
            &mut state,
        );
        let revised = parse(
            &json!({"timestamp":2,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":5,"cachedReadTokens":0,"outputTokens":1}}}}),
            1,
            "updates",
            &mut state,
        );
        assert_eq!(first.facts[0].key, revised.facts[0].key);
    }

    #[test]
    fn first_completed_child_prompt_is_counted_as_its_own_turn() {
        let mut state = ReaderState {
            session_id: "child".into(),
            parent_session_id: Some("parent".into()),
            ..Default::default()
        };
        let parsed = parse(
            &json!({"timestamp":1,"params":{"sessionId":"child","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":100,"cachedReadTokens":80,"outputTokens":10,"costUsdTicks":100}}}}),
            0,
            "updates",
            &mut state,
        );
        assert_eq!(parsed.facts.len(), 1);
        assert_eq!(parsed.facts[0].native_session_id, "child");
        assert_eq!(parsed.facts[0].parent_native_session_id.as_deref(), Some("parent"));
        assert_eq!(parsed.facts[0].buckets.input, Some(20));
        assert_eq!(parsed.facts[0].buckets.output, Some(10));
        assert_eq!(parsed.facts[0].reported_cost, Some(0.00000001));
    }

    #[test]
    fn child_fork_prefix_before_creation_is_excluded_but_new_turn_counts() {
        let mut state = ReaderState {
            session_id: "child".into(),
            parent_session_id: Some("parent".into()),
            data: json!({"grokForkCreatedAt": 2_000}),
            ..Default::default()
        };
        let copied_prefix = parse(
            &json!({"timestamp":1,"params":{"sessionId":"child","update":{"sessionUpdate":"turn_completed","prompt_id":"parent-prompt","usage":{"inputTokens":100,"cachedReadTokens":80,"outputTokens":10}}}}),
            0,
            "updates",
            &mut state,
        );
        let child_turn = parse(
            &json!({"timestamp":3,"params":{"sessionId":"child","update":{"sessionUpdate":"turn_completed","prompt_id":"child-prompt","usage":{"inputTokens":150,"cachedReadTokens":100,"outputTokens":20,"costUsdTicks":150}}}}),
            1,
            "updates",
            &mut state,
        );
        assert!(copied_prefix.facts.is_empty());
        assert_eq!(child_turn.facts.len(), 1);
        assert_eq!(child_turn.facts[0].buckets.input, Some(50));
        assert_eq!(child_turn.facts[0].reported_cost, Some(0.000000015));
    }

}
