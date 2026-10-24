use crate::usage_ledger::facts::{number, text, timestamp, Buckets, Fact, Parsed, ReaderState};
use serde_json::{json, Value};

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

fn delta(now: &Buckets, previous: Option<&Buckets>) -> (Buckets, bool) {
    let reset = previous.is_some_and(|old| {
        [
            now.input.zip(old.input),
            now.cache_read.zip(old.cache_read),
            now.cache_write_unknown.zip(old.cache_write_unknown),
            now.output.zip(old.output),
        ]
        .into_iter()
        .flatten()
        .any(|(next, before)| next < before)
    });
    let subtract = |next: Option<i64>, before: Option<i64>| match (next, before, reset) {
        (Some(next), Some(before), false) => Some(next.saturating_sub(before)),
        (value, _, _) => value,
    };
    (
        Buckets {
            input: subtract(now.input, previous.and_then(|v| v.input)),
            cache_read: subtract(now.cache_read, previous.and_then(|v| v.cache_read)),
            cache_write5m: None,
            cache_write1h: None,
            cache_write_unknown: subtract(
                now.cache_write_unknown,
                previous.and_then(|v| v.cache_write_unknown),
            ),
            output: subtract(now.output, previous.and_then(|v| v.output)),
            reasoning: subtract(now.reasoning, previous.and_then(|v| v.reasoning)),
            ..Default::default()
        },
        reset,
    )
}

fn state_buckets(state: &ReaderState, key: &str) -> Option<Buckets> {
    state
        .data
        .get(key)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

fn save_state(state: &mut ReaderState, key: &str, value: Value) {
    if !state.data.is_object() {
        state.data = json!({});
    }
    state.data[key] = value;
}

fn timestamp_millis(value: &Value) -> Option<i64> {
    let value = value.as_i64()?;
    if value.abs() < 100_000_000_000 {
        value.checked_mul(1000)
    } else {
        Some(value)
    }
}

/// Parses durable Grok Build turn-completed updates. Counters are cumulative,
/// so a prompt keeps a baseline from immediately before its first snapshot.
/// Repeated snapshots therefore replace the same stable request key with its
/// full delta, which is safe for the store's max merge.
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
    let previous = state_buckets(state, "grok_latest");
    let same_prompt = state.data.get("grok_prompt").and_then(Value::as_str) == Some(prompt);
    let baseline = if same_prompt {
        state_buckets(state, "grok_prompt_baseline")
    } else {
        previous.clone()
    };
    let (buckets, mut reset) = delta(&now, baseline.as_ref());
    // A repeat is merged against its prompt baseline, so that delta alone
    // cannot reveal a counter reset. Compare it with the immediately prior
    // snapshot as well before retaining the new epoch.
    if same_prompt {
        reset |= delta(&now, previous.as_ref()).1;
    }
    let cost_ticks = number(usage, &["costUsdTicks", "cost_usd_ticks"]);
    let previous_cost = state.data.get("grok_cost_latest").and_then(Value::as_i64);
    let cost_baseline = if same_prompt {
        state
            .data
            .get("grok_prompt_cost_baseline")
            .and_then(Value::as_i64)
    } else {
        previous_cost
    };
    if cost_ticks
        .zip(cost_baseline)
        .is_some_and(|(next, before)| next < before)
    {
        reset = true;
    }
    let cost_delta = match (cost_ticks, cost_baseline, reset) {
        (Some(next), Some(before), false) => Some(next.saturating_sub(before)),
        (next, _, _) => next,
    };
    let mut epoch = state
        .data
        .get("grok_reset_epoch")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if reset {
        epoch += 1;
        // Reset values are a new cumulative sequence.  Baseline them at zero
        // and give the record a new coordinate so it cannot be max-merged with
        // a prior, larger snapshot for the same prompt.
        let (reset_buckets, _) = delta(&now, None);
        save_state(state, "grok_prompt_baseline", Value::Null);
        save_state(state, "grok_prompt_cost_baseline", Value::Null);
        save_state(state, "grok_reset_epoch", json!(epoch));
        save_state(
            state,
            "grok_latest",
            serde_json::to_value(&now).unwrap_or(Value::Null),
        );
        save_state(state, "grok_cost_latest", json!(cost_ticks));
        save_state(state, "grok_prompt", json!(prompt));
        return emit_fact(
            &mut parsed,
            update,
            state,
            file_id,
            offset,
            &session,
            prompt,
            &occurred_at,
            reset_buckets,
            cost_ticks,
            epoch,
            true,
        );
    }
    save_state(
        state,
        "grok_latest",
        serde_json::to_value(&now).unwrap_or(Value::Null),
    );
    save_state(state, "grok_cost_latest", json!(cost_ticks));
    save_state(state, "grok_prompt", json!(prompt));
    if !same_prompt {
        save_state(
            state,
            "grok_prompt_baseline",
            serde_json::to_value(&previous).unwrap_or(Value::Null),
        );
        save_state(state, "grok_prompt_cost_baseline", json!(previous_cost));
    }
    // A resumed child begins with counters that may already include its parent.
    // Establish a baseline before accepting child deltas so those copied totals
    // can never be re-added as a child request.
    let before_child_creation = state.parent_session_id.is_some()
        && state
            .data
            .get("grokForkCreatedAt")
            .and_then(Value::as_i64)
            .zip(value.get("timestamp").and_then(timestamp_millis))
            .is_some_and(|(created, event)| event < created);
    if (previous.is_none() && state.parent_session_id.is_some()) || before_child_creation {
        save_state(
            state,
            "grok_prompt_baseline",
            serde_json::to_value(&now).unwrap_or(Value::Null),
        );
        save_state(state, "grok_prompt_cost_baseline", json!(cost_ticks));
        parsed.covered_sessions.push(session.clone());
        parsed
            .problems
            .push("grok child baseline skipped to exclude inherited counters".into());
        return parsed;
    }
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
        buckets,
        cost_delta,
        epoch,
        false,
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
    epoch: i64,
    reset: bool,
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
    let key = if epoch == 0 {
        format!("{session}:{prompt}")
    } else {
        format!("{session}:{prompt}:reset:{epoch}")
    };
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
    if reset {
        parsed.problems.push(
            "grok cumulative counters reset; treated current counters as a new baseline".into(),
        );
    }
    parsed.covered_sessions.push(session.to_owned());
    parsed.facts.push(fact);
    std::mem::take(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cumulative_turns_become_deltas_and_reasoning_stays_in_output() {
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
        assert_eq!(second.facts[0].buckets.input, Some(10));
        assert_eq!(second.facts[0].buckets.output, Some(4));
        assert_eq!(second.facts[0].buckets.reasoning, Some(1));
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
    fn counter_reset_gets_a_new_request_coordinate() {
        let mut state = ReaderState::default();
        let first = parse(
            &json!({"timestamp":1,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":100,"cachedReadTokens":0,"outputTokens":10}}}}),
            0,
            "updates",
            &mut state,
        );
        let reset = parse(
            &json!({"timestamp":2,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":5,"cachedReadTokens":0,"outputTokens":1}}}}),
            1,
            "updates",
            &mut state,
        );
        assert_ne!(first.facts[0].key, reset.facts[0].key);
        assert_eq!(reset.facts[0].buckets.input, Some(5));
    }
}
